import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session, Group, GroupMessage, Delivery, DeliveryAttempt, Activity, GroupDetail } from '../shared/types.ts';

const now = () => new Date().toISOString();
type Table = 'sessions' | 'groups' | 'messages' | 'deliveries' | 'activities';
export type StoreChange = { table: 'sessions'; data: Session } | { table: 'groups'; data: Group } | { table: 'activities'; data: Activity };

export class Store {
  readonly db: DatabaseSync;
  private listeners = new Set<(change: StoreChange) => void>();
  private changes: StoreChange[] | null = null;
  onChange(listener: (change: StoreChange) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') {
      // SQLite creates the file using the process umask; enforce local-only metadata even
      // when the user's umask is permissive. WAL sidecars inherit the directory boundary.
      try { chmodSync(path, 0o600); } catch { /* in-memory or a platform with no chmod */ }
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    for (const table of ['sessions', 'groups', 'messages', 'deliveries', 'activities']) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_group ON messages(json_extract(data, '$.groupId'));
      CREATE INDEX IF NOT EXISTS messages_revision ON messages(json_extract(data, '$.groupId'), json_extract(data, '$.revision'));
      CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries(json_extract(data, '$.messageId'));`);
    // A restart must not leave phantom live agents in the contact list.
    for (const session of this.sessions()) {
      if (session.running) this.updateSession(session.id, {
        running: false, status: 'unknown', statusSource: 'process',
        statusDetail: '服务已重新启动，点击进入并恢复原生会话', nativeUrl: null,
      });
    }
    // A crash between native acceptance and SQLite commit is not a failed send.
    for (const row of this.db.prepare("SELECT data FROM deliveries WHERE json_extract(data, '$.status') = 'sending'").all()) {
      const delivery = JSON.parse(String(row.data)) as Delivery;
      const attempt = delivery.attempts?.at(-1);
      if (attempt) this.finishDelivery(delivery.id, attempt.id, 'unknown', '服务在投递期间重启，请核对原生会话是否已收到');
    }
  }
  private list<T>(table: Table): T[] {
    return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.data)) as T);
  }
  private get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }
  private put<T extends { id: string }>(table: Table, data: T): T {
    this.db.prepare(`INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(data.id, JSON.stringify(data));
    if (table === 'sessions' || table === 'groups' || table === 'activities') {
      const change = { table, data } as unknown as StoreChange;
      if (this.changes) this.changes.push(change);
      else for (const listener of this.listeners) listener(change);
    }
    return data;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.changes = [];
    let result: T;
    try { result = fn(); this.db.exec('COMMIT'); }
    catch (error) { this.changes = null; this.db.exec('ROLLBACK'); throw error; }
    const changes = this.changes; this.changes = null;
    for (const change of changes) for (const listener of this.listeners) listener(change);
    return result;
  }
  sessions() { return this.list<Session>('sessions'); }
  session(id: string) { return this.get<Session>('sessions', id); }
  groups() { return this.list<Group>('groups'); }
  group(id: string) { return this.get<Group>('groups', id); }
  deliveries() { return this.list<Delivery>('deliveries'); }
  delivery(id: string) { return this.get<Delivery>('deliveries', id); }
  message(id: string) { return this.get<GroupMessage>('messages', id); }
  activities() { return this.list<Activity>('activities').slice(-100).reverse(); }
  addSession(input: Pick<Session, 'backend' | 'title' | 'cwd'> & Partial<Session>): Session {
    const date = now();
    return this.put('sessions', {
      id: randomUUID(), nativeSessionId: null, groupId: null, parentId: null, forkPending: false,
      status: 'idle', statusSource: 'process', statusDetail: '尚未启动', lastActivity: date,
      createdAt: date, updatedAt: date, archived: false, pinned: false, unread: 0,
      running: false, origin: 'created', ...input,
    });
  }
  updateSession(id: string, patch: Partial<Session>): Session {
    const session = this.session(id);
    if (!session) throw new Error('会话不存在');
    return this.put('sessions', { ...session, ...patch, id, updatedAt: now() });
  }
  addGroup(title: string, goal: string): Group {
    const date = now();
    return this.put('groups', { id: randomUUID(), title, goal, createdAt: date, updatedAt: date });
  }
  updateGroup(id: string, patch: Partial<Pick<Group, 'title' | 'goal'>>): Group {
    const group = this.group(id);
    if (!group) throw new Error('群组不存在');
    // This timestamp also identifies the revision consumed by group viewers.
    // Two mutations within the same millisecond must still invalidate history.
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(group.updatedAt) + 1)).toISOString();
    return this.put('groups', { ...group, ...patch, updatedAt });
  }
  groupDetail(id: string, options: { before?: number; since?: string } = {}): GroupDetail {
    const group = this.group(id);
    if (!group) throw new Error('群组不存在');
    if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 1)) throw new Error('历史游标无效');
    if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) throw new Error('历史版本无效');
    const rows = options.since !== undefined
      ? this.db.prepare("SELECT rowid, data FROM messages WHERE json_extract(data, '$.groupId') = ? AND json_extract(data, '$.revision') > ? ORDER BY json_extract(data, '$.revision'), rowid LIMIT 201").all(id, Date.parse(options.since))
      : this.db.prepare("SELECT rowid, data FROM messages WHERE json_extract(data, '$.groupId') = ? AND rowid < ? ORDER BY rowid DESC LIMIT 201").all(id, options.before ?? Number.MAX_SAFE_INTEGER);
    const hasMore = rows.length > 200;
    const messages = rows.slice(0, 200).map(row => ({ ...JSON.parse(String(row.data)) as GroupMessage, sequence: Number(row.rowid) }));
    const nextSince = options.since !== undefined && hasMore ? new Date(messages.at(-1)!.revision!).toISOString() : null;
    messages.sort((a, b) => a.sequence! - b.sequence!);
    // Bound both tables to this page and probe the expression index directly.
    // The previous JOIN scanned deliveries belonging to every other group.
    const deliveries = messages.length ? this.db.prepare(`SELECT json_remove(data, '$.text') AS data FROM deliveries
      WHERE json_extract(data, '$.messageId') IN (${messages.map(() => '?').join(',')}) ORDER BY rowid`).all(...messages.map(message => message.id))
      .map(row => JSON.parse(String(row.data)) as Omit<Delivery, 'text'>) : [];
    const total = Number(this.db.prepare("SELECT count(*) AS count FROM messages WHERE json_extract(data, '$.groupId') = ?").get(id)!.count);
    return { group, messages, deliveries, page: { total, before: hasMore && messages.length ? messages[0].sequence! : null }, revision: nextSince ?? group.updatedAt, nextSince };
  }
  addMessage(input: Omit<GroupMessage, 'id' | 'createdAt'>): GroupMessage {
    return this.transaction(() => {
      if (!this.group(input.groupId)) throw new Error('群组不存在');
      if (input.senderId && this.session(input.senderId)?.groupId !== input.groupId) throw new Error('发送者不属于这个群组');
      const source = input.sourceMessageId ? this.get<GroupMessage>('messages', input.sourceMessageId) : undefined;
      if (input.sourceMessageId && source?.groupId !== input.groupId) throw new Error('转交来源必须是这个群组中的消息');
      const recipientIds = [...new Set(input.recipientIds)];
      for (const id of recipientIds) {
        if (this.session(id)?.groupId !== input.groupId || this.session(id)?.archived) throw new Error('接收成员无效或已归档');
      }
      const group = this.updateGroup(input.groupId, {});
      const message = this.put('messages', { ...input, recipientIds, id: randomUUID(), createdAt: now(), revision: Date.parse(group.updatedAt) });
      for (const sessionId of recipientIds) this.put<Delivery>('deliveries', {
        id: randomUUID(), messageId: message.id, sessionId,
        text: `【SessionDeck 群组：${group.title}】\n共同目标：${group.goal || '见群组讨论'}\n来自：${input.senderName}${source ? `\n转交来源：${source.senderName}的${source.kind === 'result' ? '结果' : source.kind === 'task' ? '任务' : '记录'}` : ''}\n\n${input.text}`,
        status: 'pending', createdAt: now(), sentAt: null,
      });
      return message;
    });
  }
  updateDelivery(id: string, status: 'sent' | 'staged' | 'cancelled') {
    const delivery = this.delivery(id);
    if (!delivery) throw new Error('投递记录不存在');
    if (delivery.status !== 'pending') throw new Error('这条消息已处理，不能重复投递');
    return this.transaction(() => {
      return this.saveDelivery({ ...delivery, status, sentAt: status === 'sent' || status === 'staged' ? now() : null });
    });
  }
  beginDelivery(id: string, mode: 'sent' | 'staged'): DeliveryAttempt {
    return this.transaction(() => {
      const delivery = this.delivery(id);
      if (!delivery || delivery.status !== 'pending') throw new Error('消息已处理或结果待确认，不能重复投递');
      const attempt: DeliveryAttempt = { id: randomUUID(), mode, startedAt: now(), outcome: 'sending' };
      this.saveDelivery({ ...delivery, status: 'sending', lastError: undefined, attempts: [...(delivery.attempts ?? []), attempt] });
      return attempt;
    });
  }
  finishDelivery(id: string, attemptId: string, outcome: Exclude<DeliveryAttempt['outcome'], 'sending'>, error?: string): Delivery {
    return this.transaction(() => {
      const delivery = this.delivery(id);
      const attempt = delivery?.attempts?.at(-1);
      if (!delivery || delivery.status !== 'sending' || attempt?.id !== attemptId) throw new Error('投递尝试已失效');
      const status = outcome === 'rejected' ? 'pending' : outcome;
      return this.saveDelivery({ ...delivery, status, lastError: error?.slice(0, 500), sentAt: status === 'sent' || status === 'staged' ? now() : null,
        attempts: [...delivery.attempts!.slice(0, -1), { ...attempt, outcome, finishedAt: now() }] });
    });
  }
  resolveDelivery(id: string, attemptId: string, resolution: NonNullable<DeliveryAttempt['resolution']>): Delivery {
    return this.transaction(() => {
      const delivery = this.delivery(id);
      const attempt = delivery?.attempts?.at(-1);
      if (!delivery || delivery.status !== 'unknown' || attempt?.id !== attemptId) throw new Error('投递结果已更新，请刷新后再核对');
      const status = resolution === 'confirmed' ? attempt.mode : resolution === 'not_received' ? 'pending' : 'cancelled';
      return this.saveDelivery({ ...delivery, status, lastError: undefined, sentAt: resolution === 'confirmed' ? now() : null,
        attempts: [...delivery.attempts!.slice(0, -1), { ...attempt, resolution }] });
    });
  }
  private saveDelivery(delivery: Delivery): Delivery {
    const message = this.get<GroupMessage>('messages', delivery.messageId);
    if (!message) throw new Error('群组消息不存在');
    const updated = this.put('deliveries', delivery);
    const group = this.updateGroup(message.groupId, {});
    this.put('messages', { ...message, revision: Date.parse(group.updatedAt) });
    return updated;
  }
  activity(sessionId: string | null, type: string, text: string): Activity {
    const event = this.put('activities', { id: randomUUID(), sessionId, type, text, createdAt: now() });
    this.db.exec('DELETE FROM activities WHERE rowid NOT IN (SELECT rowid FROM activities ORDER BY rowid DESC LIMIT 500)');
    return event;
  }
  close() { this.db.close(); }
}
