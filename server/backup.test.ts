import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { backupMetadata, metadataDataDirectory } from './backup.ts';
import { Store } from './store.ts';

const execute = promisify(execFile);
const nativeId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-backup-test-'));
  const dataDir = join(root, 'data');
  const path = join(dataDir, 'sessiondeck.sqlite');
  const store = new Store(path);
  const group = store.addGroup('Private group title', 'Private shared objective');
  const source = store.addSession({ backend: 'codex', title: 'Private source title', cwd: root, nativeSessionId: nativeId, running: true, status: 'running' });
  const member = store.addSession({ backend: 'codex', title: 'Private fork title', cwd: root, nativeSessionId: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', parentId: source.id, groupId: group.id });
  const message = store.addMessage({ groupId: group.id, senderId: null, senderName: '用户', recipientIds: [member.id], text: 'Private task text that must not appear in output', kind: 'task' });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, path, store, group, source, member, message };
}

test('online backup includes committed live WAL data and preserves the running source', async t => {
  const item = await fixture(t);
  assert.ok((await stat(`${item.path}-wal`)).size > 0, 'The source must have real live WAL data');
  // Another connection has a write transaction in progress. Its uncommitted
  // changes must not leak into the committed backup or block WAL readers.
  item.store.db.exec('BEGIN IMMEDIATE');
  item.store.updateSession(item.source.id, { title: 'Uncommitted title' });
  item.store.updateGroup(item.group.id, { goal: 'Uncommitted objective' });
  let result;
  try { result = await backupMetadata({ dataDir: item.dataDir }); }
  finally { item.store.db.exec('ROLLBACK'); }
  assert.equal(item.store.session(item.source.id)?.running, true);
  assert.equal(item.store.session(item.source.id)?.title, 'Private source title');
  assert.deepEqual(result.counts, { sessions: 2, groups: 1, messages: 1, deliveries: 1, activities: 0 });
  assert.equal(result.sourcePath, item.path);
  assert.ok(result.bytes > 0);
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(result.path))).mode & 0o777, 0o700);
  assert.match(result.path, /backups\/sessiondeck-.*\.sqlite$/);

  const snapshot = new DatabaseSync(result.path, { readOnly: true });
  try {
    const restored = JSON.parse(String(snapshot.prepare('SELECT data FROM sessions WHERE id = ?').get(item.source.id)!.data));
    const group = JSON.parse(String(snapshot.prepare('SELECT data FROM groups WHERE id = ?').get(item.group.id)!.data));
    assert.equal(restored.running, true);
    assert.equal(restored.title, 'Private source title');
    assert.equal(group.goal, 'Private shared objective');
    assert.equal(snapshot.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
    assert.equal(snapshot.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  } finally { snapshot.close(); }
  assert.deepEqual(await readdir(dirname(result.path)), [result.path.split('/').at(-1)]);

  // Opening a copied backup as a normal Store retains contact identity, Fork
  // lineage, group messages and deliveries; startup resets only that copy.
  const restoredPath = join(item.root, 'restored', 'sessiondeck.sqlite');
  await mkdir(dirname(restoredPath), { mode: 0o700 });
  await copyFile(result.path, restoredPath);
  const restored = new Store(restoredPath);
  try {
    assert.equal(restored.session(item.source.id)?.nativeSessionId, nativeId);
    assert.equal(restored.session(item.member.id)?.parentId, item.source.id);
    assert.equal(restored.session(item.source.id)?.running, false);
    const detail = restored.groupDetail(item.group.id);
    assert.equal(detail.messages[0].text, item.message.text);
    assert.equal(detail.deliveries[0].sessionId, item.member.id);
    assert.equal(detail.deliveries[0].status, 'pending');
  } finally { restored.close(); }
  assert.equal(item.store.session(item.source.id)?.running, true);
});

test('backup never overwrites an existing target or symbolic link', async t => {
  const item = await fixture(t);
  const target = join(item.root, 'existing.sqlite');
  await writeFile(target, 'keep-existing-content');
  await assert.rejects(backupMetadata({ dataDir: item.dataDir, output: target }), /不能覆盖/);
  assert.equal(await readFile(target, 'utf8'), 'keep-existing-content');
  const linked = join(item.root, 'linked.sqlite');
  await symlink(target, linked);
  await assert.rejects(backupMetadata({ dataDir: item.dataDir, output: linked }), /不能覆盖/);
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), 'keep-existing-content');
  await assert.rejects(backupMetadata({ dataDir: item.dataDir, output: item.path }), /不能覆盖/);
  assert.equal(item.store.session(item.source.id)?.running, true);

  const linkedDirectory = join(item.root, 'linked-directory');
  await symlink(item.dataDir, linkedDirectory);
  await assert.rejects(backupMetadata({ dataDir: item.dataDir, output: join(linkedDirectory, 'new.sqlite') }), /符号链接/);
  await assert.rejects(backupMetadata({ dataDir: linkedDirectory }), /符号链接/);
  assert.equal((await readdir(item.dataDir)).includes('new.sqlite'), false);
});

test('concurrent backups publish a target once and remove only their private temporary files', async t => {
  const item = await fixture(t);
  const output = join(item.root, 'exports', 'one.sqlite');
  const results = await Promise.allSettled([backupMetadata({ dataDir: item.dataDir, output }), backupMetadata({ dataDir: item.dataDir, output })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.match(String(rejected.reason), /不能覆盖/);
  assert.deepEqual(await readdir(dirname(output)), ['one.sqlite']);
  const db = new DatabaseSync(output, { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 2); }
  finally { db.close(); }
});

test('invalid backup schema leaves no published file and preserves unrelated files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-invalid-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new DatabaseSync(join(root, 'sessiondeck.sqlite'));
  source.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  source.close();
  const outputDir = join(root, 'exports');
  await mkdir(outputDir, { mode: 0o700 });
  await writeFile(join(outputDir, 'unrelated.txt'), 'keep');
  await assert.rejects(backupMetadata({ dataDir: root, output: join(outputDir, 'invalid.sqlite') }), /缺少 SessionDeck 数据表：groups/);
  assert.deepEqual(await readdir(outputDir), ['unrelated.txt']);
  assert.equal(await readFile(join(outputDir, 'unrelated.txt'), 'utf8'), 'keep');
});

test('backup command follows the selected local data directory and prints counts without message content', async t => {
  const item = await fixture(t);
  const output = join(item.root, 'command.sqlite');
  const result = await execute(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', '--output', output], { cwd: resolve('.'), env: { ...process.env, SESSIONDECK_DATA_DIR: item.dataDir, SESSIONDECK_DEMO: '1' } });
  const report = JSON.parse(result.stdout);
  assert.equal(report.path, output);
  assert.equal(report.counts.sessions, 2);
  assert.equal(report.counts.messages, 1);
  assert.equal(result.stdout.includes('Private'), false);
  assert.equal(result.stdout.includes(nativeId), false);
  assert.equal(item.store.session(item.source.id)?.running, true);
});

test('backup data path follows normal, demo and explicit server configuration', () => {
  assert.equal(metadataDataDirectory({}), join(homedir(), '.local/share/sessiondeck'));
  assert.equal(metadataDataDirectory({ SESSIONDECK_DEMO: '1' }), join(homedir(), '.local/share/sessiondeck-demo'));
  assert.equal(metadataDataDirectory({ SESSIONDECK_DEMO: '1', SESSIONDECK_DATA_DIR: './custom-data' }), resolve('custom-data'));
});
