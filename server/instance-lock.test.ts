import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { acquireInstanceLock } from './instance-lock.ts';

test('only one service can recover a data directory, including symlink aliases', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sessiondeck-instance-'));
  const alias = `${dir}-alias`;
  let lock = await acquireInstanceLock(dir);
  t.after(async () => { await lock.release(); await rm(alias, { force: true }); await rm(dir, { recursive: true, force: true }); });
  await symlink(dir, alias, 'dir');
  await assert.rejects(acquireInstanceLock(dir), /已有 SessionDeck 实例/);
  await assert.rejects(acquireInstanceLock(alias), /已有 SessionDeck 实例/);
  const independent = await acquireInstanceLock(join(dir, 'independent'));
  await independent.release();
  await lock.release();
  lock = await acquireInstanceLock(alias);
  await assert.rejects(acquireInstanceLock(dir), /已有 SessionDeck 实例/);
});

test('a killed owner releases the kernel lock without stale files or PID recovery', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sessiondeck-instance-crash-'));
  const module = new URL('./instance-lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { acquireInstanceLock } from ${JSON.stringify(module)}; await acquireInstanceLock(process.argv[1]); console.log('locked'); setInterval(() => {}, 1000);`, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
  await new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Owner exited too soon: ${code}`)));
    child.stdout.once('data', () => accept());
  });
  await assert.rejects(acquireInstanceLock(dir), /已有 SessionDeck 实例/);
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  child.kill('SIGKILL');
  await exited;
  const replacement = await acquireInstanceLock(dir);
  await replacement.release();
});
