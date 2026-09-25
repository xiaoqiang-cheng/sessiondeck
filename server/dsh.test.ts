import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { DshBridge } from './dsh.ts';
import { DeliveryNotAcceptedError } from './delivery.ts';

async function freePort() {
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => probe.close(() => accept()));
  return address.port;
}

async function until(check: () => Promise<boolean>, detail: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(detail);
}

async function fixture(t: TestContext, options: { wrongIdentity?: boolean; stubborn?: boolean; startupTimeoutMs?: number; probeDelayMs?: number; stall?: 'identity-headers' | 'identity-body' | 'api-headers' | 'api-body' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sessiondeck-dsh-events-'));
  const file = join(dir, 'native-events-fixture.cjs'), id = `session-${randomUUID()}`;
  const wsModule = fileURLToPath(new URL('../node_modules/ws/index.js', import.meta.url));
  await writeFile(file, `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
const { WebSocketServer } = require(${JSON.stringify(wsModule)});
const args = process.argv.slice(2), id = ${JSON.stringify(id)};
${options.stubborn ? "process.on('SIGTERM', () => {});" : ''}
let running = false, history = [], holdReplay = false, muxConnections = 0, holdList = false, releaseList = null;
const pending = new Map(), paused = new Set();
const server = http.createServer(async (request, response) => {
  if (${options.probeDelayMs ?? 0} && ['/sessiondeck/instance','/api/session.list'].includes(request.url)) await new Promise(resolve => setTimeout(resolve, ${options.probeDelayMs ?? 0}));
  const stall = ${JSON.stringify(options.stall ?? '')};
  if ((stall.startsWith('identity') && request.url === '/sessiondeck/instance') || (stall.startsWith('api') && request.url === '/api/session.list')) {
    fs.appendFileSync(${JSON.stringify(join(dir, 'stalled-probes'))},request.url+'\\n');
    if (stall.endsWith('body')) { response.writeHead(200); response.write(stall.startsWith('identity') ? process.env.SESSIONDECK_DSH_LAUNCH_TOKEN : '{'); }
    return;
  }
  if (request.url === '/sessiondeck/instance') { response.end(${options.wrongIdentity ? "'another-process'" : 'process.env.SESSIONDECK_DSH_LAUNCH_TOKEN'}); return; }
  if (request.method === 'GET') {
    response.end(request.url === '/fixture' ? JSON.stringify({muxConnections, listPending: !!releaseList}) : 'native fixture'); return;
  }
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  if (['session.create','session.fork'].includes(input.method)) fs.appendFileSync(${JSON.stringify(join(dir, 'native-mutations'))},input.method+'\\n');
  if (request.url === '/fixture') {
    if (input.exit) { response.end('{}'); setImmediate(() => process.exit(0)); return; }
    if (Object.hasOwn(input, 'running')) running = input.running;
    if (Object.hasOwn(input, 'history')) history = input.history;
    if (Object.hasOwn(input, 'holdReplay')) holdReplay = input.holdReplay;
    if (Object.hasOwn(input, 'holdList')) holdList = input.holdList;
    if (input.releaseList) { holdList = false; releaseList?.(); releaseList = null; }
    if (input.frame) {
      const frame = input.frame, p = frame.payload;
      if (p.type === 'approval/requested') pending.set('approval:' + p.approvalId, frame);
      if (p.type === 'question/requested') pending.set('question:' + frame.rpcId, frame);
      if (p.type === 'approval/resolved') pending.delete('approval:' + p.approvalId);
      if (p.type === 'question/resolved') pending.delete('question:' + p.questionRpcId);
      if (p.type === 'session/event') { history.push(p.event); if (p.event.type === 'turn/end') pending.clear(); }
      for (const socket of streams.clients) if (socket.path === (p.type.startsWith('host/') ? '/api/events.host' : '/api/events.mux')) socket.send(JSON.stringify(frame));
    }
    if (input.disconnect) for (const socket of streams.clients) socket.terminate();
    if (input.releaseReplay) {
      holdReplay = false;
      for (const socket of paused) if (socket.readyState === 1) for (const frame of pending.values()) socket.send(JSON.stringify(frame));
      paused.clear();
    }
    response.end('{}'); return;
  }
  let value = {};
  if (input.method === 'session.list') value = { items: [{ sessionId: id, running }] };
  if (input.method === 'session.list' && holdList) await new Promise(resolve => { releaseList = resolve; });
  if (input.method === 'session.history') value = { events: history.map(event => ({event})), hasMore: false };
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } }));
});
const streams = new WebSocketServer({ server });
streams.on('connection', (socket, request) => {
  socket.path = request.url;
  if (socket.path !== '/api/events.mux') return;
  muxConnections++;
  socket.send(JSON.stringify({type:'server-request',rpcId:'subscription',payload:{type:'session/subscribed',sessionId:id,lastSeq:history.at(-1)?.seq ?? -1}}));
  if (holdReplay) paused.add(socket);
  else for (const frame of pending.values()) socket.send(JSON.stringify(frame));
});
server.listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
${options.wrongIdentity ? 'setTimeout(() => process.exit(1), 800);' : ''}
`, { mode: 0o700 });
  const previous = process.env.SESSIONDECK_DSH_BIN;
  process.env.SESSIONDECK_DSH_BIN = file;
  const bridge = new DshBridge({ port: await freePort(), dataDir: dir, cwd: dir, startupTimeoutMs: options.startupTimeoutMs });
  t.after(async () => {
    await bridge.close();
    if (previous === undefined) delete process.env.SESSIONDECK_DSH_BIN;
    else process.env.SESSIONDECK_DSH_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const configure = async (input: Record<string, unknown>) => {
    await fetch(`${bridge.baseUrl}/fixture`, { method: 'POST', body: JSON.stringify(input) });
  };
  const send = (frame: Record<string, unknown>, extra: Record<string, unknown> = {}, rpcId = 'shared-id') => configure({ ...extra, frame: { type: 'server-request', rpcId, payload: { sessionId: id, ...frame } } });
  const waitStatus = async (expected: string) => {
    let actual = await bridge.getStatus(id);
    await until(async () => { actual = await bridge.getStatus(id); return actual.status === expected; }, `Expected ${expected}, received ${JSON.stringify(actual)}`);
    return actual;
  };
  return { bridge, id, directory: dir, configure, send, waitStatus };
}

test('dsh startup cancellation and immediate running-process replacement own independent generations', { timeout: 15_000 }, async t => {
  const { bridge, directory } = await fixture(t);
  const cancelled = bridge.start();
  const cancelling = bridge.stop();
  const replacement = bridge.start();
  await Promise.all([assert.rejects(cancelled, /启动已取消/), replacement, cancelling]);
  assert.equal((await fetch(bridge.baseUrl)).status, 200);
  const retiring = bridge.stop();
  // start waits for the old listener to release its port before probing it.
  await Promise.all([bridge.start(), retiring]);
  assert.equal((await fetch(bridge.baseUrl)).status, 200);
  await bridge.stop();
  await until(async () => {
    try { await fetch(bridge.baseUrl, { signal: AbortSignal.timeout(100) }); return false; }
    catch { return true; }
  }, 'Native process remained reachable after bridge.stop()');
  await until(async () => !(await readdir(directory)).some(name => name.startsWith('dsh-launch-')), 'Stopped launches left temporary plugin files');
});

test('dsh startup refuses an HTTP server without this launch identity', { timeout: 10_000 }, async t => {
  const { bridge } = await fixture(t, { wrongIdentity: true });
  await assert.rejects(bridge.start(), /已退出/);
});

test('repeated dsh stop/start retires stubborn generations and cleans their invocation files', { timeout: 12_000 }, async t => {
  const { bridge, directory } = await fixture(t, { stubborn: true });
  await bridge.start();
  for (let cycle = 0; cycle < 2; cycle++) {
    const stopping = bridge.stop();
    await Promise.all([bridge.start(), stopping]);
    assert.equal((await readdir(directory)).filter(name => name.startsWith('dsh-launch-')).length, 1);
    assert.equal((await fetch(bridge.baseUrl)).status, 200);
  }
  await bridge.close();
  assert.equal((await readdir(directory)).filter(name => name.startsWith('dsh-launch-')).length, 0);
  await assert.rejects(bridge.start(), /正在关闭/);
});

test('dsh never adopts or stops a service already occupying the selected port', async t => {
  const { directory } = await fixture(t);
  const existing = createHttpServer((_request, response) => response.end('existing service'));
  await new Promise<void>(accept => existing.listen(0, '127.0.0.1', accept));
  const address = existing.address(); assert.ok(address && typeof address === 'object');
  const bridge = new DshBridge({ port: address.port, dataDir: directory, cwd: directory });
  t.after(async () => { await bridge.close(); await new Promise<void>(accept => existing.close(() => accept())); });
  await assert.rejects(bridge.start(), /已被占用/);
  await bridge.stop();
  assert.equal(await (await fetch(bridge.baseUrl)).text(), 'existing service');
});

test('native dsh pending replay keeps approval/question identities and never marks an opening socket as running', { timeout: 15_000 }, async t => {
  const { bridge, id, configure, send, waitStatus } = await fixture(t);
  await bridge.start();
  await until(async () => Number((await (await fetch(`${bridge.baseUrl}/fixture`)).json()).muxConnections) === 1, 'mux did not connect');
  assert.equal((await bridge.getStatus(id)).status, 'idle');
  await send({ type: 'host/session-status', running: true }, { running: true });
  assert.equal((await bridge.getStatus(id)).status, 'unknown');
  await send({ type: 'session/event', event: { type: 'turn/start', seq: 0, data: { turn: 0 } } });
  await waitStatus('running');
  await send({ type: 'approval/requested', approvalId: 'shared-id' });
  const approval = await waitStatus('waiting_approval');
  assert.ok(approval.attentionKey?.includes('approval:shared-id'));
  await send({ type: 'question/requested', questions: [{ question: 'private question' }] });
  await send({ type: 'question/resolved', questionRpcId: 'shared-id' });
  assert.equal((await waitStatus('waiting_approval')).attentionKey, approval.attentionKey);
  await configure({ holdReplay: true, disconnect: true });
  await waitStatus('unknown');
  await until(async () => Number((await (await fetch(`${bridge.baseUrl}/fixture`)).json()).muxConnections) >= 2, 'mux did not reconnect');
  // Both sockets have opened, but the pending-request baseline has not arrived.
  assert.equal((await bridge.getStatus(id)).status, 'unknown');
  await configure({ releaseReplay: true });
  assert.equal((await waitStatus('waiting_approval')).attentionKey, approval.attentionKey);
  await send({ type: 'approval/resolved', approvalId: 'shared-id' });
  await waitStatus('running');
  await send({ type: 'question/requested' });
  const question = await waitStatus('waiting_input');
  assert.ok(question.attentionKey?.includes('question:shared-id'));
  assert.notEqual(question.attentionKey, approval.attentionKey);
  assert.ok(!JSON.stringify(question).includes('private question'));
  await send({ type: 'question/resolved', questionRpcId: 'shared-id' });
  await waitStatus('running');
  await send({ type: 'session/event', event: { type: 'turn/end', seq: 4, data: { turn: 0, reason: { kind: 'completed' } } } }, { running: false });
  const completed = await waitStatus('waiting_input');
  assert.ok(completed.attentionKey?.endsWith(':4:completed'));
  // The host socket can lag behind the mux socket. Its old running frame
  // must not erase the identified turn/end already received above.
  await send({ type: 'host/session-status', running: true });
  assert.equal((await waitStatus('waiting_input')).attentionKey, completed.attentionKey);
  await configure({ disconnect: true });
  assert.equal((await waitStatus('waiting_input')).attentionKey, completed.attentionKey);
  await send({ type: 'host/session-status', running: true }, { running: true });
  await configure({ history: [] });
  await waitStatus('unknown');
  await configure({ running: null });
  assert.equal((await bridge.getStatus(id)).status, 'unknown');
});

test('dsh recovers stable completion/error identities from native history and rejects stale boundaries', { timeout: 15_000 }, async t => {
  const { bridge, id, configure, send, waitStatus } = await fixture(t);
  await bridge.start();
  const completedEvent = { type: 'turn/end', seq: 12, data: { turn: 1, reason: { kind: 'completed' } } };
  await configure({ history: [completedEvent] });
  const completed = await waitStatus('waiting_input');
  assert.equal(completed.attentionKey, `dsh:turn:${id}:12:completed`);
  await until(async () => Number((await (await fetch(`${bridge.baseUrl}/fixture`)).json()).muxConnections) === 1, 'mux did not connect');
  await send({ type: 'session/event', event: { type: 'turn/start', seq: 13, data: { turn: 2 } } }, { running: true });
  await waitStatus('running');
  await send({ type: 'session/event', event: completedEvent });
  assert.equal((await bridge.getStatus(id)).status, 'running');
  await send({ type: 'session/event', event: { type: 'turn/end', seq: 20, data: { turn: 2, reason: { kind: 'error', error: { message: 'private provider failure' } } } } }, { running: false });
  const failed = await waitStatus('error');
  assert.equal(failed.attentionKey, `dsh:turn:${id}:20:error`);
  assert.ok(!JSON.stringify(failed).includes('private provider failure'));
  await configure({ disconnect: true });
  assert.equal((await bridge.getStatus(id)).attentionKey, failed.attentionKey);
  await until(async () => Number((await (await fetch(`${bridge.baseUrl}/fixture`)).json()).muxConnections) >= 2, 'mux did not reconnect');
  await send({ type: 'session/event', event: { type: 'turn/start', seq: 21, data: { turn: 3 } } }, { running: true });
  await waitStatus('running');
  await send({ type: 'host/agent-error', message: 'private host failure' }, {}, 'error-identity');
  const hostError = await waitStatus('error');
  assert.equal(hostError.attentionKey, `dsh:error:${id}:error-identity`);
  assert.ok(!JSON.stringify(hostError).includes('private host failure'));
  await send({ type: 'host/session-status', running: true });
  assert.equal((await bridge.getStatus(id)).attentionKey, hostError.attentionKey);
  await send({ type: 'session/event', event: { type: 'turn/start', seq: 30, data: { turn: 4 } } });
  await waitStatus('running');
  const offlineCompletion = { type: 'turn/end', seq: 40, data: { turn: 4, reason: { kind: 'completed' } } };
  await configure({ disconnect: true, running: false, history: [offlineCompletion] });
  const recovered = await waitStatus('waiting_input');
  assert.equal(recovered.attentionKey, `dsh:turn:${id}:40:completed`);
  // The event identity comes from native history, so clearing all bridge state
  // and starting a replacement does not manufacture a different notification.
  await bridge.stop();
  await bridge.start();
  await configure({ history: [offlineCompletion] });
  assert.equal((await waitStatus('waiting_input')).attentionKey, recovered.attentionKey);
});

test('dsh stop aborts in-flight native responses before a replacement generation can observe them', { timeout: 10_000 }, async t => {
  const id = `session-${randomUUID()}`;
  let release: (() => void) | undefined;
  const server = createHttpServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    await new Promise<void>(accept => { release = accept; });
    response.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value: { items: [{ sessionId: id, running: true }] } } }));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bridge = new DshBridge({ port: address.port, manageProcess: false });
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); });
  await bridge.start();
  const old = bridge.getStatus(id);
  await until(async () => !!release, 'native list did not start');
  const stopping = bridge.stop();
  await Promise.all([bridge.start(), stopping]);
  release!();
  assert.equal((await old).status, 'unknown');
});

