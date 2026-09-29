import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { CodexBridge } from './codex.ts';
import { CodexChatState, nativeChatAnswer, nativeChatRequest } from './codex-chat.ts';

type Message = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
async function until(check: () => boolean) { for (let i = 0; i < 150; i++) { if (check()) return; await delay(5); } assert.fail('Native chat fixture did not reach expected state'); }
async function fixture(t: test.TestContext) {
  const threadId = randomUUID(), turnId = randomUUID(), server = new WebSocketServer({ port: 0 });
  const sockets = new Set<WebSocket>(), calls: { message: Message; socket: WebSocket }[] = [];
  let observer: WebSocket | undefined;
  let thread: Record<string, unknown> = { id: threadId, cwd: '/tmp', status: { type: 'idle' }, turns: [] };
  let intercept: ((socket: WebSocket, message: Message) => boolean) | undefined;
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Message;
      calls.push({ message, socket });
      if (!message.method || message.id === undefined) return;
      if (message.method === 'thread/resume') observer = socket;
      if (intercept?.(socket, message)) return;
      const result = message.method === 'thread/read' || message.method === 'thread/resume' ? { thread } : message.method === 'turn/start' ? { turn: { id: turnId, status: 'inProgress', items: [] } } : {};
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise<void>(accept => server.once('listening', accept));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const bridge = new CodexBridge({ manageProcess: false, remoteUrl: `ws://127.0.0.1:${address.port}`, remoteToken: 'chat-fixture' });
  t.after(async () => { await bridge.close(); for (const socket of sockets) socket.terminate(); await new Promise<void>(accept => server.close(() => accept())); });
  return { threadId, turnId, bridge, calls,
    observer: () => { assert.ok(observer); return observer; },
    setThread: (next: Record<string, unknown>) => { thread = next; },
    intercept: (handler?: typeof intercept) => { intercept = handler; },
    send: async (method: string, params: Record<string, unknown>, id?: string | number) => { assert.ok(observer); observer.send(JSON.stringify({ method, params: { threadId, ...params }, ...(id !== undefined ? { id } : {}) })); await delay(10); },
  };
}

test('Codex graphical read never resumes; prompt keeps its observer and streams native items', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await assert.rejects(bridge.readChat(threadId), /先打开/);
  assert.equal(f.calls.length, 0);
  await bridge.start();
  assert.equal((await bridge.readChat(threadId)).connected, false);
  assert.equal(f.calls.some(call => call.message.method === 'thread/resume'), false);
  await bridge.openSession(threadId, '/tmp');
  const changes: number[] = [];
  const unsubscribe = bridge.onChat((id, snapshot) => { assert.equal(id, threadId); changes.push(snapshot.revision); });
  t.after(unsubscribe);
  assert.deepEqual(await bridge.sendPrompt(threadId, '修复当前按钮'), { turnId });
  const start = f.calls.find(call => call.message.method === 'turn/start')!;
  assert.equal(start.socket, f.observer());
  assert.deepEqual(start.message.params, { threadId, input: [{ type: 'text', text: '修复当前按钮', text_elements: [] }] });
  await assert.rejects(bridge.sendPrompt(threadId, 'duplicate'), /仍在执行/);
  await f.send('item/started', { turnId, item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '修复当前按钮' }] } });
  await f.send('item/started', { turnId, item: { id: 'answer', type: 'agentMessage', text: '' } });
  await f.send('item/agentMessage/delta', { turnId, itemId: 'answer', delta: '正在检查' });
  await f.send('item/agentMessage/delta', { turnId, itemId: 'answer', delta: '按钮。' });
  await f.send('item/started', { turnId, item: { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'inProgress' } });
  await f.send('item/commandExecution/outputDelta', { turnId, itemId: 'cmd', delta: 'PASS\n' });
  await f.send('item/completed', { turnId, item: { id: 'cmd', type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'PASS\n' } });
  await f.send('item/fileChange/patchUpdated', { turnId, itemId: 'file', changes: [{ path: 'app.ts', kind: { type: 'update' }, diff: '-broken\n+fixed' }] });
  await f.send('turn/plan/updated', { turnId, explanation: '修复计划', plan: [{ step: '测试', status: 'completed' }] });
  await f.send('item/started', { turnId, item: { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'inProgress', arguments: { query: 'button' } } });
  await f.send('item/mcpToolCall/progress', { turnId, itemId: 'mcp', message: '已找到文档' });
  assert.equal(bridge.chatSnapshot(threadId)!.items.find(item => item.id === 'mcp')?.output, '已找到文档');
  await f.send('item/completed', { turnId, item: { id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { query: 'button' }, result: { content: [{ type: 'text', text: '文档结果' }] } } });
  await f.send('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', text: '已修复。' } });
  await f.send('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } });
  const view = bridge.chatSnapshot(threadId)!;
  assert.equal(view.connected, true); assert.equal(view.activeTurnId, null);
  assert.equal(view.items.find(item => item.id === 'answer')?.text, '已修复。');
  assert.equal(view.items.find(item => item.id === 'cmd')?.output, 'PASS\n');
  assert.equal(view.items.find(item => item.id === 'file')?.output, 'app.ts\n-broken\n+fixed');
  assert.ok(view.items.some(item => item.type === 'plan' && item.text.includes('✓ 测试')));
  assert.ok(changes.length >= 10); assert.ok(changes.every((value, index) => index === 0 || value > changes[index - 1]));
});

