import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sameDirectory } from './paths.ts';
import { acquireInstanceLock } from './instance-lock.ts';

test('directory identity accepts native canonical paths and user aliases, never a different directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-paths-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'original')); await mkdir(join(directory, 'different'));
  await symlink(join(directory, 'original'), join(directory, 'alias'));
  assert.equal(await sameDirectory(join(directory, 'alias'), await realpath(join(directory, 'original'))), true);
  assert.equal(await sameDirectory(join(directory, 'alias'), join(directory, 'different')), false);
  assert.equal(await sameDirectory(join(directory, 'missing'), join(directory, 'original')), false);
});

test('instance lock supports paths longer than Unix socket address limits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-long-lock-'));
  const path = join(directory, 'nested'.repeat(25), 'data');
  const lock = await acquireInstanceLock(path);
  t.after(async () => { await lock.release(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(acquireInstanceLock(path), /已有 SessionDeck 实例/);
  await lock.release();
  const next = await acquireInstanceLock(path); await next.release();
});
