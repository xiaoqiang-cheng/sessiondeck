import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { AppState, Delivery, Group, GroupDetail, GroupMessage, Session } from '../shared/types.ts';
import type { CodexChatSnapshot, CodexChatSubmission } from '../shared/chat.ts';

async function freePort() {
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => probe.close(() => accept()));
  return address.port;
}
async function until(check: () => Promise<boolean>, description: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error(description);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  const kill = setTimeout(() => child.kill('SIGKILL'), 4000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(kill); }
}
type Call = { method?: string; event?: string; nativeId?: string; id?: string; params?: { threadId?: string; input?: unknown[] }; result?: unknown };

async function launch(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-chat-api-'));
  const executable = join(directory, 'codex.cjs');
  await copyFile(resolve('scripts/fixtures/codex-chat-protocol.cjs'), executable); await chmod(executable, 0o700);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: resolve('.'), env: { ...env, SESSIONDECK_PORT: String(port), SESSIONDECK_DEMO: '0', SESSIONDECK_DATA_DIR: join(directory, 'data'), SESSIONDECK_CODEX_PORT: '0', SESSIONDECK_CODEX_BIN: executable, SESSIONDECK_CLAUDE_BIN: '/missing-claude-fixture', SESSIONDECK_DSH_BIN: '/missing-dsh-fixture', SESSIONDECK_FIXTURE_DIR: directory, SESSIONDECK_FIXTURE_WS: createRequire(import.meta.url).resolve('ws'), CODEX_HOME: join(directory, 'codex-home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', data => { logs = (logs + data).slice(-8000); }); child.stderr?.on('data', data => { logs = (logs + data).slice(-8000); });
  const streams = new Set<AbortController>();
  t.after(async () => { for (const stream of streams) stream.abort(); await stop(child); await rm(directory, { recursive: true, force: true }); });
  await until(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(base + '/api/config')).ok; } catch { return false; } }, 'Fixture HTTP service did not start');
  const { csrfToken } = await (await fetch(base + '/api/config')).json() as { csrfToken: string };
  const request = async <T>(path: string, method = 'GET', data?: unknown, expected: number | number[] = 200): Promise<T> => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-sessiondeck-token': csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(12_000) });
    const result = await response.json();
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${path} returned ${response.status}: ${JSON.stringify(result)}`);
    return result as T;
  };
  const calls = async (): Promise<Call[]> => (await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const stream = async (id: string) => {
    const controller = new AbortController(); streams.add(controller);
    const response = await fetch(`${base}/api/sessions/${id}/chat/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const result = { text: '' };
    void (async () => { const reader = response.body!.getReader(); try { for (;;) { const data = await reader.read(); if (data.done) break; result.text += new TextDecoder().decode(data.value); } } catch { /* Test cleanup aborts open SSE. */ } finally { reader.releaseLock(); } })();
    return result;
  };
  const create = (title: string) => request<Session>('/api/sessions', 'POST', { backend: 'codex', title, cwd: directory }, 201);
  const snapshot = (id: string) => request<CodexChatSnapshot>(`/api/sessions/${id}/chat`);
  const current = async (id: string) => (await request<AppState>('/api/state')).sessions.find(session => session.id === id)!;
  return { directory, request, calls, stream, create, snapshot, current };
}

