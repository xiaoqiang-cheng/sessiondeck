/** Optional real-Harness workflow check with a deterministic loopback provider.
 * npm exec tsx scripts/dsh-workflow-smoke.ts
 * No real credentials or external model requests; all native data is temporary. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DshBridge } from '../server/dsh.ts';
import { findExecutable } from '../server/adapters.ts';

const executable = await findExecutable('dsh');
if (!executable) {
  console.log(JSON.stringify({ result: 'skipped', reason: 'DeepSeek Harness is not installed' }));
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-dsh-workflow-'));
const workspace = join(directory, 'workspace'), nativeHome = join(directory, 'dsh');
await Promise.all([mkdir(workspace), mkdir(nativeHome)]);
const auditPath = join(directory, 'blocked-network.txt');
const requests: { marker: string; sessionId?: string }[] = [];
const held = new Set<ServerResponse>();
let cancellations = 0;
let bridge: DshBridge | undefined;
let fixtureError: Error | undefined;
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sessiondeck-local-fixture-only');
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 2_000_000) throw new Error('Fixture request exceeds its size limit');
    }
    const input = JSON.parse(body) as { messages: { role: string; content: unknown }[]; stream: boolean; model: string };
    assert.equal(input.stream, true);
    const text = JSON.stringify(input.messages);
    const marker = ['SESSIONDECK_SOURCE', 'SESSIONDECK_CHILD', 'SESSIONDECK_CANCEL'].filter(value => text.includes(value)).sort((a, b) => text.lastIndexOf(b) - text.lastIndexOf(a))[0];
    assert.ok(marker, 'A native request did not contain an expected fixture marker');
    requests.push({ marker, sessionId: String(request.headers['x-deepseek-harness-session-id'] ?? '') });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ id: 'sessiondeck-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`;
    response.write(chunk(`${marker}_REPLY`));
    if (marker === 'SESSIONDECK_CANCEL') {
      held.add(response);
      response.once('close', () => { held.delete(response); cancellations++; });
      return;
    }
    response.end(`${chunk('', 'stop')}data: [DONE]\n\n`);
  } catch (error) {
    fixtureError = error instanceof Error ? error : new Error(String(error));
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: fixtureError.message } }));
  }
});

async function waitFor(check: () => Promise<boolean> | boolean, detail: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (await check()) return;
    await delay(50);
  }
  throw new Error(detail);
}
async function rpc<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  assert.ok(bridge);
  const rpcId = randomUUID();
  const response = await fetch(`${bridge.baseUrl}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: bridge.baseUrl }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal: AbortSignal.timeout(5000) });
  const body = await response.json() as { rpcId: string; result: { ok: boolean; value: T; error?: unknown } };
  assert.equal(response.status, 200);
  assert.equal(body.rpcId, rpcId);
  assert.equal(body.result.ok, true, `${method}: ${JSON.stringify(body.result.error)}`);
  return body.result.value;
}
type History = { events: { event: Record<string, unknown> }[] };
const history = (id: string) => rpc<History>('session.history', { sessionId: id, maxMessages: 100 });

try {
  await new Promise<void>(accept => provider.listen(0, '127.0.0.1', accept));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  const nativePortProbe = createServer();
  await new Promise<void>(accept => nativePortProbe.listen(0, '127.0.0.1', accept));
  const nativeAddress = nativePortProbe.address();
  assert.ok(nativeAddress && typeof nativeAddress === 'object');
  await new Promise<void>(accept => nativePortProbe.close(() => accept()));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    DSH_HOME: nativeHome,
    DEEPSEEK_API_KEY: 'sessiondeck-local-fixture-only',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
    NODE_OPTIONS: `--import ${JSON.stringify(new URL('./fixtures/loopback-only.mjs', import.meta.url).href)}`,
    SESSIONDECK_NETWORK_AUDIT: auditPath,
  });
  bridge = new DshBridge({ port: nativeAddress.port, dataDir: join(directory, 'deck'), cwd: workspace, env });
  const source = await bridge.createSession(workspace, 'Fixture source');
  await rpc('session.rename', { sessionId: source.nativeSessionId, title: 'Pinned fixture source' });
  await rpc('session.selectModel', { sessionId: source.nativeSessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' });
  await bridge.prompt(source.nativeSessionId, 'SESSIONDECK_SOURCE');
  await waitFor(async () => (await bridge!.getStatus(source.nativeSessionId)).status === 'waiting_input', 'Source native turn did not complete');
  const sourceHistory = await history(source.nativeSessionId);
  assert.ok(JSON.stringify(sourceHistory).includes('SESSIONDECK_SOURCE_REPLY'));
  const child = await bridge.forkSession(source.nativeSessionId, workspace);
  assert.notEqual(child.nativeSessionId, source.nativeSessionId);
  const forkedHistory = await history(child.nativeSessionId);
  assert.ok(JSON.stringify(forkedHistory).includes('SESSIONDECK_SOURCE_REPLY'), 'Native fork did not retain source context');
  await bridge.prompt(child.nativeSessionId, 'SESSIONDECK_CHILD');
  await waitFor(async () => (await bridge!.getStatus(child.nativeSessionId)).status === 'waiting_input', 'Child native turn did not complete');
  assert.ok(JSON.stringify(await history(child.nativeSessionId)).includes('SESSIONDECK_CHILD_REPLY'));
  assert.deepEqual(await history(source.nativeSessionId), sourceHistory, 'Child prompt mutated the original native history');
  await bridge.prompt(child.nativeSessionId, 'SESSIONDECK_CANCEL');
  await waitFor(() => held.size === 1, 'Cancellation turn did not reach the local provider');
  assert.equal((await bridge.getStatus(child.nativeSessionId)).status, 'running');
  await bridge.stopSession(child.nativeSessionId);
  await waitFor(() => cancellations === 1, 'Native cancellation did not abort its HTTP stream');
  await waitFor(async () => (await bridge!.getStatus(child.nativeSessionId)).status !== 'running', 'Cancelled native turn stayed running');
  assert.deepEqual(requests.map(request => request.marker), ['SESSIONDECK_SOURCE', 'SESSIONDECK_CHILD', 'SESSIONDECK_CANCEL']);
  assert.equal(requests[0]!.sessionId, source.nativeSessionId);
  assert.equal(requests[1]!.sessionId, child.nativeSessionId);
  assert.equal(requests[2]!.sessionId, child.nativeSessionId);
  const blocked = await readFile(auditPath, 'utf8').catch(() => '');
  assert.equal(blocked, '', 'Native harness attempted unexpected external network traffic');
  const version = (await promisify(execFile)(executable, ['--version'], { env, cwd: workspace, timeout: 5000 })).stdout.trim();
  console.log(JSON.stringify({ result: 'passed', harness: version, provider: 'deterministic loopback fixture', nativeCreate: true, nativeCompletion: true, nativeFork: true, inheritedContext: true, independentChild: true, nativeCancellation: true, localModelRequests: requests.length, externalModelRequests: 0, realCredentialsUsed: false, isolatedData: true }, null, 2));
} finally {
  await bridge?.close();
  for (const response of held) response.destroy();
  provider.closeAllConnections();
  await new Promise<void>(accept => provider.close(() => accept()));
  let nativeStopped = !bridge;
  if (bridge) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await fetch(bridge.baseUrl, { signal: AbortSignal.timeout(200) }); await delay(25); }
      catch { nativeStopped = true; break; }
    }
  }
  await rm(directory, { recursive: true, force: true });
  assert.ok(nativeStopped, 'Native fixture process did not stop during cleanup');
}
