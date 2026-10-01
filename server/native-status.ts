import { readdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import type { Session, SessionStatus } from '../shared/types.js';
import { decodeDshFrames } from './conversation.ts';

export interface NativeStatusEvent { status: SessionStatus; detail: string; timestamp: string }
interface Observation {
  session: Session;
  callback: (event: NativeStatusEvent) => void;
  since: number;
  path?: string;
  offset: number;
  remainder: string;
  droppingLine: boolean;
  lastTimestamp: number;
  busy: boolean;
  lastLookup: number;
  /** Compressed logs are decoded whole; `offset` then counts decoded bytes already handled. */
  compressed?: boolean;
}
export interface NativeStatusOptions { codexHome?: string; dshHome?: string; intervalMs?: number }

/** dsh 0.2 session-log lifecycle rows; assistant text and tool output never count. */
export function dshStatusEvent(record: unknown): NativeStatusEvent | null {
  if (!record || typeof record !== 'object') return null;
  const row = record as { type?: string; time?: unknown; data?: { reason?: { kind?: string } } };
  if (typeof row.type !== 'string' || typeof row.time !== 'number' || !Number.isFinite(row.time)) return null;
  const timestamp = new Date(row.time).toISOString();
  if (row.type === 'turn/start') return { status: 'running', detail: 'DeepSeek Harness 正在执行', timestamp };
  if (row.type === 'turn/end') {
    const kind = row.data?.reason?.kind;
    if (kind === 'error') return { status: 'error', detail: 'DeepSeek Harness 本轮出错，请进入原生会话查看', timestamp };
    if (kind === 'cancelled' || kind === 'aborted' || kind === 'interrupted') return { status: 'idle', detail: 'DeepSeek Harness 当前轮次已中断', timestamp };
    return { status: 'waiting_input', detail: 'DeepSeek Harness 本轮已结束，可以继续或验收', timestamp };
  }
  if (/^(?:user-)?approval\/request$/.test(row.type)) return { status: 'waiting_approval', detail: 'DeepSeek Harness 正在等待审批', timestamp };
  if (/^(?:ask-user|user-questions)\/request$/.test(row.type)) return { status: 'waiting_input', detail: 'DeepSeek Harness 正在等待你的回答', timestamp };
  return null;
}

/** sessions/<cwd-slug>/<id>/session[.vN].jsonl[.zstd], one slug level deep. */
async function findDshLog(home: string, nativeId: string): Promise<string | undefined> {
  let slugs: string[];
  try { slugs = await readdir(join(home, 'sessions')); } catch { return; }
  for (const slug of slugs.slice(0, 500)) {
    const directory = join(home, 'sessions', slug, nativeId);
    let names: string[];
    try { names = await readdir(directory); } catch { continue; }
    const name = names.filter(entry => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry)).sort().at(-1);
    if (name) return join(directory, name);
  }
}

/** Interpret only Codex's structured lifecycle envelope, never assistant/tool text. */
export function codexStatusEvent(record: unknown): NativeStatusEvent | null {
  if (!record || typeof record !== 'object') return null;
  const row = record as { type?: string; timestamp?: unknown; payload?: { type?: string } };
  if (row.type !== 'event_msg' || typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))) return null;
  const statuses: Record<string, {status: SessionStatus; detail: string}> = {
    task_started: { status: 'running', detail: 'Codex 原生事件：正在执行' },
    task_complete: { status: 'waiting_input', detail: 'Codex 本轮已结束，可以继续或验收' },
    turn_aborted: { status: 'idle', detail: 'Codex 原生事件：当前轮次已中断' },
    error: { status: 'error', detail: 'Codex 报告执行错误，请进入原生会话查看' },
    exec_approval_request: { status: 'waiting_approval', detail: 'Codex 正在等待命令审批' },
    apply_patch_approval_request: { status: 'waiting_approval', detail: 'Codex 正在等待修改审批' },
  };
  const next = row.payload?.type ? statuses[row.payload.type] : undefined;
  return next ? { ...next, timestamp: row.timestamp } : null;
}

async function findRollout(home: string, nativeId: string): Promise<string | undefined> {
  let names: string[];
  try { names = await readdir(home); } catch { return; }
  const databases = names.filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a,b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
  for (const name of databases) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(home, name), { readOnly: true });
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(nativeId) as { rollout_path?: string } | undefined;
      if (row?.rollout_path) return row.rollout_path;
    } catch { /* missing schema or migration in progress */ } finally { db?.close(); }
  }
  let remaining = 3000;
  async function scan(directory: string, depth: number): Promise<string | undefined> {
    if (depth > 4 || remaining <= 0) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (--remaining < 0) return;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(`${nativeId}.jsonl`)) return path;
      if (entry.isDirectory()) { const found = await scan(path, depth + 1); if (found) return found; }
    }
  }
  return scan(join(home, 'sessions'), 0);
}

/** Incrementally observes only known native identities. start() can first be
 * called before the ID is known and called again when the ID is resolved;
 * this preserves the original launch boundary and cannot replay old turns. */
