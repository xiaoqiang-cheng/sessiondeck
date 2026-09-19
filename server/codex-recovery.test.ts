import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { CodexBridge } from './codex.ts';

const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const thread = { id: threadId, cwd: '/tmp', status: { type: 'idle' }, turns: [] };

async function fixture(t: test.TestContext) {
  const server = new WebSocketServer({ port: 0 });
  const sockets = new Set<WebSocket>();
  const observers = new Set<WebSocket>();
  const held: (() => void)[] = [];
  let holdResume = true;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => { sockets.delete(socket); observers.delete(socket); });
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { id?: number; method?: string };
      if (message.id === undefined || !message.method) return;
      const respond = (result: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, result })); };
      if (message.method === 'initialize') respond({});
      else if (message.method === 'thread/read') respond({ thread });
      else if (message.method === 'thread/resume') {
        observers.add(socket);
        if (holdResume) held.push(() => respond({ thread }));
        else respond({ thread });
      }
    });
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bridge = new CodexBridge({ manageProcess: false, remoteUrl: `ws://127.0.0.1:${address.port}`, remoteToken: 'fixture' });
  t.after(async () => { await bridge.close(); for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await bridge.start();
  const until = async (check: () => boolean, description: string) => {
    for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
    throw new Error(description);
  };
  return { bridge, sockets, observers, held, until, resume: () => { holdResume = false; for (const release of held.splice(0)) release(); } };
}

test('releasing a Codex contact cancels its observer recovery already in flight', async t => {
  const { bridge, observers, held, until, resume } = await fixture(t);
  const recovery = bridge.getStatus(threadId);
  await until(() => held.length === 1, 'Recovery did not reach thread/resume');
  bridge.releaseSession(threadId);
  resume();
  await recovery;
  await delay(30);
  assert.equal(observers.size, 0, 'A late resume response must not retain an observer for a stopped contact');
});

test('concurrent Codex status recovery shares one observer and release closes it completely', async t => {
  const { bridge, observers, held, until, resume } = await fixture(t);
  const first = bridge.getStatus(threadId);
  const second = bridge.getStatus(threadId);
  await until(() => held.length > 0, 'Recovery did not reach thread/resume');
  // Let an independently started duplicate reach the same native request.
  await delay(20);
  assert.equal(held.length, 1, 'Concurrent recovery must resume the native thread only once');
  resume();
  await Promise.all([first, second]);
  bridge.releaseSession(threadId);
  await delay(30);
  assert.equal(observers.size, 0, 'All observers for a released contact must close, including concurrent recoveries');
});

test('fifty concurrent recovery/release cycles leave no native RPC or observer sockets behind', { timeout: 10_000 }, async t => {
  const { bridge, sockets, observers, until, resume } = await fixture(t);
  resume();
  for (let cycle = 0; cycle < 50; cycle++) {
    const states = await Promise.all(Array.from({ length: 5 }, () => bridge.getStatus(threadId)));
    assert.ok(states.every(state => state.status === 'idle'));
    assert.equal(observers.size, 1, 'A contact may own only one observer');
    bridge.releaseSession(threadId);
    await until(() => sockets.size === 0 && observers.size === 0, `Native sockets leaked after cycle ${cycle + 1}`);
  }
  await bridge.close();
  assert.equal(sockets.size, 0);
});
