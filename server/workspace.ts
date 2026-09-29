import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { realpath, opendir, stat, lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 600;
const MAX_SCANNED_ENTRIES = 3000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;

type GitCommandResult = { stdout: string; code: number | null; truncated: boolean; failed: boolean };
type GitEntry = { path: string; status: string };
export interface WorkspaceEntry { name: string; path: string; kind: 'file' | 'directory'; size?: number }
export interface WorkspaceTree { path: string; entries: WorkspaceEntry[]; truncated: boolean }
export interface WorkspaceFile { path: string; content: string; truncated: boolean; binary: boolean; size: number }
export interface WorkspaceGitStatus { entries: GitEntry[]; available: boolean }

function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }

function cleanRelative(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) fail('文件路径无效');
  if (isAbsolute(value) || win32.isAbsolute(value) || /^[a-z]:/i.test(value)) fail('文件路径必须相对于工作目录');
  const path = value.replaceAll('\\', '/');
  if (path.split('/').some(part => part === '..')) fail('文件路径超出工作目录');
  return path.split('/').filter(part => part && part !== '.').join('/');
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function workspaceRoot(cwd: string): Promise<string> {
  try {
    const root = await realpath(cwd);
    if (!(await stat(root)).isDirectory()) fail('工作目录不存在或无法访问', 404);
    return root;
  } catch { fail('工作目录不存在或无法访问', 404); }
}

async function inside(cwd: string, value: unknown, expect?: 'file' | 'directory', allowMissing = false) {
  const root = await workspaceRoot(cwd), relativePath = cleanRelative(value);
  const candidate = resolve(root, relativePath);
  let canonical: string;
  try { canonical = await realpath(candidate); }
  catch (error) {
    if (!allowMissing || !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) fail('文件或目录不存在', 404);
    // A deleted Git path can be missing, but an existing symlink at any level
    // must still resolve inside this workspace, including a dangling symlink.
    let ancestor = candidate;
    while (ancestor !== root) {
      const metadata = await lstat(ancestor).catch(error => {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return undefined;
        throw error;
      });
      if (metadata) {
        const actual = await realpath(ancestor).catch(() => fail('文件或目录不存在', 404));
        if (!contained(root, actual)) fail('文件路径超出工作目录', 403);
        if (!metadata.isDirectory() && !metadata.isSymbolicLink()) fail('请选择文件');
        break;
      }
      ancestor = dirname(ancestor);
    }
    return { root, relativePath, canonical: candidate, metadata: undefined };
  }
  if (!contained(root, canonical)) fail('文件路径超出工作目录', 403);
  const metadata = await stat(canonical);
  if (expect === 'file' && !metadata.isFile()) fail('请选择文件');
  if (expect === 'directory' && !metadata.isDirectory()) fail('请选择目录');
  // Keep the requested path for tree navigation and literal Git pathspecs.
  // A safe symlink's target is only used for filesystem permission checks.
  return { root, relativePath, canonical, metadata };
}

export async function listWorkspace(cwd: string, value?: unknown): Promise<WorkspaceTree> {
  const target = await inside(cwd, value, 'directory');
  const result: WorkspaceEntry[] = [];
  let scanned = 0, truncated = false;
  for await (const entry of await opendir(target.canonical)) {
    if (++scanned > MAX_SCANNED_ENTRIES) { truncated = true; break; }
    try {
      const canonical = await realpath(resolve(target.canonical, entry.name));
      if (!contained(target.root, canonical)) continue;
      const metadata = await stat(canonical);
      if (!metadata.isDirectory() && !metadata.isFile()) continue;
      if (result.length === MAX_ENTRIES) { truncated = true; break; }
      result.push({ name: entry.name, path: target.relativePath ? `${target.relativePath}/${entry.name}` : entry.name, kind: metadata.isDirectory() ? 'directory' : 'file', ...(metadata.isFile() ? { size: metadata.size } : {}) });
    } catch { /* An entry can disappear while the native agent edits it. */ }
  }
  result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  return { path: target.relativePath, entries: result, truncated };
}

export async function readWorkspaceFile(cwd: string, value: unknown): Promise<WorkspaceFile> {
  const target = await inside(cwd, value, 'file');
  const handle = await open(target.canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== target.metadata?.dev || metadata.ino !== target.metadata?.ino) fail('文件已变化，请刷新后重试');
    if (process.platform === 'linux') {
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!contained(target.root, opened)) fail('文件路径超出工作目录', 403);
    }
    const bytes = Buffer.alloc(Math.min(metadata.size, MAX_FILE_BYTES) + 1);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const truncated = read > MAX_FILE_BYTES || metadata.size > MAX_FILE_BYTES;
    const body = bytes.subarray(0, Math.min(read, MAX_FILE_BYTES));
    let content = '', binary = body.includes(0);
    if (!binary) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(body, { stream: truncated }); }
      catch { binary = true; }
    }
    return { path: target.relativePath, content, truncated, binary, size: metadata.size };
  } finally { await handle.close(); }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  // A CLI-launched service must not inherit another repository's index/worktree.
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG.*|EXTERNAL_DIFF|DIFF_OPTS|ICASE_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|LITERAL_PATHSPECS)$/u.test(key)) delete env[key as keyof typeof env];
  return env;
}

