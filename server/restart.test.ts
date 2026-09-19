import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { AppState, Group, GroupDetail, GroupMessage, Session } from '../shared/types.ts';

test('a real service restart preserves contacts and queued handoffs, invalidates old tokens, and never auto-starts agents', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-restart-'));
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  const port = address.port, base = `http://127.0.0.1:${port}`;
  await new Promise<void>(accept => probe.close(() => accept()));
  const children: ChildProcess[] = [];
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(accept => child.once('exit', () => accept()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(timer); }
  }
  t.after(async () => { await Promise.all(children.map(stop)); await rm(directory, { recursive: true, force: true }); });
  async function start() {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(port), SESSIONDECK_PORT: String(port), SESSIONDECK_DEMO: '1', SESSIONDECK_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let logs = ''; child.stdout?.on('data', chunk => { logs = (logs + chunk).slice(-8000); }); child.stderr?.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(logs);
      try {
        const response = await fetch(`${base}/api/config`);
        if (response.ok) return { child, token: (await response.json() as { csrfToken: string }).csrfToken };
      } catch { /* not listening yet */ }
      await delay(30);
    }
    throw new Error(`Service did not start: ${logs}`);
  }
  let live = await start();
  async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', 'x-sessiondeck-token': live.token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result as T;
  }
  const group = await request<Group>('/api/groups', { title: 'Persistent group', goal: 'Resume local work' });
  const item = await request<Session>('/api/sessions', { backend: 'codex', title: 'Persistent member', cwd: directory, groupId: group.id });
  await request(`/api/sessions/${item.id}/start`, {});
  await request(`/api/sessions/${item.id}`, { title: 'Renamed member', pinned: true }, 'PATCH');
  const result = await request<GroupMessage>(`/api/groups/${group.id}/messages`, { kind: 'result', text: 'Saved member result', senderId: item.id });
  await request(`/api/groups/${group.id}/messages`, { kind: 'task', text: 'Continue this result', sourceMessageId: result.id, recipientIds: [item.id] });
  const before = await request<GroupDetail>(`/api/groups/${group.id}`);
  const oldToken = live.token;
  const oldState = await request<AppState>('/api/state');
  const nextState = await request<AppState>('/api/state');
  assert.equal(nextState.instanceId, oldState.instanceId);
  assert.ok(nextState.revision! > oldState.revision!);
  await stop(live.child);
  live = await start();
  assert.notEqual(live.token, oldToken);
  const state = await request<AppState>('/api/state');
  assert.notEqual(state.instanceId, oldState.instanceId);
  const recovered = state.sessions.find(session => session.id === item.id)!;
  assert.equal(recovered.title, 'Renamed member'); assert.equal(recovered.pinned, true);
  assert.equal(recovered.groupId, group.id); assert.equal(recovered.running, false);
  assert.equal(recovered.status, 'unknown'); assert.ok(state.sessions.every(session => !session.running));
  assert.deepEqual(await request<GroupDetail>(`/api/groups/${group.id}`), before);
  const stale = await fetch(`${base}/api/sessions/${item.id}/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-sessiondeck-token': oldToken }, body: '{}',
  });
  assert.equal(stale.status, 403);
  const resumed = await request<Session>(`/api/sessions/${item.id}/start`, {});
  assert.equal(resumed.id, item.id); assert.equal(resumed.running, true);
  assert.equal((await request<AppState>('/api/state')).sessions.length, state.sessions.length);
  await request(`/api/sessions/${item.id}/stop`, {});
});
