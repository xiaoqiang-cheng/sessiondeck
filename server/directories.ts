import { opendir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DirectoryListing {
  path: string;
  canonicalPath: string;
  parentPath: string | null;
  homePath: string;
  entries: { name: string; path: string; symlink: boolean }[];
  truncated: boolean;
}

/** Accept paths copied by file managers without interpreting shell syntax. */
export function normalizeDirectoryInput(value: unknown, base = process.cwd()): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请填写工作目录');
  if (value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('目录路径包含无效字符或过长');
  let path = value.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  if (!path) throw new Error('请填写工作目录');
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.search || url.hash) throw new Error('Unexpected URL suffix');
      path = fileURLToPath(url);
    } catch { throw new Error('无效的目录链接，请粘贴本机绝对路径或 file:// 链接'); }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    throw new Error('请填写运行 Agent 的电脑上的目录路径，或 file:// 目录链接');
  }
  if (/[\u0000-\u001f\u007f]/u.test(path)) throw new Error('目录路径包含无效字符');
  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  return resolve(base, path);
}

function directoryError(cause: unknown): Error {
  const code = (cause as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return new Error('目录不存在，请检查路径');
  if (code === 'EACCES' || code === 'EPERM') return new Error('没有权限读取这个目录，请选择其他目录');
  if (code === 'ENOTDIR') return new Error('请选择目录，不能选择文件');
  if (code === 'ELOOP') return new Error('目录链接存在循环，无法打开');
  return cause instanceof Error ? cause : new Error('无法读取这个目录');
}

/** List one explicitly selected level only; never scan project contents recursively. */
export async function listDirectories(value?: unknown, options: { showHidden?: boolean; limit?: number; scanLimit?: number; base?: string } = {}): Promise<DirectoryListing> {
  const path = normalizeDirectoryInput(value === undefined || value === '' ? options.base ?? process.cwd() : value, options.base);
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit ?? 300)));
  const scanLimit = Math.min(10_000, Math.max(1, Math.floor(options.scanLimit ?? 3000)));
  try {
    if (!(await stat(path)).isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
    const canonicalPath = await realpath(path);
    const entries: DirectoryListing['entries'] = [];
    let scanned = 0, truncated = false;
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (scanned >= scanLimit) { truncated = true; break; }
      scanned++;
      if (!options.showHidden && entry.name.startsWith('.')) continue;
      const childPath = join(path, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDirectory = (await stat(childPath)).isDirectory(); }
        catch { continue; } // Broken or inaccessible links cannot be selected.
      }
      if (!isDirectory) continue;
      if (entries.length >= limit) { truncated = true; break; }
      entries.push({ name: entry.name, path: childPath, symlink: entry.isSymbolicLink() });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const parent = dirname(path);
    return { path, canonicalPath, parentPath: parent === path ? null : parent, homePath: homedir(), entries, truncated };
  } catch (cause) { throw directoryError(cause); }
}
