import { access, opendir, open, stat } from 'node:fs/promises';
import { constants, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import type { Backend, BackendInfo, DiscoveredSession, Session } from '../shared/types.js';

const run = promisify(execFile);
const BACKENDS: Backend[] = ['claude', 'codex', 'dsh'];
const LABELS: Record<Backend, string> = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' };
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
type Candidate = DiscoveredSession & { createdAt?: string };
export interface DiscoveryPaths { claudeHome?: string; codexHome?: string; dshHome?: string }
const DISCOVERY_LIMIT = 250;
const DISCOVERY_SCAN_ENTRIES = 20_000;
const DISCOVERY_SCAN_DIRECTORIES = 2000;
const DISCOVERY_DEADLINE_MS = 4000;
const DISCOVERY_CANDIDATES = 750;
const READ_CONCURRENCY = 8;
interface ScanBudget { entries: number; directories: number; deadline: number }
interface LogFile { path: string; id?: string; modified: number; created: number }

/** dsh 0.1 ids are `session-<uuid>`; dsh 0.2 (and dsh-tui) use the bare uuid. */
export const DSH_ID = new RegExp(`^(?:session-)?${UUID.source.slice(1, -1)}$`, 'i');
export function validateNativeId(backend: Backend, id: string): string {
  if (!(backend === 'dsh' ? DSH_ID.test(id) : UUID.test(id))) {
    throw new Error('无效的原生会话 ID');
  }
  return id;
}

/** The DeepSeek Harness terminal UI (`dsh-tui`), when installed next to `dsh`. */
export async function findDshTui(): Promise<string | null> {
  const configured = process.env.SESSIONDECK_DSH_TUI_BIN;
  const candidates = configured ? [configured] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(p => join(p, 'dsh-tui'));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return resolve(path); } catch { /* next PATH entry */ }
  }
  return null;
}

export async function findExecutable(backend: Backend): Promise<string | null> {
  const configured = process.env[`SESSIONDECK_${backend.toUpperCase()}_BIN`];
  const candidates = configured ? [configured] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(p => join(p, backend));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return resolve(path); } catch { /* next PATH entry */ }
  }
  return null;
}

export async function getBackendInfo(): Promise<BackendInfo[]> {
  return Promise.all(BACKENDS.map(async id => {
    const file = await findExecutable(id);
    if (!file) return { id, label: LABELS[id], installed: false, version: null, capabilities: { terminal: false, resume: false, fork: false, discovery: true }, note: '未在 PATH 中找到原生命令' };
    let version: string | null = null;
    try { version = (await run(file, ['--version'], { timeout: 5000, maxBuffer: 4096 })).stdout.trim().slice(0, 120); } catch { /* launch will report details */ }
    let help = '';
    try { help = (await run(file, ['--help'], { timeout: 5000, maxBuffer: 40_000 })).stdout; } catch { /* conservative capability detection */ }
    let nativeControl = false;
    if (id === 'codex' && help.includes('--remote-auth-token-env')) {
      try {
        const serverHelp = (await run(file, ['app-server', '--help'], { timeout: 5000, maxBuffer: 40_000 })).stdout;
        nativeControl = serverHelp.includes('--ws-token-file') && serverHelp.includes('--ws-auth');
      } catch { /* An older Codex can still use the native terminal path. */ }
    }
    // dsh-tui is a separate package. With it present, DeepSeek Harness gets the
    // same terminal + transcript pairing as Claude and Codex; without it the
    // embedded native Web UI remains the only interactive path.
    const tui = id === 'dsh' ? await findDshTui() : null;
    return {
      id, label: LABELS[id], installed: true, version,
      capabilities: { terminal: id !== 'dsh' || !!tui, resume: id === 'dsh' || /\bresume\b/.test(help), fork: id === 'dsh' || (id === 'claude' ? help.includes('--fork-session') : /\bfork\b/.test(help)), discovery: true, nativeControl, graphicalChat: nativeControl },
      note: id === 'dsh' ? (tui ? '原生终端界面（dsh-tui）与对话记录；原生 Web 界面仍可打开' : '复用原生 Web 界面与本地 session API；安装 @deepseek-harness-tui/dsh-tui 可获得原生终端') : id === 'codex' ? (nativeControl ? '原生 app-server 提供图形对话、流式回复、审批和精确会话；可切换原生终端' : '兼容终端模式：原生 ID 在完成一轮后确认；更新 Codex 可启用图形对话') : '复用原生终端，保留后端自身的登录、权限与审批',
    };
  }));
}

