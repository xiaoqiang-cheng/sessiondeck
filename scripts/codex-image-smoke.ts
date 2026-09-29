/**
 * Verify the native Codex TUI image-path paste flow against a disposable,
 * loopback-only Responses fixture.
 *
 * npm exec tsx scripts/codex-image-smoke.ts
 *
 * The browser does not provide a binary image to a PTY. Codex's native
 * composer does, however, accept a bracketed-pasted local image path, encode
 * it, and submit an input_image item. This check covers that native boundary
 * without using real credentials or a cloud model.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { CodexBridge } from '../server/codex.ts';
import { findExecutable } from '../server/adapters.ts';
import { OwnedProcess } from '../server/owned-process.ts';

type FixtureInputPart = Record<string, unknown>;
type FixtureInputItem = Record<string, unknown>;
type FixtureRequest = { input?: unknown; model?: string; stream?: boolean };

const executable = await findExecutable('codex');
if (!executable) {
  console.log(JSON.stringify({ result: 'skipped', reason: 'Codex is not installed' }));
  process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-image-'));
const workspace = join(directory, 'workspace');
const nativeHome = join(directory, 'codex');
const auditPath = join(directory, 'network-audit.txt');
// Include shell metacharacters to verify that the path remains one literal
// token when Codex's native composer parses the pasted attachment path.
const imagePath = join(workspace, 'fixture \'quoted\' "image" $value`name`.png');
const run = promisify(execFile);

const requests: FixtureRequest[] = [];
let captured: FixtureRequest | undefined;
let fixtureError: Error | undefined;
let bridge: CodexBridge | undefined;
let terminal: pty.IPty | undefined;
let terminalOwner: OwnedProcess | undefined;
let terminalScreen: headless.Terminal | undefined;
let terminalExited = false;

const fixture = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer sessiondeck-image-fixture-only');
    const body = await readRequest(request);
    const input = JSON.parse(body) as FixtureRequest;
    assert.equal(input.stream, true);
    const serialized = JSON.stringify(input.input);
    assert.ok(serialized.includes('SESSIONDECK_IMAGE_PROMPT'), 'Unexpected native fixture prompt');
    captured = input;
    requests.push(input);

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let sequence = 0;
    const event = (type: string, payload: Record<string, unknown>) => {
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);
    };
    const result = {
      id: 'resp_sessiondeck_image_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', model: input.model, output: [] as unknown[],
    };
    const item = {
      id: 'msg_sessiondeck_image_fixture', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'SESSIONDECK_IMAGE_REPLY', annotations: [] }],
    };
    event('response.created', { response: result });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'SESSIONDECK_IMAGE_REPLY' });
    event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'SESSIONDECK_IMAGE_REPLY' });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { ...result, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 8, total_tokens: 108 } } });
    response.end();
  } catch (cause) {
    fixtureError = cause instanceof Error ? cause : new Error(String(cause));
    if (response.headersSent) response.destroy();
    else { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: fixtureError.message } })); }
  }
});

async function readRequest(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    assert.ok(body.length < 4_000_000, 'Fixture request is unexpectedly large');
  }
  return body;
}

function screenText(): string {
  const buffer = terminalScreen?.buffer.active;
  if (!buffer) return '';
  return Array.from({ length: terminalScreen!.rows }, (_, offset) => buffer.getLine(buffer.viewportY + offset)?.translateToString(true) ?? '').join('\n');
}

async function waitFor(check: () => boolean, description: string, timeout = 25_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fixtureError) throw fixtureError;
    if (terminalExited) throw new Error(`${description}\nNative TUI exited:\n${screenText()}`);
    if (check()) return;
    await delay(50);
  }
  throw new Error(`${description}\n${screenText()}`);
}

function imageParts(input: FixtureRequest): FixtureInputPart[] {
  const items = Array.isArray(input.input) ? input.input : [];
  const user = [...items].reverse().find((item): item is FixtureInputItem => (
    typeof item === 'object' && item !== null && item.role === 'user'
  ));
  const content = user && Array.isArray(user.content) ? user.content : [];
  return content.filter((part): part is FixtureInputPart => typeof part === 'object' && part !== null);
}

try {
  await Promise.all([mkdir(workspace), mkdir(nativeHome)]);
  // A valid 1x1 PNG keeps this smoke test self-contained and deterministic.
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  await writeFile(join(nativeHome, 'config.toml'), `model = "gpt-5.6-terra"
model_provider = "sessiondeck_image_fixture"
approval_policy = "on-request"
sandbox_mode = "read-only"
web_search = "disabled"
check_for_update_on_startup = false

[features]
enable_request_compression = false
apps = false

[model_providers.sessiondeck_image_fixture]
name = "SessionDeck image fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
env_key = "SESSIONDECK_IMAGE_FIXTURE_KEY"
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

  const minimalEnv: Record<string, string> = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM']) if (process.env[key]) minimalEnv[key] = process.env[key]!;
  const loopbackGuard = new URL('./fixtures/loopback-only.mjs', import.meta.url).href;
  // The guard covers the Node wrapper. The Rust executable uses the explicit
  // loopback provider above; this is not an OS-level network sandbox.
  const env = {
    ...minimalEnv,
    CODEX_HOME: nativeHome,
    SESSIONDECK_IMAGE_FIXTURE_KEY: 'sessiondeck-image-fixture-only',
    NODE_OPTIONS: `--import ${loopbackGuard}`,
    SESSIONDECK_NETWORK_AUDIT: auditPath,
  };

  bridge = new CodexBridge({ executable, dataDir: join(directory, 'deck'), env, port: 0 });
  const session = await bridge.createSession(workspace, 'Native image fixture');
  const launch = bridge.remoteLaunch(session.nativeSessionId, executable, workspace);
  terminal = pty.spawn(launch.file, launch.args, {
    name: 'xterm-256color', cols: 110, rows: 35, cwd: workspace,
    env: { ...env, ...launch.env },
  });
  const terminalExit = new Promise<void>(resolve => terminal!.onExit(() => { terminalExited = true; resolve(); }));
  terminalOwner = new OwnedProcess(terminal.pid, terminalExit, signal => terminal!.kill(signal));
  terminalScreen = new headless.Terminal({ cols: 110, rows: 35, scrollback: 1000, allowProposedApi: true });
  terminal.onData(data => terminalScreen!.write(data));
  terminalScreen.onData(data => { if (!terminalExited) terminal!.write(data); });

  // A first-run model notice can temporarily cover the composer. Escape only
  // after the notice is visible; an ordinary empty composer is left untouched.
  let dismissedNotice = false;
  let composerReadySince = 0;
  await waitFor(() => {
    const visible = screenText();
    if (/Try new model|Use existing model|Meet GPT-\d/.test(visible)) {
      if (!dismissedNotice) { terminal!.write('\x1b'); dismissedNotice = true; }
      composerReadySince = 0;
      return false;
    }
    if (!/Ask Codex to do anything|context left|context used/.test(visible)) { composerReadySince = 0; return false; }
    composerReadySince ||= Date.now();
    return Date.now() - composerReadySince > 1500;
  }, 'Native remote TUI did not expose its composer');

  // Shell single-quoting preserves the literal path for Codex's shlex parser.
  // Codex recognizes the path, reads the local image, and shows a
  // placeholder without submitting until Enter is pressed.
  const quotedPath = `'${imagePath.replace(/'/g, "'\\''")}'`;
  terminal.write(`\x1b[200~${quotedPath}\x1b[201~`);
  await waitFor(() => screenText().includes('[Image #1]'), 'Native TUI did not turn the pasted image path into an attachment');
  terminal.write('\x1b[200~ SESSIONDECK_IMAGE_PROMPT\x1b[201~');
  await delay(250);
  terminal.write('\r');
  await waitFor(() => !!captured, 'Native TUI did not submit the image prompt to the loopback provider');
  await waitFor(() => screenText().includes('SESSIONDECK_IMAGE_REPLY'), 'Native TUI did not render the fixture reply');

  const parts = imageParts(captured!);
  const image = parts.find(part => part.type === 'input_image');
  const text = parts.find(part => part.type === 'input_text');
  assert.ok(image, `Native request has no input_image part: ${JSON.stringify(parts)}`);
  assert.equal(typeof image.image_url, 'string');
  assert.match(image.image_url as string, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  assert.ok(text && typeof text.text === 'string' && text.text.includes('SESSIONDECK_IMAGE_PROMPT'), `Native request lost prompt text: ${JSON.stringify(parts)}`);
  assert.equal(requests.length, 1, 'The native image prompt was submitted more than once');
  assert.equal((await readFile(auditPath, 'utf8').catch(() => '')).trim(), '', 'Loopback guard recorded an external network attempt');
  await assert.rejects(access(join(nativeHome, 'auth.json')), 'Fixture unexpectedly wrote account credentials');

  console.log(JSON.stringify({
    result: 'passed',
    version: (await run(executable, ['--version'], { env, cwd: workspace, timeout: 5000 })).stdout.trim(),
    provider: 'explicit loopback deterministic Responses fixture',
    isolatedProfile: true,
    remoteTuiAttach: true,
    bracketedImagePathPaste: true,
    nativeImagePlaceholder: '[Image #1]',
    inputImageReceived: true,
    nativeReply: true,
    localModelRequests: requests.length,
    networkIsolation: 'explicit loopback provider; Node wrapper guard; no OS network sandbox',
    realCredentialsUsed: false,
  }, null, 2));
} finally {
  const cleanup = await Promise.allSettled([
    terminalOwner?.stop('SIGHUP'),
    bridge?.close(),
  ]);
  terminalScreen?.dispose();
  if (fixture.listening) {
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
  await rm(directory, { recursive: true, force: true });
  const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Native image fixture cleanup failed');
}