test('stopping a cold persisted DSH session is a no-op, while running or unknown tasks require native cancellation', async t => {
  const id = `session-${randomUUID()}`;
  let running: boolean | undefined = false, cancellations = 0, failCancel = false;
  const server = createHttpServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.method === 'session.cancel') cancellations++;
    response.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: failCancel && input.method === 'session.cancel' ? { ok: false, error: { code: 'session-not-found', message: 'not attached' } } : { ok: true, value: input.method === 'session.list' ? { items: [{ sessionId: id, running }] } : { accepted: true } } }));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bridge = new DshBridge({ port: address.port, manageProcess: false });
  t.after(async () => { await bridge.close(); await new Promise<void>(accept => server.close(() => accept())); });
  await bridge.start();
  await bridge.stopSession(id);
  assert.equal(cancellations, 0);
  running = true;
  await bridge.stopSession(id);
  assert.equal(cancellations, 1);
  failCancel = true;
  await assert.rejects(bridge.stopSession(id), /not attached/);
  running = undefined;
  await assert.rejects(bridge.stopSession(id), /not attached/);
  assert.equal(cancellations, 3);
});

for (const stall of ['identity-headers', 'identity-body', 'api-headers', 'api-body'] as const) {
  test(`dsh total startup deadline bounds stalled ${stall} and finishes owned cleanup before rejecting`, { timeout: 5000 }, async t => {
    const { bridge, directory } = await fixture(t, { stall, startupTimeoutMs: 650 });
    const started = Date.now();
    await assert.rejects(bridge.start(), /启动超时/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 600 && elapsed < 1100, `Total readiness deadline drifted to ${elapsed}ms`);
    assert.ok((await readFile(join(directory, 'stalled-probes'), 'utf8')).includes(stall.startsWith('identity') ? '/sessiondeck/instance' : '/api/session.list'));
    assert.equal((await readdir(directory)).filter(name => name.startsWith('dsh-launch-')).length, 0, 'Timed-out launch left its plugin files');
    await assert.rejects(fetch(bridge.baseUrl, { signal: AbortSignal.timeout(100) }), /fetch failed/);
  });
}

