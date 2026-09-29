import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { ShellTerminal } from '../shared/shell.ts';
import type { Session } from '../shared/types.ts';

async function freePort() {
  const server = createServer();
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => server.close(() => accept()));
  return address.port;
}
async function until(check: () => boolean | Promise<boolean>, description: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error(description);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(kill); }
}

test('shell HTTP and WebSocket preserve live shells across disconnect and terminate only explicitly closed terminals', { timeout: 30_000, skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-shell-api-'));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: resolve('.'), env: { ...process.env, PORT: String(port), SESSIONDECK_PORT: String(port), SESSIONDECK_DEMO: '1', SESSIONDECK_DATA_DIR: join(directory, 'data') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', data => { logs += data; }); child.stderr?.on('data', data => { logs += data; });
  const sockets = new Set<WebSocket>();
  t.after(async () => { for (const socket of sockets) socket.terminate(); await stop(child); await rm(directory, { recursive: true, force: true }); });
  await until(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(`${base}/api/config`)).ok; } catch { return false; } }, 'Shell fixture service did not start');
  const { csrfToken } = await (await fetch(`${base}/api/config`)).json() as { csrfToken: string };
  const request = async <T>(path: string, method = 'GET', body?: object, status = 200): Promise<T> => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-SessionDeck-Token': csrfToken }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result as T;
  };
  const connect = async (id: string) => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/shells/${id}/terminal?token=${csrfToken}`, { origin: base });
    sockets.add(socket);
    const result = { socket, output: '', ready: false };
    socket.on('message', raw => { const event = JSON.parse(raw.toString()); if (event.type === 'data') result.output += event.data; if (event.type === 'ready') result.ready = true; });
    await new Promise<void>((accept, reject) => { socket.once('open', accept); socket.once('error', reject); });
    await until(() => result.ready, 'Shell WebSocket did not become ready');
    return result;
  };
  const denied = await fetch(`${base}/api/shells`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  const foreign = await fetch(`${base}/api/shells`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SessionDeck-Token': csrfToken, Origin: 'https://foreign.invalid' }, body: '{}' });
  assert.equal(foreign.status, 403);
  await request('/api/shells', 'POST', { sessionId: '../missing' }, 404);
  assert.deepEqual(await request('/api/shells'), []);
  const source = await request<Session>('/api/sessions', 'POST', { title: 'Shell cwd source', backend: 'codex', cwd: directory }, 201);
  const first = await request<ShellTerminal>('/api/shells', 'POST', { sessionId: source.id }, 201);
  const second = await request<ShellTerminal>('/api/shells', 'POST', {}, 201);
  assert.equal(first.cwd, directory); assert.equal(second.cwd, process.cwd());
  assert.equal((await request<ShellTerminal[]>('/api/shells')).length, 2);
  const terminal = await connect(first.id);
  terminal.socket.send(JSON.stringify({ type: 'input', data: "printf 'LIVE_%s\\n' 'SHELL'\r" }));
  await until(() => terminal.output.includes('LIVE_SHELL'), 'WebSocket input was not executed by the shell');
  terminal.socket.send(JSON.stringify({ type: 'resize', cols: 101, rows: 31 }));
  terminal.socket.send(JSON.stringify({ type: 'input', data: 'stty size\r' }));
  await until(() => terminal.output.includes('31 101'), 'WebSocket resize did not reach PTY');
  terminal.socket.close();
  assert.equal((await request<ShellTerminal[]>('/api/shells')).find(item => item.id === first.id)?.running, true);
  const restored = await connect(first.id);
  await until(() => restored.output.includes('LIVE_SHELL'), 'Reconnect failed to replay the same shell');
  restored.socket.send(JSON.stringify({ type: 'input', data: "printf 'BACK_%s\\n' 'AGAIN'\r" }));
  await until(() => restored.output.includes('BACK_AGAIN'), 'Restored shell did not remain interactive');
  const closed = new Promise<number>(accept => restored.socket.once('close', code => accept(code)));
  await request(`/api/shells/${first.id}`, 'DELETE', {});
  assert.equal(await closed, 1000, 'Explicit removal should stop observer reconnection');
  assert.deepEqual((await request<ShellTerminal[]>('/api/shells')).map(item => item.id), [second.id]);
  const badSocket = new WebSocket(`${base.replace('http:', 'ws:')}/api/shells/${second.id}/terminal?token=invalid`, { origin: base });
  sockets.add(badSocket);
  const status = await new Promise<number>((accept, reject) => { badSocket.once('unexpected-response', (_request, response) => { response.resume(); accept(response.statusCode ?? 0); }); badSocket.once('open', () => reject(new Error('Invalid shell token accepted'))); badSocket.once('error', () => {}); });
  assert.equal(status, 403);
  await request(`/api/shells/${second.id}`, 'DELETE', {});
  assert.deepEqual(await request('/api/shells'), []);
});
