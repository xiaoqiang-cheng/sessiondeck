import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { listDirectories, normalizeDirectoryInput } from './directories.ts';

test('directory input accepts copied paths, relative paths and encoded file links without shell evaluation', () => {
  assert.equal(normalizeDirectoryInput('  "/tmp/a b"  '), '/tmp/a b');
  assert.equal(normalizeDirectoryInput("'/tmp/a b'"), '/tmp/a b');
  assert.equal(normalizeDirectoryInput('../project', '/tmp/work'), '/tmp/project');
  assert.equal(normalizeDirectoryInput('~/project'), join(homedir(), 'project'));
  assert.equal(normalizeDirectoryInput('~'), homedir());
  assert.equal(normalizeDirectoryInput(pathToFileURL('/tmp/项目 #1').href), '/tmp/项目 #1');
  assert.equal(normalizeDirectoryInput('/tmp/$(touch nope)'), '/tmp/$(touch nope)');
  assert.equal(normalizeDirectoryInput('file://localhost/tmp/project'), '/tmp/project');
  for (const input of [null, 12, '', "''", '/tmp/\nfile', '/tmp/\0file', 'file:///tmp/%00file', 'file://other-host/tmp', 'file:///tmp/a?x=1', 'https://example.com/project', 'file:///tmp/%2Fproject']) {
    assert.throws(() => normalizeDirectoryInput(input), Error);
  }
});

test('directory listing excludes files and hidden names, validates symlinks and keeps canonical identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-directories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  await mkdir(join(root, '.private'));
  await writeFile(join(root, 'file.txt'), 'fixture');
  await symlink(join(root, 'project'), join(root, 'linked'));
  await symlink(join(root, 'missing'), join(root, 'broken'));
  await symlink(join(root, 'file.txt'), join(root, 'file-link'));
  const result = await listDirectories(pathToFileURL(root).href);
  assert.equal(result.path, root);
  assert.equal(result.canonicalPath, await realpath(root));
  assert.equal(result.homePath, homedir());
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries, [
    { name: 'linked', path: join(root, 'linked'), symlink: true },
    { name: 'project', path: join(root, 'project'), symlink: false },
  ]);
  assert.deepEqual((await listDirectories(root, { showHidden: true })).entries.map(entry => entry.name), ['.private', 'linked', 'project']);
  const linked = await listDirectories(join(root, 'linked'));
  assert.equal(linked.path, join(root, 'linked'));
  assert.equal(linked.canonicalPath, await realpath(join(root, 'project')));
  assert.equal(linked.parentPath, root);
  await assert.rejects(listDirectories(join(root, 'file.txt')), /不能选择文件/);
  await assert.rejects(listDirectories(join(root, 'missing')), /不存在/);
  assert.equal((await listDirectories(undefined, { base: root })).path, root);
});

test('directory listing bounds returned folders and inspected entries, including hidden-only directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-directories-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 12; index++) await mkdir(join(root, `dir${index}`));
  const limited = await listDirectories(root, { limit: 3 });
  assert.equal(limited.entries.length, 3);
  assert.equal(limited.truncated, true);
  const scanned = await listDirectories(root, { scanLimit: 2 });
  assert.equal(scanned.entries.length, 2);
  assert.equal(scanned.truncated, true);
  const hidden = join(root, 'hidden-only');
  await mkdir(hidden);
  for (let index = 0; index < 5; index++) await mkdir(join(hidden, `.hidden${index}`));
  const hiddenScan = await listDirectories(hidden, { scanLimit: 2 });
  assert.deepEqual(hiddenScan.entries, []);
  assert.equal(hiddenScan.truncated, true);
});
