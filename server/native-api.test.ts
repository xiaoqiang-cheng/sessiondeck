import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';
import type { AppState, Session } from '../shared/types.ts';

async function freePort() {
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => probe.close(() => accept()));
  return address.port;
}
async function until(check: () => Promise<boolean>, description: string) {
  for (let attempt = 0; attempt < 300; attempt++) { if (await check()) return; await delay(25); }
  throw new Error(description);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  const kill = setTimeout(() => child.kill('SIGKILL'), 2500);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(kill); }
}
interface Handshake { url: string; token: string; nativeId: string }

test('native callbacks are isolated to one launch and duplicate notifications do not inflate unread', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sessiondeck-native-api-'));
  const file = join(dir, 'fixture-cli.cjs'), handshakePath = join(dir, 'handshake.json');
  // This fixture exercises the real PTY/hook launch contract without a model,
  // native credentials, or writes to any backend's existing history.
  await writeFile(file, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture 1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('--resume --fork-session'); process.exit(0); }
const command = JSON.parse(args[args.indexOf('--settings') + 1]).hooks.SessionStart[0].hooks[0].command;
const url = command.match(/http:\\/\\/[^']+/)[0];
const token = command.match(/'[a-f0-9]{64}'/)[0].slice(1, -1);
const nativeId = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : args[args.indexOf('--resume') + 1];
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
fs.writeFileSync(process.env.SESSIONDECK_FIXTURE_HANDSHAKE, JSON.stringify({ url, token, nativeId }), { mode: 0o600 });
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const children: ChildProcess[] = [];
  const launchServer = (portNumber: number, dataDir = join(dir, 'data')) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(portNumber), SESSIONDECK_PORT: String(portNumber), SESSIONDECK_DEMO: '0', SESSIONDECK_DATA_DIR: dataDir, SESSIONDECK_CLAUDE_BIN: file, SESSIONDECK_CODEX_BIN: '/nonexistent-codex-fixture', SESSIONDECK_DSH_BIN: '/nonexistent-dsh-fixture', SESSIONDECK_FIXTURE_HANDSHAKE: handshakePath, CLAUDE_CONFIG_DIR: join(dir, 'claude') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout?.resume(); child.stderr?.resume();
    return child;
  };
  t.after(async () => { await Promise.all(children.map(stop)); await rm(dir, { recursive: true, force: true }); });
  const server = launchServer(port);
  await until(async () => { try { return (await fetch(`${base}/api/config`)).ok; } catch { return false; } }, 'Native fixture service failed to start');
  const { csrfToken } = await (await fetch(`${base}/api/config`)).json() as { csrfToken: string };
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-sessiondeck-token': csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result as T;
  };
  const item = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: 'Native fixture', cwd: dir });
  const state = async () => (await request<AppState>('/api/state')).sessions.find(row => row.id === item.id)!;
  const hook = async (handshake: Handshake, event: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(handshake.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sessiondeck-token': handshake.token }, body: JSON.stringify({ source: 'claude', payload: { session_id: handshake.nativeId, hook_event_name: event, ...extra } }) });
    assert.equal(response.status, 200);
  };
  const readHandshake = () => readFile(handshakePath, 'utf8').then(value => JSON.parse(value) as Handshake);
  await request(`/api/sessions/${item.id}/start`, 'POST');
  await until(async () => { try { return !!(await readHandshake()).url; } catch { return false; } }, 'PTY fixture did not receive hook configuration');
  const first = await readHandshake();
  await hook(first, 'SessionStart');
  assert.equal((await state()).nativeSessionId, first.nativeId);
  await hook(first, 'UserPromptSubmit');
  await hook(first, 'Stop');
  const completed = await state();
  assert.equal(completed.status, 'waiting_input');
  assert.equal(completed.unread, 1);
  await hook(first, 'Stop');
  assert.equal((await state()).unread, 1);
  await request(`/api/sessions/${item.id}/read`, 'POST');
  await hook(first, 'Stop');
  assert.equal((await state()).unread, 0);

  await t.test('second service is rejected before it can reset live database state', async () => {
    const duplicate = launchServer(await freePort());
    await until(async () => duplicate.exitCode !== null, 'Duplicate service did not exit');
    assert.notEqual(duplicate.exitCode, 0);
    assert.equal((await state()).running, true);
  });
  await request(`/api/sessions/${item.id}/stop`, 'POST');
  await request(`/api/sessions/${item.id}/start`, 'POST');
  await until(async () => (await readHandshake()).url !== first.url, 'Restart did not receive a fresh launch token');
  const second = await readHandshake();
  assert.equal(second.nativeId, first.nativeId);
  await hook(second, 'SessionStart');
  await hook(first, 'PermissionRequest');
  assert.equal((await state()).status, 'idle');
  await hook(second, 'PermissionRequest');
  assert.equal((await state()).status, 'waiting_approval');
  await hook(second, 'Stop', { session_id: 'invalid-native-id' });
  assert.equal((await state()).status, 'waiting_approval');
  await t.test('Claude cancellation keys invalidate execution claims, while arrow keys and tool results retain native semantics', async () => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/terminal/${item.id}?token=${csrfToken}`, { origin: base });
    await new Promise<void>((accept, reject) => { ws.once('open', accept); ws.once('error', reject); });
    try {
      ws.send(JSON.stringify({ type: 'input', data: '\x1b[A' }));
      await delay(50);
      assert.equal((await state()).status, 'waiting_approval', 'Arrow key must not appear to cancel approval');
      ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
      await until(async () => (await state()).status === 'unknown', 'Esc incorrectly retained a confirmed native approval state');
      assert.equal((await state()).running, true, 'Cancellation does not stop the managed TUI');
      await hook(second, 'PostToolUse');
      assert.equal((await state()).status, 'running');
      assert.equal((await state()).statusSource, 'native');
      ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
      await until(async () => (await state()).status === 'unknown', 'Ctrl-C incorrectly retained a confirmed native running state');
      await hook(second, 'UserPromptSubmit');
      await hook(second, 'Stop');
      assert.equal((await state()).status, 'waiting_input');
    } finally { ws.terminate(); }
  });
  await request(`/api/sessions/${item.id}/stop`, 'POST');
  await stop(server);

  await t.test('port conflict closes its storage instance lock so a retry can start', async () => {
    const occupied = createServer();
    const occupiedPort = await freePort();
    await new Promise<void>(accept => occupied.listen(occupiedPort, '127.0.0.1', accept));
    try {
      const conflicted = launchServer(occupiedPort);
      await until(async () => conflicted.exitCode !== null, 'Port-conflicted server did not close');
      assert.equal(conflicted.exitCode, 1);
      const retryPort = await freePort();
      const retry = launchServer(retryPort);
      await until(async () => { try { return (await fetch(`http://127.0.0.1:${retryPort}/api/config`)).ok; } catch { return false; } }, 'Retry could not acquire released lock');
      await stop(retry);
    } finally { await new Promise<void>(accept => occupied.close(() => accept())); }
  });
});
