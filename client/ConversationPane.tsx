import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine, MessageSquare, RefreshCw, TerminalSquare } from 'lucide-react';
import type { ConversationTranscript, Session } from '../shared/types';
import { api } from './api';
import './conversation.css';

type Snapshot = { identity: string; transcript: ConversationTranscript; syncedAt: Date };
type ScrollAnchor = { id: string; offset: number };

const backendName = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' };

function messageTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Reads native structured history. Input and permission decisions remain native. */
export default function ConversationPane({ session, onTerminal, onSelection }: {
  session: Session; onTerminal: () => void; onSelection?: (text: string) => void;
}) {
  const identity = `${session.id}:${session.nativeSessionId ?? ''}:${session.forkPending}`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const anchor = useRef<ScrollAnchor | null>(null);
  const refresh = useRef<(manual?: boolean) => void>(() => {});
  const running = useRef(session.running);
  const selectionCallback = useRef(onSelection);
  running.current = session.running;
  selectionCallback.current = onSelection;
  const current = snapshot?.identity === identity ? snapshot : null;

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let pendingRefresh = false;
    let pendingManual = false;
    let previous: ConversationTranscript | undefined;
    setLoading(true); setRefreshing(false); setError(''); setAtBottom(true);
    followBottom.current = true; anchor.current = null;
    selectionCallback.current?.('');

    function captureAnchor() {
      const element = scroller.current;
      if (!element || followBottom.current) return;
      const top = element.getBoundingClientRect().top;
      const first = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((message) => message.getBoundingClientRect().bottom > top);
      anchor.current = first ? { id: first.dataset.messageId!, offset: first.getBoundingClientRect().top - top } : null;
    }

    async function load(manual = false) {
      if (disposed) return;
      if (inFlight) { pendingRefresh = true; pendingManual ||= manual; return; }
      inFlight = true;
      if (manual) setRefreshing(true);
      try {
        const transcript = await api<ConversationTranscript>(`/sessions/${encodeURIComponent(session.id)}/conversation`);
        if (disposed) return;
        // Polling an unchanged transcript must not replace selected message text.
        if (!previous || JSON.stringify(previous) !== JSON.stringify(transcript)) {
          captureAnchor();
          previous = transcript;
          setSnapshot({ identity, transcript, syncedAt: new Date() });
        }
        setError('');
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : '暂时无法读取对话记录');
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false); setRefreshing(false);
          if (pendingRefresh) { const manual = pendingManual; pendingRefresh = false; pendingManual = false; void load(manual); }
        }
      }
    }
    refresh.current = (manual) => { void load(manual); };
    void load();
    const timer = setInterval(() => {
      if (running.current && document.visibilityState !== 'hidden') void load();
    }, 3000);
    const onVisible = () => { if (document.visibilityState !== 'hidden') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible);
      refresh.current = () => {}; selectionCallback.current?.('');
    };
  }, [identity, session.id]);

  useEffect(() => { refresh.current(); }, [session.lastActivity, session.running, session.status, session.lastUserInputAt]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !current) return;
    if (followBottom.current) element.scrollTop = element.scrollHeight;
    else if (anchor.current) {
      const { id, offset } = anchor.current;
      const target = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(message => message.dataset.messageId === id);
      if (target) element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - offset;
    }
    anchor.current = null;
  }, [current]);

  useEffect(() => {
    const onSelect = () => {
      const selection = window.getSelection();
      const element = scroller.current;
      if (!selection || !element) return;
      const anchorElement = selection.anchorNode?.parentElement?.closest('.conversation-text');
      const focusElement = selection.focusNode?.parentElement?.closest('.conversation-text');
      selectionCallback.current?.(anchorElement && focusElement && element.contains(anchorElement) && element.contains(focusElement)
        ? selection.toString().trim() : '');
    };
    document.addEventListener('selectionchange', onSelect);
    const element = scroller.current;
    const observer = new ResizeObserver(() => { if (followBottom.current && element) element.scrollTop = element.scrollHeight; });
    if (element) observer.observe(element);
    return () => { document.removeEventListener('selectionchange', onSelect); observer.disconnect(); };
  }, []);

  const transcript = current?.transcript;
  const empty = !transcript?.messages.length;
  const isLoading = loading && !current;
  const scrollToBottom = () => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    followBottom.current = true; setAtBottom(true);
  };

  return <section className="conversation-pane" aria-label="原生对话记录">
    {/* One quiet row: what this is, how much is shown, and the two actions. The
        view switch in the session header already names the backend. */}
    <header className="conversation-toolbar">
      <span className="conversation-source" title={transcript?.notice || (transcript?.truncated ? '只显示最近一部分记录，完整上下文请在原生终端中查看' : '只读 · 发送消息、工具详情和审批请使用原生终端')}>
        <MessageSquare size={13} />{transcript && !empty ? `${transcript.messages.length} 条` : '记录'}{transcript?.truncated && !transcript.notice && <em>（最近部分，完整上下文请在原生终端中查看）</em>}{transcript?.notice && <em>（{transcript.notice}）</em>}{current && <time dateTime={current.syncedAt.toISOString()}>{current.syncedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}
      </span>
      <span className="conversation-actions">
        {!atBottom && !empty && <button className="text-button" onClick={scrollToBottom}><ArrowDownToLine size={13} />回到最新消息</button>}
        <button className="icon-button" aria-label="刷新记录" title="刷新记录" disabled={isLoading || refreshing} onClick={() => refresh.current(true)}><RefreshCw size={14} className={isLoading || refreshing ? 'spin' : undefined} /></button>
        <button className="icon-button" aria-label="进入原生终端" title="进入原生终端" onClick={onTerminal}><TerminalSquare size={14} /></button>
      </span>
    </header>
    {error && <div className="conversation-error" role="alert"><span>{error}</span><button className="text-button" disabled={refreshing} onClick={() => refresh.current(true)}>重试读取</button></div>}
    <div className="conversation-scroller" ref={scroller} tabIndex={0} aria-label="会话消息" onScroll={(event) => {
      const element = event.currentTarget;
      const next = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
      followBottom.current = next; setAtBottom(next);
    }}>
      {isLoading ? <div className="conversation-empty" role="status"><RefreshCw size={24} className="spin" /><h3>正在读取原生记录</h3></div>
        : empty ? <div className="conversation-empty"><MessageSquare size={28} /><h3>{error ? '暂时无法显示对话' : '还没有可显示的对话'}</h3>
          <p>{session.forkPending ? '启动 Fork 后，这里将显示新会话的记录。' : !session.nativeSessionId ? '启动原生会话并发送第一条消息后，记录会显示在这里。' : '原生记录保存后会出现在这里；可刷新记录或进入终端继续。'}</p>
          <button className="button secondary" onClick={onTerminal}><TerminalSquare size={14} />进入原生终端</button></div>
          : <ol className="conversation-messages">{transcript!.messages.map(message => <li key={message.id} data-message-id={message.id} className={`conversation-message from-${message.role}`}>
            <div className="conversation-message-meta"><span>{message.role === 'user' ? '你' : backendName[session.backend]}</span>{messageTime(message.createdAt) && <time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>}</div>
            <div className="conversation-text">{message.text}</div>
          </li>)}</ol>}
    </div>
  </section>;
}
