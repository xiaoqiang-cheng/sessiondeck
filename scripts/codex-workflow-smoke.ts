/** Optional native Codex/TUI workflow against a deterministic local Responses
 * provider. Linux user+network namespaces make external networking impossible.
 * npm exec tsx scripts/codex-workflow-smoke.ts */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import WebSocket from 'ws';
import { CodexBridge } from '../server/codex.ts';
import { findExecutable } from '../server/adapters.ts';

const run = promisify(execFile);
const minimalEnv: NodeJS.ProcessEnv = {};
for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM']) if (process.env[key]) minimalEnv[key] = process.env[key];
if (!process.argv.includes('--isolated-network')) {
  if (process.platform !== 'linux') {
    console.log(JSON.stringify({ result: 'skipped', reason: 'This optional check requires Linux network namespaces' }));
    process.exit(0);
  }
  const namespace = await readlink('/proc/self/ns/net');
  const child = spawn('unshare', ['--user', '--map-root-user', '--net', process.execPath, '--import', 'tsx', fileURLToPath(import.meta.url), '--isolated-network'], {
    env: { ...minimalEnv, SESSIONDECK_PARENT_NETWORK_NAMESPACE: namespace }, stdio: 'inherit',
  });
  const exitCode = await new Promise<number>(accept => {
    child.once('error', error => { console.error(`Cannot create isolated network namespace: ${error.message}`); accept(1); });
    child.once('exit', code => accept(code ?? 1));
  });
  process.exit(exitCode);
}
assert.ok(process.env.SESSIONDECK_PARENT_NETWORK_NAMESPACE, 'Start this script through its network namespace wrapper');
assert.notEqual(await readlink('/proc/self/ns/net'), process.env.SESSIONDECK_PARENT_NETWORK_NAMESPACE);
await run('ip', ['link', 'set', 'lo', 'up'], { env: minimalEnv });
const networkLinks = JSON.parse((await run('ip', ['-j', 'link', 'show'], { env: minimalEnv })).stdout) as { ifname: string }[];
assert.deepEqual(networkLinks.map(link => link.ifname), ['lo'], 'Fixture namespace unexpectedly has an external interface');
const executable = await findExecutable('codex');
if (!executable) { console.log(JSON.stringify({ result: 'skipped', reason: 'Codex is not installed' })); process.exit(0); }

const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-workflow-'));
const workspace = join(directory, 'workspace'), nativeHome = join(directory, 'codex');
await Promise.all([mkdir(workspace), mkdir(nativeHome)]);
process.chdir(workspace);
const held = new Set<ServerResponse>();
const requests: { marker: string; input: string }[] = [];
let cancellations = 0;
let fixtureError: Error | undefined;
let bridge: CodexBridge | undefined;
const terminals: { child: pty.IPty; terminal: headless.Terminal; text(): string; exited: boolean }[] = [];

