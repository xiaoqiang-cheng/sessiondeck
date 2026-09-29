import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm, open, stat, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gitDiff, gitStatus, listWorkspace, readWorkspaceFile } from './workspace.ts';

const execFileAsync = promisify(execFile);
async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function git(root: string, ...args: string[]) {
  return execFileAsync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
}
async function repo(t: TestContext) {
  const root = await temporary(t);
  await git(root, 'init', '-q');
  return root;
}
async function commit(root: string) {
  await git(root, 'add', '.');
  await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture baseline');
}

test('workspace lists and reads paths without leaving its canonical root', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'README.md'), '# Local notes\n');
  await writeFile(join(root, 'docs', 'plan.txt'), 'read only\n');
  const tree = await listWorkspace(root);
  assert.deepEqual(tree.entries.map(entry => entry.name), ['docs', 'README.md']);
  assert.equal(tree.truncated, false);
  assert.equal((await readWorkspaceFile(root, 'README.md')).content, '# Local notes\n');
  await symlink(join(root, 'docs'), join(root, 'safe-link'));
  assert.equal((await listWorkspace(root, 'safe-link')).entries[0]?.path, 'safe-link/plan.txt');
  assert.equal((await readWorkspaceFile(root, 'safe-link/plan.txt')).path, 'safe-link/plan.txt');
  for (const path of ['../outside.txt', 'docs/../../outside', 'docs\\..\\outside']) {
    await assert.rejects(readWorkspaceFile(root, path), /超出工作目录/);
  }
  for (const path of ['/etc/passwd', '//server/share', 'C:\\private\\secret', 'C:relative', '\\private', join(root, 'README.md')]) {
    await assert.rejects(readWorkspaceFile(root, path), /相对于工作目录/);
    await assert.rejects(gitDiff(root, path), /相对于工作目录/);
  }
});

test('exact parent symlinks, outside files and deleted paths under outside symlinks are refused', async t => {
  const parent = await temporary(t), root = join(parent, 'workspace');
  await mkdir(root);
  await writeFile(join(parent, 'secret.txt'), 'secret');
  await symlink(parent, join(root, 'parent'));
  await symlink(join(parent, 'secret.txt'), join(root, 'secret-link.txt'));
  assert.deepEqual(await listWorkspace(root), { path: '', entries: [], truncated: false });
  await assert.rejects(listWorkspace(root, 'parent'), /超出工作目录/);
  await assert.rejects(readWorkspaceFile(root, 'secret-link.txt'), /超出工作目录/);
  await assert.rejects(gitDiff(root, 'parent/deleted.txt'), /超出工作目录/);
  await symlink(join(parent, 'missing.txt'), join(root, 'dangling'));
  await assert.rejects(gitDiff(root, 'dangling'), /文件或目录不存在/);
});

test('file previews bound sparse input and detect binary bytes beyond the first sample', async t => {
  const root = await temporary(t), path = join(root, 'large.txt');
  const handle = await open(path, 'w');
  try {
    await handle.write(Buffer.from('x'.repeat(1024 * 1024)));
    await handle.truncate(512 * 1024 * 1024);
  } finally { await handle.close(); }
  const file = await readWorkspaceFile(root, 'large.txt');
  assert.equal(file.size, 512 * 1024 * 1024);
  assert.equal(file.content.length, 1024 * 1024);
  assert.equal(file.truncated, true);
  assert.equal(file.binary, false);
  await writeFile(join(root, 'binary'), Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0, 66])]));
  assert.equal((await readWorkspaceFile(root, 'binary')).binary, true);
  await writeFile(join(root, 'bad-utf8'), Buffer.from([255, 128, 65]));
  assert.equal((await readWorkspaceFile(root, 'bad-utf8')).binary, true);
  await writeFile(join(root, 'utf8.txt'), 'x'.repeat(1024 * 1024 - 1) + '你好');
  const utf8 = await readWorkspaceFile(root, 'utf8.txt');
  assert.equal(utf8.binary, false);
  assert.equal(utf8.truncated, true);
  assert.equal(utf8.content.includes('\ufffd'), false);
});