/** Arguments are always passed directly to exec/PTY, never through a shell. */
export async function buildLaunch(session: Session): Promise<{ file: string; args: string[]; nativeSessionId?: string }> {
  const source = session.nativeSessionId ? validateNativeId(session.backend, session.nativeSessionId) : null;
  if (session.forkPending && !source) throw new Error('原会话尚未获得原生 ID，无法 Fork');
  if (session.backend === 'dsh') {
    const tui = await findDshTui();
    if (!tui) throw new Error('未找到 dsh-tui，请安装 @deepseek-harness-tui/dsh-tui 或使用原生 Web 界面');
    // dsh-tui resolves the workspace from the session on resume; a new session
    // takes the directory as its only positional argument. It has no fork flag,
    // so a pending fork resumes the parent and the TUI branches from there.
    if (source) return { file: tui, args: ['--resume', source], ...(session.forkPending ? {} : { nativeSessionId: source }) };
    return { file: tui, args: [session.cwd] };
  }
  const file = await findExecutable(session.backend);
  if (!file) throw new Error(`未找到 ${LABELS[session.backend]}，请安装原生命令并加入 PATH`);
  if (session.backend === 'claude') {
    if (source && !session.forkPending) return { file, args: ['--resume', source], nativeSessionId: source };
    const nativeSessionId = randomUUID();
    const args = source ? ['--resume', source, '--fork-session'] : [];
    args.push('--session-id', nativeSessionId, '--name', session.title);
    return { file, args, nativeSessionId };
  }
  if (source) return { file, args: [session.forkPending ? 'fork' : 'resume', source, '--cd', session.cwd], ...(session.forkPending ? {} : { nativeSessionId: source }) };
  return { file, args: ['--cd', session.cwd] };
}

function iso(value: unknown, fallback = Date.now()): string {
  const number = typeof value === 'number' ? value < 10_000_000_000 ? value * 1000 : value : typeof value === 'string' ? Date.parse(value) : fallback;
  const date = new Date(Number.isFinite(number) ? number : fallback);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : new Date(fallback).toISOString();
}
function label(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 160) || fallback : fallback;
}
function validCwd(value: unknown): value is string { return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value); }
function budget(): ScanBudget { return { entries: DISCOVERY_SCAN_ENTRIES, directories: DISCOVERY_SCAN_DIRECTORIES, deadline: Date.now() + DISCOVERY_DEADLINE_MS }; }
function withinBudget(scan: ScanBudget): boolean { return scan.entries > 0 && scan.directories > 0 && Date.now() < scan.deadline; }

/** Stream directory names with a shared work budget. readdir() on an enormous
 * directory allocates every entry before a limit can be enforced. */
async function entries(path: string, scan: ScanBudget) {
  const result: Dirent[] = [];
  if (!withinBudget(scan)) return result;
  scan.directories--;
  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (--scan.entries < 0 || Date.now() >= scan.deadline) break;
      result.push(entry);
    }
  } catch { /* optional/migrating native directory */ }
  return result;
}

async function mapLimited<T, R>(items: T[], parallelism: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  let cursor = 0;
  const result: R[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(parallelism, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; result[index] = await fn(items[index]!); }
  }));
  return result;
}

/** File metadata is cheap; read actual JSON only after selecting the most
 * recently modified logs, with extra candidates to tolerate damaged files. */