export class NativeStatusWatcher {
  private observations = new Map<string, Observation>();
  private timer: NodeJS.Timeout;
  private codexHome: string;
  private dshHome: string;
  constructor(options: NativeStatusOptions = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    this.dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
    this.timer = setInterval(() => { for (const observation of this.observations.values()) void this.poll(observation); }, Math.max(25, options.intervalMs ?? 750));
    this.timer.unref();
  }

  start(session: Session, callback: (event: NativeStatusEvent) => void, since?: string): void {
    if (session.backend !== 'codex' && session.backend !== 'dsh') return;
    const existing = this.observations.get(session.id);
    if (existing && existing.session.nativeSessionId === session.nativeSessionId) {
      existing.session = { ...session }; existing.callback = callback;
      void this.poll(existing);
      return;
    }
    // Replace the observation on identity change, so an in-flight lookup/read
    // for the old native session cannot mutate or notify the new observation.
    const boundary = existing?.since ?? (since ? Date.parse(since) : Date.now());
    const observation: Observation = { session: { ...session }, callback, since: Number.isFinite(boundary) ? boundary : Date.now(), offset: 0, remainder: '', droppingLine: false, lastTimestamp: 0, busy: false, lastLookup: 0 };
    this.observations.set(session.id, observation);
    void this.poll(observation);
  }

  stop(id: string): void { this.observations.delete(id); }
  close(): void { clearInterval(this.timer); this.observations.clear(); }

  private async poll(observation: Observation): Promise<void> {
    const { session } = observation;
    if (observation.busy || session.forkPending || !session.nativeSessionId || !/^(?:session-)?[a-f\d-]{36}$/i.test(session.nativeSessionId)) return;
    observation.busy = true;
    try {
      if (!observation.path) {
        if (Date.now() - observation.lastLookup < 2000) return;
        observation.lastLookup = Date.now();
        observation.path = session.backend === 'dsh' ? await findDshLog(this.dshHome, session.nativeSessionId) : await findRollout(this.codexHome, session.nativeSessionId);
        if (!observation.path) return;
        observation.compressed = observation.path.endsWith('.zstd');
        if (observation.compressed) {
          // Start after everything already written; the launch boundary filters
          // any older turn that the first full decode would otherwise replay.
          observation.offset = 0; observation.droppingLine = false;
        } else {
          const size = (await stat(observation.path)).size;
          observation.offset = Math.max(0, size - 65536);
          observation.droppingLine = observation.offset > 0;
        }
      }
      const info = await stat(observation.path);
      let chunk: string;
      if (observation.compressed) {
        // zstd frames cannot be read from an arbitrary byte offset. Decode the
        // whole log (bounded) and hand over only the decoded bytes not yet seen.
        if (info.size > 8 * 1024 * 1024) return;
        if (info.size === observation.lastLookup) return;
        observation.lastLookup = info.size;
        const file = await open(observation.path, 'r');
        let decoded: string;
        try {
          const buffer = Buffer.alloc(info.size);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          decoded = decodeDshFrames(buffer.subarray(0, bytesRead), 32 * 1024 * 1024).text;
        } finally { await file.close(); }
        if (decoded.length < observation.offset) { observation.offset = 0; observation.remainder = ''; }
        chunk = decoded.slice(observation.offset);
        observation.offset = decoded.length;
        if (!chunk) return;
      } else {
        if (info.size < observation.offset) { observation.offset = 0; observation.remainder = ''; observation.droppingLine = false; }
        if (info.size === observation.offset) return;
        const file = await open(observation.path, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(info.size - observation.offset, 262144));
          const { bytesRead } = await file.read(buffer, 0, buffer.length, observation.offset);
          observation.offset += bytesRead;
          chunk = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await file.close(); }
      }
      if (this.observations.get(session.id) !== observation) return;
      let content = observation.remainder + chunk;
      if (observation.droppingLine) {
        const newline = content.indexOf('\n');
        if (newline < 0) return;
        content = content.slice(newline + 1); observation.droppingLine = false;
      }
      const lines = content.split('\n');
      observation.remainder = lines.pop() ?? '';
      if (observation.remainder.length > 1_048_576) { observation.remainder = ''; observation.droppingLine = true; }
      let latest: NativeStatusEvent | null = null;
      for (const line of lines) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const event = session.backend === 'dsh' ? dshStatusEvent(parsed) : codexStatusEvent(parsed);
        if (!event) continue;
        const timestamp = Date.parse(event.timestamp);
        if (timestamp < observation.since || timestamp < observation.lastTimestamp) continue;
        observation.lastTimestamp = timestamp; latest = event;
      }
      if (latest) observation.callback(latest);
    } catch {
      // A rollout can move or disappear during native maintenance. Resolve it
      // again on a later poll, retaining the last lifecycle timestamp.
      observation.path = undefined; observation.remainder = '';
    }
    finally { observation.busy = false; }
  }
}