test('graphical Codex starts without a TUI, streams once per request ID, and attaches the exact native thread', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, calls, snapshot } = fixture;
  const source = await fixture.create('Graphical native source');
  assert.equal((await snapshot(source.id)).connected, false);
  const events = await fixture.stream(source.id);
  assert.equal((await calls()).filter(call => call.method === 'thread/start').length, 0, 'Reading the panel must not start an agent');
  const started = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  assert.ok(started.nativeSessionId); assert.equal(started.running, true);
  assert.equal((await calls()).filter(call => call.event === 'tui').length, 0);
  const requestId = randomUUID(), text = 'Verify exact native graphical thread';
  const simultaneous = await Promise.all([1, 2].map(() => request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId, text }, [200, 202])));
  const submitted = simultaneous.find(result => result.status === 'accepted');
  assert.ok(submitted?.turnId);
  assert.ok(simultaneous.every(result => result.status === 'accepted' || result.status === 'sending'));
  assert.deepEqual(await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId, text }), submitted);
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId, text: 'Conflicting retry must not execute' }, 409);
  await until(async () => (await snapshot(source.id)).items.some(item => item.type === 'assistant' && item.text.includes(text)), 'Assistant stream did not reach graphical snapshot');
  await until(async () => events.text.includes('Reply: ' + text), 'Assistant stream did not reach SSE');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, 1);
  assert.equal((await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/submissions/${requestId}`)).status, 'accepted');
  assert.equal((await fixture.current(source.id)).lastUserInput, text);
  const attached = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'terminal' });
  assert.equal(attached.nativeSessionId, started.nativeSessionId);
  await until(async () => (await calls()).some(call => call.event === 'tui' && call.nativeId === started.nativeSessionId), 'TUI did not attach the graphical native thread');
  assert.equal((await calls()).filter(call => call.method === 'thread/start').length, 1);
  const sourceHistory = (await snapshot(source.id)).items;
  const child = await request<Session>(`/api/sessions/${source.id}/fork`, 'POST', { title: 'Graphical child' }, 201);
  assert.notEqual(child.nativeSessionId, started.nativeSessionId);
  await request(`/api/sessions/${child.id}/start`, 'POST', { mode: 'chat' });
  assert.ok((await snapshot(child.id)).items.some(item => item.text.includes(text)), 'Fork must inherit the native context');
  await request(`/api/sessions/${child.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Child correction' });
  await until(async () => (await snapshot(child.id)).items.some(item => item.text === 'Reply: Child correction'), 'Fork could not continue in graphical mode');
  assert.deepEqual((await snapshot(source.id)).items, sourceHistory);
});

test('graphical approvals and questions validate opaque handles; interrupt keeps the native session available', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, calls, snapshot } = fixture;
  const source = await fixture.create('Graphical approval source');
  await request(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'APPROVAL' });
  await until(async () => (await snapshot(source.id)).requests.length === 1, 'Native approval did not reach the panel');
  const approval = (await snapshot(source.id)).requests[0];
  assert.equal(approval.kind, 'approval');
  await request(`/api/sessions/${source.id}/chat/requests/${approval.id}`, 'POST', { decision: 'invented-permission' }, [400, 409]);
  assert.equal((await calls()).filter(call => call.event === 'answer').length, 0);
  const decline = approval.options?.find(option => /拒绝|decline|deny/i.test(option.label)); assert.ok(decline);
  await request(`/api/sessions/${source.id}/chat/requests/${approval.id}`, 'POST', { decision: decline.id });
  await until(async () => (await snapshot(source.id)).activeTurnId === null, 'Approval response did not finish its native turn');
  assert.deepEqual((await calls()).find(call => call.event === 'answer')?.result, { decision: 'decline' });
  await request(`/api/sessions/${source.id}/chat/requests/${approval.id}`, 'POST', { decision: decline.id }, [400, 404, 409]);
  assert.equal((await calls()).filter(call => call.event === 'answer').length, 1);
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'QUESTION' });
  await until(async () => (await snapshot(source.id)).requests.some(request => request.kind === 'question'), 'Native question did not reach the panel');
  const question = (await snapshot(source.id)).requests[0];
  await request(`/api/sessions/${source.id}/chat/requests/${question.id}`, 'POST', { answers: { other: ['One'] } }, [400, 409]);
  await request(`/api/sessions/${source.id}/chat/requests/${question.id}`, 'POST', { answers: { choice: ['Two'] } });
  await until(async () => (await snapshot(source.id)).activeTurnId === null, 'Question response did not finish');
  assert.deepEqual((await calls()).filter(call => call.event === 'answer').at(-1)?.result, { answers: { choice: { answers: ['Two'] } } });
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'HOLD' });
  assert.ok((await snapshot(source.id)).activeTurnId);
  const busyRequest = { requestId: randomUUID(), text: 'Must not overtake the active native turn' };
  const busyReply = await request<CodexChatSubmission & { code: string }>(`/api/sessions/${source.id}/chat/messages`, 'POST', busyRequest, 409);
  assert.equal(busyReply.code, 'CHAT_REJECTED');
  assert.equal((await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/submissions/${busyRequest.requestId}`)).status, 'rejected');
  const turnsBeforeRetry = (await calls()).filter(call => call.method === 'turn/start').length;
  assert.equal((await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', busyRequest)).status, 'rejected');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBeforeRetry);
  await request(`/api/sessions/${source.id}/chat/interrupt`, 'POST', {});
  await until(async () => (await snapshot(source.id)).activeTurnId === null, 'Interrupt did not end the turn');
  assert.equal((await fixture.current(source.id)).running, true, 'Interrupt must retain the connected session');
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Continue after interrupt' });
  await until(async () => (await snapshot(source.id)).items.some(item => item.text === 'Reply: Continue after interrupt'), 'Session was not usable after interrupt');
});

test('a lost native submit response stays unknown and the same request ID never resends', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, calls } = fixture;
  const source = await fixture.create('Ambiguous graphical submission');
  await request(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  const body = { requestId: randomUUID(), text: 'DROP_RESPONSE' };
  const result = await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', body, 202);
  assert.equal(result.status, 'unknown');
  assert.equal((await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/submissions/${body.requestId}`)).status, 'unknown');
  const retried = await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', body, 202);
  assert.equal(retried.status, 'unknown');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, 1);
});

