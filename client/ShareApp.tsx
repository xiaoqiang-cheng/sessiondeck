import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Folder, Layers3, LoaderCircle, LogOut, MessageSquare, Play, Square, TerminalSquare } from 'lucide-react';
import type { AppState, Session } from '../shared/types';
import type { AuthStatus } from '../shared/auth';
import { api } from './api';
import { BACKEND, StatusBadge } from './App';
import TerminalPane from './TerminalPane';
import ConversationPane from './ConversationPane';
import WorkspaceExplorer from './WorkspaceExplorer';
import { readLocalPreference, writeLocalPreference } from './ui';

const CodexChatPane = lazy(() => import('./CodexChatPane'));
type ShareStatus = Extract<AuthStatus, { kind: 'share' }>;
const ignoreSelection = () => {};

/**
 * What a colleague sees through a share link: exactly one session, without the
 * owner's contact list, groups, Shell or settings. The server enforces the same
 * scope; this view only avoids offering actions that would be refused.
 */
export default function ShareApp({ status }: { status: ShareStatus }) {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [explorer, setExplorer] = useState(() => readLocalPreference('sessiondeck.share-explorer') === 'on');
  const [view, setView] = useState<'chat' | 'conversation' | 'terminal'>('terminal');
  const revisionRef = useRef(-1);
  const writable = status.mode === 'write';
  const accept = useCallback((next: AppState) => {
    if (typeof next.revision === 'number' && next.revision < revisionRef.current) return;
    revisionRef.current = next.revision ?? revisionRef.current;
    setState(next);
  }, []);
  useEffect(() => {
    void api<AppState>('/state').then(accept).catch(cause => setError(cause.message));
    const stream = new EventSource('/api/events');
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    // Shares always receive filtered full snapshots, never workspace patches.
    stream.addEventListener('state', event => { try { accept(JSON.parse((event as MessageEvent).data)); } catch { /* next snapshot recovers */ } });
    return () => stream.close();
  }, [accept]);
  useEffect(() => { writeLocalPreference('sessiondeck.share-explorer', explorer ? 'on' : 'off'); }, [explorer]);

  const session: Session | undefined = state?.sessions.find(item => item.id === status.sessionId);
  const backend = session ? state?.backends.find(item => item.id === session.backend) : undefined;
  const chatAvailable = session?.backend === 'codex' && !state?.demo && !!backend?.capabilities.graphicalChat;
  // Pick a sensible first view per backend; a read-only viewer cannot type into chat.
  useEffect(() => {
    if (!session) return;
    setView(current => current !== 'terminal' ? current : chatAvailable && writable && session.interactionMode === 'chat' ? 'chat' : 'terminal');
  }, [session?.id, chatAvailable, writable]);
  useEffect(() => { document.title = `${session?.title ?? '共享会话'} · SessionDeck`; }, [session?.title]);

  const act = async (path: 'start' | 'stop') => {
    if (!session) return;
    setBusy(true); setError('');
    try { await api(`/sessions/${session.id}/${path}`, path === 'start' ? { mode: view === 'chat' ? 'chat' : 'terminal' } : {}); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const logout = async () => { await api('/auth/logout', {}).catch(() => {}); location.replace(`${location.pathname}#/`); location.reload(); };

  if (!state) return <div className="auth-page">{error ? <p className="form-error">{error}</p> : <LoaderCircle className="spin" size={22} />}</div>;
  if (!session) return <div className="auth-page"><main className="auth-card"><h1>会话不可用</h1><p className="auth-subtitle">这个会话已被归档或删除。请联系分享者。</p><button className="button secondary" onClick={() => void logout()}><LogOut size={14} />退出</button></main></div>;

  const conversationLabel = chatAvailable && writable ? '图形对话' : '对话记录';
  return <div className="app-shell share-shell">
    <header className="share-topbar">
      <span className="brand-mark"><Layers3 size={15} /></span>
      <div className="share-heading"><div className="drawer-title"><h1 title={session.title}>{session.title}</h1><StatusBadge session={session} /></div>
        <p className="session-meta"><span>{BACKEND[session.backend].short}</span><span className="session-cwd" title={session.cwd}><Folder size={12} /><span><bdi>{session.cwd}</bdi></span></span></p></div>
      <span className={`share-role ${writable ? 'write' : ''}`} title={writable ? '你可以在这个会话中输入、审批、启动和停止' : '你只能查看这个会话'}>{writable ? '可协作' : '只读'} · {status.name}</span>
      <span className="connection-indicator" title={connected ? '已连接' : '正在重连'}><span className={`connection-dot ${connected ? 'online' : ''}`} /></span>
      <button className={`icon-button ${explorer ? 'active' : ''}`} aria-label="打开资源管理器" title="文件与改动" onClick={() => setExplorer(value => !value)}><Folder size={16} /></button>
      <button className="icon-button" aria-label="退出共享" title="退出" onClick={() => void logout()}><LogOut size={16} /></button>
    </header>
    <div className="app-body">
      {explorer && <WorkspaceExplorer session={session} close={() => setExplorer(false)} />}
      <div className="app-main"><section className="session-drawer" aria-label={`${session.title} 的共享会话`}>
        <header className="drawer-header">
          {(session.backend !== 'dsh' || state.demo) && <div className="private-view-switch" role="group" aria-label="会话显示方式"><button aria-pressed={view !== 'terminal'} onClick={() => setView(chatAvailable && writable ? 'chat' : 'conversation')}><MessageSquare size={13} />{conversationLabel}</button><button aria-pressed={view === 'terminal'} onClick={() => setView('terminal')}><TerminalSquare size={13} />原生终端</button></div>}
          <span className="share-spacer" />
          {writable && (session.running ? <button className="button secondary small-button" disabled={busy} onClick={() => void act('stop')}><Square size={11} />停止</button>
            : <button className="button primary small-button" disabled={busy || session.archived || !backend?.installed} onClick={() => void act('start')}>{busy ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}{session.nativeSessionId ? '恢复会话' : '启动会话'}</button>)}
        </header>
        {error && <div role="alert" className="error-banner"><span>{error}</span></div>}
        <div className="session-conversation">
          {session.backend === 'dsh' && !state.demo ? <div className="terminal-empty"><h3>DeepSeek Harness 暂不支持远程查看</h3><p>它的原生界面只在分享者的电脑上可用。</p></div>
            : view === 'chat' ? <Suspense fallback={<div className="loading-state"><LoaderCircle size={22} className="spin" /></div>}><CodexChatPane key={session.id} session={session} onTerminal={() => setView('terminal')} onSelection={ignoreSelection} /></Suspense>
            : view === 'conversation' ? <ConversationPane key={session.id} session={session} onTerminal={() => setView('terminal')} onSelection={ignoreSelection} />
            : chatAvailable && session.running && session.interactionMode === 'chat' ? <div className="terminal-empty"><h3>会话正在图形对话中运行</h3><p>{writable ? '切换到图形对话继续。' : '切换到对话记录查看进展。'}</p></div>
            : <TerminalPane key={session.id} sessionId={session.id} running={session.running} status={session.status} allowImages={writable && session.backend === 'codex' && !state.demo} readOnly={!writable} onSelection={ignoreSelection} />}
        </div>
      </section></div>
    </div>
  </div>;
}
