import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { OwnedProcess } from './owned-process.ts';

async function live(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
  } catch { return false; }
}

test('owned process cleanup escalates a stubborn multigeneration tree and preserves detached work', { skip: process.platform !== 'linux', timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'deck-owned-tree-'));
  const script = join(directory, 'tree.cjs'), report = join(directory, 'pids.jsonl');
  await writeFile(script, `const fs=require('node:fs'),{spawn}=require('node:child_process');
const role=process.argv[2]||'root';
process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});
fs.appendFileSync(process.env.REPORT,JSON.stringify({role,pid:process.pid})+'\\n');
if(role==='root'){spawn(process.execPath,[__filename,'child'],{stdio:'ignore',env:process.env});spawn(process.execPath,[__filename,'detached'],{detached:true,stdio:'ignore',env:process.env}).unref();}
if(role==='child')spawn(process.execPath,[__filename,'grandchild'],{stdio:'ignore',env:process.env});
setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, REPORT: report }, stdio: 'ignore' });
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  const owner = new OwnedProcess(child.pid!, exited, signal => { child.kill(signal); });
  let rows: { role: string; pid: number }[] = [];
  t.after(async () => {
    child.kill('SIGKILL');
    for (const row of rows) if (await live(row.pid)) try { process.kill(row.pid, 'SIGKILL'); } catch { /* exited */ }
    await rm(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { rows = (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { /* not written */ }
    if (rows.length === 4) break;
    await delay(20);
  }
  assert.equal(rows.length, 4);
  const started = Date.now();
  const stopping = owner.stop();
  assert.equal(owner.stop(), stopping, 'Repeated stop must join the same ownership instance');
  await stopping;
  assert.ok(Date.now() - started >= 900, 'Graceful shutdown must get a bounded opportunity before escalation');
  for (const row of rows) assert.equal(await live(row.pid), row.role === 'detached', `${row.role} has incorrect post-stop lifetime`);
});

test('PID birth mismatch never invokes a signal callback for a replacement process', { skip: process.platform !== 'linux', timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let release!: () => void;
  const exited = new Promise<void>(accept => { release = accept; });
  let signals = 0;
  const owner = new OwnedProcess(child.pid!, exited, () => { signals++; });
  t.after(() => { child.kill('SIGKILL'); });
  // Simulate the kernel having reused the numeric PID. The guard must compare
  // the captured birth identity before any signal, including the first one.
  const captured = owner as unknown as { original: { birth: string } };
  assert.ok(captured.original);
  captured.original.birth = `${captured.original.birth}-different-lifetime`;
  const stopping = owner.stop();
  await delay(40);
  release();
  await stopping;
  assert.equal(signals, 0);
  assert.equal(await live(child.pid!), true);
});

test('cleanup follows a PTY session change while retaining the captured birth identity', { skip: process.platform !== 'linux', timeout: 5000 }, async t => {
  const script = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
child.stdout.once('data',()=>process.stdout.write(String(child.pid)+'\\n'));
setInterval(()=>{},1000);`;
  const root = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(accept => root.once('exit', () => accept()));
  const owner = new OwnedProcess(root.pid!, exited, signal => { root.kill(signal); });
  let output = '', descendantPid = 0;
  root.stdout.on('data', chunk => { output += chunk.toString(); });
  t.after(async () => {
    root.kill('SIGKILL');
    if (descendantPid && await live(descendantPid)) try { process.kill(descendantPid, 'SIGKILL'); } catch { /* exited */ }
  });
  for (let attempt = 0; attempt < 100 && !output.includes('\n'); attempt++) await delay(10);
  descendantPid = Number(output.trim());
  assert.ok(descendantPid > 0);
  assert.equal(await live(descendantPid), true);
  const captured = owner as unknown as { original: { birth: string; session: number } };
  const birth = captured.original.birth;
  // node-pty can return before its forked child calls setsid. Reproduce that
  // stale pre-setsid snapshot deterministically without depending on scheduling.
  captured.original.session = process.pid;
  await owner.stop('SIGHUP');
  assert.equal(captured.original.birth, birth);
  assert.equal(await live(root.pid!), false);
  assert.equal(await live(descendantPid), false, 'A session change must not orphan an owned descendant');
});

test('already exited owned process cleanup does not signal any PID', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  let signals = 0;
  const owner = new OwnedProcess(child.pid!, exited, () => { signals++; });
  await exited;
  await owner.stop();
  assert.equal(signals, 0);
});

test('failed spawn without a PID settles cleanup through close without signaling a process', { skip: process.platform !== 'linux', timeout: 5000 }, async () => {
  const child = spawn('/definitely-missing-sessiondeck-native-fixture', [], { stdio: 'ignore' });
  child.on('error', () => { /* expected ENOENT */ });
  const closed = new Promise<void>(accept => child.once('close', () => accept()));
  let signals = 0;
  const owner = new OwnedProcess(child.pid ?? 0, closed, signal => { signals++; child.kill(signal); });
  await owner.stop();
  assert.equal(child.pid, undefined);
  assert.equal(signals, 0);
});