const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer sessiondeck-local-fixture-only');
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 4_000_000) throw new Error('Fixture request is too large'); }
    const input = JSON.parse(body) as { input: unknown[]; model: string; stream: boolean; tools?: unknown[] };
    assert.equal(input.stream, true);
    const text = JSON.stringify(input.input);
    const marker = ['SESSIONDECK_SOURCE', 'SESSIONDECK_CHILD', 'SESSIONDECK_CANCEL', 'SESSIONDECK_APPROVAL'].filter(value => text.includes(value)).sort((a, b) => text.lastIndexOf(b) - text.lastIndexOf(a))[0];
    assert.ok(marker, 'Unexpected local fixture prompt');
    requests.push({ marker, input: text });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const responseId = `resp_${requests.length}`, itemId = `msg_${requests.length}`;
    let sequence = 0;
    const event = (type: string, payload: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);
    const answer = `${marker}_REPLY`;
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    const result = { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: input.model, output: [] as unknown[] };
    event('response.created', { response: result });
    if (marker === 'SESSIONDECK_APPROVAL' && !text.includes('function_call_output')) {
      const tools = input.tools as { name?: string; type?: string; parameters?: unknown }[] | undefined;
      // Native Codex may serve a cached tool schema after the first request.
      const tool = tools?.find(candidate => candidate.name === 'exec_command') ?? tools?.find(candidate => candidate.name === 'shell_command') ?? { name: 'exec_command' };
      const args = tool.name === 'exec_command' ? { cmd: `printf fixture > ${join(directory, 'must-not-execute.txt')}`, sandbox_permissions: 'require_escalated', justification: 'SessionDeck local fixture: reject this harmless test write' }
        : { command: `printf fixture > ${join(directory, 'must-not-execute.txt')}`, sandbox_permissions: 'require_escalated', justification: 'SessionDeck local fixture: reject this harmless test write' };
      const call = { id: `fc_${requests.length}`, type: 'function_call', name: tool.name, call_id: 'sessiondeck-fixture-approval', arguments: JSON.stringify(args), status: 'completed' };
      event('response.output_item.added', { output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } });
      event('response.function_call_arguments.delta', { item_id: call.id, output_index: 0, delta: call.arguments });
      event('response.output_item.done', { output_index: 0, item: call });
      event('response.completed', { response: { ...result, status: 'completed', output: [call], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
      response.end();
      return;
    }
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: answer });
    if (marker === 'SESSIONDECK_CANCEL') {
      held.add(response);
      response.once('close', () => { held.delete(response); cancellations++; });
      return;
    }
    event('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: answer });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { ...result, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
    response.end();
  } catch (error) {
    fixtureError = error instanceof Error ? error : new Error(String(error));
    if (response.headersSent) response.destroy();
    else { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: fixtureError.message } })); }
  }
});

