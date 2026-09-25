import { backup, DatabaseSync } from 'node:sqlite';
import { chmod, link, lstat, mkdir, mkdtemp, open, readlink, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve, sep } from 'node:path';

const tables = ['sessions', 'groups', 'messages', 'deliveries', 'activities'] as const;
type Table = typeof tables[number];

export interface MetadataBackupOptions {
  dataDir?: string;
  /** A new file. Existing files, directories and symbolic links are rejected. */
  output?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MetadataBackupResult {
  path: string;
  sourcePath: string;
  createdAt: string;
  bytes: number;
  counts: Record<Table, number>;
}

export function metadataDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SESSIONDECK_DATA_DIR || join(homedir(), '.local/share', env.SESSIONDECK_DEMO === '1' ? 'sessiondeck-demo' : 'sessiondeck'));
}

async function absent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error(`备份目标已存在，不能覆盖：${path}`);
}

/** Refuse symbolic links, including in parent directories. Newly created
 * directories are private; existing user directories retain their permissions. */
async function safeDirectory(path: string, create: boolean): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let entry;
    try { entry = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      entry = await lstat(current);
    }
    // macOS itself exposes /var and /tmp through root-owned aliases. They are
    // not user-selected backup redirections; every remaining component is
    // still checked, including symlinks below these system directories.
    if (process.platform === 'darwin' && entry.isSymbolicLink() && entry.uid === 0
      && ['/var', '/tmp', '/etc'].includes(current)
      && resolve(dirname(current), await readlink(current)) === `/private${current}`) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`备份路径必须是真实目录，不能包含符号链接：${current}`);
  }
}

function verifySnapshot(db: DatabaseSync): Record<Table, number> {
  const check = db.prepare('PRAGMA quick_check').all();
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('备份完整性检查失败');
  const counts = {} as Record<Table, number>;
  for (const table of tables) {
    const schema = db.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table);
    if (schema?.type !== 'table') throw new Error(`备份缺少 SessionDeck 数据表：${table}`);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!['id', 'data'].every(name => columns.some(column => column.name === name))) throw new Error(`备份数据表结构不兼容：${table}`);
    counts[table] = Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  }
  return counts;
}

/** Copy only SessionDeck's metadata via SQLite's online backup API. Never use
 * Store here: opening a Store resets contacts that were marked as running. */
export async function backupMetadata(options: MetadataBackupOptions = {}): Promise<MetadataBackupResult> {
  const dataDir = resolve(options.dataDir || metadataDataDirectory(options.env));
  const sourcePath = join(dataDir, 'sessiondeck.sqlite');
  await safeDirectory(dataDir, false);
  const sourceEntry = await lstat(sourcePath);
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) throw new Error('源数据库必须是普通文件，不能是符号链接');
  const createdAt = new Date().toISOString();
  const filename = `sessiondeck-${createdAt.replace(/[:.]/g, '-')}.sqlite`;
  const output = resolve(options.output || join(dataDir, 'backups', filename));
  await absent(output);

  // The source is read-only, including while another process holds live WAL
  // writes. The backup API copies a consistent committed SQLite snapshot.
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let temporaryDir: string | undefined;
  try {
    source.exec('PRAGMA busy_timeout=5000;');
    await safeDirectory(dirname(output), true);
    temporaryDir = await mkdtemp(join(dirname(output), '.sessiondeck-backup-'));
    await chmod(temporaryDir, 0o700);
    const temporaryFile = join(temporaryDir, 'snapshot.sqlite');
    const reserved = await open(temporaryFile, 'wx', 0o600);
    await reserved.close();
    await backup(source, temporaryFile);

    const snapshot = new DatabaseSync(temporaryFile);
    let counts: Record<Table, number>;
    try {
      // Produce a standalone file without relying on WAL or SHM sidecars.
      snapshot.exec('PRAGMA journal_mode=DELETE;');
      counts = verifySnapshot(snapshot);
    } finally { snapshot.close(); }
    await chmod(temporaryFile, 0o600);
    const saved = await open(temporaryFile, 'r');
    try { await saved.sync(); } finally { await saved.close(); }
    const bytes = (await stat(temporaryFile)).size;

    // An atomic hard link publishes the already verified file and refuses any
    // existing target, including a symlink created after the initial check.
    try { await link(temporaryFile, output); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`备份目标已存在，不能覆盖：${output}`);
      throw error;
    }
    return { path: output, sourcePath, createdAt, bytes, counts };
  } finally {
    source.close();
    // This random private directory is the only path this function removes.
    // A failed backup never deletes an existing or concurrently created target.
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true });
  }
}
