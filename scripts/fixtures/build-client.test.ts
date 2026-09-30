import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishClientBuild } from '../build-client.ts';

test('publishing a frontend keeps lazy chunks needed by open tabs and installs new HTML last', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging'), live = join(root, 'live');
  await mkdir(join(staging, 'assets'), { recursive: true });
  await mkdir(join(live, 'assets'), { recursive: true });
  await writeFile(join(live, 'index.html'), '<script src="/assets/old.js"></script>');
  await writeFile(join(live, 'assets/old.js'), 'import("./old-chat.js")');
  await writeFile(join(live, 'assets/old-chat.js'), 'old lazy chat');
  const html = '<script src="/assets/new.js"></script>';
  await writeFile(join(staging, 'index.html'), html);
  await writeFile(join(staging, 'assets/new.js'), 'new app');
  await publishClientBuild(staging, live);
  assert.equal(await readFile(join(live, 'index.html'), 'utf8'), html);
  assert.equal(await readFile(join(live, 'assets/new.js'), 'utf8'), 'new app');
  assert.equal(await readFile(join(live, 'assets/old.js'), 'utf8'), 'import("./old-chat.js")');
  assert.equal(await readFile(join(live, 'assets/old-chat.js'), 'utf8'), 'old lazy chat');
});

test('an incomplete build or failed asset publication leaves the current entrypoint available', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-build-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging'), live = join(root, 'live');
  await mkdir(staging); await mkdir(live);
  await writeFile(join(live, 'index.html'), 'current app');
  await assert.rejects(publishClientBuild(staging, live));
  assert.equal(await readFile(join(live, 'index.html'), 'utf8'), 'current app');
  await writeFile(join(staging, 'index.html'), 'incomplete replacement');
  await symlink(join(root, 'missing-asset'), join(staging, 'asset.js'));
  await assert.rejects(publishClientBuild(staging, live), /不支持的文件类型/);
  assert.equal(await readFile(join(live, 'index.html'), 'utf8'), 'current app');
});
