import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { ConversationReader, conversationPreview, type ConversationSession } from './conversation.ts';
import { DshBridge } from './dsh.ts';

const date = '2026-09-29T08:00:00.000Z';
function contact(backend: ConversationSession['backend'], id = randomUUID()): ConversationSession {
  return { backend, nativeSessionId: backend === 'dsh' ? `session-${id}` : id, forkPending: false, cwd: '/workspace/project' };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-conversation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex'), dshHome: join(root, 'dsh') };
  const file = async (session: ConversationSession, values: unknown[], compressed = false) => {
    const path = session.backend === 'claude' ? join(paths.claudeHome, 'projects', '-workspace-project', `${session.nativeSessionId}.jsonl`)
      : session.backend === 'codex' ? join(paths.codexHome, 'sessions', '2026', '09', '29', `rollout-${session.nativeSessionId}.jsonl`)
      : join(paths.dshHome, 'sessions', '--workspace-project--', session.nativeSessionId!, `session.jsonl${compressed ? '.zstd' : ''}`);
    await mkdir(join(path, '..'), { recursive: true });
    const content = values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n';
    await writeFile(path, compressed ? Buffer.concat(content.trimEnd().split('\n').map(line => zstdCompressSync(Buffer.from(line + '\n')))) : content);
    return path;
  };
  return { root, paths, file, reader: new ConversationReader({ ...paths, cacheMs: 0 }) };
}
function claude(role: 'user' | 'assistant', content: unknown, extra = {}) { return { type: role, uuid: randomUUID(), timestamp: date, message: { role, content }, ...extra }; }
function codexHeader(id: string) { return { type: 'session_meta', payload: { id, cwd: '/workspace/project' } }; }
function dshMessage(seq: number, role: 'user' | 'assistant', text: string, source = role === 'user' ? 'user' : 'model') {
  const message = { role, source: { kind: source }, content: [{ type: 'text', text }] };
  return { type: `${role}/message`, seq, time: Date.parse(date) + seq, surfaceOp: 'append', data: role === 'user' ? message : { turn: 1, step: seq, message } };
}

test('Claude conversation reads only exact native file and human/assistant text', async t => {
  const { file, reader } = await fixture(t), a = contact('claude'), b = contact('claude');
  await file(a, [
    claude('user', '请修复登录按钮'),
    claude('assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '我来检查。' }, { type: 'tool_use', input: { secret: 'hidden tool' } }]),
    claude('user', [{ type: 'tool_result', content: 'hidden result' }]),
    claude('user', 'hidden summary', { isCompactSummary: true }),
    claude('user', 'hidden meta', { isMeta: true }),
    claude('user', 'hidden agent', { isSidechain: true }),
    claude('user', 'hidden wrong identity', { sessionId: b.nativeSessionId }),
    claude('user', '<command-name>/clear</command-name>'),
    '{bad row',
    claude('user', [{ type: 'text', text: '然后增加键盘操作' }, { type: 'image', source: { data: 'hidden bytes' } }]),
    claude('assistant', '已完成。'),
  ]);
  await file(b, [claude('user', 'different session secret')]);
  const result = await reader.read(a);
  assert.deepEqual(result.messages.map(message => [message.role, message.text]), [['user', '请修复登录按钮'], ['assistant', '我来检查。'], ['user', '然后增加键盘操作'], ['assistant', '已完成。']]);
  assert.equal(result.truncated, false);
  assert.equal(result.messages[0].createdAt, date);
  assert.equal(await reader.preview(a), '然后增加键盘操作');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.equal((await reader.read(b)).messages[0].text, 'different session secret');
});

test('Codex uses native user events and excludes duplicate input, system, tools and model reasoning', async t => {
  const { file, reader } = await fixture(t), a = contact('codex');
  await file(a, [codexHeader(a.nativeSessionId!),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace\nsecret instructions' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实用户问题' }] } },
    { type: 'event_msg', timestamp: date, payload: { type: 'user_message', message: '真实用户问题' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'hidden reasoning' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'hidden output' } },
    { type: 'response_item', timestamp: date, payload: { id: 'answer-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已找到解决办法' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '已找到解决办法' } },
  ]);
  const result = await reader.read(a);
  assert.deepEqual(result.messages.map(message => message.text), ['真实用户问题', '已找到解决办法']);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[1].role, 'assistant');
});