async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`${description}\n${terminals.map(view => view.text().slice(-3500)).join('\n')}`);
}
async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  assert.ok(bridge?.remoteToken);
  const socket = new WebSocket(bridge.endpoint, { headers: { Authorization: `Bearer ${bridge.remoteToken}` } });
  const call = (id: number, name: string, payload: Record<string, unknown>) => new Promise<Record<string, unknown>>((accept, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error(`${name} timed out`)); }, 5000);
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== id) return;
      clearTimeout(timer); socket.off('message', listener);
      if (message.error) reject(new Error(`${name}: ${message.error.message}`));
      else accept(message.result);
    };
    socket.on('message', listener);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: name, params: payload }));
  });
  try {
    await new Promise<void>((accept, reject) => { socket.once('open', accept); socket.once('error', reject); });
    await call(1, 'initialize', { clientInfo: { name: 'sessiondeck-smoke', version: '1.0' }, capabilities: { experimentalApi: true } });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    return await call(2, method, params) as T;
  } finally { socket.close(); }
}
const history = (threadId: string) => rpc<{ data: unknown[] }>('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 100 });

try {
  await new Promise<void>(accept => provider.listen(0, '127.0.0.1', accept));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
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
  const env = { ...minimalEnv, CODEX_HOME: nativeHome, SESSIONDECK_FIXTURE_API_KEY: 'sessiondeck-local-fixture-only', TERM: 'xterm-256color' };
  bridge = new CodexBridge({ executable, dataDir: join(directory, 'deck'), env, port: 0 });
  const source = await bridge.createSession(workspace, 'Native fixture source');
  const openTui = async (id: string) => {
    const command = bridge!.remoteLaunch(id, executable, workspace);
    const child = pty.spawn(command.file, command.args, { cols: 110, rows: 32, cwd: workspace, env: { ...env, ...command.env } as Record<string, string> });
    const terminal = new headless.Terminal({ cols: 110, rows: 32, scrollback: 1000, allowProposedApi: true });
    const view = { child, terminal, exited: false, text: () => Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n') };
    terminals.push(view);
    terminal.onData(data => { if (!view.exited) child.write(data); });
    child.onData(data => terminal.write(data));
    child.onExit(() => { view.exited = true; });
    await waitFor(() => /gpt-5\.6|Native fixture|context left|context used/.test(view.text()), 'Native remote TUI did not attach');
    return view;
  };
  const sourceTui = await openTui(source.nativeSessionId);
  const submit = async (view: typeof sourceTui, text: string) => {
    view.child.write(text);
    // The native TUI deliberately treats rapid text+Enter bursts as paste.
    await delay(200);
    view.child.write('\r');
  };
  await submit(sourceTui, 'SESSIONDECK_SOURCE');
  await waitFor(() => requests.some(request => request.marker === 'SESSIONDECK_SOURCE'), 'Native TUI did not submit source prompt');
  await waitFor(() => sourceTui.text().includes('SESSIONDECK_SOURCE_REPLY'), 'Native source reply did not reach its TUI');
  await waitFor(async () => JSON.stringify(await history(source.nativeSessionId)).includes('SESSIONDECK_SOURCE_REPLY'), 'Native source turn did not persist');
  const sourceHistory = await history(source.nativeSessionId);
  const child = await bridge.forkSession(source.nativeSessionId, workspace);
  assert.notEqual(child.nativeSessionId, source.nativeSessionId);
  assert.ok(JSON.stringify(await history(child.nativeSessionId)).includes('SESSIONDECK_SOURCE_REPLY'));
  const childTui = await openTui(child.nativeSessionId);
  await submit(childTui, 'SESSIONDECK_CHILD');
  await waitFor(() => childTui.text().includes('SESSIONDECK_CHILD_REPLY'), 'Child native TUI did not complete its turn');
  assert.deepEqual(await history(source.nativeSessionId), sourceHistory, 'Child native execution changed source history');
  await submit(childTui, 'SESSIONDECK_APPROVAL');
  await waitFor(async () => (await bridge!.getStatus(child.nativeSessionId)).status === 'waiting_approval', 'Native tool request did not produce an approval state');
  await waitFor(() => /Would you like|approve|Yes, proceed|Run this command|No, and/.test(childTui.text()), 'Native approval prompt did not appear in the TUI');
  childTui.child.write('\x1b');
  await waitFor(() => childTui.text().includes('SESSIONDECK_APPROVAL_REPLY') || /interrupt|denied|reject/.test(childTui.text()), 'TUI did not handle approval rejection');
  await waitFor(async () => ['idle', 'waiting_input'].includes((await bridge!.getStatus(child.nativeSessionId)).status), 'Rejected native approval remained active');
  await assert.rejects(access(join(directory, 'must-not-execute.txt')), 'Rejected native approval executed its command');
  await submit(childTui, 'SESSIONDECK_CANCEL');
  await waitFor(() => held.size === 1, 'Cancellation turn did not reach mock provider');
  await bridge.stopSession(child.nativeSessionId);
  await waitFor(() => cancellations === 1, 'Native cancellation did not abort its local HTTP stream');
  console.log(JSON.stringify({ result: 'passed', version: (await run(executable, ['--version'], { env, cwd: workspace })).stdout.trim(), provider: 'deterministic local Responses fixture', networkNamespace: 'isolated; loopback only', nativeIdentity: true, remoteTuiAttach: true, nativeTuiPrompt: true, nativeCompletion: true, nativeFork: true, inheritedContext: true, independentChild: true, nativeCancellation: true, nativeApproval: true, rejectedCommandNotExecuted: true, localModelRequests: requests.length, externalModelRequests: 0, realCredentialsUsed: false }, null, 2));
} finally {
  for (const view of terminals) if (!view.exited) view.child.kill();
  await bridge?.close();
  for (const response of held) response.destroy();
  provider.closeAllConnections();
  await new Promise<void>(accept => provider.close(() => accept()));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (terminals.every(view => view.exited)) break;
    await delay(25);
  }
  for (const view of terminals) { if (!view.exited) view.child.kill('SIGKILL'); view.terminal.dispose(); }
  if (bridge) {
    const shutdownDeadline = Date.now() + 3000;
    let stopped = false;
    while (Date.now() < shutdownDeadline) {
      try { await fetch(bridge.endpoint.replace('ws:', 'http:') + '/readyz', { signal: AbortSignal.timeout(200) }); await delay(25); }
      catch { stopped = true; break; }
    }
    assert.ok(stopped, 'Native app-server did not stop during cleanup');
  }
  process.chdir(tmpdir());
  await rm(directory, { recursive: true, force: true });
}
