import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, Check, ChevronRight, CircleAlert, LoaderCircle, MessageSquare, RefreshCw, Send, Square, TerminalSquare } from 'lucide-react';
import type { Session } from '../shared/types';
import type { CodexChatAnswer, CodexChatItem, CodexChatPatch, CodexChatRequest, CodexChatSnapshot, CodexChatSubmission } from '../shared/chat';
import { api, ApiError } from './api';
import Markdown from './Markdown';
import './codex-chat.css';

type Pending = { requestId: string; text: string };
type Draft = { text: string; pending: Pending | null };
const draftKey = (id: string) => `sessiondeck.codex-chat-draft.${id}`;
function readDraft(id: string): Draft {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(id)) ?? 'null');
    if (value && typeof value.text === 'string') return {
      text: value.text.slice(0, 30000),
      pending: typeof value.pending?.requestId === 'string' && typeof value.pending.text === 'string' ? value.pending : null,
    };
  } catch { /* A missing or invalid draft must not prevent reading the session. */ }
  return { text: '', pending: null };
}
function saveDraft(id: string, value: Draft) {
  try { sessionStorage.setItem(draftKey(id), JSON.stringify(value)); return true; } catch { return false; }
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';
function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}

const MessageItem = memo(function MessageItem({ item }: { item: CodexChatItem }) {
  if (item.type === 'assistant' || item.type === 'user') return <article className={`codex-message codex-${item.type}`} data-chat-item={item.id}>
    <div className="codex-message-heading"><strong>{item.type === 'user' ? '你' : 'Codex'}</strong>{item.status === 'inProgress' && <span><LoaderCircle size={11} className="spin" />正在回复</span>}{item.status === 'failed' && <span>未完成</span>}</div>
    <div className="codex-message-body">{item.type === 'assistant' ? <Markdown text={item.text || '…'} /> : <p>{item.text}</p>}</div>
  </article>;
  if (item.type === 'notice') return <p className="codex-inline-notice" data-chat-item={item.id}>{item.text}</p>;
  if (item.type === 'plan') return <article className="codex-plan" data-chat-item={item.id}><strong>{item.title || '执行计划'}</strong><Markdown text={item.text} /></article>;
  return <details className={`codex-tool ${item.status === 'failed' ? 'failed' : ''}`} data-chat-item={item.id}>
    <summary><ChevronRight size={13} />{item.status === 'inProgress' ? <LoaderCircle size={13} className="spin" /> : item.status === 'failed' ? <CircleAlert size={13} /> : <Check size={13} />}<span>{item.title || (item.type === 'command' ? '运行命令' : item.type === 'fileChange' ? '修改文件' : '使用工具')}</span><small>{item.status === 'inProgress' ? '执行中' : item.status === 'failed' ? '失败' : '已完成'}</small></summary>
    {item.text && <pre>{item.text}</pre>}{item.output && <pre className="codex-tool-output">{item.output}</pre>}
  </details>;
});