async function newestLogs(root: string, kind: 'claude' | 'codex', scan: ScanBudget): Promise<LogFile[]> {
  const files: LogFile[] = [];
  const pending = [{ path: root, depth: 0 }];
  while (pending.length && withinBudget(scan)) {
    const directory = pending.shift()!;
    const found = await entries(directory.path, scan);
    const logs = found.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && (kind === 'codex' || UUID.test(entry.name.slice(0, -6))));
    const metadata = await mapLimited(logs, 16, async entry => {
      if (Date.now() >= scan.deadline) return null;
      const path = join(directory.path, entry.name);
      try {
        const info = await stat(path);
        return info.isFile() ? { path, id: kind === 'claude' ? entry.name.slice(0, -6) : undefined, modified: info.mtimeMs, created: info.birthtimeMs } : null;
      } catch { return null; }
    });
    files.push(...metadata.filter((item): item is NonNullable<typeof item> => item !== null));
    if (files.length > DISCOVERY_CANDIDATES * 2) { files.sort((a, b) => b.modified - a.modified); files.length = DISCOVERY_CANDIDATES; }
    const maxDepth = kind === 'claude' ? 1 : 4;
    if (directory.depth < maxDepth) {
      // Codex's YYYY/MM/DD folders are visited newest first when a very large
      // archive reaches the scan budget. Symlink directories are never followed.
      const dirs = found.filter(entry => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
      pending.unshift(...dirs.slice(0, scan.directories).map(entry => ({ path: join(directory.path, entry.name), depth: directory.depth + 1 })));
    }
  }
  return files.sort((a, b) => b.modified - a.modified).slice(0, DISCOVERY_CANDIDATES);
}

async function readLogEdges(path: string, bytes: number, tail: boolean): Promise<string[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) return [];
    const length = Math.min(info.size, bytes);
    const head = Buffer.alloc(length);
    const first = await file.read(head, 0, length, 0);
    const chunks = [head.subarray(0, first.bytesRead).toString('utf8')];
    if (tail && info.size > length) {
      const last = Buffer.alloc(length);
      const read = await file.read(last, 0, length, info.size - length);
      chunks.push(last.subarray(0, read.bytesRead).toString('utf8'));
    }
    return chunks;
  } finally { await file.close(); }
}

async function parseNewest(files: LogFile[], scan: ScanBudget, parse: (file: LogFile) => Promise<Candidate | null>): Promise<Candidate[]> {
  const rows: Candidate[] = [];
  for (let index = 0; index < files.length && rows.length < DISCOVERY_LIMIT && Date.now() < scan.deadline; index += READ_CONCURRENCY) {
    const parsed = await mapLimited(files.slice(index, index + READ_CONCURRENCY), READ_CONCURRENCY, async file => {
      try { return await parse(file); } catch { return null; }
    });
    rows.push(...parsed.filter((row): row is Candidate => row !== null));
  }
  return rows.slice(0, DISCOVERY_LIMIT);
}

async function codexSessions(home: string): Promise<Candidate[]> {
  const scan = budget();
  const dbNames = (await entries(home, scan)).filter(e => e.isFile() && /^state_\d+\.sqlite$/.test(e.name)).map(e => e.name).sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0])).slice(0, 8);
  for (const name of dbNames) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(home, name), { readOnly: true });
      const columns = new Set((db.prepare('PRAGMA table_info(threads)').all() as {name: string}[]).map(r => r.name));
      if (!['id', 'cwd'].every(c => columns.has(c)) || (!columns.has('updated_at') && !columns.has('updated_at_ms'))) continue;
      const fallbackTitle = columns.has('title') ? 'title' : "'Codex 会话'";
      const title = columns.has('name') ? `COALESCE(NULLIF(name, ''), ${fallbackTitle})` : fallbackTitle;
      const updatedFallback = columns.has('updated_at') ? 'updated_at * 1000' : 'NULL';
      const updated = columns.has('updated_at_ms') ? `COALESCE(updated_at_ms, ${updatedFallback})` : updatedFallback;
      const createdFallback = columns.has('created_at') ? 'created_at * 1000' : updated;
      const created = columns.has('created_at_ms') ? `COALESCE(created_at_ms, ${createdFallback})` : createdFallback;
      const where = columns.has('archived') ? ' WHERE archived = 0' : '';
      return (db.prepare(`SELECT id, cwd, ${title} AS title, ${updated} AS updated, ${created} AS created FROM threads${where} ORDER BY updated DESC LIMIT ${DISCOVERY_CANDIDATES}`).all() as Record<string, unknown>[])
        .filter(r => typeof r.id === 'string' && UUID.test(r.id) && validCwd(r.cwd)).slice(0, DISCOVERY_LIMIT)
        .map(r => ({ backend: 'codex', nativeSessionId: String(r.id), title: label(r.title, 'Codex 会话'), cwd: String(r.cwd), lastActivity: iso(r.updated), createdAt: iso(r.created) }));
    } catch { /* legacy/migrating database: try an older index */ } finally { db?.close(); }
  }
  // Older CLIs use a metadata record at the start of each rollout file.
  const files = await newestLogs(join(home, 'sessions'), 'codex', scan);
  return parseNewest(files, scan, async file => {
    const chunks = await readLogEdges(file.path, 32768, false);
    const record = JSON.parse(chunks[0]?.split('\n')[0] ?? '');
    if (record?.type !== 'session_meta' || !UUID.test(record.payload?.id) || !validCwd(record.payload?.cwd)) return null;
    return { backend: 'codex', nativeSessionId: record.payload.id, title: 'Codex 会话', cwd: record.payload.cwd, createdAt: iso(record.payload.timestamp, file.created), lastActivity: iso(file.modified) };
  });
}