test('legacy Codex user input fallback rejects AGENTS and environment context', async t => {
  const { file, reader } = await fixture(t), a = contact('codex');
  await file(a, [codexHeader(a.nativeSessionId!), ...['# AGENTS.md instructions for /tmp\nprivate', '<environment_context>private</environment_context>', '<permissions instructions>private</permissions instructions>', '实际用户输入'].map(text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }))]);
  assert.deepEqual((await reader.read(a)).messages.map(message => message.text), ['实际用户输入']);
});

test('Codex rejects mismatched rollout identity even when its filename names the requested session', async t => {
  const { file, reader } = await fixture(t), a = contact('codex');
  await file(a, [codexHeader(randomUUID()), { type: 'event_msg', payload: { type: 'user_message', message: 'other session secret' } }]);
  const result = await reader.read(a);
  assert.equal(result.messages.length, 0);
  assert.match(result.notice!, /身份不匹配/);
});

test('pending forks and malformed IDs cannot read their parent or arbitrary files', async t => {
  const { file, reader } = await fixture(t), a = contact('claude');
  await file(a, [claude('user', 'parent private request')]);
  assert.equal((await reader.read({ ...a, forkPending: true })).messages.length, 0);
  assert.equal((await reader.read({ ...a, nativeSessionId: '../../outside' })).messages.length, 0);
  assert.equal((await reader.read({ ...a, nativeSessionId: null })).messages.length, 0);
  assert.equal((await reader.read(a)).messages.length, 1);
});