function NativeRequest({ request, disabled, answer }: { request: CodexChatRequest; disabled: boolean; answer: (id: string, answer: CodexChatAnswer) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(payload: CodexChatAnswer) {
    if (busy || disabled) return;
    setBusy(true); setError('');
    try { await answer(request.id, payload); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const questions = request.questions ?? [];
  const complete = questions.every(question => !!(values[question.id] === '__other__' ? other[question.id]?.trim() : values[question.id]?.trim()));
  return <section className="codex-request" aria-label={request.kind === 'question' ? 'Codex 提问' : 'Codex 审批'}>
    <div className="codex-request-heading"><CircleAlert size={16} /><h3>{request.title}</h3></div>
    {request.description && <p>{request.description}</p>}
    {request.details && <details open><summary>操作详情</summary><pre>{request.details}</pre></details>}
    {request.kind === 'question' ? <form onSubmit={(event) => {
      event.preventDefault(); if (!complete) return;
      void submit({ answers: Object.fromEntries(questions.map(question => [question.id, [values[question.id] === '__other__' ? other[question.id].trim() : values[question.id].trim()]])) });
    }}>
      {questions.map(question => <fieldset key={question.id} disabled={disabled || busy}><legend>{question.header && <span>{question.header} · </span>}{question.question}</legend>
        {question.options?.length ? <><div className="codex-question-options">{question.options.map(option => <label key={option.label}><input type="radio" name={`${request.id}-${question.id}`} value={option.label} checked={values[question.id] === option.label} onChange={() => setValues(current => ({ ...current, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}{question.isOther && <label><input type="radio" name={`${request.id}-${question.id}`} checked={values[question.id] === '__other__'} onChange={() => setValues(current => ({ ...current, [question.id]: '__other__' }))} /><span>其他答案</span></label>}</div>
          {values[question.id] === '__other__' && <input aria-label={`${question.question}：其他答案`} type={question.isSecret ? 'password' : 'text'} value={other[question.id] ?? ''} onChange={event => setOther(current => ({ ...current, [question.id]: event.target.value }))} maxLength={8000} autoComplete="off" />}</>
          : <input aria-label={question.question} type={question.isSecret ? 'password' : 'text'} value={values[question.id] ?? ''} onChange={event => setValues(current => ({ ...current, [question.id]: event.target.value }))} maxLength={8000} autoComplete="off" />}
      </fieldset>)}<button type="submit" className="button primary small-button" disabled={disabled || busy || !complete}>{busy ? '提交中…' : '提交回答'}</button>
    </form> : <div className="codex-approval-actions">{request.options?.map(option => <button type="button" key={option.id} className="button secondary small-button" disabled={disabled || busy} onClick={() => void submit({ decision: option.id })}>{option.label}</button>)}{request.kind === 'unsupported' && <p>当前界面还不能处理这个请求，请在原生终端中核对。</p>}</div>}
    {error && <p className="codex-request-error" role="alert">{error}</p>}
  </section>;
}

export default function CodexChatPane(props: { session: Session; onTerminal: () => void; onSelection?: (text: string) => void }) {
  return <ChatSession key={props.session.id} {...props} />;
}

function ChatSession({ session, onTerminal, onSelection }: { session: Session; onTerminal: () => void; onSelection?: (text: string) => void }) {
  const [draft, setDraft] = useState(() => readDraft(session.id));
  const [snapshot, setSnapshot] = useState<CodexChatSnapshot | null>(null);
  const [transport, setTransport] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedUnknown, setCheckedUnknown] = useState(false);
  const [checkNotice, setCheckNotice] = useState('');
  const [interrupting, setInterrupting] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const snapshotRef = useRef(snapshot);
  const draftRef = useRef(draft);
  const sessionRef = useRef(session);
  const active = useRef(true);
  const busyRef = useRef(false);
  const onSelectionRef = useRef(onSelection);
  const readSnapshot = useRef<() => Promise<void>>(async () => {});
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const followsBottom = useRef(true);
  const scrollAnchor = useRef<{ id: string; offset: number } | null>(null);
  draftRef.current = draft; sessionRef.current = session; onSelectionRef.current = onSelection;
  function updateDraft(next: Draft) {
    draftRef.current = next; saveDraft(session.id, next);
    if (active.current) setDraft(next);
    else window.dispatchEvent(new CustomEvent('sessiondeck:codex-draft', { detail: { id: session.id } }));
  }

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let sequence = 0;
    let sourceReset = true;
    let refreshJob: Promise<void> | undefined;
    let refreshAgain = false;
    function install(next: CodexChatSnapshot) {
      if (disposed) return;
      const previous = snapshotRef.current;
      if (previous?.instanceId === next.instanceId && previous?.nativeSessionId === next.nativeSessionId && next.revision < previous.revision) return;
      const element = scroller.current;
      if (!followsBottom.current && element) {
        const retained = new Set(next.items.map(item => item.id));
        const top = element.getBoundingClientRect().top;
        const visible = [...element.querySelectorAll<HTMLElement>('[data-chat-item]')].find(item => retained.has(item.dataset.chatItem!) && item.getBoundingClientRect().bottom > top);
        scrollAnchor.current = visible ? { id: visible.dataset.chatItem!, offset: visible.getBoundingClientRect().top - top } : null;
      }
      snapshotRef.current = next; setSnapshot(next); setLoading(false); setError('');
    }
    async function refresh(required = false): Promise<void> {
      if (disposed) return;
      if (refreshJob) { refreshAgain ||= required; return refreshJob; }
      const before = sequence;
      refreshJob = (async () => {
        try { const result = await api<CodexChatSnapshot>(`/sessions/${session.id}/chat`); if (sequence === before) install(result); }
        catch (cause) { if (!disposed && sequence === before) { setError(errorText(cause)); setLoading(false); } }
        finally { refreshJob = undefined; if (refreshAgain && !disposed) { refreshAgain = false; void refresh(); } }
      })();
      return refreshJob;
    }
    readSnapshot.current = refresh;
    const source = new EventSource(`/api/sessions/${encodeURIComponent(session.id)}/chat/events`);
    source.onopen = () => { if (!disposed) { sourceReset = true; setTransport(true); } };
    source.onerror = () => { if (!disposed) setTransport(false); };
    source.addEventListener('unavailable', event => {
      if (disposed) return;
      setTransport(false);
      try { const details = JSON.parse((event as MessageEvent).data) as { error?: string }; setError(details.error || '原生会话连接暂不可用，请刷新后重试。'); }
      catch { setError('原生会话连接暂不可用，请刷新后重试。'); }
    });
    source.addEventListener('state', event => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as CodexChatSnapshot;
        const previous = snapshotRef.current;
        if (!sourceReset && previous?.instanceId === next.instanceId && previous?.nativeSessionId === next.nativeSessionId && next.revision < previous.revision) return;
        sourceReset = false; sequence++; install(next);
      } catch { void refresh(); }
    });
    source.addEventListener('patch', event => {
      try {
        const patch = JSON.parse((event as MessageEvent).data) as CodexChatPatch;
        const previous = snapshotRef.current;
        if (previous && patch.instanceId === previous.instanceId && patch.nativeSessionId === previous.nativeSessionId && patch.revision <= previous.revision) return;
        if (!previous || patch.instanceId !== previous.instanceId || patch.nativeSessionId !== previous.nativeSessionId || patch.baseRevision !== previous.revision) { sequence++; void refresh(true); return; }
        const items = new Map(previous.items.map(item => [item.id, item]));
        for (const item of patch.items) items.set(item.id, item);
        if (patch.order.some(id => !items.has(id))) { sequence++; void refresh(true); return; }
        sequence++; install({ instanceId: patch.instanceId, nativeSessionId: patch.nativeSessionId, revision: patch.revision, connected: patch.connected, activeTurnId: patch.activeTurnId, requests: patch.requests, truncated: patch.truncated, notice: patch.notice, items: patch.order.map(id => items.get(id)!) });
      } catch { void refresh(); }
    });
    void refresh();
    const visible = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const changedDraft = (event: Event) => {
      if ((event as CustomEvent<{ id: string }>).detail.id === session.id) { const next = readDraft(session.id); draftRef.current = next; setDraft(next); }
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('sessiondeck:codex-draft', changedDraft);
    return () => { disposed = true; active.current = false; source.close(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('sessiondeck:codex-draft', changedDraft); onSelectionRef.current?.(''); };
  }, [session.id]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (followsBottom.current) element.scrollTop = element.scrollHeight;
    else if (scrollAnchor.current) {
      const { id, offset } = scrollAnchor.current;
      const target = [...element.querySelectorAll<HTMLElement>('[data-chat-item]')].find(item => item.dataset.chatItem === id);
      if (target) element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - offset;
    }
    scrollAnchor.current = null;
  }, [snapshot]);
  useEffect(() => {
    const element = scroller.current;
    const observer = new ResizeObserver(() => { if (element && followsBottom.current) element.scrollTop = element.scrollHeight; });
    if (element) observer.observe(element);
    const select = () => {
      const selected = window.getSelection();
      if (!selected || !element) return;
      const from = selected.anchorNode?.parentElement?.closest('.codex-message-body');
      const to = selected.focusNode?.parentElement?.closest('.codex-message-body');
      onSelectionRef.current?.(from && to && element.contains(from) && element.contains(to) ? selected.toString().trim() : '');
    };
    document.addEventListener('selectionchange', select);
    return () => { observer.disconnect(); document.removeEventListener('selectionchange', select); };
  }, []);

  function accepted(pending: Pending) {
    // A late response may finish after this panel was closed and reopened.
    // Clear only its own submitted snapshot, preserving the newer editor.
    const current = active.current ? draftRef.current : readDraft(session.id);
    if (current.pending?.requestId !== pending.requestId) return;
    updateDraft({ text: current.text === pending.text ? '' : current.text, pending: null });
    if (active.current) { setCheckNotice(''); setCheckedUnknown(false); void readSnapshot.current(); }
  }
  async function checkSubmission() {
    const pending = draftRef.current.pending;
    if (!pending || checking) return;
    setChecking(true); setCheckNotice('');
    try {
      const result = await api<CodexChatSubmission>(`/sessions/${session.id}/chat/submissions/${encodeURIComponent(pending.requestId)}`);
      if (!active.current || draftRef.current.pending?.requestId !== pending.requestId) return;
      if (result.status === 'accepted') accepted(pending);
      else if (result.status === 'rejected') { updateDraft({ ...draftRef.current, pending: null }); setError(result.error || '这条消息未被接收，草稿已保留，可以修改后重试。'); }
      else { setCheckedUnknown(result.status === 'unknown'); setCheckNotice(result.status === 'sending' ? '服务仍在提交这条消息，请稍后再次查询。' : '暂时无法确认。请先检查对话记录或原生终端，避免重复发送。'); }
    } catch (cause) {
      if (active.current) { setCheckedUnknown(cause instanceof ApiError && cause.status === 404); setCheckNotice(cause instanceof ApiError && cause.status === 404 ? '服务可能已重启，找不到本次发送记录。请先核对原生会话是否已收到。' : errorText(cause)); }
    } finally { if (active.current) setChecking(false); }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draftRef.current.text;
    if (!text.trim() || busyRef.current || draftRef.current.pending || !transport || session.archived || snapshot?.activeTurnId || snapshot?.requests.length || (session.running && !snapshot?.connected)) return;
    busyRef.current = true; setBusy(true); setError(''); setCheckNotice('');
    let pending: Pending | undefined;
    try {
      if (!sessionRef.current.running || sessionRef.current.interactionMode !== 'chat') await api(`/sessions/${session.id}/start`, { mode: 'chat' });
      if (!active.current) return;
      pending = { requestId: requestId(), text };
      const next = { ...draftRef.current, pending };
      if (!saveDraft(session.id, next)) throw new Error('无法保存本次发送状态。请允许此站点使用浏览器存储后重试。');
      updateDraft(next);
      const result = await api<CodexChatSubmission>(`/sessions/${session.id}/chat/messages`, { text, requestId: pending.requestId });
      if (result.status === 'accepted') accepted(pending);
      else if (result.status === 'rejected') { const current = active.current ? draftRef.current : readDraft(session.id); if (current.pending?.requestId === pending.requestId) updateDraft({ ...current, pending: null }); if (active.current) setError(result.error || '消息未被接收，草稿已保留。'); }
      else if (active.current) setCheckNotice(result.status === 'sending' ? '消息正在提交，请查询发送结果。' : '发送结果尚未确认，请查询结果后继续。');
    } catch (cause) {
      if (pending && cause instanceof ApiError && cause.status >= 400 && cause.status < 500) { const current = active.current ? draftRef.current : readDraft(session.id); if (current.pending?.requestId === pending.requestId) updateDraft({ ...current, pending: null }); }
      if (active.current) setError(errorText(cause));
    } finally {
      busyRef.current = false;
      if (active.current) { setBusy(false); textarea.current?.focus(); }
    }
  }

  const hasTurn = !!snapshot?.activeTurnId;
  const nativeAvailable = !session.running || !!snapshot?.connected;
  const canSend = !!draft.text.trim() && !busy && !draft.pending && transport && nativeAvailable && !hasTurn && !snapshot?.requests.length && !session.archived;
  return <section className="codex-chat-pane" aria-label="Codex 图形会话">
    <header className="codex-chat-toolbar"><span><MessageSquare size={15} /><strong>Codex</strong><i className={transport && nativeAvailable ? 'online' : ''} />{!transport ? '连接中' : snapshot?.requests.length ? '需要你回复' : hasTurn ? '正在处理' : session.running ? '已连接' : '尚未启动'}</span><div><button className="icon-button" type="button" aria-label="刷新对话" title="刷新对话" onClick={() => void readSnapshot.current()}><RefreshCw size={14} /></button><button type="button" className="text-button" onClick={onTerminal}><TerminalSquare size={14} />原生终端</button></div></header>
    {!transport && !loading && <div className="codex-chat-banner" role="status">与本地服务的连接已中断，正在重连。草稿已保留。</div>}
    {error && <div className="codex-chat-error" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={() => { setError(''); void readSnapshot.current(); }}>重新读取</button></div>}
    {snapshot?.notice && <p className="codex-chat-notice">{snapshot.notice}</p>}
    {snapshot?.truncated && <p className="codex-chat-notice">当前展示最近的消息，完整历史保留在原生会话中。</p>}
    <div className="codex-chat-scroll" ref={scroller} tabIndex={0} aria-label="Codex 消息记录" onScroll={event => {
      const element = event.currentTarget, bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      followsBottom.current = bottom; setAtBottom(bottom);
    }}>
      {loading && !snapshot ? <div className="codex-chat-empty" role="status"><LoaderCircle className="spin" size={25} /><p>正在读取对话…</p></div> : !snapshot?.items.length ? <div className="codex-chat-empty"><MessageSquare size={30} /><h3>在这里继续你的工作</h3><p>发送消息后，Codex 会在当前工作目录中处理任务。操作审批和需要补充的问题会显示在对话里。</p></div> : <div className="codex-chat-items">{snapshot.items.map(item => <MessageItem key={item.id} item={item} />)}</div>}
      {!!snapshot?.requests.length && <div className="codex-chat-requests">{snapshot.requests.map(request => <NativeRequest key={request.id} request={request} disabled={!transport || !snapshot.connected} answer={async (id, answer) => { await api(`/sessions/${session.id}/chat/requests/${encodeURIComponent(id)}`, answer); await readSnapshot.current(); }} />)}</div>}
    </div>
    {!atBottom && <button type="button" className="codex-latest" onClick={() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; followsBottom.current = true; setAtBottom(true); }}><ArrowDownToLine size={13} />回到最新消息</button>}
    {draft.pending && !busy && <div className="codex-pending" role="status"><strong>发送结果待确认</strong><p>{checkNotice || '这条消息可能已被原生会话接收。查询结果前不会重复发送。'}</p><div><button type="button" className="button secondary small-button" disabled={checking} onClick={() => void checkSubmission()}>{checking ? '正在查询…' : '查询发送结果'}</button>{checkedUnknown && <><button type="button" className="text-button" onClick={() => { if (draftRef.current.pending) accepted(draftRef.current.pending); setError(''); }}>已核对收到，完成发送</button><button type="button" className="text-button" onClick={() => { updateDraft({ ...draftRef.current, pending: null }); setCheckedUnknown(false); setCheckNotice(''); setError(''); }}>已核对未发送，恢复草稿</button></>}</div></div>}
    <form className="codex-composer" onSubmit={event => void send(event)}>
      <textarea ref={textarea} aria-label="给 Codex 发送消息" placeholder={session.archived ? '恢复联系人后继续对话' : hasTurn ? '可以先写下下一条消息…' : '描述任务，或继续补充你的想法…'} value={draft.text} maxLength={30000} disabled={session.archived} rows={3} onChange={event => updateDraft({ ...draftRef.current, text: event.target.value })} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (canSend) void send(); }
      }} />
      <div className="codex-composer-footer"><span>{busy ? '正在发送…' : draft.pending ? '请先核对上一条消息的发送结果' : !nativeAvailable ? '原生连接尚未就绪，请刷新后重试' : 'Enter 发送 · Shift + Enter 换行'}</span><div>{hasTurn && <button type="button" className="button secondary small-button" disabled={!transport || interrupting} onClick={async () => {
        setInterrupting(true); setError('');
        try { await api(`/sessions/${session.id}/chat/interrupt`, {}); await readSnapshot.current(); }
        catch (cause) { if (active.current) setError(errorText(cause)); }
        finally { if (active.current) setInterrupting(false); }
      }}><Square size={12} />{interrupting ? '正在停止…' : '停止生成'}</button>}<button type="submit" className="button primary small-button" disabled={!canSend}>{busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}发送</button></div></div>
    </form>
  </section>;
}