async function claudeSessions(home: string): Promise<Candidate[]> {
  const scan = budget();
  const files = await newestLogs(join(home, 'projects'), 'claude', scan);
  return parseNewest(files, scan, async file => {
    const chunks = await readLogEdges(file.path, 65536, true);
    let cwd = '', title = '', createdAt: string | undefined;
    for (const line of chunks.join('\n').split('\n')) {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      if (validCwd(row.cwd)) cwd = row.cwd;
      if (!createdAt && typeof row.timestamp === 'string') createdAt = iso(row.timestamp, file.created);
      if (typeof row.customTitle === 'string') title = row.customTitle;
      else if (!title && typeof row.summary === 'string') title = row.summary;
      // A user's first prompt can contain secrets. Only native display metadata
      // is eligible for the import list, never conversation text as a fallback.
    }
    return cwd ? { backend: 'claude', nativeSessionId: file.id!, title: label(title, 'Claude Code 会话'), cwd, lastActivity: iso(file.modified), createdAt } : null;
  });
}

/** dsh 0.2 / dsh-tui keep no projcache. Each session directory's log starts
 * with a header frame `{type:'session', id, createdAt, cwd}`; the directory
 * slug is lossy, so the header is the only trustworthy cwd. */
async function dshSessionDirectories(home: string): Promise<Candidate[]> {
  const rows: Candidate[] = [];
  const scan = budget();
  let slugs: Dirent[];
  try { slugs = await opendirEntries(join(home, 'sessions')); } catch { return rows; }
  for (const slug of slugs) {
    if (!slug.isDirectory() || !withinBudget(scan)) break;
    let ids: Dirent[];
    try { ids = await opendirEntries(join(home, 'sessions', slug.name)); } catch { continue; }
    for (const entry of ids) {
      if (!withinBudget(scan)) break;
      scan.entries--;
      if (!entry.isDirectory() || !DSH_ID.test(entry.name)) continue;
      const directory = join(home, 'sessions', slug.name, entry.name);
      let names: Dirent[];
      try { names = await opendirEntries(directory); } catch { continue; }
      const log = names.filter(n => n.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(n.name)).map(n => n.name).sort().at(-1);
      if (!log) continue;
      const path = join(directory, log);
      try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let header: { id?: unknown; createdAt?: unknown; cwd?: unknown } | null = null;
        let modified = 0;
        try {
          const info = await file.stat();
          if (!info.isFile()) continue;
          modified = info.mtimeMs;
          // Only the first frame/line is needed; cap the read regardless of size.
          const buffer = Buffer.alloc(Math.min(info.size, 65536));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const bytes = buffer.subarray(0, bytesRead);
          let text: string;
          if (log.endsWith('.zstd')) text = zstdDecompressSync(bytes, { maxOutputLength: 1 << 20 }).toString('utf8');
          else text = bytes.toString('utf8');
          header = JSON.parse(text.split('\n', 1)[0]);
        } finally { await file.close(); }
        if (!header || header.id !== entry.name || !validCwd(header.cwd)) continue;
        rows.push({ backend: 'dsh', nativeSessionId: entry.name, title: 'DeepSeek Harness 会话', cwd: header.cwd, createdAt: iso(header.createdAt, modified), lastActivity: iso(modified) });
      } catch { /* torn header during a concurrent write; next discovery sees it */ }
    }
  }
  return rows;
}
async function opendirEntries(path: string): Promise<Dirent[]> {
  const result: Dirent[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) { result.push(entry); if (result.length >= 2000) break; }
  return result;
}