test('Codex native approval is explicit, bound to one observer and claimed once across tabs', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('item/commandExecution/requestApproval', { turnId, itemId: 'cmd', command: 'npm test', cwd: '/tmp', reason: '需要运行测试', availableDecisions: ['accept', 'decline'] }, 90);
  const request = bridge.chatSnapshot(threadId)!.requests[0];
  assert.equal(request.kind, 'approval'); assert.equal(request.options?.length, 2);
  assert.equal(f.calls.filter(call => !call.message.method).length, 0);
  await assert.rejects(bridge.answerChatRequest(randomUUID(), request.id, { decision: request.options![0].id }), /失效/);
  await assert.rejects(bridge.answerChatRequest(threadId, request.id, { decision: 'acceptForSession' }), /当前原生请求/);
  await assert.rejects(bridge.sendPrompt(threadId, 'while waiting'), /等待答复/);
  const answers = await Promise.allSettled([bridge.answerChatRequest(threadId, request.id, { decision: request.options![0].id }), bridge.answerChatRequest(threadId, request.id, { decision: request.options![0].id })]);
  assert.equal(answers.filter(answer => answer.status === 'fulfilled').length, 1);
  await until(() => f.calls.some(call => call.message.id === 90 && !call.message.method));
  assert.deepEqual(f.calls.filter(call => call.message.id === 90 && !call.message.method).map(call => call.message.result), [{ decision: 'accept' }]);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0);
  await f.send('item/commandExecution/requestApproval', { turnId, itemId: 'cmd', command: 'npm test', availableDecisions: ['accept', 'decline'] }, 90);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0, 'Replayed request cannot resurrect an already submitted answer');
  await f.send('serverRequest/resolved', { requestId: 90 });
  await f.send('item/fileChange/requestApproval', { turnId, itemId: 'file', reason: '修改文件' }, 'other-client');
  const other = bridge.chatSnapshot(threadId)!.requests[0];
  await f.send('serverRequest/resolved', { requestId: 'other-client' });
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0);
  await assert.rejects(bridge.answerChatRequest(threadId, other.id, { decision: 'decision-0' }), /失效/);
});

test('Codex question and permission replies use only native offered fields', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('item/tool/requestUserInput', { turnId, itemId: 'question', isBlocking: true, questions: [{ id: 'choice', header: '选择', question: '选择哪一种？', isOther: false, isSecret: false, options: [{ label: 'A', description: '第一种' }, { label: 'B', description: '第二种' }] }, { id: 'detail', header: '说明', question: '补充内容', isOther: true, isSecret: false, options: null }] }, 'question-1');
  const request = bridge.chatSnapshot(threadId)!.requests[0];
  await assert.rejects(bridge.answerChatRequest(threadId, request.id, { answers: { choice: ['C'], detail: ['补充'] } }), /选项/);
  await assert.rejects(bridge.answerChatRequest(threadId, request.id, { answers: { choice: ['A'] } }), /完整/);
  await bridge.answerChatRequest(threadId, request.id, { answers: { choice: ['B'], detail: ['我的补充'] } });
  await until(() => f.calls.some(call => call.message.id === 'question-1' && !call.message.method));
  assert.deepEqual(f.calls.find(call => call.message.id === 'question-1' && !call.message.method)!.message.result, { answers: { choice: { answers: ['B'] }, detail: { answers: ['我的补充'] } } });
  await f.send('item/permissions/requestApproval', { turnId, itemId: 'permissions', cwd: '/tmp', reason: '网络访问', permissions: { network: { enabled: true }, fileSystem: null } }, 91);
  const permissions = bridge.chatSnapshot(threadId)!.requests[0];
  await bridge.answerChatRequest(threadId, permissions.id, { decision: permissions.options![0].id });
  await until(() => f.calls.some(call => call.message.id === 91 && !call.message.method));
  assert.deepEqual(f.calls.find(call => call.message.id === 91 && !call.message.method)!.message.result, { permissions: { network: { enabled: true } }, scope: 'turn' });
});