test('a graphical group member stops and resumes its exact history, then receives a task without terminal staging', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, calls, snapshot, current } = fixture;
  const group = await request<Group>('/api/groups', 'POST', { title: 'Graphical group lifecycle', goal: 'Preserve native context and deliver directly' }, 201);
  const member = await request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Graphical group member', cwd: fixture.directory, groupId: group.id }, 201);
  const started = await request<Session>(`/api/sessions/${member.id}/start`, 'POST', { mode: 'chat' });
  assert.ok(started.nativeSessionId);
  await request(`/api/sessions/${member.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Remember the original graphical context' });
  await until(async () => !(await snapshot(member.id)).activeTurnId && (await snapshot(member.id)).items.some(item => item.text === 'Reply: Remember the original graphical context'), 'Original native history did not finish');
  const original = (await snapshot(member.id)).items;
  const stopped = await request<Session>(`/api/sessions/${member.id}/stop`, 'POST', {});
  assert.equal(stopped.running, false); assert.equal(stopped.nativeSessionId, started.nativeSessionId);
  assert.equal((await current(member.id)).running, false);
  assert.equal((await snapshot(member.id)).connected, false);
  const turnsBefore = (await calls()).filter(call => call.method === 'turn/start').length;
  await request(`/api/sessions/${member.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Stopped sessions must not receive prompts' }, 409);
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBefore);

  const resumed = await request<Session>(`/api/sessions/${member.id}/start`, 'POST', { mode: 'chat' });
  assert.equal(resumed.running, true); assert.equal(resumed.nativeSessionId, started.nativeSessionId);
  assert.deepEqual((await snapshot(member.id)).items, original);
  await request(`/api/sessions/${member.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Continue the same graphical context' });
  await until(async () => !(await snapshot(member.id)).activeTurnId && (await snapshot(member.id)).items.some(item => item.text === 'Reply: Continue the same graphical context'), 'Resumed session could not continue');
  const task = await request<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: 'Please verify the shared task in graphical mode', recipientIds: [member.id] }, 201);
  const detail = await request<GroupDetail>(`/api/groups/${group.id}`);
  const delivery = detail.deliveries.find(delivery => delivery.messageId === task.id && delivery.sessionId === member.id)!;
  assert.ok(delivery); assert.equal(delivery.status, 'pending');
  const sent = await request<Delivery>(`/api/deliveries/${delivery.id}/send`, 'POST', {});
  assert.equal(sent.status, 'sent');
  await until(async () => !(await snapshot(member.id)).activeTurnId && (await snapshot(member.id)).items.some(item => item.type === 'assistant' && item.text.includes(task.text)), 'Group task did not complete through the native graphical turn');
  const nativeCalls = await calls();
  assert.equal(nativeCalls.filter(call => call.event === 'tui').length, 0, 'Graphical group delivery unexpectedly launched a terminal');
  assert.equal(nativeCalls.filter(call => call.method === 'thread/start').length, 1, 'Stop/resume or group delivery created a replacement native thread');
  assert.equal(nativeCalls.filter(call => call.method === 'turn/start').length, turnsBefore + 2);
  assert.ok(nativeCalls.filter(call => call.method === 'turn/start').every(call => call.params?.threadId === started.nativeSessionId));
  const after = await request<GroupDetail>(`/api/groups/${group.id}`);
  assert.equal(after.deliveries.find(item => item.id === delivery.id)?.status, 'sent');
  await request(`/api/deliveries/${delivery.id}/send`, 'POST', {}, 400);
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBefore + 2, 'Already delivered group task executed twice');

  const terminal = await request<Session>(`/api/sessions/${member.id}/start`, 'POST', { mode: 'terminal' });
  assert.equal(terminal.interactionMode, 'terminal'); assert.equal(terminal.nativeSessionId, started.nativeSessionId);
  await until(async () => (await calls()).filter(call => call.event === 'tui').length === 1, 'TUI did not attach before returning to chat');
  const graphical = await request<Session>(`/api/sessions/${member.id}/start`, 'POST', { mode: 'chat' });
  assert.equal(graphical.interactionMode, 'chat'); assert.equal(graphical.nativeSessionId, started.nativeSessionId);
  const secondTask = await request<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: 'Returning to chat must send directly even while a TUI is attached', recipientIds: [member.id] }, 201);
  const secondDetail = await request<GroupDetail>(`/api/groups/${group.id}`);
  const secondDelivery = secondDetail.deliveries.find(delivery => delivery.messageId === secondTask.id)!;
  assert.equal((await request<Delivery>(`/api/deliveries/${secondDelivery.id}/send`, 'POST', {})).status, 'sent');
  await until(async () => !(await snapshot(member.id)).activeTurnId && (await snapshot(member.id)).items.some(item => item.type === 'assistant' && item.text.includes(secondTask.text)), 'Returning to chat incorrectly staged the group task in the existing TUI');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBefore + 3);
  assert.equal((await calls()).filter(call => call.method === 'thread/start').length, 1);
  assert.equal((await calls()).filter(call => call.event === 'tui').length, 1);
});
