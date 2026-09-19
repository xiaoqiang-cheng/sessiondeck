/** Full SessionDeck HTTP + browser-terminal + native-backend group workflow.
 * All three installed CLIs use disposable profiles and deterministic loopback
 * model providers inside a Linux namespace with no external network interface.
 * npm exec tsx scripts/workspace-workflow-smoke.ts */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import headless from '@xterm/headless';
import WebSocket from 'ws';
import { findExecutable } from '../server/adapters.ts';
import type { AppState, Backend, Delivery, Group, GroupDetail, GroupMessage, Session } from '../shared/types.ts';

const run = promisify(execFile);
const minimalEnv: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM']) if (process.env[key]) minimalEnv[key] = process.env[key];
if (!process.argv.includes('--isolated-network')) {
  if (process.platform !== 'linux') { console.log(JSON.stringify({ result: 'skipped', reason: 'This optional check requires Linux network namespaces' })); process.exit(0); }
  const namespace = await readlink('/proc/self/ns/net');
  const child = spawn('unshare', ['--user', '--map-root-user', '--net', process.execPath, '--import', 'tsx', fileURLToPath(import.meta.url), '--isolated-network'], { env: { ...minimalEnv, SESSIONDECK_PARENT_NETWORK_NAMESPACE: namespace }, stdio: 'inherit' });
  const exitCode = await new Promise<number>(accept => {
    child.once('error', error => { console.error(`Cannot create isolated network namespace: ${error.message}`); accept(1); });
    child.once('exit', code => accept(code ?? 1));
  });
  process.exit(exitCode);
}
assert.ok(process.env.SESSIONDECK_PARENT_NETWORK_NAMESPACE, 'Start through the network namespace wrapper');
assert.notEqual(await readlink('/proc/self/ns/net'), process.env.SESSIONDECK_PARENT_NETWORK_NAMESPACE);
await run('ip', ['link', 'set', 'lo', 'up'], { env: minimalEnv });
const links = JSON.parse((await run('ip', ['-j', 'link', 'show'], { env: minimalEnv })).stdout) as { ifname: string }[];
assert.deepEqual(links.map(link => link.ifname), ['lo'], 'An external network interface exists in the fixture namespace');