async function runGit(args: string[], cwd: string, timeout: number): Promise<GitCommandResult> {
  const command = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args];
  try {
    const result = await execFileAsync('git', command, { cwd, env: gitEnvironment(), timeout, killSignal: 'SIGKILL', maxBuffer: MAX_DIFF_BYTES, encoding: 'buffer' });
    return { stdout: result.stdout.toString('utf8'), code: 0, truncated: false, failed: false };
  } catch (cause) {
    const error = cause as { code?: number | string; message?: string; killed?: boolean; signal?: string; stdout?: Buffer };
    const truncated = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error.message?.startsWith('stdout ') === true;
    const failed = !truncated && (error.killed === true || !!error.signal || typeof error.code !== 'number');
    const output = Buffer.isBuffer(error.stdout) ? error.stdout.subarray(0, MAX_DIFF_BYTES) : Buffer.alloc(0);
    return { stdout: failed ? '' : new StringDecoder('utf8').write(output), code: typeof error.code === 'number' ? error.code : null, truncated, failed };
  }
}

async function repository(root: string): Promise<{ prefix: string } | null> {
  const result = await runGit(['rev-parse', '--show-toplevel'], root, 5000);
  if (result.code !== 0 || result.failed || result.truncated) return null;
  const repo = await realpath(result.stdout.replace(/\r?\n$/, '')).catch(() => '');
  if (!repo || !contained(repo, root)) return null;
  const path = relative(repo, root).split(sep).join('/');
  return { prefix: path ? `${path}/` : '' };
}

function parseStatus(output: string, prefix: string): GitEntry[] {
  const records = output.split('\0'), entries: GitEntry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const status = record.slice(0, 2), path = record.slice(3);
    // Porcelain v1 -z is XY destination\0source\0 for BOTH index and
    // worktree renames/copies. The second record is never a new status row.
    if (/[RC]/.test(status)) index++;
    if (!path.startsWith(prefix)) continue;
    const local = path.slice(prefix.length);
    if (local && !isAbsolute(local) && !local.split('/').includes('..')) entries.push({ status: status.trim() || '?', path: local });
  }
  return entries;
}

export async function gitStatus(cwd: string): Promise<WorkspaceGitStatus> {
  const root = await workspaceRoot(cwd), repo = await repository(root);
  if (!repo) return { entries: [], available: false };
  const result = await runGit(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all', '-z', '--', '.'], root, 5000);
  if (result.code !== 0 || result.failed || result.truncated) return { entries: [], available: false };
  return { entries: parseStatus(result.stdout, repo.prefix), available: true };
}

export async function gitDiff(cwd: string, value: unknown): Promise<{ path: string; diff: string; truncated: boolean; available: boolean }> {
  const target = await inside(cwd, value, 'file', true);
  if (!target.relativePath) fail('请选择文件');
  const unavailable = { path: target.relativePath, diff: '', truncated: false, available: false };
  const repo = await repository(target.root);
  if (!repo) return unavailable;
  const status = await runGit(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all', '-z', '--', target.relativePath], target.root, 5000);
  if (status.code !== 0 || status.failed || status.truncated) return unavailable;
  const entries = parseStatus(status.stdout, repo.prefix);
  if (!entries.length) return { ...unavailable, available: true };
  const untracked = entries.some(entry => entry.path === target.relativePath && entry.status === '??');
  const options = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', '--no-renames'];
  let result: GitCommandResult;
  let noIndex = untracked;
  if (untracked) {
    // no-index reads the actual file, so reject symlinks rather than allowing
    // Git to follow their targets independently of our boundary checks.
    const file = await lstat(resolve(target.root, target.relativePath));
    if (!file.isFile()) return unavailable;
    result = await runGit(['diff', '--no-index', ...options, '--', process.platform === 'win32' ? 'NUL' : '/dev/null', target.relativePath], target.root, 7000);
  } else {
    const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], target.root, 5000);
    if (head.failed || head.truncated || (head.code !== 0 && head.code !== 1)) return unavailable;
    if (head.code === 0) result = await runGit(['diff', ...options, '--relative', 'HEAD', '--', target.relativePath], target.root, 7000);
    else {
      // Before the first commit the baseline is empty. Diffing the worktree
      // against the index would miss already-staged lines and hide later edits.
      if (!target.metadata) return { ...unavailable, available: true };
      noIndex = true;
      const file = await lstat(resolve(target.root, target.relativePath));
      if (!file.isFile()) return unavailable;
      result = await runGit(['diff', '--no-index', ...options, '--', process.platform === 'win32' ? 'NUL' : '/dev/null', target.relativePath], target.root, 7000);
    }
  }
  if (result.failed || (!result.truncated && result.code !== 0 && !(result.code === 1 && noIndex))) return unavailable;
  // Only a deliberately bounded stdout preview may survive output overflow;
  // a timeout, signal, missing executable or Git error is never a valid diff.
  return { path: target.relativePath, diff: result.stdout, truncated: result.truncated, available: true };
}
