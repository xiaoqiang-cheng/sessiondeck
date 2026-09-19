import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session, Group, GroupMessage, Delivery, Activity, GroupDetail } from '../shared/types.ts';

const now = () => new Date().toISOString();
type Table = 'sessions' | 'groups' | 'messages' | 'deliveries' | 'activities';

export class Store {
  readonly db: DatabaseSync;
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
      CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries(json_extract(data, '$.messageId'));`);
    // A restart must not leave phantom live agents in the contact list.
    for (const session of this.sessions()) {
      if (session.running) this.updateSession(session.id, {
        running: false, status: 'unknown', statusSource: 'process',
        statusDetail: '服务已重新启动，点击进入并恢复原生会话', nativeUrl: null,
      });
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
    return data;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  sessions() { return this.list<Session>('sessions'); }
  session(id: string) { return this.get<Session>('sessions', id); }
  groups() { return this.list<Group>('groups'); }
  group(id: string) { return this.get<Group>('groups', id); }
  deliveries() { return this.list<Delivery>('deliveries'); }
  delivery(id: string) { return this.get<Delivery>('deliveries', id); }
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
  groupDetail(id: string): GroupDetail {
    const group = this.group(id);
    if (!group) throw new Error('群组不存在');
    // Index by group before decoding JSON so another group's large history
    // cannot slow down every live conversation or enter this response's memory.
    const messages = this.db.prepare("SELECT data FROM messages WHERE json_extract(data, '$.groupId') = ? ORDER BY rowid").all(id)
      .map(row => JSON.parse(String(row.data)) as GroupMessage);
    const deliveries = this.db.prepare(`SELECT d.data FROM deliveries d JOIN messages m ON m.id = json_extract(d.data, '$.messageId')
      WHERE json_extract(m.data, '$.groupId') = ? ORDER BY d.rowid`).all(id)
      .map(row => JSON.parse(String(row.data)) as Delivery);
    return { group, messages, deliveries };
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
      const message = this.put('messages', { ...input, recipientIds, id: randomUUID(), createdAt: now() });
      const group = this.group(input.groupId)!;
      for (const sessionId of recipientIds) this.put<Delivery>('deliveries', {
        id: randomUUID(), messageId: message.id, sessionId,
        text: `【SessionDeck 群组：${group.title}】\n共同目标：${group.goal || '见群组讨论'}\n来自：${input.senderName}${source ? `\n转交来源：${source.senderName}的${source.kind === 'result' ? '结果' : source.kind === 'task' ? '任务' : '记录'}` : ''}\n\n${input.text}`,
        status: 'pending', createdAt: now(), sentAt: null,
      });
      this.updateGroup(group.id, {});
      return message;
    });
  }
  updateDelivery(id: string, status: Delivery['status']) {
    const delivery = this.delivery(id);
    if (!delivery) throw new Error('投递记录不存在');
    if (delivery.status !== 'pending') throw new Error('这条消息已处理，不能重复投递');
    return this.transaction(() => {
      const updated = this.put('deliveries', { ...delivery, status, sentAt: status === 'sent' || status === 'staged' ? now() : null });
      const message = this.get<GroupMessage>('messages', delivery.messageId);
      if (!message) throw new Error('群组消息不存在');
      this.updateGroup(message.groupId, {});
      return updated;
    });
  }
  activity(sessionId: string | null, type: string, text: string): Activity {
    const event = this.put('activities', { id: randomUUID(), sessionId, type, text, createdAt: now() });
    this.db.exec('DELETE FROM activities WHERE rowid NOT IN (SELECT rowid FROM activities ORDER BY rowid DESC LIMIT 500)');
    return event;
  }
  close() { this.db.close(); }
}
