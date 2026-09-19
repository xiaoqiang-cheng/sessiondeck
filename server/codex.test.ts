import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { findExecutable } from './adapters.js';
import { CodexBridge } from './codex.js';

test('Codex app-server creates exact IDs, names and native forks without a model turn', async t => {
  const executable = await findExecutable('codex');
  if (!executable) return t.skip('codex CLI is not installed');
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-'));
  const home = join(root, 'codex-home');
  const dataDir = join(root, 'data');
  const bridge = new CodexBridge({ executable, dataDir, port: 0, env: { ...process.env, CODEX_HOME: home } });
  try {
    await bridge.start();
    assert.match(bridge.endpoint, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(bridge.remoteToken);
    const session = await bridge.createSession(root, 'Bridge probe');
    assert.match(session.nativeSessionId, /^[a-f\d]{8}-[a-f\d-]{27,}$/i);
    assert.equal(session.remoteUrl, bridge.endpoint);
    const status = await bridge.getStatus(session.nativeSessionId);
    assert.equal(status.status, 'idle');
    bridge.releaseSession(session.nativeSessionId);
    const resumed = await bridge.openSession(session.nativeSessionId, root);
    assert.deepEqual(resumed, session);
    const forkCwd = join(root, 'fork-workspace');
    await mkdir(forkCwd);
    const fork = await bridge.forkSession(session.nativeSessionId, forkCwd);
    assert.match(fork.nativeSessionId, /^[a-f\d]{8}-[a-f\d-]{27,}$/i);
    assert.notEqual(fork.nativeSessionId, session.nativeSessionId);
    assert.equal(fork.remoteUrl, bridge.endpoint);
    bridge.releaseSession(fork.nativeSessionId);
    assert.deepEqual(await bridge.openSession(fork.nativeSessionId, forkCwd), fork);
    const launch = bridge.remoteLaunch(session.nativeSessionId, executable, root);
    assert.deepEqual(launch.args.slice(0, 5), ['--remote', bridge.endpoint, '--remote-auth-token-env', 'SESSIONDECK_CODEX_TOKEN', 'resume']);
    assert.equal(launch.args[5], session.nativeSessionId);
    assert.equal(launch.args[6], '--no-alt-screen');
    assert.equal(launch.env.SESSIONDECK_CODEX_TOKEN, bridge.remoteToken);
    assert.equal(process.env.SESSIONDECK_CODEX_TOKEN, undefined);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex bridge reports status notifications by native thread ID', async t => {
  const executable = await findExecutable('codex');
  if (!executable) return t.skip('codex CLI is not installed');
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-status-'));
  const bridge = new CodexBridge({ executable, dataDir: join(root, 'data'), port: 0, env: { ...process.env, CODEX_HOME: join(root, 'home') } });
  const events: { id: string; status: string }[] = [];
  const unsubscribe = bridge.onStatus((id, event) => events.push({ id, status: event.status }));
  try {
    await bridge.start();
    const session = await bridge.createSession(root, 'Status probe');
    assert.ok(events.some(event => event.id === session.nativeSessionId && event.status === 'idle'));
    assert.equal((await bridge.getStatus(session.nativeSessionId)).status, 'idle');
  } finally {
    unsubscribe();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex bridge does not leave runtime bearer token files after stop', async t => {
  const executable = await findExecutable('codex');
  if (!executable) return t.skip('codex CLI is not installed');
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-cleanup-'));
  const dataDir = join(root, 'data');
  const bridge = new CodexBridge({ executable, dataDir, port: 0, env: { ...process.env, CODEX_HOME: join(root, 'home') } });
  try {
    await bridge.start();
    assert.ok((await readdir(dataDir)).some(name => name.startsWith('.codex-app-server-')));
  } finally {
    await bridge.close();
    assert.deepEqual((await readdir(dataDir).catch(() => [] as string[])).filter(name => name.startsWith('.codex-app-server-')), []);
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex bridge rejects malformed/stale notifications and invalidates a disconnected observer', async () => {
  const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const server = new WebSocketServer({ port: 0 });
  const sockets = new Set<WebSocket>();
  const observers = new Set<WebSocket>();
  const thread = { id: threadId, cwd: '/tmp', status: { type: 'idle' } };
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); observers.delete(socket); });
    socket.on('message', raw => {
      let message: { id?: number; method?: string };
      try { message = JSON.parse(raw.toString()) as typeof message; } catch { return; }
      if (message.method === 'initialize' && message.id !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      if (message.method === 'thread/read' && message.id !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { thread } }));
      if (message.method === 'thread/resume' && message.id !== undefined) {
        observers.add(socket);
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { thread } }));
      }
    });
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const bridge = new CodexBridge({ manageProcess: false, remoteUrl: `ws://127.0.0.1:${address.port}`, remoteToken: 'fixture-token' });
  const events: string[] = [];
  const remove = bridge.onStatus((id, event) => { if (id === threadId) events.push(event.status); });
  try {
    await bridge.openSession(threadId, '/tmp');
    const observer = [...observers][0];
    assert.ok(observer);
    observer.send('not-json');
    observer.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } }));
    await delay(10);
    observer.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId, status: {} } }));
    await delay(10);
    assert.deepEqual(events.slice(-2), ['running', 'unknown']);
    observer.close();
    await delay(20);
    assert.equal(events.at(-1), 'unknown');
  } finally {
    remove();
    await bridge.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Codex requests cannot collide with RPC responses; completion and interrupt follow the exact active turn', async () => {
  const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const turnId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const staleTurn = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
  const server = new WebSocketServer({ port: 0 });
  let observer: WebSocket | undefined;
  let nativeStatus: { type: string; activeFlags?: string[] } = { type: 'idle' };
  const calls: { method?: string; params?: Record<string, unknown> }[] = [];
  let attemptedAnswer = false;
  let injectCollision = false;
  server.on('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (!message.method) { attemptedAnswer = true; return; }
      calls.push(message);
      if (message.id === undefined) return;
      if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
      else if (message.method === 'thread/read') {
        if (injectCollision) {
          socket.send(JSON.stringify({ id: message.id, method: 'item/commandExecution/requestApproval', params: { threadId } }));
          injectCollision = false;
        }
        setTimeout(() => socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, cwd: '/tmp', status: nativeStatus, turns: [] } } })), 5);
      } else if (message.method === 'thread/resume') {
        observer = socket;
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, cwd: '/tmp', status: nativeStatus, turns: [] } } }));
      } else if (message.method === 'turn/interrupt') socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bridge = new CodexBridge({ manageProcess: false, remoteUrl: `ws://127.0.0.1:${address.port}`, remoteToken: 'fixture' });
  const events: string[] = [];
  const remove = bridge.onStatus((_id, event) => events.push(event.status));
  const notify = async (method: string, params: Record<string, unknown>) => {
    observer!.send(JSON.stringify({ method, params }));
    await delay(10);
  };
  try {
    await bridge.openSession(threadId, '/tmp');
    injectCollision = true;
    assert.equal((await bridge.getStatus(threadId)).status, 'idle');
    assert.equal(attemptedAnswer, false);
    nativeStatus = { type: 'active', activeFlags: [] };
    await notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    await notify('turn/completed', { threadId, turn: { id: staleTurn, status: 'completed' } });
    assert.equal(events.at(-1), 'running');
    await bridge.stopSession(threadId);
    assert.deepEqual(calls.find(call => call.method === 'turn/interrupt')?.params, { threadId, turnId });
    await notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed' } });
    nativeStatus = { type: 'idle' };
    await notify('thread/status/changed', { threadId, status: nativeStatus });
    assert.equal((await bridge.getStatus(threadId)).status, 'error');
    await notify('turn/started', { threadId, turn: { id: staleTurn, status: 'inProgress' } });
    await notify('turn/completed', { threadId, turn: { id: staleTurn, status: 'completed' } });
    await notify('thread/status/changed', { threadId, status: nativeStatus });
    assert.equal((await bridge.getStatus(threadId)).status, 'waiting_input');
    assert.ok(!calls.some(call => call.method === 'turn/start'));
  } finally {
    remove(); await bridge.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
