import type express from 'express';
import type { Session } from '../shared/types.ts';
import type { CodexChatPatch, CodexChatSnapshot } from '../shared/chat.ts';
import type { CodexBridge } from './codex.ts';
import type { ConversationReader } from './conversation.ts';
import { conversationPreview } from './conversation.ts';
import { ChatSubmissions } from './chat-submissions.ts';
import type { Store } from './store.ts';

interface Dependencies {
  store: Store;
  bridge: CodexBridge;
  conversations: ConversationReader;
  instanceId: string;
  demo: boolean;
  closing(): boolean;
  supported(): boolean;
  ready(item: Session): boolean;
  busy(id: string): boolean;
  sessions(): Session[];
  broadcast(): void;
}
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const requestId = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(value) ? value : fail('发送标识无效');
interface Viewer { response: express.Response; previous?: CodexChatSnapshot }

export function registerCodexChat(app: express.Express, options: Dependencies) {
  const { store, bridge, conversations } = options;
  const submissions = new ChatSubmissions(store.db);
  const viewers = new Map<string, Set<Viewer>>();
  const scheduled = new Map<string, NodeJS.Timeout>();
  const snapshots = new Map<string, CodexChatSnapshot>();
  let revision = 0;
  function session(id: string): Session {
    const item = store.session(id) ?? fail('会话不存在', 404);
    if (item.backend !== 'codex') fail('图形化聊天目前仅支持 Codex');
    return item;
  }
  function writable(id: string): Session {
    const item = session(id);
    if (options.demo || !options.supported()) fail('当前 Codex 不支持原生图形化交互，请使用原生终端');
    if (options.closing() || options.busy(id)) fail('会话正在启动或停止，请稍后重试', 409);
    if (item.archived || item.forkPending || !item.running || !item.nativeSessionId || !options.ready(item)) fail('请先启动或恢复这个 Codex 会话', 409);
    return item;
  }
  function remember(id: string, snapshot: CodexChatSnapshot) {
    const previous = snapshots.get(id);
    const comparable = { ...snapshot, instanceId: options.instanceId, revision: 0 };
    if (previous && JSON.stringify({ ...previous, revision: 0 }) === JSON.stringify(comparable)) return previous;
    const next = { ...comparable, revision: ++revision };
    snapshots.delete(id); snapshots.set(id, next);
    // Only visible or recently accessed contacts need an HTTP view cache.
    for (const key of snapshots.keys()) {
      if (snapshots.size <= 100) break;
      if (!viewers.has(key)) snapshots.delete(key);
    }
    return next;
  }
  function nativeView(item: Session, snapshot: CodexChatSnapshot) {
    return remember(item.id, { ...snapshot, connected: item.running && options.ready(item) && snapshot.connected });
  }
  async function read(id: string) {
    const item = session(id);
    const identity = item.nativeSessionId;
    if (!options.demo && identity && !item.forkPending) {
      try {
        const native = await bridge.readChat(identity);
        if (options.closing()) fail('服务正在关闭', 503);
        const current = session(id);
        if (current.nativeSessionId !== identity || current.forkPending) fail('会话身份已更新，请刷新', 409);
        // Bridge reconciles stream events received while thread/read was pending.
        return nativeView(current, native);
      } catch (error) {
        if (options.closing() || (error as { status?: number }).status === 409) throw error;
        const cached = bridge.chatSnapshot(identity);
        if (cached) return nativeView(session(id), cached);
      }
    }
    const transcript = options.demo ? { messages: [], truncated: false, notice: '演示终端不调用真实 Codex，请连接原生 Codex 使用图形化聊天。' } : await conversations.read(item);
    if (options.closing()) fail('服务正在关闭', 503);
    const current = session(id);
    if (current.nativeSessionId !== identity || current.forkPending !== item.forkPending) fail('会话身份已更新，请刷新', 409);
    return remember(id, {
      nativeSessionId: item.forkPending ? null : identity, connected: false, revision: 0, activeTurnId: null,
      items: transcript.messages.map(message => ({ id: message.id, type: message.role, text: message.text, status: 'completed' })),
      requests: [], truncated: transcript.truncated, notice: transcript.notice,
    });
  }
  function emit(id: string, snapshot: CodexChatSnapshot) {
    for (const viewer of viewers.get(id) ?? []) {
      const { response, previous } = viewer;
      if (response.destroyed || response.writableLength > 2_097_152) { response.destroy(); viewers.get(id)?.delete(viewer); continue; }
      if (previous?.revision === snapshot.revision) continue;
      if (!previous || previous.nativeSessionId !== snapshot.nativeSessionId) response.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);
      else {
        const oldItems = new Map(previous.items.map(item => [item.id, item]));
        const patch: CodexChatPatch = { ...snapshot, baseRevision: previous.revision, items: snapshot.items.filter(item => JSON.stringify(item) !== JSON.stringify(oldItems.get(item.id))), order: snapshot.items.map(item => item.id) };
        response.write(`event: patch\ndata: ${JSON.stringify(patch)}\n\n`);
      }
      viewer.previous = snapshot;
    }
  }
  function queue(id: string) {
    if (options.closing() || scheduled.has(id) || !viewers.has(id)) return;
    scheduled.set(id, setTimeout(() => {
      scheduled.delete(id);
      if (options.closing()) return;
      const item = store.session(id);
      const native = item?.nativeSessionId && !item.forkPending ? bridge.chatSnapshot(item.nativeSessionId) : undefined;
      if (item && native) emit(id, nativeView(item, native));
      else void read(id).then(snapshot => emit(id, snapshot)).catch(() => {});
    }, 80));
  }
  const offChat = bridge.onChat((nativeId, snapshot) => {
    if (options.closing()) return;
    const item = options.sessions().find(item => item.backend === 'codex' && item.nativeSessionId === nativeId && !item.forkPending);
    if (!item) return;
    queue(item.id);
    const preview = conversationPreview({ messages: snapshot.items.filter(item => item.type === 'user').map(item => ({ id: item.id, role: 'user', text: item.text })), truncated: snapshot.truncated });
    if (preview && preview.text !== item.lastUserInput) { store.updateSession(item.id, { lastUserInput: preview.text }); options.broadcast(); }
  });
  const offStore = store.onChange(change => { if (change.table === 'sessions' && change.data.backend === 'codex') queue(change.data.id); });

  app.get('/api/sessions/:id/chat', async (req, res) => res.json(await read(String(req.params.id))));
  app.get('/api/sessions/:id/chat/events', async (req, res) => {
    const id = String(req.params.id);
    session(id);
    const viewer: Viewer = { response: res };
    const set = viewers.get(id) ?? new Set<Viewer>(); set.add(viewer); viewers.set(id, set);
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 20_000);
    const cleanup = () => { clearInterval(heartbeat); set.delete(viewer); if (!set.size) viewers.delete(id); };
    req.on('close', cleanup);
    try { const snapshot = await read(id); if (!res.destroyed) emit(id, snapshot); }
    catch (error) { if (!res.destroyed) { res.write(`event: unavailable\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : '无法读取原生聊天' })}\n\n`); res.end(); } }
  });
  app.get('/api/sessions/:id/chat/submissions/:requestId', (req, res) => {
    const item = session(String(req.params.id));
    res.json(submissions.get(item.id, requestId(req.params.requestId)) ?? fail('没有找到发送记录，请先核对会话历史', 404));
  });
  app.post('/api/sessions/:id/chat/messages', async (req, res) => {
    const item = writable(String(req.params.id));
    const id = requestId(req.body.requestId);
    if (typeof req.body.text !== 'string' || !req.body.text.trim() || req.body.text.length > 32_000 || /\x00/.test(req.body.text)) fail('消息不能为空，且最多 32000 字符');
    const text = req.body.text.trim();
    const { created, submission } = submissions.begin(item.id, id, item.nativeSessionId!, text);
    if (!created) return res.status(submission.status === 'unknown' || submission.status === 'sending' ? 202 : 200).json(submission);
    try {
      const result = await bridge.sendPrompt(item.nativeSessionId!, text);
      if (options.closing()) return;
      const accepted = submissions.finish(item.id, id, { status: 'accepted', turnId: result.turnId });
      res.json(accepted);
    } catch (cause) {
      if (options.closing()) return;
      const rejected = (cause as { deliveryUnknown?: boolean }).deliveryUnknown === false;
      const error = cause instanceof Error ? cause.message : '无法确认原生会话是否收到消息';
      const result = submissions.finish(item.id, id, { status: rejected ? 'rejected' : 'unknown', error });
      if (rejected) res.status(409).json({ ...result, error, code: 'CHAT_REJECTED' });
      else res.status(202).json(result);
    }
  });
  app.post('/api/sessions/:id/chat/requests/:requestId', async (req, res) => {
    const item = writable(String(req.params.id));
    const id = String(req.params.requestId);
    if (!id || id.length > 200) fail('审批标识无效');
    await bridge.answerChatRequest(item.nativeSessionId!, id, req.body);
    res.json({ ok: true });
  });
  app.post('/api/sessions/:id/chat/interrupt', async (req, res) => {
    const item = writable(String(req.params.id));
    await bridge.stopSession(item.nativeSessionId!);
    res.json({ ok: true });
  });
  return { close() {
    offChat(); offStore();
    for (const timer of scheduled.values()) clearTimeout(timer);
    scheduled.clear();
    for (const set of viewers.values()) for (const viewer of set) viewer.response.end();
    viewers.clear(); snapshots.clear();
  } };
}