test('directory preview caps entries and reports actual truncation', async t => {
  const root = await temporary(t);
  await Promise.all(Array.from({ length: 620 }, (_, index) => writeFile(join(root, `file-${index}`), '')));
  const tree = await listWorkspace(root);
  assert.equal(tree.entries.length, 600);
  assert.equal(tree.truncated, true);
});

test('unborn repository diff includes staged content plus current unstaged edits and untracked files', async t => {
  const root = await repo(t);
  await writeFile(join(root, 'draft.md'), '# Staged\n');
  await git(root, 'add', 'draft.md');
  const staged = await gitDiff(root, 'draft.md');
  assert.equal(staged.available, true);
  assert.match(staged.diff, /\+# Staged/);
  await writeFile(join(root, 'draft.md'), '# Current\n');
  const modified = await gitDiff(root, 'draft.md');
  assert.equal(modified.available, true);
  assert.match(modified.diff, /\+# Current/);
  assert.doesNotMatch(modified.diff, /\+# Staged/);
  await writeFile(join(root, 'untracked.md'), '# Untracked\n');
  assert.deepEqual((await gitStatus(root)).entries, [{ status: 'AM', path: 'draft.md' }, { status: '??', path: 'untracked.md' }]);
  assert.match((await gitDiff(root, 'untracked.md')).diff, /\+# Untracked/);
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(root, 'ignored.txt'), 'must not be shown as a change\n');
  assert.equal((await gitDiff(root, 'ignored.txt')).diff, '');
});

test('tracked staged/unstaged/deleted diffs compare the current workspace with HEAD', async t => {
  const root = await repo(t);
  await mkdir(join(root, 'deleted-dir'));
  await writeFile(join(root, 'notes.txt'), 'baseline\n');
  await writeFile(join(root, 'deleted-dir', 'gone.txt'), 'removed content\n');
  await commit(root);
  await writeFile(join(root, 'notes.txt'), 'staged\n');
  await git(root, 'add', 'notes.txt');
  assert.match((await gitDiff(root, 'notes.txt')).diff, /\+staged/);
  await writeFile(join(root, 'notes.txt'), 'working\n');
  const diff = await gitDiff(root, 'notes.txt');
  assert.match(diff.diff, /-baseline/);
  assert.match(diff.diff, /\+working/);
  assert.doesNotMatch(diff.diff, /\+staged/);
  await rm(join(root, 'deleted-dir'), { recursive: true });
  const deleted = await gitDiff(root, 'deleted-dir/gone.txt');
  assert.equal(deleted.available, true);
  assert.match(deleted.diff, /deleted file/);
  assert.match(deleted.diff, /-removed content/);
  await git(root, 'add', '-u');
  assert.match((await gitDiff(root, 'deleted-dir/gone.txt')).diff, /-removed content/);
});

test('porcelain rename records keep the destination, skip the source and preserve later entries', async t => {
  const root = await repo(t);
  await writeFile(join(root, 'original name.txt'), 'same content\n');
  await writeFile(join(root, 'later.txt'), 'before\n');
  await commit(root);
  await rename(join(root, 'original name.txt'), join(root, 'new 名字.txt'));
  await git(root, 'add', '-A');
  await writeFile(join(root, 'later.txt'), 'after\n');
  const result = await gitStatus(root);
  assert.deepEqual(result.entries, [{ status: 'M', path: 'later.txt' }, { status: 'R', path: 'new 名字.txt' }]);
  assert.equal((await gitDiff(root, 'new 名字.txt')).available, true);
  assert.match((await gitDiff(root, 'new 名字.txt')).diff, /\+same content/);
});

test('repo subdirectory status and diffs stay local and treat Git pathspec magic literally', async t => {
  const root = await repo(t), sub = join(root, 'sub');
  await mkdir(sub);
  await writeFile(join(root, 'outside.txt'), 'outside base\n');
  await writeFile(join(sub, 'inside.txt'), 'inside base\n');
  await writeFile(join(sub, ':(glob)*.txt'), 'literal base\n');
  await commit(root);
  await writeFile(join(root, 'outside.txt'), 'outside changed\n');
  await writeFile(join(sub, 'inside.txt'), 'inside changed\n');
  await writeFile(join(sub, ':(glob)*.txt'), 'literal changed\n');
  assert.deepEqual((await gitStatus(sub)).entries, [{ status: 'M', path: ':(glob)*.txt' }, { status: 'M', path: 'inside.txt' }]);
  const inside = await gitDiff(sub, 'inside.txt');
  assert.equal(inside.available, true);
  assert.match(inside.diff, /\+inside changed/);
  assert.doesNotMatch(inside.diff, /outside changed|a\/sub\//);
  const literal = await gitDiff(sub, ':(glob)*.txt');
  assert.match(literal.diff, /\+literal changed/);
  assert.doesNotMatch(literal.diff, /inside changed|outside changed/);
});

test('Git previews do not run textconv, external diff or fsmonitor commands and do not refresh the index', async t => {
  const root = await repo(t);
  await writeFile(join(root, 'notes.txt'), 'baseline\n');
  await writeFile(join(root, '.gitattributes'), '*.txt diff=fixture\n');
  await commit(root);
  const command = join(root, 'must-not-run.cjs'), marker = join(root, 'marker');
  await writeFile(command, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write('CONVERTED');`);
  const helper = `${process.execPath} ${command}`;
  await git(root, 'config', 'diff.fixture.textconv', helper);
  await git(root, 'config', 'diff.external', helper);
  await git(root, 'config', 'core.fsmonitor', helper);
  await writeFile(join(root, 'notes.txt'), 'current\n');
  const index = await readFile(join(root, '.git', 'index')), before = await stat(join(root, '.git', 'index'));
  assert.equal((await gitStatus(root)).available, true);
  const result = await gitDiff(root, 'notes.txt');
  assert.equal(result.available, true);
  assert.match(result.diff, /\+current/);
  assert.deepEqual(await readFile(join(root, '.git', 'index')), index);
  assert.equal((await stat(join(root, '.git', 'index'))).mtimeMs, before.mtimeMs);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test('large Git output returns a bounded explicitly truncated UTF-8 preview', async t => {
  const root = await repo(t);
  await writeFile(join(root, 'large.txt'), '初始\n'.repeat(200_000));
  const diff = await gitDiff(root, 'large.txt');
  assert.equal(diff.available, true);
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.diff) <= 512 * 1024);
  assert.doesNotMatch(diff.diff, /\ufffd/);
});

async function fakeGit(t: TestContext, behavior: string) {
  const root = await temporary(t), bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(root, 'notes.txt'), 'content');
  await writeFile(join(bin, 'git'), `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('rev-parse'))process.stdout.write(${JSON.stringify(root + '\n')});else if(a.includes('status'))process.stdout.write('?? notes.txt\\0');else if(a.includes('diff')){${behavior}}`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ''}`;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  return root;
}

test('Git errors with partial stdout cannot masquerade as a successful diff', async t => {
  const root = await fakeGit(t, "process.stdout.write('partial error output');process.exit(2);");
  assert.deepEqual(await gitDiff(root, 'notes.txt'), { path: 'notes.txt', diff: '', truncated: false, available: false });
});

test('Git timeout with partial output is unavailable, not diff exit 1 or truncation', { timeout: 12_000 }, async t => {
  const root = await fakeGit(t, "process.stdout.write('partial before timeout');setInterval(()=>{},1000);");
  const started = Date.now();
  assert.deepEqual(await gitDiff(root, 'notes.txt'), { path: 'notes.txt', diff: '', truncated: false, available: false });
  assert.ok(Date.now() - started < 10_000);
});

test('nonrepository directories return unavailable without running no-index previews', async t => {
  const root = await temporary(t);
  await writeFile(join(root, 'plain.txt'), 'plain');
  assert.deepEqual(await gitStatus(root), { entries: [], available: false });
  assert.equal((await gitDiff(root, 'plain.txt')).available, false);
  await assert.rejects(gitDiff(root, '../missing'), /超出工作目录/);
  await assert.rejects(listWorkspace(join(root, 'plain.txt')), /工作目录不存在/);
  assert.equal(dirname(root), tmpdir());
});
