import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import type { AppState, Group, GroupDetail, GroupMessage, Session, Delivery } from '../shared/types.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((accept, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', accept);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
  return port;
}

async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(message);
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  child.kill('SIGTERM');
  const hardStop = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(hardStop); }
}

test('local HTTP and real demo PTYs complete the contact, fork and group flow', { timeout: 45_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sessiondeck-api-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SESSIONDECK_PORT: String(port), SESSIONDECK_DEMO: '1', SESSIONDECK_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', chunk => { logs = (logs + chunk).slice(-16_000); });
  child.stderr?.on('data', chunk => { logs = (logs + chunk).slice(-16_000); });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await stopProcess(child);
    rmSync(directory, { recursive: true, force: true });
  });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture server exited: ${logs}`);
    try { return (await fetch(`${base}/api/config`)).ok; } catch { return false; }
  }, `Fixture server did not start: ${logs}`, 15_000);
  const config = await (await fetch(`${base}/api/config`)).json() as { csrfToken: string };
  const token = config.csrfToken;
  assert.match(token, /^[a-f0-9]{64}$/);

  async function request<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-SessionDeck-Token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  async function terminal(id: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${id}?token=${token}`, { origin: base });
    sockets.push(socket);
    const result = { socket, output: '' };
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString()) as { type: string; data?: string };
      if (event.type === 'data') result.output += event.data ?? '';
    });
    await new Promise<void>((accept, reject) => { socket.once('open', accept); socket.once('error', reject); });
    return result;
  }

  await t.test('write requests require a token and local origin; malformed backend never persists', async () => {
    const count = (await request<AppState>('/api/state')).sessions.length;
    const body = { backend: 'codex', title: 'Should not exist', cwd: directory };
    const noToken = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(noToken.status, 403);
    const foreignOrigin = await fetch(`${base}/api/sessions`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-SessionDeck-Token': token, Origin: 'https://attacker.example',
    }, body: JSON.stringify(body) });
    assert.equal(foreignOrigin.status, 403);
    // fetch owns Host; use a raw HTTP request to exercise the DNS-rebinding boundary.
    const foreignHost = await new Promise<number>((accept, reject) => {
      const req = httpRequest(`${base}/api/state`, { headers: { Host: `attacker.example:${port}` } }, response => {
        response.resume(); accept(response.statusCode ?? 0);
      });
      req.once('error', reject); req.end();
    });
    assert.equal(foreignHost, 403);
    await request('/api/sessions', 'POST', { ...body, backend: ['claude'] }, 400);
    await request('/api/sessions', 'POST', { ...body, cwd: join(directory, 'missing') }, 400);
    await request('/api/sessions', 'POST', [], 400);
    await request('/api/sessions', 'POST', null, 400);
    assert.equal((await request<AppState>('/api/state')).sessions.length, count);
  });

  let group: Group;
  let member: Session;
  let reviewer: Session;
  let source: Session;
  await t.test('contacts rename, reload, and fork into a group while retaining the source', async () => {
    source = await request<Session>('/api/import', 'POST', {
      backend: 'codex', nativeSessionId: 'demo-api-source', title: '独立来源', cwd: directory,
    }, 201);
    const title = '新的名称 · `literal` $(literal)';
    await request(`/api/sessions/${source.id}`, 'PATCH', { title });
    const reloaded = await request<AppState>('/api/state');
    assert.equal(reloaded.sessions.find(s => s.id === source.id)?.title, title);
    group = await request<Group>('/api/groups', 'POST', { title: '跨后端功能组', goal: '分别实现与审查' }, 201);
    const fork = await request<Session>(`/api/sessions/${source.id}/fork`, 'POST', { title: '群内分支', groupId: group.id }, 201);
    assert.notEqual(fork.id, source.id);
    assert.notEqual(fork.nativeSessionId, source.nativeSessionId);
    assert.equal(fork.parentId, source.id);
    assert.equal(fork.groupId, group.id);
    assert.equal(fork.origin, 'forked');
    const original = (await request<AppState>('/api/state')).sessions.find(s => s.id === source.id)!;
    assert.equal(original.groupId, null);
    assert.equal(original.nativeSessionId, source.nativeSessionId);
    member = await request<Session>('/api/sessions', 'POST', { backend: 'codex', title: '群内实现', cwd: directory, groupId: group.id }, 201);
    reviewer = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: '群内审查', cwd: directory, groupId: group.id }, 201);
  });

  await t.test('invalid group recipients and source attribution cannot create partial messages', async () => {
    const before = await request<GroupDetail>(`/api/groups/${group.id}`);
    await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: '不应投递', recipientIds: [member.id, source.id] }, 400);
    await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'result', text: '无效来源', recipientIds: [], senderId: source.id }, 400);
    await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: '无效收件人', recipientIds: [member.id, {}] }, 400);
    assert.deepEqual(await request<GroupDetail>(`/api/groups/${group.id}`), before);
  });

  let firstTerminal: Awaited<ReturnType<typeof terminal>>;
  let secondTerminal: Awaited<ReturnType<typeof terminal>>;
  await t.test('real demo PTY output, reconnection, and input stay attached to the chosen contact', async () => {
    await request(`/api/sessions/${member.id}/start`, 'POST');
    await request(`/api/sessions/${reviewer.id}/start`, 'POST');
    firstTerminal = await terminal(member.id);
    secondTerminal = await terminal(reviewer.id);
    await until(() => firstTerminal.output.includes('本地演示终端') && secondTerminal.output.includes('本地演示终端'), 'Both demo terminals should be ready');
    firstTerminal.socket.send(JSON.stringify({ type: 'input', data: 'private-first-contact\r' }));
    await until(() => firstTerminal.output.includes('已收到演示输入：private-first-contact'), 'First terminal did not receive private input');
    assert.equal(secondTerminal.output.includes('private-first-contact'), false);
    const reconnected = await terminal(member.id);
    await until(() => reconnected.output.includes('private-first-contact'), 'Reconnected terminal should replay the same session');
    reconnected.socket.close();
    await request(`/api/sessions/${member.id}`, 'PATCH', { archived: true }, 400);
  });

  await t.test('a selected group task stages once and reaches the demo only after user submission', async () => {
    const message = await request<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', {
      kind: 'task', text: 'group-task-token\nsecond line\u001b[31m', recipientIds: [member.id, member.id],
    }, 201);
    const detail = await request<GroupDetail>(`/api/groups/${group.id}`);
    const deliveries = detail.deliveries.filter(d => d.messageId === message.id);
    assert.equal(deliveries.length, 1);
    const delivery = deliveries[0]!;
    const staged = await request<Delivery>(`/api/deliveries/${delivery.id}/send`, 'POST');
    assert.equal(staged.status, 'staged');
    await request(`/api/deliveries/${delivery.id}/send`, 'POST', undefined, 400);
    await request(`/api/deliveries/${delivery.id}/cancel`, 'POST', undefined, 400);
    await until(() => firstTerminal.output.includes('group-task-token'), 'Task should be visible in the chosen terminal');
    // PTY line discipline echoes staged text; the demo process must not receive a complete line yet.
    const beforeEnter = firstTerminal.output.slice(firstTerminal.output.indexOf('private-first-contact'));
    assert.equal(/已收到演示输入：[^\r\n]*group-task-token/.test(beforeEnter), false);
    assert.equal(secondTerminal.output.includes('group-task-token'), false);
    firstTerminal.socket.send(JSON.stringify({ type: 'input', data: '\r' }));
    await until(() => /已收到演示输入：[^\r\n]*group-task-token/.test(firstTerminal.output), 'Enter should submit the staged task');
    assert.equal(secondTerminal.output.includes('group-task-token'), false);
    const recorded = await request<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', {
      kind: 'result', senderId: member.id, text: '已完成，交给审查成员', recipientIds: [reviewer.id],
    }, 201);
    assert.equal(recorded.senderId, member.id);
    assert.deepEqual(recorded.recipientIds, [reviewer.id]);
  });

  await t.test('invalid WebSocket tokens are denied without losing the HTTP service', async () => {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/${member.id}?token=invalid`, { origin: base });
    sockets.push(denied);
    denied.on('error', () => {});
    const code = await new Promise<number>((accept, reject) => {
      denied.once('unexpected-response', (_req, response) => { response.resume(); accept(response.statusCode ?? 0); });
      denied.once('open', () => reject(new Error('Invalid terminal token was accepted')));
    });
    assert.equal(code, 403);
    assert.equal((await request<AppState>('/api/state')).demo, true);
  });

  await t.test('stop and archive preserve the contact and leave no phantom live state', async () => {
    await request(`/api/sessions/${member.id}/stop`, 'POST');
    await request(`/api/sessions/${reviewer.id}/stop`, 'POST');
    const archived = await request<Session>(`/api/sessions/${member.id}`, 'PATCH', { archived: true });
    assert.equal(archived.archived, true);
    assert.equal(archived.running, false);
    await request(`/api/sessions/${member.id}/start`, 'POST', undefined, 400);
    const state = await request<AppState>('/api/state');
    assert.equal(state.sessions.find(s => s.id === reviewer.id)?.running, false);
    assert.equal(state.sessions.find(s => s.id === member.id)?.archived, true);
    await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: '归档成员不可接收', recipientIds: [member.id] }, 400);
  });
});