test('native symlinks and Codex index paths outside its owned history are not followed', async t => {
  const { root, file, paths, reader } = await fixture(t), a = contact('claude'), codex = contact('codex');
  const outside = join(root, `${a.nativeSessionId}.jsonl`);
  await writeFile(outside, JSON.stringify(claude('user', 'outside secret')));
  const placeholder = await file(a, []);
  await rm(placeholder);
  await symlink(outside, placeholder);
  await mkdir(paths.codexHome, { recursive: true });
  const db = new DatabaseSync(join(paths.codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(codex.nativeSessionId, outside);
  db.close();
  assert.equal((await reader.read(a)).messages.length, 0);
  assert.equal((await reader.read(codex)).messages.length, 0);
});

test('bounded tail read skips partial and malformed records and caps message count/text', async t => {
  const { paths, file } = await fixture(t), a = contact('codex');
  await file(a, [codexHeader(a.nativeSessionId!), { type: 'unused', content: 'x'.repeat(4000) }, '{bad tail row',
    ...Array.from({ length: 8 }, (_, index) => ({ type: 'event_msg', payload: { type: 'user_message', message: `new message ${index}` } })),
  ]);
  const reader = new ConversationReader({ ...paths, maxBytes: 1024, maxMessages: 3 });
  const result = await reader.read(a);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.messages.map(message => message.text), ['new message 5', 'new message 6', 'new message 7']);
  assert.match(result.notice!, /部分对话/);
  const huge = contact('claude');
  await file(huge, [claude('user', '长'.repeat(50_000))]);
  const hugeResult = await new ConversationReader(paths).read(huge);
  assert.equal(hugeResult.truncated, true);
  assert.equal(hugeResult.messages[0].text.length, 24_000);
  assert.equal(Array.from(conversationPreview(hugeResult)!.text).length, 240);
});

test('unchanged files reuse a parsed result and appended records refresh previews', async t => {
  const { file, reader } = await fixture(t), a = contact('claude');
  const path = await file(a, [claude('user', 'first')]);
  const first = await reader.read(a);
  assert.equal(await reader.read(a), first);
  await appendFile(path, JSON.stringify(claude('user', 'second')) + '\n');
  const second = await reader.read(a);
  assert.notEqual(second, first);
  assert.equal(conversationPreview(second)?.text, 'second');
  assert.equal(await reader.read(a), second);
});

test('large assistant turns retain the latest user preview within the total text and message budgets', async t => {
  const { paths, file } = await fixture(t), a = contact('claude');
  await file(a, [claude('user', 'Keep this actual latest request'), ...Array.from({ length: 30 }, (_, index) => claude('assistant', `${index}:` + 'a'.repeat(23_995)))]);
  const large = await new ConversationReader(paths).read(a);
  assert.equal(large.truncated, true);
  assert.ok(large.messages.reduce((total, message) => total + message.text.length, 0) <= 512_000);
  assert.equal(conversationPreview(large)?.text, 'Keep this actual latest request');
  const few = await new ConversationReader({ ...paths, maxMessages: 3 }).read(a);
  assert.equal(few.messages.length, 3);
  assert.equal(conversationPreview(few)?.text, 'Keep this actual latest request');
  assert.ok(few.messages.at(-1)?.text.startsWith('29:'));
});

test('a shared native index avoids rescanning for every missing card', async t => {
  const { file, reader } = await fixture(t), a = contact('claude'), b = contact('claude');
  await file(a, [claude('user', 'first')]);
  await reader.read(a);
  await file(b, [claude('user', 'new indexed later')]);
  assert.equal((await reader.read(b)).messages.length, 0);
});

test('DeepSeek offline plaintext and compressed histories exclude injected and replacement context', async t => {
  const { file, paths } = await fixture(t);
  for (const compressed of [false, true]) {
    const a = contact('dsh');
    await file(a, [{ type: 'session', id: a.nativeSessionId, cwd: a.cwd },
      dshMessage(1, 'user', 'direct human request'), dshMessage(2, 'user', 'hidden plugin instructions', 'plugin'),
      { ...dshMessage(3, 'user', 'hidden compact copy'), surfaceOp: { op: 'replace', start: 0, end: 1 } },
      { type: 'tool/result', seq: 4, data: { message: { role: 'user', content: [{ type: 'text', text: 'hidden tool result' }] } } },
      dshMessage(5, 'assistant', 'visible assistant reply'),
    ], compressed);
    const result = await new ConversationReader(paths).read(a);
    assert.deepEqual(result.messages.map(message => message.text), ['direct human request', 'visible assistant reply']);
  }
});

test('DeepSeek live history is cached, bounded and never called for a pending fork', async t => {
  const { paths } = await fixture(t), a = contact('dsh');
  let calls = 0;
  const reader = new ConversationReader({ ...paths, dshHistory: async id => {
    assert.equal(id, a.nativeSessionId); calls++;
    return { events: [dshMessage(1, 'user', 'live request'), dshMessage(2, 'assistant', 'live answer')].map(event => ({ event })), hasMore: true };
  } });
  const result = await reader.read(a);
  assert.equal(result.truncated, true);
  assert.equal(await reader.preview(a), 'live request');
  assert.equal(calls, 1);
  assert.equal((await reader.read({ ...a, forkPending: true })).messages.length, 0);
  assert.equal(calls, 1);
});

test('reading DeepSeek history while stopped never starts its native service', async () => {
  const bridge = new DshBridge();
  let started = false;
  bridge.start = async () => { started = true; throw new Error('Must not start'); };
  assert.equal(await bridge.readHistory(`session-${randomUUID()}`), undefined);
  assert.equal(started, false);
  await bridge.close();
});

test('preview collapses whitespace and preserves whole Unicode characters', () => {
  const result = conversationPreview({ messages: [{ id: 'u', role: 'user', text: '\n\t' + '🙂'.repeat(250), createdAt: date }], truncated: false });
  assert.equal(Array.from(result!.text).length, 240);
  assert.equal(result!.text.endsWith('…'), true);
  assert.equal(result!.text.includes('\ufffd'), false);
  assert.equal(result!.createdAt, date);
});