const backends = ['claude', 'codex', 'dsh'] as const;
const executables = Object.fromEntries(await Promise.all(backends.map(async backend => [backend, await findExecutable(backend)]))) as Record<Backend, string | null>;
if (backends.some(backend => !executables[backend])) {
  console.log(JSON.stringify({ result: 'skipped', reason: `Missing native executables: ${backends.filter(backend => !executables[backend]).join(', ')}` }));
  process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-workspace-workflow-'));
const workspace = join(directory, 'workspace'), dataDir = join(directory, 'deck');
const codexHome = join(directory, 'codex'), claudeHome = join(directory, 'claude'), dshHome = join(directory, 'dsh');
await Promise.all([workspace, dataDir, codexHome, claudeHome, dshHome, join(directory, 'xdg-config'), join(directory, 'xdg-cache')].map(path => mkdir(path, { mode: 0o700 })));
const apiKey = 'sessiondeck-local-fixture-only';
const markers = ['WORKSPACE_CODEX_SOURCE', 'WORKSPACE_CLAUDE_SOURCE', 'WORKSPACE_DSH_HANDOFF', 'WORKSPACE_CHILD_CORRECTION', 'WORKSPACE_PRIVATE_CORRECTION'] as const;
type Marker = typeof markers[number];
const requests: { backend: Backend; marker: Marker; input: string; nativeId?: string }[] = [];
let fixtureError: Error | undefined;
let deck: ChildProcess | undefined;
let deckLog = '';
let csrfToken = '';
let baseUrl = '';
let dshUrl = '';
let codexUrl = '';
let report: Record<string, unknown> | undefined;
let deckEnv: NodeJS.ProcessEnv | undefined;
type TerminalView = { id: string; backend: Backend; ws: WebSocket; terminal: headless.Terminal; text(): string; send(data: string): void };
const views: TerminalView[] = [];
const liveCards = new Set<string>();

function messagesSse(response: ServerResponse, model: string, answer: string, requestId: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type: string, payload: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  event('message_start', { message: { id: `msg_fixture_${requestId}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
  event('message_stop', {}); response.end();
}
function responsesSse(response: ServerResponse, model: string, answer: string, requestId: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let sequence = 0;
  const event = (type: string, payload: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);
  const itemId = `msg_${requestId}`;
  const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
  const result = { id: `resp_${requestId}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model, output: [] };
  event('response.created', { response: result });
  event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  event('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  event('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: answer });
  event('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: answer });
  event('response.output_item.done', { output_index: 0, item });
  event('response.completed', { response: { ...result, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
  response.end();
}
const provider = createServer(async (request, response) => {
  try {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 4_000_000) throw new Error('Local fixture input exceeded its size bound'); }
    if (path === '/v1/messages/count_tokens') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":100}'); return; }
    assert.equal(request.method, 'POST');
    const backend: Backend = path === '/v1/responses' ? 'codex' : path === '/v1/messages' ? 'claude' : path === '/chat/completions' ? 'dsh' : (() => { throw new Error(`Unexpected provider route ${path}`); })();
    assert.equal(backend === 'claude' ? request.headers['x-api-key'] : request.headers.authorization, backend === 'claude' ? apiKey : `Bearer ${apiKey}`);
    const input = JSON.parse(body) as { model: string; stream: boolean; input?: unknown[]; messages?: unknown[] };
    assert.equal(input.stream, true);
    const text = JSON.stringify(backend === 'codex' ? input.input : input.messages);
    const marker = markers.filter(value => text.includes(value)).sort((a, b) => text.lastIndexOf(b) - text.lastIndexOf(a))[0];
    assert.ok(marker, 'Unexpected native request without a test marker');
    requests.push({ backend, marker, input: text, ...(backend === 'dsh' ? { nativeId: String(request.headers['x-deepseek-harness-session-id'] ?? '') } : {}) });
    const answer = `${marker}_REPLY`;
    if (backend === 'codex') responsesSse(response, input.model, answer, requests.length);
    else if (backend === 'claude') messagesSse(response, input.model, answer, requests.length);
    else {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (content: string, finish: string | null) => `data: ${JSON.stringify({ id: `workspace_${requests.length}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`;
      response.end(`${chunk(answer, null)}${chunk('', 'stop')}data: [DONE]\n\n`);
    }
  } catch (error) {
    fixtureError = error instanceof Error ? error : new Error(String(error));
    if (response.headersSent) response.destroy();
    else { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: fixtureError.message } })); }
  }
});

async function freePort() {
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => probe.close(() => accept()));
  return address.port;
}
async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (deck?.exitCode !== null && deck?.exitCode !== undefined) throw new Error(`SessionDeck exited: ${deckLog}`);
    if (await check()) return;
    await delay(75);
  }
  throw new Error(`${description}\n${deckLog.slice(-3000)}\n${views.map(view => `${view.backend}:\n${view.text().slice(-4500)}`).join('\n')}`);
}
async function launchDeck() {
  assert.ok(deckEnv);
  deckLog = ''; csrfToken = '';
  const loader = createRequire(import.meta.url).resolve('tsx');
  deck = spawn(process.execPath, ['--import', pathToFileURL(loader).href, fileURLToPath(new URL('../server/index.ts', import.meta.url))], { cwd: workspace, env: deckEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  deck.stdout?.on('data', value => { deckLog = (deckLog + value).slice(-10_000); });
  deck.stderr?.on('data', value => { deckLog = (deckLog + value).slice(-10_000); });
  await waitFor(async () => { try { const response = await fetch(`${baseUrl}/api/config`); if (!response.ok) return false; csrfToken = (await response.json() as { csrfToken: string }).csrfToken; return !!csrfToken; } catch { return false; } }, 'SessionDeck did not start');
}
async function stopDeck() {
  for (const view of views.splice(0)) { view.ws.terminate(); view.terminal.dispose(); }
  if (deck && deck.exitCode === null && deck.signalCode === null) {
    const child = deck;
    const exited = new Promise<void>(accept => child.once('exit', () => accept()));
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    try { await exited; } finally { clearTimeout(force); }
  }
  deck = undefined;
  const endpoints = [baseUrl, dshUrl, codexUrl.replace('ws:', 'http:')].filter(Boolean);
  for (let attempt = 0; attempt < 40; attempt++) {
    const active = await Promise.all(endpoints.map(async endpoint => { try { await fetch(endpoint, { signal: AbortSignal.timeout(200) }); return true; } catch { return false; } }));
    if (active.every(value => !value)) return;
    await delay(75);
  }
  throw new Error('A native bridge remained running after SessionDeck shutdown');
}
async function api<T>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json', origin: baseUrl, ...(csrfToken ? { 'x-sessiondeck-token': csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25_000) });
  const result = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
  return result as T;
}
const state = () => api<AppState>('/api/state');
async function card(id: string) { const result = (await state()).sessions.find(item => item.id === id); assert.ok(result); return result; }
async function dshRpc<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const rpcId = randomUUID();
  const response = await fetch(`${dshUrl}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: dshUrl }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal: AbortSignal.timeout(5000) });
  const body = await response.json() as { rpcId: string; result: { ok: boolean; value: T; error?: unknown } };
  assert.equal(response.status, 200); assert.equal(body.rpcId, rpcId); assert.equal(body.result.ok, true, JSON.stringify(body.result.error));
  return body.result.value;
}
async function codexHistory(nativeId: string): Promise<unknown> {
  const names = (await readdir(dataDir)).filter(name => name.startsWith('.codex-app-server-') && name.endsWith('.token'));
  assert.equal(names.length, 1);
  const token = await readFile(join(dataDir, names[0]), 'utf8');
  const ws = new WebSocket(codexUrl, { headers: { Authorization: `Bearer ${token}` } });
  let nextId = 0;
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((accept, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { ws.off('message', listener); reject(new Error(`Codex ${method} timed out`)); }, 5000);
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id || message.method) return;
      clearTimeout(timer); ws.off('message', listener);
      if (message.error) reject(new Error(message.error.message)); else accept(message.result);
    };
    ws.on('message', listener); ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise<void>((accept, reject) => { ws.once('open', accept); ws.once('error', reject); });
    await rpc('initialize', { clientInfo: { name: 'workspace-smoke-reader', version: '1.0' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return await rpc('thread/turns/list', { threadId: nativeId, itemsView: 'full', sortDirection: 'asc', limit: 100 });
  } finally { ws.close(); }
}
async function claudeHistory(nativeId: string) {
  for (const project of await readdir(join(claudeHome, 'projects'))) {
    try { return await readFile(join(claudeHome, 'projects', project, `${nativeId}.jsonl`), 'utf8'); } catch { /* next project */ }
  }
  throw new Error(`Claude did not persist the expected native history: ${nativeId}`);
}

async function terminal(item: Session): Promise<TerminalView> {
  const ws = new WebSocket(`${baseUrl.replace('http:', 'ws:')}/api/terminal/${item.id}?token=${csrfToken}`, { origin: baseUrl });
  const screen = new headless.Terminal({ cols: 110, rows: 34, scrollback: 1000, allowProposedApi: true });
  const view: TerminalView = { id: item.id, backend: item.backend, ws, terminal: screen, text: () => Array.from({ length: screen.buffer.active.length }, (_, index) => screen.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n'), send: data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data })); } };
  views.push(view);
  screen.onData(data => view.send(data));
  ws.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.type === 'data') screen.write(message.data); if (message.type === 'error') fixtureError = new Error(message.error); });
  await new Promise<void>((accept, reject) => { ws.once('open', accept); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'resize', cols: 110, rows: 34 }));
  const handled = new Set<string>();
  await waitFor(async () => {
    const text = view.text();
    if (item.backend === 'claude') {
      if (/Choose the text style|Choose the theme|Let's get started|Select the text style/.test(text) && !handled.has('theme')) { handled.add('theme'); view.send('\r'); }
      if (/Do you trust the files|trust this folder|Is this a project you created/.test(text) && text.includes('Enter to confirm') && !handled.has('trust')) {
        handled.add('trust');
        setTimeout(() => { if (/❯ No, exit/.test(view.text())) view.send('\x1b[B'); }, 300);
        setTimeout(() => view.send('\r'), 600);
      }
      if (text.includes('Do you want to use this API key?') && text.includes('No (recommended)') && !handled.has('key')) {
        handled.add('key'); setTimeout(() => view.send('\x1b[A'), 300); setTimeout(() => view.send('\r'), 600);
      }
      const current = await card(item.id);
      return !!current.nativeSessionId && current.statusSource === 'native' && /Try |for shortcuts|Workspace Claude|WORKSPACE_CLAUDE_SOURCE_REPLY/.test(text);
    }
    return /gpt-5\.6|context left|context used/.test(text);
  }, `${item.backend} native TUI did not become ready`);
  return view;
}
async function stageTask(group: Group, item: Session, view: TerminalView, marker: Marker) {
  const message = await api<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: marker, recipientIds: [item.id] }, 201);
  const detail = await api<GroupDetail>(`/api/groups/${group.id}`);
  const delivery = detail.deliveries.find(row => row.messageId === message.id && row.sessionId === item.id); assert.ok(delivery);
  const before = requests.length;
  const staged = await api<Delivery>(`/api/deliveries/${delivery.id}/send`, 'POST', {});
  assert.equal(staged.status, 'staged');
  await api(`/api/deliveries/${delivery.id}/send`, 'POST', {}, 400);
  await delay(350);
  assert.equal(requests.length, before, 'Staging must leave submission to the native TUI');
  view.send('\r');
  await waitFor(async () => requests.some(request => request.marker === marker && request.backend === item.backend) && (await card(item.id)).status === 'waiting_input' && view.text().includes(`${marker}_REPLY`), `${item.backend} group task did not complete`);
  assert.equal((await card(item.id)).statusSource, 'native');
  return message;
}

try {
  await new Promise<void>(accept => provider.listen(0, '127.0.0.1', accept));
  const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress === 'object');
  const providerUrl = `http://127.0.0.1:${providerAddress.port}`;
  const [port, dshPort, codexPort] = await Promise.all([freePort(), freePort(), freePort()]);
  baseUrl = `http://127.0.0.1:${port}`; dshUrl = `http://127.0.0.1:${dshPort}`; codexUrl = `ws://127.0.0.1:${codexPort}`;
  // Skip only Claude's introductory external connectivity check. Workspace
  // trust and the dummy API-key confirmation still pass through its real TUI.
  await writeFile(join(claudeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }), { mode: 0o600 });
  await writeFile(join(codexHome, 'config.toml'), `model = "gpt-5.6-terra"
model_provider = "sessiondeck_fixture"
approval_policy = "on-request"
sandbox_mode = "read-only"
web_search = "disabled"
check_for_update_on_startup = false

[features]
enable_request_compression = false
apps = false

[model_providers.sessiondeck_fixture]
name = "SessionDeck local group fixture"
base_url = "${providerUrl}/v1"
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
  deckEnv = {
    ...minimalEnv, SESSIONDECK_PORT: String(port), SESSIONDECK_DSH_PORT: String(dshPort), SESSIONDECK_CODEX_PORT: String(codexPort), SESSIONDECK_DATA_DIR: dataDir, SESSIONDECK_DEMO: '0',
    SESSIONDECK_CLAUDE_BIN: executables.claude!, SESSIONDECK_CODEX_BIN: executables.codex!, SESSIONDECK_DSH_BIN: executables.dsh!,
    CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, DSH_HOME: dshHome,
    XDG_CONFIG_HOME: join(directory, 'xdg-config'), XDG_CACHE_HOME: join(directory, 'xdg-cache'),
    ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: providerUrl, ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    DEEPSEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: providerUrl, SESSIONDECK_FIXTURE_API_KEY: apiKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1', TERM: 'xterm-256color',
  };
  await launchDeck();
  const initial = await state(); assert.equal(initial.demo, false); assert.deepEqual(initial.sessions, []);
  assert.ok(initial.backends.every(backend => backend.installed));
  assert.equal(initial.backends.find(backend => backend.id === 'codex')?.capabilities.nativeControl, true);

  const group = await api<Group>('/api/groups', 'POST', { title: 'Workspace native team', goal: 'Complete one task, hand off its result, and correct an independent Fork' }, 201);
  const contacts = {} as Record<Backend, Session>;
  for (const backend of backends) {
    contacts[backend] = await api<Session>('/api/sessions', 'POST', { backend, title: `Workspace ${backend === 'claude' ? 'Claude' : backend}`, cwd: workspace, groupId: group.id }, 201);
    contacts[backend] = await api<Session>(`/api/sessions/${contacts[backend].id}/start`, 'POST', {});
    liveCards.add(contacts[backend].id);
  }
  const claudeTui = await terminal(contacts.claude);
  const codexTui = await terminal(contacts.codex);
  contacts.claude = await card(contacts.claude.id);
  for (const item of Object.values(contacts)) {
    assert.ok(item.nativeSessionId); assert.equal(item.groupId, group.id);
    await api(`/api/sessions/${item.id}/read`, 'POST', {});
  }
  assert.match(contacts.dsh.nativeUrl ?? '', /sessiondeckSession=session-/);
  assert.equal((await fetch(contacts.dsh.nativeUrl!)).status, 200);
  await dshRpc('session.selectModel', { sessionId: contacts.dsh.nativeSessionId, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'off' });

  await stageTask(group, contacts.claude, claudeTui, 'WORKSPACE_CLAUDE_SOURCE');
  await stageTask(group, contacts.codex, codexTui, 'WORKSPACE_CODEX_SOURCE');
  assert.equal((await card(contacts.claude.id)).unread, 1, 'Claude completion should produce one unread reminder');
  assert.equal((await card(contacts.codex.id)).unread, 1, 'Codex completion should produce one unread reminder');
  const savedClaudeHistory = await claudeHistory(contacts.claude.nativeSessionId!);
  assert.ok(savedClaudeHistory.includes('WORKSPACE_CLAUDE_SOURCE_REPLY'));
  assert.ok(requests.find(request => request.backend === 'codex')?.input.includes(group.title));
  assert.ok(requests.find(request => request.backend === 'claude')?.input.includes(group.goal));
  const sourceHistory = await codexHistory(contacts.codex.nativeSessionId!);
  assert.ok(JSON.stringify(sourceHistory).includes('WORKSPACE_CODEX_SOURCE_REPLY'));
  await api(`/api/sessions/${contacts.codex.id}/read`, 'POST', {});
  assert.equal((await card(contacts.codex.id)).unread, 0);

  const result = await api<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', { kind: 'result', text: 'WORKSPACE_CODEX_SOURCE_REPLY', senderId: contacts.codex.id }, 201);
  assert.equal(result.senderId, contacts.codex.id); assert.equal(result.senderName, contacts.codex.title);
  const handoff = await api<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: 'Continue from WORKSPACE_CODEX_SOURCE_REPLY. WORKSPACE_DSH_HANDOFF', sourceMessageId: result.id, recipientIds: [contacts.dsh.id] }, 201);
  assert.equal(handoff.sourceMessageId, result.id);
  const detail = await api<GroupDetail>(`/api/groups/${group.id}`);
  const pending = detail.deliveries.find(delivery => delivery.messageId === handoff.id); assert.ok(pending);
  assert.ok(pending.text.includes(contacts.codex.title));
  const delivered = await api<Delivery>(`/api/deliveries/${pending.id}/send`, 'POST', {}); assert.equal(delivered.status, 'sent');
  await api(`/api/deliveries/${pending.id}/send`, 'POST', {}, 400);
  await waitFor(async () => (await card(contacts.dsh.id)).status === 'waiting_input', 'dsh did not report completion of the handed-off group task');
  assert.equal((await card(contacts.dsh.id)).unread, 1, 'Harness completion should produce one unread reminder');
  const dshHistory = await dshRpc('session.history', { sessionId: contacts.dsh.nativeSessionId, maxMessages: 100 });
  assert.ok(JSON.stringify(dshHistory).includes('WORKSPACE_DSH_HANDOFF_REPLY'));
  assert.equal(requests.find(request => request.backend === 'dsh')?.nativeId, contacts.dsh.nativeSessionId);

  const child = await api<Session>(`/api/sessions/${contacts.codex.id}/fork`, 'POST', { title: 'Workspace fork for correction', groupId: group.id }, 201);
  assert.equal(child.parentId, contacts.codex.id); assert.equal(child.groupId, group.id); assert.equal(child.forkPending, false);
  assert.notEqual(child.nativeSessionId, contacts.codex.nativeSessionId);
  assert.ok(JSON.stringify(await codexHistory(child.nativeSessionId!)).includes('WORKSPACE_CODEX_SOURCE_REPLY'));
  await api(`/api/sessions/${child.id}/start`, 'POST', {}); liveCards.add(child.id);
  const childTui = await terminal(child);
  await api(`/api/sessions/${child.id}/read`, 'POST', {});
  const renamed = await api<Session>(`/api/sessions/${child.id}`, 'PATCH', { title: 'Corrected independent member' }); assert.equal(renamed.title, 'Corrected independent member');
  await stageTask(group, child, childTui, 'WORKSPACE_CHILD_CORRECTION');
  assert.equal((await card(child.id)).unread, 1, 'The corrected member should produce one new reminder');
  assert.ok(requests.find(request => request.marker === 'WORKSPACE_CHILD_CORRECTION')?.input.includes('WORKSPACE_CODEX_SOURCE_REPLY'));
  await api(`/api/sessions/${child.id}/read`, 'POST', {});
  // The user can enter one member and correct it directly, without creating a
  // group message or forwarding that private instruction to other members.
  childTui.send('WORKSPACE_PRIVATE_CORRECTION');
  await delay(250); childTui.send('\r');
  await waitFor(async () => childTui.text().includes('WORKSPACE_PRIVATE_CORRECTION_REPLY') && (await card(child.id)).status === 'waiting_input', 'Private correction in the member TUI did not complete');
  assert.equal((await card(child.id)).unread, 1);
  assert.ok(JSON.stringify(await codexHistory(child.nativeSessionId!)).includes('WORKSPACE_PRIVATE_CORRECTION_REPLY'));
  assert.deepEqual(await codexHistory(contacts.codex.nativeSessionId!), sourceHistory, 'Correcting the Fork changed the source native history');
  assert.equal((await card(contacts.codex.id)).unread, 0, 'Another group member must not revive the source notification');
  const finalGroup = await api<GroupDetail>(`/api/groups/${group.id}`);
  assert.equal(finalGroup.messages.length, 5);
  assert.deepEqual(finalGroup.deliveries.map(delivery => delivery.status), ['staged', 'staged', 'sent', 'staged']);
  for (const id of liveCards) {
    const stopped = await api<Session>(`/api/sessions/${id}/stop`, 'POST', {});
    assert.equal(stopped.running, false); assert.equal(stopped.status, 'stopped');
  }
  liveCards.clear();
  const finalState = await state(); assert.equal(finalState.sessions.length, 4); assert.ok(finalState.sessions.every(item => !item.running));
  // Harness may make an additional native title-generation call. Assert the
  // exact set of task/backend pairs while reporting every local model request.
  assert.deepEqual([...new Set(requests.map(request => `${request.backend}:${request.marker}`))].sort(), ['claude:WORKSPACE_CLAUDE_SOURCE', 'codex:WORKSPACE_CHILD_CORRECTION', 'codex:WORKSPACE_CODEX_SOURCE', 'codex:WORKSPACE_PRIVATE_CORRECTION', 'dsh:WORKSPACE_DSH_HANDOFF']);
  const previousToken = csrfToken;
  const requestsBeforeRestart = requests.length;
  await stopDeck();
  await launchDeck();
  assert.notEqual(csrfToken, previousToken, 'A restart must create a new local API capability');
  const persisted = await state();
  assert.deepEqual(persisted.sessions, finalState.sessions, 'Stopped contact metadata changed across service restart');
  assert.deepEqual(persisted.groups, finalState.groups);
  assert.deepEqual(await api<GroupDetail>(`/api/groups/${group.id}`), finalGroup, 'Group messages, deliveries or result provenance changed on restart');
  for (const backend of backends) {
    const original = contacts[backend];
    const reopened = await api<Session>(`/api/sessions/${original.id}/start`, 'POST', {});
    liveCards.add(original.id);
    assert.equal(reopened.nativeSessionId, original.nativeSessionId, `Restart created a different ${backend} native identity`);
    assert.equal(reopened.running, true);
    if (backend === 'claude') {
      const reopenedTui = await terminal(reopened);
      await waitFor(() => reopenedTui.text().includes('WORKSPACE_CLAUDE_SOURCE_REPLY'), 'Claude resume did not display its saved conversation');
      assert.ok((await claudeHistory(original.nativeSessionId!)).includes('WORKSPACE_CLAUDE_SOURCE_REPLY'));
    } else if (backend === 'codex') {
      const reopenedTui = await terminal(reopened);
      await waitFor(() => reopenedTui.text().includes('WORKSPACE_CODEX_SOURCE_REPLY'), 'Codex resume did not display its saved conversation');
      assert.deepEqual(await codexHistory(original.nativeSessionId!), sourceHistory, 'Codex resume changed its saved source history');
      assert.equal((await card(original.id)).unread, 0, 'Restart replay must not revive the acknowledged Codex completion');
    } else {
      assert.equal((await fetch(reopened.nativeUrl!)).status, 200);
      assert.ok(JSON.stringify(await dshRpc('session.history', { sessionId: original.nativeSessionId, maxMessages: 100 })).includes('WORKSPACE_DSH_HANDOFF_REPLY'));
    }
  }
  assert.equal(requests.length, requestsBeforeRestart, 'Restoring saved sessions must not submit another model task');
  assert.equal((await state()).sessions.length, 4, 'Resume created duplicate contact cards');
  for (const id of liveCards) {
    try { assert.equal((await api<Session>(`/api/sessions/${id}/stop`, 'POST', {})).running, false); }
    catch (error) {
      // Diagnostics remain inside this disposable fixture. The production
      // metadata and any user's native history are never inspected here.
      if (id === contacts.dsh.id) {
        const listing = await dshRpc<{ items: unknown[] }>('session.list', {});
        const rpcId = randomUUID();
        const response = await fetch(`${dshUrl}/api/session.cancel`, { method: 'POST', headers: { 'content-type': 'application/json', origin: dshUrl }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.cancel', payload: { sessionId: contacts.dsh.nativeSessionId } }) });
        const rows = Array.isArray(listing.items) ? listing.items as { sessionId?: unknown; running?: unknown; blank?: unknown }[] : [];
        const cancel = await response.json() as { result?: { ok?: boolean; error?: { code?: string } } };
        console.error(JSON.stringify({ dshStopDiagnostic: { session: rows.find(row => row.sessionId === contacts.dsh.nativeSessionId) ?? null, cancelCode: cancel.result?.error?.code ?? null } }));
      }
      throw error;
    }
  }
  liveCards.clear();
  report = { result: 'passed', backends: initial.backends.map(({ id, version }) => ({ id, version })), networkNamespace: 'isolated; loopback only', webApiIntegration: true, nativeTerminalWebSocket: true, nativeWorkspaceAndKeyConfirmation: true, nativeStatusAndIdentity: true, taskStagingRequiresEnter: true, repeatedDeliveryBlocked: true, exactUnreadReminderCounts: true, groupResultAttribution: true, sourceLinkedHandoff: true, dshNativeDeliveryAndCompletion: true, nativeForkIntoGroup: true, independentMemberCorrection: true, privateNativeTuiCorrection: true, sourceHistoryUnchanged: true, stopAllContacts: true, serviceRestartPersistence: true, allBackendsResumeExactNativeIdentity: true, nativeContextRestoredWithoutModelCalls: true, contacts: finalState.sessions.length, groupMessages: finalGroup.messages.length, localModelRequests: requests.length, externalModelRequests: 0, realCredentialsUsed: false };
} finally {
  try { await stopDeck(); }
  finally {
    provider.closeAllConnections();
    await new Promise<void>(accept => provider.close(() => accept()));
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(report, null, 2));