async function dshSessions(home: string): Promise<Candidate[]> {
  const [cached, walked] = await Promise.all([dshProjcacheSessions(home), dshSessionDirectories(home)]);
  // The projcache carries titles; directories carry sessions the cache lacks.
  const byId = new Map(walked.map(row => [row.nativeSessionId, row]));
  for (const row of cached) {
    const base = byId.get(row.nativeSessionId);
    // Keep whichever side has a value; a cache row without createdAt must not
    // erase the one read from the log header (and vice versa).
    byId.set(row.nativeSessionId, base ? { ...base, ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) } : row);
  }
  return [...byId.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, DISCOVERY_LIMIT);
}

async function dshProjcacheSessions(home: string): Promise<Candidate[]> {
  try {
    const file = await open(join(home, 'storages', 'session_projcache.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let content: string;
    try {
      const info = await file.stat();
      // This is a metadata cache, not an unbounded session transcript. Refuse
      // unexpectedly large replacements before allocating/parsing their body.
      if (!info.isFile() || info.size > 16 * 1024 * 1024) return [];
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
    const doc = JSON.parse(content);
    if (!doc || typeof doc !== 'object' || !doc.tables?.sessions || typeof doc.tables.sessions !== 'object' || Array.isArray(doc.tables.sessions)) return [];
    const rows: Candidate[] = [];
    for (const [nativeSessionId, raw] of Object.entries(doc.tables?.sessions ?? {})) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as { identity?: { cwd?: string; createdAt?: number }; rows?: Record<string, { val?: unknown }> };
      if (!DSH_ID.test(nativeSessionId) || !validCwd(item.identity?.cwd)) continue;
      const meta = item.rows?.sessionListMetadata?.val as { lastPromptAt?: number } | undefined;
      rows.push({ backend: 'dsh', nativeSessionId, title: label(item.rows?.title?.val, 'DeepSeek Harness 会话'), cwd: item.identity.cwd, createdAt: iso(item.identity.createdAt), lastActivity: iso(meta?.lastPromptAt ?? item.identity.createdAt) });
    }
    return rows.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, DISCOVERY_LIMIT);
  } catch { return []; }
}

const discoveries = new Map<string, Promise<Candidate[]>>();
function discoverOnce(id: Backend, home: string): Promise<Candidate[]> {
  const key = `${id}:${resolve(home)}`;
  const existing = discoveries.get(key);
  if (existing) return existing;
  const pending = (id === 'codex' ? codexSessions(home) : id === 'claude' ? claudeSessions(home) : dshSessions(home))
    .finally(() => { if (discoveries.get(key) === pending) discoveries.delete(key); });
  discoveries.set(key, pending);
  return pending;
}

async function candidates(backend?: Backend, paths: DiscoveryPaths = {}): Promise<Candidate[]> {
  const jobs = (backend ? [backend] : BACKENDS).map(id => discoverOnce(id, id === 'codex' ? paths.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex') : id === 'claude' ? paths.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude') : paths.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')));
  const results = await Promise.allSettled(jobs);
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

/** Explicit discovery only returns display metadata; conversation logs never leave the server. */
export async function discoverSessions(backend?: Backend, paths: DiscoveryPaths = {}): Promise<DiscoveredSession[]> {
  return (await candidates(backend, paths)).slice(0, DISCOVERY_LIMIT).map(({ createdAt: _createdAt, ...row }) => row);
}

/** Ambiguous simultaneous launches never silently attach a card to somebody else's session. */
export async function resolveNativeSessionId(session: Session, startedAt: string, excludeIds: string[], paths: DiscoveryPaths = {}): Promise<string | null> {
  const cutoff = Date.parse(startedAt) - 2000;
  const found = (await candidates(session.backend, paths)).filter(r => resolve(r.cwd) === resolve(session.cwd) && !excludeIds.includes(r.nativeSessionId) && r.createdAt && Date.parse(r.createdAt) >= cutoff);
  return found.length === 1 ? found[0]!.nativeSessionId : null;
}
