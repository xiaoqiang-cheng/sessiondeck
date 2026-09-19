/**
 * Optional, local CLI compatibility check: npx tsx scripts/native-cli-smoke.ts
 * Uses temporary backend configuration and workspaces; sends no input or model prompt.
 * This verifies argument parsing/startup only, not authenticated model execution or Fork.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { buildLaunch, findExecutable } from '../server/adapters.ts';
import { Store } from '../server/store.ts';
import { stripTerminal } from '../server/terminal.ts';
import type { Backend } from '../shared/types.ts';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directory = mkdtempSync(join(tmpdir(), 'sessiondeck-native-smoke-'));
const store = new Store(':memory:');
const hookEvents: string[] = [];
const callback = createServer((req, res) => {
  let input = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { if (input.length < 65_536) input += chunk; });
  req.on('end', () => {
    try {
      const event = JSON.parse(input) as { source?: string; payload?: { hook_event_name?: string; type?: string } };
      hookEvents.push(`${event.source ?? 'unknown'}:${event.payload?.hook_event_name ?? event.payload?.type ?? 'unknown'}`);
    } catch { /* report only recognized event names, never raw content */ }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
});
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const children = new Set<pty.IPty>();

async function check(backend: Exclude<Backend, 'dsh'>, port: number) {
  const executable = await findExecutable(backend);
  if (!executable) return { backend, result: 'skipped: native executable not installed' };
  const workspace = join(directory, `${backend}-workspace`);
  const config = join(directory, `${backend}-config`);
  mkdirSync(workspace); mkdirSync(config);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/(TOKEN|API_KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) env[key] = value;
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Override only the spawned backend's documented config location, never the parent environment.
  if (backend === 'claude') env.CLAUDE_CONFIG_DIR = config;
  else env.CODEX_HOME = config;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  const version = (await run(executable, ['--version'], { cwd: workspace, env, timeout: 5000 })).stdout.trim();
  const contact = store.addSession({ backend, title: 'Native startup compatibility check', cwd: workspace });
  const command = await buildLaunch(contact);
  const hook = [process.execPath, join(root, 'server/native-hook.cjs'), `http://127.0.0.1:${port}/native-event`, randomBytes(16).toString('hex'), backend];
  if (backend === 'claude') {
    const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest'].map(event => [event, [{ hooks: [{ type: 'command', command: hook.map(shellQuote).join(' '), timeout: 3 }] }]]));
    command.args.push('--settings', JSON.stringify({ hooks }));
  } else command.args.push('-c', `notify=${JSON.stringify(hook)}`);

  let output = '';
  let timedOut = false;
  const child = pty.spawn(command.file, command.args, { name: 'xterm-256color', cols: 110, rows: 34, cwd: workspace, env });
  children.add(child);
  const exited = new Promise<number>(accept => {
    child.onData(chunk => { output = (output + chunk).slice(-40_000); });
    child.onExit(event => { children.delete(child); accept(event.exitCode); });
  });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 8000);
  let exitCode: number;
  try { exitCode = await exited; } finally { clearTimeout(timer); }
  const visible = stripTerminal(output).replace(/\x1b[^\n]*/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const rejected = /(?:unknown (?:option|argument)|unexpected argument|unrecognized option|invalid (?:value|configuration|settings)|failed to parse|error parsing|error loading config)/i.test(visible);
  const initialized = /(?:Welcome|Claude Code|Sign in|Log in|login|trust|theme|OpenAI|codex)/i.test(visible);
  const blocked = /(?:Unable to connect|Failed to connect|network|Status\s*403|could not connect|connection refused)/i.test(visible);
  if (rejected || (!initialized && !blocked && !timedOut)) process.exitCode = 1;
  return {
    backend, version, result: rejected ? 'arguments rejected' : initialized ? 'initialized; no input sent' : blocked ? 'network blocked startup; no argument error observed' : 'startup inconclusive',
    terminatedAtTimeout: timedOut, exitCode,
    output: visible.slice(0, 1800),
    limitation: 'No login, trust confirmation, prompt, authenticated request, resume, or fork was attempted.',
  };
}

try {
  await new Promise<void>((accept, reject) => { callback.once('error', reject); callback.listen(0, '127.0.0.1', accept); });
  const address = callback.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate local hook callback');
  for (const backend of ['claude', 'codex'] as const) console.log(JSON.stringify(await check(backend, address.port), null, 2));
  console.log(JSON.stringify({ hookEvents, isolated: true, modelPromptsSent: 0 }));
} finally {
  for (const child of children) child.kill();
  await new Promise<void>(accept => callback.close(() => accept()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
