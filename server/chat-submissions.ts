import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CodexChatSubmission } from '../shared/chat.ts';

interface Record extends CodexChatSubmission {
  sessionId: string;
  nativeId: string;
  promptHash: string;
  createdAt: string;
}

/** A restart or network loss cannot turn an uncertain native send into a retry.
 * Only the prompt hash is kept here; native Codex remains the history owner. */
export class ChatSubmissions {
  constructor(private readonly db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS chat_submissions (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    db.exec(`UPDATE chat_submissions SET data = json_set(data, '$.status', 'unknown', '$.error', '服务在发送期间重启，请先核对原生会话') WHERE json_extract(data, '$.status') = 'sending'`);
  }
  private getRecord(sessionId: string, requestId: string): Record | undefined {
    const row = this.db.prepare('SELECT data FROM chat_submissions WHERE id = ?').get(`${sessionId}:${requestId}`);
    return row ? JSON.parse(String(row.data)) as Record : undefined;
  }
  get(sessionId: string, requestId: string): CodexChatSubmission | undefined {
    const record = this.getRecord(sessionId, requestId);
    if (!record) return;
    return { requestId: record.requestId, status: record.status, ...(record.turnId ? { turnId: record.turnId } : {}), ...(record.error ? { error: record.error } : {}) };
  }
  begin(sessionId: string, requestId: string, nativeId: string, text: string): { created: boolean; submission: CodexChatSubmission } {
    const promptHash = createHash('sha256').update(text).digest('hex');
    const previous = this.getRecord(sessionId, requestId);
    if (previous) {
      if (previous.promptHash !== promptHash || previous.nativeId !== nativeId) throw Object.assign(new Error('这个发送标识已用于其他内容，请先核对原消息'), { status: 409 });
      return { created: false, submission: this.get(sessionId, requestId)! };
    }
    const record: Record = { requestId, sessionId, nativeId, promptHash, status: 'sending', createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO chat_submissions(id,data) VALUES (?,?)').run(`${sessionId}:${requestId}`, JSON.stringify(record));
    return { created: true, submission: { requestId, status: 'sending' } };
  }
  finish(sessionId: string, requestId: string, patch: Pick<CodexChatSubmission, 'status' | 'turnId' | 'error'>): CodexChatSubmission {
    const current = this.getRecord(sessionId, requestId);
    if (!current) throw new Error('发送记录不存在');
    this.db.prepare('UPDATE chat_submissions SET data = ? WHERE id = ?').run(JSON.stringify({ ...current, ...patch }), `${sessionId}:${requestId}`);
    return this.get(sessionId, requestId)!;
  }
}
