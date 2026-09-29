import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AppState, ConversationTranscript, Session } from '../shared/types.ts';
import { Store } from './store.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const priorActivity = '2026-08-20T01:00:00.000Z';
const firstInputAt = '2026-09-20T02:00:00.000Z';

async function freePort() {
  const probe = createServer();
  await new Promise<void>((accept, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', accept); });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((accept, reject) => probe.close(error => error ? reject(error) : accept()));
  return address.port;
}

async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(30);
  }
  throw new Error(message);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  child.kill('SIGTERM');
  const fallback = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(fallback); }
}

test('HTTP conversation reads exact stopped native histories and refreshes card previews without launching agents', { timeout: 25_000 }, async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'sessiondeck-conversation-api-'));
  const data = join(temporary, 'data');
  const claudeHome = join(temporary, 'claude');
  const codexHome = join(temporary, 'codex');
  const dshHome = join(temporary, 'dsh');
  const workspace = join(temporary, 'workspace');
  mkdirSync(workspace);
  mkdirSync(dshHome);
  const cliLog = join(temporary, 'cli-calls.jsonl');
  const fakeCli = join(temporary, 'native-fixture.cjs');
  // No real executable, profile or model credentials are reachable through
  // these adapters. The log proves that reads only request capabilities.
  writeFileSync(fakeCli, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.SESSIONDECK_CONVERSATION_CLI_LOG, JSON.stringify(args) + '\\n');\nif (args.length === 1 && args[0] === '--version') console.log('read-only-fixture 1.0');\nelse if (args.length === 1 && args[0] === '--help') console.log('resume fork --fork-session');\nelse process.exit(97);\n`, { mode: 0o700 });

  const store = new Store(join(data, 'sessiondeck.sqlite'));
  const seed = (backend: Session['backend'], title: string) => store.addSession({
    backend, title, cwd: workspace, nativeSessionId: randomUUID(), running: false,
    status: 'waiting_input', statusSource: 'native', statusDetail: '保留原生等待输入状态',
    lastActivity: priorActivity, unread: 7, lastAttentionKey: `${backend}-${title}-attention`, origin: 'imported',
  });
  const claude = seed('claude', 'Claude 精确来源');
  const otherClaude = seed('claude', '同目录另一会话');
  const codex = seed('codex', 'Codex 精确来源');
  const fork = store.addSession({ ...claude, id: randomUUID(), title: '待完成的 Fork', forkPending: true, parentId: claude.id, origin: 'forked' });
  const fresh = store.addSession({ backend: 'codex', title: '尚未启动的会话', cwd: workspace });
  store.close();

  function log(path: string, rows: unknown[]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return path;
  }
  const claudeRow = (session: Session, type: 'user' | 'assistant', text: string, timestamp = firstInputAt, extra = {}) => ({
    type, sessionId: session.nativeSessionId, uuid: randomUUID(), timestamp, message: { role: type, content: text }, ...extra,
  });
  const claudePath = log(join(claudeHome, 'projects', '-same-workspace', `${claude.nativeSessionId}.jsonl`), [
    claudeRow(claude, 'user', '只检查第一个 Claude 会话'),
    claudeRow(claude, 'assistant', '已读取正确的 Claude 上下文。'),
    claudeRow(otherClaude, 'user', '错误身份不得进入原会话'),
    claudeRow(claude, 'user', '工具结果不应成为卡片预览', firstInputAt, { toolUseResult: {} }),
  ]);
  log(join(claudeHome, 'projects', '-same-workspace', `${otherClaude.nativeSessionId}.jsonl`), [claudeRow(otherClaude, 'user', '同目录第二个会话的独立输入')]);
  const codexPath = log(join(codexHome, 'sessions', '2026', '09', '20', `rollout-${codex.nativeSessionId}.jsonl`), [
    { type: 'session_meta', payload: { id: codex.nativeSessionId, cwd: workspace } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n不要显示系统注入' }] } },
    { type: 'event_msg', timestamp: firstInputAt, payload: { type: 'user_message', message: '只检查 Codex 会话的实际用户输入' } },
    { type: 'response_item', timestamp: firstInputAt, payload: { id: 'answer-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已读取正确的 Codex 上下文。' }] } },
  ]);
  const originalClaude = readFileSync(claudePath, 'utf8');
  const originalCodex = readFileSync(codexPath, 'utf8');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1',
      PORT: String(port), HOST: '127.0.0.1', SESSIONDECK_PORT: String(port), SESSIONDECK_DEMO: '0', SESSIONDECK_DATA_DIR: data,
      CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, DSH_HOME: dshHome,
      SESSIONDECK_CLAUDE_BIN: fakeCli, SESSIONDECK_CODEX_BIN: fakeCli, SESSIONDECK_DSH_BIN: fakeCli,
      SESSIONDECK_CONVERSATION_CLI_LOG: cliLog,
    },
  });
  let output = '';
  child.stdout?.on('data', chunk => { output = (output + chunk).slice(-12_000); });
  child.stderr?.on('data', chunk => { output = (output + chunk).slice(-12_000); });
  t.after(async () => { await stop(child); rmSync(temporary, { recursive: true, force: true }); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Conversation fixture exited: ${output}`);
    try { return (await fetch(`${base}/api/config`)).ok; } catch { return false; }
  }, 'Isolated conversation server did not start', 12_000);

  async function get<T>(path: string, expected = 200): Promise<T> {
    const response = await fetch(`${base}/api${path}`);
    const result = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  function unchangedState(current: Session, original: Session) {
    for (const key of ['lastActivity', 'unread', 'status', 'statusSource', 'statusDetail', 'lastAttentionKey', 'running', 'nativeSessionId'] as const) {
      assert.equal(current[key], original[key], `Reading history must preserve ${key} for ${original.title}`);
    }
  }

  await t.test('startup preview refresh does not alter activity, attention or lifecycle state', async () => {
    await until(async () => {
      const state = await get<AppState>('/state');
      return state.sessions.find(item => item.id === claude.id)?.lastUserInput === '只检查第一个 Claude 会话'
        && state.sessions.find(item => item.id === codex.id)?.lastUserInput === '只检查 Codex 会话的实际用户输入';
    }, 'Startup should populate saved native prompts without opening the conversation');
    const state = await get<AppState>('/state');
    assert.equal(state.demo, false);
    for (const original of [claude, otherClaude, codex, fork, fresh]) unchangedState(state.sessions.find(item => item.id === original.id)!, original);
    assert.equal(state.sessions.find(item => item.id === claude.id)?.lastUserInputAt, firstInputAt);
    assert.equal(state.sessions.find(item => item.id === fork.id)?.lastUserInput, undefined);
    assert.equal(state.activities.length, 0);
  });

  await t.test('HTTP records come from exact stopped native identities, and pending forks cannot read their parent', async () => {
    const records = await get<ConversationTranscript>(`/sessions/${claude.id}/conversation`);
    assert.deepEqual(records.messages.map(message => [message.role, message.text]), [
      ['user', '只检查第一个 Claude 会话'], ['assistant', '已读取正确的 Claude 上下文。'],
    ]);
    const peer = await get<ConversationTranscript>(`/sessions/${otherClaude.id}/conversation`);
    assert.deepEqual(peer.messages.map(message => message.text), ['同目录第二个会话的独立输入']);
    const codexRecords = await get<ConversationTranscript>(`/sessions/${codex.id}/conversation`);
    assert.deepEqual(codexRecords.messages.map(message => [message.role, message.text]), [
      ['user', '只检查 Codex 会话的实际用户输入'], ['assistant', '已读取正确的 Codex 上下文。'],
    ]);
    const forkRecords = await get<ConversationTranscript>(`/sessions/${fork.id}/conversation`);
    assert.deepEqual(forkRecords.messages, []);
    assert.match(forkRecords.notice!, /Fork/);
    const freshRecords = await get<ConversationTranscript>(`/sessions/${fresh.id}/conversation`);
    assert.deepEqual(freshRecords.messages, []);
    await get(`/sessions/${randomUUID()}/conversation`, 404);
    assert.equal(readFileSync(claudePath, 'utf8'), originalClaude);
    assert.equal(readFileSync(codexPath, 'utf8'), originalCodex);
  });

  await t.test('new native input updates the record and card, while assistant replies leave the user preview intact', async () => {
    const appendedAt = '2026-09-29T08:15:00.000Z';
    appendFileSync(claudePath, JSON.stringify(claudeRow(claude, 'user', '继续修复键盘导航', appendedAt)) + '\n');
    appendFileSync(claudePath, JSON.stringify(claudeRow(claude, 'assistant', '已增加焦点保护。', appendedAt)) + '\n');
    appendFileSync(codexPath, JSON.stringify({ type: 'event_msg', timestamp: appendedAt, payload: { type: 'user_message', message: '请再检查边界情况' } }) + '\n');
    await until(async () => {
      const record = await get<ConversationTranscript>(`/sessions/${claude.id}/conversation`);
      return record.messages.at(-1)?.text === '已增加焦点保护。';
    }, 'Appended Claude history should invalidate the bounded read cache');
    await until(async () => {
      const record = await get<ConversationTranscript>(`/sessions/${codex.id}/conversation`);
      return record.messages.at(-1)?.text === '请再检查边界情况';
    }, 'Appended Codex history should invalidate the bounded read cache');
    const state = await get<AppState>('/state');
    const currentClaude = state.sessions.find(item => item.id === claude.id)!;
    const currentCodex = state.sessions.find(item => item.id === codex.id)!;
    assert.equal(currentClaude.lastUserInput, '继续修复键盘导航');
    assert.equal(currentClaude.lastUserInputAt, appendedAt);
    assert.equal(currentCodex.lastUserInput, '请再检查边界情况');
    assert.equal(currentCodex.lastUserInputAt, appendedAt);
    unchangedState(currentClaude, claude); unchangedState(currentCodex, codex);
    assert.equal(state.sessions.find(item => item.id === otherClaude.id)?.lastUserInput, '同目录第二个会话的独立输入');
    assert.equal(state.sessions.find(item => item.id === fork.id)?.lastUserInput, undefined);
    assert.equal(state.activities.length, 0);
  });

  await t.test('reads never execute a native launch, resume or model command', () => {
    assert.equal(existsSync(cliLog), true, 'Capability probes should use the isolated fake executables');
    const calls = readFileSync(cliLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.ok(calls.length >= 6);
    for (const args of calls) assert.ok(args.length === 1 && ['--version', '--help'].includes(args[0]), `Unexpected native invocation: ${JSON.stringify(args)}`);
  });
});
