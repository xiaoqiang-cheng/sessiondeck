/** Optional real Codex graphical workflow. All model requests use a disposable
 * profile and an explicitly configured loopback Responses fixture, with no real
 * credentials. No namespace availability is assumed. */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { findExecutable } from '../server/adapters.ts';
import type { AppState, Session } from '../shared/types.ts';
import type { CodexChatSnapshot, CodexChatSubmission } from '../shared/chat.ts';

const run = promisify(execFile);
const executable = await findExecutable('codex');
if (!executable) { console.log(JSON.stringify({ result: 'skipped', reason: 'Codex is not installed' })); process.exit(0); }
const projectRoot = resolve('.');
const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-chat-smoke-'));
const workspace = join(directory, 'workspace'), nativeHome = join(directory, 'codex');
await mkdir(workspace); await mkdir(nativeHome);
const minimalEnv: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM']) if (process.env[key]) minimalEnv[key] = process.env[key];
const held = new Set<ServerResponse>();
const requests: { marker: string; input: string }[] = [];
let cancellations = 0, fixtureError: Error | undefined, child: ChildProcess | undefined;
let logs = '', eventText = '';
const streams = new Set<AbortController>();
const blockedWrite = join(directory, 'must-not-execute.txt');
const markers = ['SESSIONDECK_CHAT_SOURCE', 'SESSIONDECK_CHAT_CHILD', 'SESSIONDECK_CHAT_APPROVAL', 'SESSIONDECK_CHAT_CANCEL'];
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer sessiondeck-chat-fixture-only');
    let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 4_000_000); }
    const input = JSON.parse(body) as { model: string; input: unknown[]; stream: boolean; tools?: { name?: string }[] };
    assert.equal(input.stream, true);
    const text = JSON.stringify(input.input);
    const marker = markers.filter(marker => text.includes(marker)).sort((a, b) => text.lastIndexOf(b) - text.lastIndexOf(a))[0];
    assert.ok(marker, 'Unexpected fixture prompt'); requests.push({ marker, input: text });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let sequence = 0;
    const event = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    const result = { id: `resp_${requests.length}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: input.model, output: [] as unknown[] };
    event('response.created', { response: result });
    if (marker === 'SESSIONDECK_CHAT_APPROVAL' && !text.includes('function_call_output')) {
      const name = input.tools?.find(tool => tool.name === 'exec_command')?.name ?? input.tools?.find(tool => tool.name === 'shell_command')?.name ?? 'exec_command';
      const command = `printf fixture > '${blockedWrite.replace(/'/g, `'"'"'`)}'`;
      const args = { [name === 'exec_command' ? 'cmd' : 'command']: command, sandbox_permissions: 'require_escalated', justification: 'SessionDeck local fixture; reject this disposable test write' };
      const item = { id: `fc_${requests.length}`, type: 'function_call', name, call_id: `fixture_call_${requests.length}`, arguments: JSON.stringify(args), status: 'completed' };
      event('response.output_item.added', { output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
      event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: { ...result, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
      response.end(); return;
    }
    const answer = marker + '_REPLY';
    const item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    event('response.output_item.added', { output_index: 0, item: { ...item, content: [], status: 'in_progress' } });
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    // Two chunks verify actual incremental item updates, not only turn completion.
    for (const delta of [answer.slice(0, 14), answer.slice(14)]) {
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta });
      await delay(20);
    }
    if (marker === 'SESSIONDECK_CHAT_CANCEL') { held.add(response); response.once('close', () => { held.delete(response); cancellations++; }); return; }
    event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: answer });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { ...result, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
    response.end();
  } catch (cause) {
    fixtureError = cause instanceof Error ? cause : new Error(String(cause));
    if (response.headersSent) response.destroy();
    else { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: fixtureError.message } })); }
  }
});
async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (fixtureError) throw fixtureError; if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(logs); if (await check()) return; await delay(40); }
  throw new Error(description + '\n' + logs.slice(-4000));
}
async function freePort() {
  const server = createServer(); await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => server.close(() => accept())); return address.port;
}
try {
  await new Promise<void>(accept => provider.listen(0, '127.0.0.1', accept));
  const address = provider.address(); assert.ok(address && typeof address === 'object');
  await writeFile(join(nativeHome, 'config.toml'), `model = "gpt-5.6-terra"
model_provider = "sessiondeck_mock"
approval_policy = "on-request"
sandbox_mode = "read-only"
web_search = "disabled"
check_for_update_on_startup = false
[features]
enable_request_compression = false
apps = false
[model_providers.sessiondeck_mock]
name = "SessionDeck local fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
env_key = "SESSIONDECK_FIXTURE_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[analytics]
enabled = false
[projects.${JSON.stringify(workspace)}]
trust_level = "trusted"
`, { mode: 0o600 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { ...minimalEnv, SESSIONDECK_PORT: String(port), SESSIONDECK_DATA_DIR: join(directory, 'deck'), SESSIONDECK_CODEX_PORT: '0', SESSIONDECK_CODEX_BIN: executable, SESSIONDECK_CLAUDE_BIN: '/missing-smoke-claude', SESSIONDECK_DSH_BIN: '/missing-smoke-dsh', CODEX_HOME: nativeHome, SESSIONDECK_FIXTURE_API_KEY: 'sessiondeck-chat-fixture-only' };
  child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', data => { logs = (logs + data).slice(-16000); }); child.stderr?.on('data', data => { logs = (logs + data).slice(-16000); });
  await waitFor(async () => { try { return (await fetch(base + '/api/config')).ok; } catch { return false; } }, 'SessionDeck did not start');
  const { csrfToken } = await (await fetch(base + '/api/config')).json() as { csrfToken: string };
  const api = async <T>(path: string, body?: unknown, expected = 200): Promise<T> => {
    const response = await fetch(base + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-sessiondeck-token': csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35_000) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result as T;
  };
  const snapshot = (id: string) => api<CodexChatSnapshot>(`/sessions/${id}/chat`);
  const source = await api<Session>('/sessions', { backend: 'codex', title: 'Native graphical fixture source', cwd: workspace }, 201);
  const stream = new AbortController(); streams.add(stream);
  const response = await fetch(`${base}/api/sessions/${source.id}/chat/events`, { signal: stream.signal }); assert.equal(response.status, 200);
  void (async () => { const reader = response.body!.getReader(); try { for (;;) { const data = await reader.read(); if (data.done) break; eventText += new TextDecoder().decode(data.value); } } catch { /* Expected stream cleanup. */ } finally { reader.releaseLock(); } })();
  const started = await api<Session>(`/sessions/${source.id}/start`, { mode: 'chat' }); assert.ok(started.nativeSessionId);
  const submission = { text: 'SESSIONDECK_CHAT_SOURCE', requestId: randomUUID() };
  const accepted = await api<CodexChatSubmission>(`/sessions/${source.id}/chat/messages`, submission);
  assert.equal(accepted.status, 'accepted');
  await waitFor(async () => (await snapshot(source.id)).items.some(item => item.text.includes('SESSIONDECK_CHAT_SOURCE_REPLY')), 'Native assistant did not stream into graphical view');
  await waitFor(async () => !(await snapshot(source.id)).activeTurnId, 'Native source turn did not finish');
  assert.ok(eventText.includes('SESSIONDECK_CHAT_SOURCE_REPLY'), 'Native assistant did not reach SSE');
  await api(`/sessions/${source.id}/chat/messages`, submission);
  assert.equal(requests.filter(request => request.marker === 'SESSIONDECK_CHAT_SOURCE').length, 1, 'Retry executed the native turn twice');
  const original = (await snapshot(source.id)).items;
  const fork = await api<Session>(`/sessions/${source.id}/fork`, { title: 'Native graphical child' }, 201);
  assert.notEqual(fork.nativeSessionId, started.nativeSessionId);
  await api(`/sessions/${fork.id}/start`, { mode: 'chat' });
  assert.ok((await snapshot(fork.id)).items.some(item => item.text.includes('SESSIONDECK_CHAT_SOURCE_REPLY')));
  await api(`/sessions/${fork.id}/chat/messages`, { text: 'SESSIONDECK_CHAT_CHILD', requestId: randomUUID() });
  await waitFor(async () => (await snapshot(fork.id)).items.some(item => item.text.includes('SESSIONDECK_CHAT_CHILD_REPLY')) && !(await snapshot(fork.id)).activeTurnId, 'Native fork did not complete');
  assert.deepEqual((await snapshot(source.id)).items, original, 'Child execution changed source context');
  await api(`/sessions/${fork.id}/chat/messages`, { text: 'SESSIONDECK_CHAT_APPROVAL', requestId: randomUUID() });
  await waitFor(async () => (await snapshot(fork.id)).requests.some(request => request.kind === 'approval'), 'Native tool approval did not reach graphical view');
  const approval = (await snapshot(fork.id)).requests.find(request => request.kind === 'approval')!;
  // Current Codex escalated commands may offer only accept / policy amendment /
  // cancel. Select the native negative option instead of inventing a decline.
  const decline = approval.options?.find(option => /拒绝|decline|deny/i.test(option.label)) ?? approval.options?.find(option => /取消|cancel/i.test(option.label));
  assert.ok(decline, `Native approval options: ${JSON.stringify(approval)}`);
  await api(`/sessions/${fork.id}/chat/requests/${approval.id}`, { decision: decline.id });
  await waitFor(async () => !(await snapshot(fork.id)).activeTurnId, 'Native rejected approval did not finish');
  await assert.rejects(access(blockedWrite), 'Rejected native approval executed its command');
  await api(`/sessions/${fork.id}/chat/messages`, { text: 'SESSIONDECK_CHAT_CANCEL', requestId: randomUUID() });
  await waitFor(() => held.size === 1, 'Native cancellation stream did not start');
  await api(`/sessions/${fork.id}/chat/interrupt`, {});
  await waitFor(() => cancellations === 1, 'Native cancellation did not abort local model stream');
  const current = (await api<AppState>('/state')).sessions.find(session => session.id === fork.id)!;
  assert.equal(current.running, true, 'Interrupt terminated the persistent native session');
  const attached = await api<Session>(`/sessions/${fork.id}/start`, { mode: 'terminal' });
  assert.equal(attached.nativeSessionId, fork.nativeSessionId);
  const metadata = await readFile(join(nativeHome, 'config.toml'), 'utf8'); assert.ok(metadata.includes(`base_url = "http://127.0.0.1:${address.port}/v1"`));
  assert.ok(!(await readdir(nativeHome)).includes('auth.json'), 'Fixture unexpectedly wrote real account credentials');
  await api(`/sessions/${source.id}/stop`, {}); await api(`/sessions/${fork.id}/stop`, {});
  const report = { result: 'passed', version: (await run(executable, ['--version'], { env: minimalEnv })).stdout.trim(), provider: 'explicit loopback deterministic Responses fixture', isolatedProfile: true, graphicalPrompt: true, streamingSSE: true, nativeApprovalNegativeOption: decline.label, rejectedCommandNotExecuted: true, nativeCancellation: true, interruptedSessionRemainsUsable: true, nativeFork: true, inheritedContext: true, independentChild: true, terminalAttachesSameThread: true, requestIdRetryDoesNotResend: true, localModelRequests: requests.length, realCredentialsUsed: false };
  await mkdir(join(projectRoot, 'artifacts'), { recursive: true });
  await writeFile(join(projectRoot, 'artifacts/codex-chat-native-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const stream of streams) stream.abort();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(accept => child!.once('exit', () => accept()));
    const kill = setTimeout(() => child!.kill('SIGKILL'), 5000);
    child.kill('SIGTERM'); try { await exited; } finally { clearTimeout(kill); }
  }
  for (const response of held) response.destroy(); provider.closeAllConnections();
  await new Promise<void>(accept => provider.close(() => accept()));
  await rm(directory, { recursive: true, force: true });
}