test('Codex unsupported requests remain visible, stop interrupts, and disconnect invalidates replies', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('turn/started', { turn: { id: turnId, status: 'inProgress' } });
  await f.send('mcpServer/elicitation/request', { turnId, serverName: 'fixture' }, 'unsupported');
  const unsupported = bridge.chatSnapshot(threadId)!.requests[0];
  assert.equal(unsupported.kind, 'unsupported');
  await assert.rejects(bridge.answerChatRequest(threadId, unsupported.id, {}), /暂不支持/);
  await bridge.stopSession(threadId);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0);
  assert.equal(bridge.chatSnapshot(threadId)!.activeTurnId, null);
  assert.deepEqual(f.calls.find(call => call.message.method === 'turn/interrupt')!.message.params, { threadId, turnId });
  await f.send('item/fileChange/requestApproval', { turnId, itemId: 'file' }, 'disconnected');
  const pending = bridge.chatSnapshot(threadId)!.requests[0];
  f.observer().terminate();
  await until(() => bridge.chatSnapshot(threadId)?.connected === false);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 0);
  await assert.rejects(bridge.answerChatRequest(threadId, pending.id, { decision: 'decision-0' }), /失效/);
  assert.equal(f.calls.some(call => !call.message.method), false);
});

test('Codex history read reconciles live deltas without overwriting completed output', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  await bridge.openSession(threadId);
  await f.send('turn/started', { turn: { id: turnId, status: 'inProgress' } });
  await f.send('item/started', { turnId, item: { id: 'a', type: 'agentMessage', text: 'old' } });
  let release: (() => void) | undefined;
  f.intercept((socket, message) => {
    if (message.method !== 'thread/read') return false;
    release = () => socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, turns: [{ id: turnId, status: 'inProgress', items: [{ type: 'agentMessage', id: 'a', text: 'old' }] }] } } }));
    return true;
  });
  const reading = bridge.readChat(threadId);
  await until(() => !!release);
  await f.send('item/agentMessage/delta', { turnId, itemId: 'a', delta: ' + live' });
  await f.send('item/completed', { turnId, item: { id: 'a', type: 'agentMessage', text: 'final answer' } });
  await f.send('turn/completed', { turn: { id: turnId, status: 'completed' } });
  release!();
  const result = await reading;
  assert.equal(result.items[0].text, 'final answer'); assert.equal(result.items[0].status, 'completed'); assert.equal(result.activeTurnId, null);
  await f.send('item/agentMessage/delta', { turnId, itemId: 'a', delta: ' stale' });
  assert.equal(bridge.chatSnapshot(threadId)!.items[0].text, 'final answer');
});

test('Codex replays approval during resume and does not resurrect turns completed before send acknowledgment', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  f.intercept((socket, message) => {
    if (message.method === 'thread/resume') socket.send(JSON.stringify({ id: 'resume-approval', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: 'file' } }));
    if (message.method !== 'turn/start') return false;
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: turnId } } }));
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }));
    socket.send(JSON.stringify({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } }));
    return true;
  });
  await bridge.openSession(threadId);
  assert.equal(bridge.chatSnapshot(threadId)!.requests.length, 1);
  await f.send('serverRequest/resolved', { requestId: 'resume-approval' });
  await bridge.sendPrompt(threadId, 'fast response');
  assert.equal(bridge.chatSnapshot(threadId)!.activeTurnId, null);
  assert.equal((await bridge.getStatus(threadId)).status, 'waiting_input');
});

test('Codex distinguishes rejected turn starts from a connection lost after dispatch', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.openSession(threadId);
  f.intercept((socket, message) => { if (message.method !== 'turn/start') return false; socket.send(JSON.stringify({ id: message.id, error: { code: -1, message: 'fixture rejection' } })); return true; });
  await assert.rejects(bridge.sendPrompt(threadId, 'rejected'), error => (error as Error & { deliveryUnknown: boolean }).deliveryUnknown === false);
  f.intercept((socket, message) => { if (message.method !== 'turn/start') return false; socket.terminate(); return true; });
  await assert.rejects(bridge.sendPrompt(threadId, 'uncertain'), error => (error as Error & { deliveryUnknown: boolean }).deliveryUnknown === true);
});