test('dsh timeout also retires a stubborn process and never lets a late probe mark the bridge ready', { timeout: 5000 }, async t => {
  const { bridge, directory, id } = await fixture(t, { stall: 'api-body', stubborn: true, startupTimeoutMs: 450 });
  const started = Date.now();
  await assert.rejects(bridge.start(), /启动超时/);
  assert.ok(Date.now() - started < 1800, 'Startup deadline plus bounded process cleanup exceeded its budget');
  assert.equal((await readdir(directory)).filter(name => name.startsWith('dsh-launch-')).length, 0);
  assert.equal((await bridge.getStatus(id)).status, 'unknown');
  await assert.rejects(fetch(bridge.baseUrl, { signal: AbortSignal.timeout(100) }), /fetch failed/);
});

test('dsh close waits for invocation files after the native process exits on its own', { timeout: 8000 }, async t => {
  const { bridge, directory, configure } = await fixture(t);
  await bridge.start();
  const childExit = configure({ exit: true });
  await childExit;
  await until(async () => {
    try { return !(await fetch(bridge.baseUrl, { signal: AbortSignal.timeout(100) })).ok; }
    catch { return true; }
  }, 'Fixture process did not exit');
  await bridge.close();
  assert.equal((await readdir(directory)).filter(name => name.startsWith('dsh-launch-')).length, 0);
});

