/** Optional real Claude Code TUI and Hooks workflow with local Messages SSE.
 * Linux network namespaces isolate the CLI, fake provider, and hook callbacks.
 * npm exec tsx scripts/claude-workflow-smoke.ts */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { findExecutable } from '../server/adapters.ts';

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
assert.ok(process.env.SESSIONDECK_PARENT_NETWORK_NAMESPACE, 'Start this script through its network namespace wrapper');
assert.notEqual(await readlink('/proc/self/ns/net'), process.env.SESSIONDECK_PARENT_NETWORK_NAMESPACE);
await run('ip', ['link', 'set', 'lo', 'up'], { env: minimalEnv });
const networkLinks = JSON.parse((await run('ip', ['-j', 'link', 'show'], { env: minimalEnv })).stdout) as { ifname: string }[];
assert.deepEqual(networkLinks.map(link => link.ifname), ['lo']);
const executable = await findExecutable('claude');
if (!executable) { console.log(JSON.stringify({ result: 'skipped', reason: 'Claude Code is not installed' })); process.exit(0); }

const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-claude-workflow-'));
const workspace = join(directory, 'workspace'), nativeHome = join(directory, 'claude');
await Promise.all([mkdir(workspace), mkdir(nativeHome)]);
// A fresh interactive onboarding performs a hard-coded Anthropic connectivity
// check before it honors the custom model endpoint. Mark only that introduction
// complete in this disposable profile; workspace/tool approval stays native.
await writeFile(join(nativeHome, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }), { mode: 0o600 });
process.chdir(workspace);
const held = new Set<ServerResponse>();
const requests: { marker: string; input: string }[] = [];
const hooks: { hook_event_name: string; session_id: string }[] = [];
let fixtureError: Error | undefined;
let cancellations = 0;
type View = { child: pty.IPty; terminal: headless.Terminal; text(): string; exited: boolean };
const terminals: View[] = [];
const provider = createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) { body += chunk; if (body.length > 4_000_000) throw new Error('Fixture input exceeded maximum length'); }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
    if (url.pathname === '/native-event') {
      const payload = JSON.parse(body).payload;
      assert.equal(typeof payload.session_id, 'string');
      assert.equal(typeof payload.hook_event_name, 'string');
      hooks.push({ hook_event_name: payload.hook_event_name, session_id: payload.session_id });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return;
    }
    if (url.pathname === '/v1/messages/count_tokens') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":100}'); return; }
    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/v1/messages');
    assert.equal(request.headers['x-api-key'], 'sessiondeck-local-fixture-only');
    const input = JSON.parse(body) as { messages: unknown[]; model: string; stream: boolean };
    assert.equal(input.stream, true);
    const text = JSON.stringify(input.messages);
    const marker = ['SESSIONDECK_SOURCE', 'SESSIONDECK_CHILD', 'SESSIONDECK_CANCEL', 'SESSIONDECK_APPROVAL', 'SESSIONDECK_ACCEPT'].filter(value => text.includes(value)).sort((a, b) => text.lastIndexOf(b) - text.lastIndexOf(a))[0];
    assert.ok(marker, 'Unexpected local fixture prompt');
    requests.push({ marker, input: text });
    const answer = `${marker}_REPLY`;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type: string, payload: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    event('message_start', { message: { id: `msg_fixture_${requests.length}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    const toolId = marker === 'SESSIONDECK_ACCEPT' ? 'tool_fixture_accept' : 'tool_fixture_approval';
    if (['SESSIONDECK_APPROVAL', 'SESSIONDECK_ACCEPT'].includes(marker) && !text.includes(`"tool_use_id":"${toolId}"`)) {
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } });
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `printf fixture > ${join(directory, marker === 'SESSIONDECK_ACCEPT' ? 'approved-fixture.txt' : 'must-not-execute.txt')}`, description: `SessionDeck fixture: ${marker === 'SESSIONDECK_ACCEPT' ? 'approve' : 'reject'} this harmless test write` }) } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } });
      event('message_stop', {}); response.end(); return;
    }
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: answer } });
    if (marker === 'SESSIONDECK_CANCEL') {
      held.add(response);
      response.once('close', () => { held.delete(response); cancellations++; });
      return;
    }
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
    event('message_stop', {});
    response.end();
  } catch (error) {
    fixtureError = error instanceof Error ? error : new Error(String(error));
    if (response.headersSent) response.destroy();
    else { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { type: 'api_error', message: fixtureError.message } })); }
  }
});
async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (await check()) return;
    await delay(75);
  }
  throw new Error(`${description}\n${terminals.map(view => view.text().slice(-4000)).join('\n')}`);
}
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

try {
  await new Promise<void>(accept => provider.listen(0, '127.0.0.1', accept));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  const env = { ...minimalEnv, CLAUDE_CONFIG_DIR: nativeHome, ANTHROPIC_API_KEY: 'sessiondeck-local-fixture-only', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_TELEMETRY: '1', TERM: 'xterm-256color' };
  const hook = [process.execPath, fileURLToPath(new URL('../server/native-hook.cjs', import.meta.url)), `http://127.0.0.1:${address.port}/native-event`, 'fixture-only', 'claude'].map(shellQuote).join(' ');
  const settings = { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification', 'PermissionRequest'].map(event => [event, [{ hooks: [{ type: 'command', command: hook, timeout: 3 }] }]])) };
  const openTui = async (id: string, source?: string) => {
    const args = [...(source ? ['--resume', source, '--fork-session'] : []), '--session-id', id, '--name', source ? 'Native fixture child' : 'Native fixture source', '--model', 'claude-sonnet-4-6', '--settings', JSON.stringify(settings), '--setting-sources', '', '--strict-mcp-config', '--no-chrome'];
    const child = pty.spawn(executable, args, { cols: 110, rows: 34, cwd: workspace, env: env as Record<string, string> });
    const terminal = new headless.Terminal({ cols: 110, rows: 34, scrollback: 1000, allowProposedApi: true });
    const view: View = { child, terminal, exited: false, text: () => Array.from({ length: terminal.buffer.active.length }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n') };
    terminals.push(view);
    terminal.onData(data => { if (!view.exited) child.write(data); });
    child.onData(data => terminal.write(data));
    child.onExit(() => { view.exited = true; });
    const handled = new Set<string>();
    await waitFor(() => {
      const screen = view.text();
      if (/Choose the text style|Choose the theme|Let's get started|Select the text style/.test(screen) && !handled.has('theme')) { handled.add('theme'); child.write('\r'); }
      if (/Do you trust the files|trust this folder|Is this a project you created/.test(screen) && screen.includes('Enter to confirm') && !handled.has('trust')) {
        handled.add('trust');
        setTimeout(() => { if (!view.exited && /❯ No, exit/.test(view.text())) child.write('\x1b[B'); }, 300);
        setTimeout(() => { if (!view.exited) child.write('\r'); }, 600);
      }
      if (screen.includes('Do you want to use this API key?') && screen.includes('No (recommended)') && !handled.has('key')) {
        handled.add('key');
        setTimeout(() => { if (!view.exited) child.write('\x1b[A'); }, 300);
        setTimeout(() => { if (!view.exited) child.write('\r'); }, 600);
      }
      return hooks.some(event => event.session_id === id && event.hook_event_name === 'SessionStart') && /Native fixture|Try |for shortcuts/.test(screen);
    }, 'Claude native TUI did not become ready');
    return view;
  };
  const submit = async (view: View, text: string) => { view.child.write(text); await delay(250); view.child.write('\r'); };
  const sourceId = randomUUID(), childId = randomUUID();
  const sourceTui = await openTui(sourceId);
  await submit(sourceTui, 'SESSIONDECK_SOURCE');
  await waitFor(() => hooks.some(event => event.session_id === sourceId && event.hook_event_name === 'Stop') && sourceTui.text().includes('SESSIONDECK_SOURCE_REPLY'), 'Source turn did not finish with its native hook');
  const nativeHistory = async (id: string) => {
    for (const project of await readdir(join(nativeHome, 'projects'))) {
      try { return await readFile(join(nativeHome, 'projects', project, `${id}.jsonl`), 'utf8'); } catch { /* next project */ }
    }
    throw new Error(`Native history not persisted for ${id}`);
  };
  await waitFor(async () => {
    try { return (await nativeHistory(sourceId)).includes('SESSIONDECK_SOURCE_REPLY'); }
    catch { return false; }
  }, 'Source native history did not finish flushing before Fork');
  const before = await nativeHistory(sourceId);
  assert.ok(before.includes('SESSIONDECK_SOURCE_REPLY'));
  const childTui = await openTui(childId, sourceId);
  await submit(childTui, 'SESSIONDECK_CHILD');
  await waitFor(() => hooks.some(event => event.session_id === childId && event.hook_event_name === 'Stop') && childTui.text().includes('SESSIONDECK_CHILD_REPLY'), 'Child turn did not finish');
  // Claude can send Stop before its queued transcript writes reach disk.
  // Wait for observable native persistence instead of racing that flush.
  await waitFor(async () => {
    try { return (await nativeHistory(childId)).includes('SESSIONDECK_SOURCE_REPLY'); }
    catch { return false; }
  }, 'Fork did not persist the inherited source context');
  assert.equal(await nativeHistory(sourceId), before, 'Child prompt changed source native history');
  const childRequest = requests.find(request => request.marker === 'SESSIONDECK_CHILD');
  assert.ok(childRequest?.input.includes('SESSIONDECK_SOURCE_REPLY'), 'Fork did not send inherited context to the provider');
  await submit(childTui, 'SESSIONDECK_ACCEPT');
  await waitFor(() => hooks.some(event => event.session_id === childId && event.hook_event_name === 'PermissionRequest') && childTui.text().includes('approved-fixture') && childTui.text().includes('Do you want to proceed?'), 'Claude approval did not appear for the disposable fixture write');
  childTui.child.write('1');
  await delay(200);
  childTui.child.write('\r');
  await waitFor(() => hooks.some(event => event.session_id === childId && event.hook_event_name === 'PostToolUse') && childTui.text().includes('SESSIONDECK_ACCEPT_REPLY'), 'Native approved tool did not return through its lifecycle hook');
  assert.equal(await readFile(join(directory, 'approved-fixture.txt'), 'utf8'), 'fixture');
  const approvalCount = hooks.filter(event => event.session_id === childId && event.hook_event_name === 'PermissionRequest').length;
  await submit(childTui, 'SESSIONDECK_APPROVAL');
  await waitFor(() => hooks.filter(event => event.session_id === childId && event.hook_event_name === 'PermissionRequest').length > approvalCount, 'Claude did not emit its native approval hook');
  await waitFor(() => /Do you want to proceed|Allow|Yes/.test(childTui.text()) && childTui.text().includes('must-not-execute'), 'Claude approval request did not appear in native TUI');
  childTui.child.write('\x1b');
  await waitFor(() => /Interrupted|rejected|denied/.test(childTui.text()) || childTui.text().includes('SESSIONDECK_APPROVAL_REPLY'), 'Native approval rejection did not settle');
  await assert.rejects(access(join(directory, 'must-not-execute.txt')), 'Rejected Claude command executed');
  await submit(childTui, 'SESSIONDECK_CANCEL');
  await waitFor(() => held.size === 1, 'Cancellation prompt did not reach loopback provider');
  childTui.child.write('\x1b');
  await waitFor(() => cancellations === 1, 'Native Escape did not cancel the provider HTTP stream');
  assert.ok(hooks.some(event => event.session_id === sourceId && event.hook_event_name === 'UserPromptSubmit'));
  assert.ok(hooks.some(event => event.session_id === childId && event.hook_event_name === 'UserPromptSubmit'));
  console.log(JSON.stringify({ result: 'passed', version: (await run(executable, ['--version'], { env, cwd: workspace })).stdout.trim(), provider: 'deterministic local Messages fixture', networkNamespace: 'isolated; loopback only', disposableOnboardingFixture: true, nativeWorkspaceTrustAndApiKeyConfirmation: true, nativeTuiPrompt: true, nativeHooksAndIdentity: true, nativeCompletion: true, nativeFork: true, inheritedContext: true, independentChild: true, nativeApproval: true, approvedToolCompletionHook: true, rejectedCommandNotExecuted: true, nativeCancellation: true, localModelRequests: requests.length, externalModelRequests: 0, realCredentialsUsed: false }, null, 2));
} finally {
  for (const view of terminals) if (!view.exited) view.child.kill();
  for (const response of held) response.destroy();
  provider.closeAllConnections();
  await new Promise<void>(accept => provider.close(() => accept()));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && terminals.some(view => !view.exited)) await delay(25);
  for (const view of terminals) { if (!view.exited) view.child.kill('SIGKILL'); view.terminal.dispose(); }
  process.chdir(tmpdir());
  await rm(directory, { recursive: true, force: true });
}