test('a turn completed during resume wins over the older resume response for chat and native status', async t => {
  const f = await fixture(t), { bridge, threadId, turnId } = f;
  const statuses: string[] = [];
  const remove = bridge.onStatus((_id, event) => statuses.push(event.status)); t.after(remove);
  f.intercept((socket, message) => {
    if (message.method !== 'thread/resume') return false;
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: turnId } } }));
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }));
    socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, status: { type: 'active' }, turns: [{ id: turnId, status: 'inProgress', items: [] }] } } }));
    return true;
  });
  await bridge.openSession(threadId);
  assert.equal(bridge.chatSnapshot(threadId)!.activeTurnId, null);
  assert.equal(statuses.at(-1), 'waiting_input');
});

test('concurrent graph opens share an in-flight native resume and cannot submit before it finishes', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  let release: (() => void) | undefined;
  f.intercept((socket, message) => {
    if (message.method !== 'thread/resume') return false;
    release = () => socket.send(JSON.stringify({ id: message.id, result: { thread: { id: threadId, turns: [], status: { type: 'idle' } } } }));
    return true;
  });
  const first = bridge.openSession(threadId);
  await until(() => !!release);
  let secondDone = false;
  const second = bridge.openSession(threadId).then(() => { secondDone = true; });
  await delay(15);
  assert.equal(secondDone, false);
  await assert.rejects(bridge.sendPrompt(threadId, 'too early'), /连接/);
  release!(); await Promise.all([first, second]);
  assert.equal(f.calls.filter(call => call.message.method === 'thread/resume').length, 1);
  assert.equal(bridge.chatSnapshot(threadId)!.connected, true);
});

test('a read racing an intentional stop cannot restart the native server or create a new socket', async t => {
  const f = await fixture(t), { bridge, threadId } = f;
  await bridge.start();
  const before = f.calls.length;
  let starts = 0;
  const original = bridge.start.bind(bridge);
  bridge.start = async () => { starts++; await original(); };
  const reading = bridge.readChat(threadId);
  const stopped = bridge.stop();
  await assert.rejects(reading, /已停止/);
  await stopped;
  assert.equal(starts, 0);
  assert.equal(f.calls.length, before);
  assert.equal(bridge.remoteToken, null);
});

test('Codex view bounds items and tool output, keeps internal reasoning out and preserves later history snapshots', () => {
  const state = new CodexChatState(), id = randomUUID(), turnId = randomUUID();
  state.connected(id, true);
  for (let i = 0; i < 250; i++) state.event(id, 'item/completed', { turnId, item: { id: `a-${i}`, type: 'agentMessage', text: String(i) } });
  state.event(id, 'item/completed', { turnId, item: { id: 'private', type: 'reasoning', content: ['hidden'] } });
  assert.equal(state.get(id)!.items.length, 200); assert.equal(state.get(id)!.truncated, true);
  for (let i = 0; i < 12; i++) state.event(id, 'item/completed', { turnId, item: { id: `cmd-${i}`, type: 'commandExecution', command: 'cmd', aggregatedOutput: 'x'.repeat(100_000) } });
  assert.ok(state.get(id)!.items.every(item => (item.output?.length ?? 0) <= 64_000));
  assert.ok(state.get(id)!.items.reduce((sum, item) => sum + item.text.length + (item.output?.length ?? 0) + (item.title?.length ?? 0), 0) <= 512_000);
  const before = state.get(id)!.revision;
  state.reconcile(id, { id, turns: [{ id: turnId, status: 'completed', items: [{ type: 'agentMessage', id: 'same', text: 'newer history' }] }] }, before, true);
  state.reconcile(id, { id, turns: [{ id: turnId, status: 'inProgress', items: [{ type: 'agentMessage', id: 'same', text: 'old history' }] }] }, before, true);
  assert.equal(state.get(id)!.items.find(item => item.id === 'same')?.text, 'newer history');
  assert.equal(state.get(id)!.activeTurnId, null);
});

test('native permission rejection cannot accept arbitrary grant JSON or an unoffered decision', () => {
  const request = nativeChatRequest('item/permissions/requestApproval', 1, { permissions: { network: { enabled: true }, fileSystem: null } });
  assert.deepEqual(nativeChatAnswer(request, { decision: 'decision-2' }), { permissions: {}, scope: 'turn' });
  assert.throws(() => nativeChatAnswer(request, { decision: 'accept' }), /当前原生请求/);
  const huge = nativeChatRequest('item/permissions/requestApproval', 2, { permissions: { fileSystem: { read: ['x'.repeat(130_000)] } } });
  assert.equal(huge.view.kind, 'unsupported'); assert.equal(huge.decisions.size, 0);
});