test('slow successful readiness probes share one deadline and cannot create a native session after it expires', { timeout: 5000 }, async t => {
  const { bridge, directory } = await fixture(t, { probeDelayMs: 350, startupTimeoutMs: 650 });
  const started = Date.now();
  await assert.rejects(bridge.createSession(directory), /启动超时/);
  assert.ok(Date.now() - started < 1100, 'Sequential probes each consumed an independent timeout budget');
  assert.equal((await readdir(directory)).filter(name => name.startsWith('dsh-launch-')).length, 0);
  assert.equal((await readFile(join(directory, 'native-mutations'), 'utf8').catch(() => '')), '');
  await assert.rejects(fetch(bridge.baseUrl, { signal: AbortSignal.timeout(100) }), /fetch failed/);
});

test('forty DSH contacts share one native listing per round and do not cache stale snapshots', async t => {
  const ids = Array.from({ length: 40 }, () => `session-${randomUUID()}`);
  let listings = 0, running = true, errorCode = '';
  const server = createHttpServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    if (input.method === 'session.list') listings++;
    response.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: errorCode ? { ok: false, error: { code: errorCode } } : { ok: true, value: input.method === 'session.list' ? { items: ids.map(sessionId => ({ sessionId, running })) } : { events: [] } } }));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bridge = new DshBridge({ port: address.port, manageProcess: false });
  t.after(async () => { await bridge.close(); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); });
  await bridge.start();
  const first = await bridge.getStatuses(ids);
  assert.equal(listings, 1); assert.equal(first.size, 40);
  assert.ok([...first.values()].every(status => status.status === 'running'));
  running = false;
  const second = await bridge.getStatuses(ids);
  assert.equal(listings, 2);
  assert.ok([...second.values()].every(status => status.status === 'idle'));
  errorCode = 'internal-error';
  await assert.rejects(bridge.prompt(ids[0], 'task'), error => !(error instanceof DeliveryNotAcceptedError));
  errorCode = 'session-not-found';
  await assert.rejects(bridge.prompt(ids[0], 'task'), DeliveryNotAcceptedError);
});

test('live DSH boundaries received during a batched listing win over that older snapshot', async t => {
  const { bridge, id, configure, send, waitStatus } = await fixture(t);
  let changes = 0;
  bridge.onStatusChange(() => { changes++; });
  await bridge.start();
  await until(async () => Number((await (await fetch(`${bridge.baseUrl}/fixture`)).json()).muxConnections) === 1, 'mux did not connect');
  await send({ type: 'session/event', event: { type: 'turn/start', seq: 1 } }, { running: true });
  await waitStatus('running');
  await configure({ holdList: true });
  const pending = bridge.getStatuses([id]);
  await until(async () => (await (await fetch(`${bridge.baseUrl}/fixture`)).json()).listPending, 'list not held');
  const before = changes;
  await send({ type: 'session/event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } } }, { running: false });
  await until(async () => changes > before, 'status event did not request refresh');
  await configure({ releaseList: true });
  assert.equal((await pending).get(id)?.status, 'waiting_input');
});
