import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { CodexBridge } from './codex.ts';
import { acquireInstanceLock } from './instance-lock.ts';

async function freePort() {
  const server = createServer();
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => server.close(() => accept()));
  return address.port;
}
async function live(pid: number) {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
    }
    process.kill(pid, 0); return true;
  } catch { return false; }
}
async function until(check: () => Promise<boolean>, detail: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await delay(20); }
  assert.fail(detail);
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  child.kill('SIGKILL'); await exited;
}

test('service SIGTERM retains the data lease until stubborn native PTYs exit', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deck-service-lifetime-'));
  const executable = join(directory, 'claude.cjs'), pidFile = join(directory, 'native.pid'), dataDir = join(directory, 'deck');
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('fixture');process.exit(0);}
if(process.argv.includes('--help')){console.log('--resume --fork-session');process.exit(0);}
process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});
fs.writeFileSync(process.env.SESSIONDECK_TEST_PID,String(process.pid));
setInterval(()=>{},1000);`, { mode: 0o700 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, SESSIONDECK_PORT: String(port), SESSIONDECK_DATA_DIR: dataDir, SESSIONDECK_CLAUDE_BIN: executable, SESSIONDECK_CODEX_BIN: '/nonexistent', SESSIONDECK_DSH_BIN: '/nonexistent', SESSIONDECK_TEST_PID: pidFile }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk; });
  let pid = 0;
  t.after(async () => { await kill(child); if (pid && await live(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } await rm(directory, { recursive: true, force: true }); });
  await until(async () => { try { return (await fetch(`${base}/api/config`)).ok; } catch { return false; } }, `Fixture service did not start: ${stderr}`);
  const config = await (await fetch(`${base}/api/config`)).json() as { csrfToken: string };
  const post = async (path: string, body: unknown = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sessiondeck-token': config.csrfToken }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status < 300, true, JSON.stringify(data)); return data;
  };
  const session = await post('/api/sessions', { backend: 'claude', cwd: directory, title: 'Shutdown fixture' }) as { id: string };
  await post(`/api/sessions/${session.id}/start`);
  await until(async () => { try { pid = Number(await readFile(pidFile, 'utf8')); return pid > 0; } catch { return false; } }, 'Native PTY did not start');
  const firstPid = pid;
  const stopped = post(`/api/sessions/${session.id}/stop`);
  await delay(100);
  const restarting = await fetch(`${base}/api/sessions/${session.id}/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sessiondeck-token': config.csrfToken }, body: '{}' });
  assert.equal(restarting.status, 409, 'restart is refused while native cleanup is pending');
  await stopped;
  assert.equal(await live(firstPid), false, 'stop response must wait for the old process to exit');
  await post(`/api/sessions/${session.id}/start`);
  await until(async () => { pid = Number(await readFile(pidFile, 'utf8')); return pid !== firstPid; }, 'replacement did not start');
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  child.kill('SIGTERM');
  await delay(100);
  assert.equal(child.exitCode, null, 'Service exited before native cleanup completed');
  await assert.rejects(acquireInstanceLock(dataDir), /已有 SessionDeck 实例/);
  await exited;
  assert.equal(child.exitCode, 0, stderr);
  assert.equal(await live(pid), false, 'Native process survived service shutdown');
  const lease = await acquireInstanceLock(dataDir);
  await lease.release();
});

test('Codex repeated stop/start waits for its old listener and removes only that generation token', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deck-codex-lifetime-'));
  const executable = join(directory, 'codex.cjs'), pidFile = join(directory, 'native.pids');
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http');
const args=process.argv.slice(2),port=Number(new URL(args[args.indexOf('--listen')+1]).port);
process.on('SIGTERM',()=>{});
fs.appendFileSync(process.env.SESSIONDECK_TEST_PID,String(process.pid)+'\\n');
http.createServer((_request,response)=>response.end('ready')).listen(port,'127.0.0.1');`, { mode: 0o700 });
  const bridge = new CodexBridge({ executable, port: await freePort(), dataDir: directory, env: { PATH: process.env.PATH, SESSIONDECK_TEST_PID: pidFile } });
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  await bridge.start();
  for (let cycle = 0; cycle < 3; cycle++) {
    const ids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number);
    const oldPid = ids.at(-1)!;
    const stopping = bridge.stop();
    await Promise.all([bridge.start(), stopping]);
    assert.equal(await live(oldPid), false, 'Previous native process survived its replacement');
    assert.equal((await readdir(directory)).filter(name => name.endsWith('.token')).length, 1, 'Only the active generation may own a token file');
    assert.equal((await readFile(pidFile, 'utf8')).trim().split('\n').length, cycle + 2);
  }
  await bridge.close();
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.token')).length, 0);
  await assert.rejects(bridge.start(), /正在关闭/);
});
