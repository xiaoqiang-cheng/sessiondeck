import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, Archive, Bell, BellOff, Check, CheckCheck,
  ChevronDown, ChevronRight, CircleHelp, Clock3, Command, Copy, Ellipsis, ExternalLink, Folder,
  GitFork, Layers3, LayoutGrid, LoaderCircle, MessageSquare, Pencil, Pin, Play, Plus,
  Radio, Search, Send, Settings2, Share2, Square, TerminalSquare, UsersRound, X,
} from 'lucide-react';
import type { AppState, Backend, DiscoveredSession, Group, GroupDetail, GroupMessage, Session, SessionStatus } from '../shared/types';
import { api, getToken } from './api';
import TerminalPane from './TerminalPane';
import { useWorkspaceRoute, workspaceHash, type View } from './navigation';
import ActivityView from './ActivityView';
import { useContactFilters, useContactSort, type ContactSort } from './preferences';
import { readLocalPreference, writeLocalPreference, useDialog } from './ui';

const BACKEND: Record<Backend, { name: string; short: string; glyph: string; color: string }> = {
  claude: { name: 'Claude Code', short: 'Claude', glyph: '✳', color: 'coral' },
  codex: { name: 'Codex', short: 'Codex', glyph: '⌘', color: 'green' },
  dsh: { name: 'DeepSeek Harness', short: 'DeepSeek', glyph: '≈', color: 'blue' },
};
const STATUS: Record<SessionStatus, { label: string; className: string }> = {
  idle: { label: '空闲', className: 'idle' }, running: { label: '运行中', className: 'running' },
  waiting_input: { label: '等待输入', className: 'waiting' }, waiting_approval: { label: '等待审批', className: 'waiting' },
  error: { label: '异常', className: 'error' }, stopped: { label: '已停止', className: 'idle' }, unknown: { label: '状态未知', className: 'unknown' },
};
type Modal = { type: 'create'; groupId?: string; backend?: Backend } | { type: 'import' } | { type: 'rename'; session: Session }
  | { type: 'fork'; session: Session; groupId?: string } | { type: 'group'; group?: Group }
  | { type: 'replaceDraft'; draft: string; sourceName: string; proceed: () => void } | { type: 'help' } | { type: 'addMember'; groupId: string } | { type: 'share'; session: Session; text: string } | null;
type GroupDraft = { text: string; kind: GroupMessage['kind']; recipients: string[]; sourceMessageId: string | null };
function readGroupDraft(groupId: string): GroupDraft {
  try {
    const draft = JSON.parse(sessionStorage.getItem(`sessiondeck.group-draft.${groupId}`) ?? 'null');
    if (draft && typeof draft.text === 'string' && ['note', 'task', 'result'].includes(draft.kind) && Array.isArray(draft.recipients)) return { text: draft.text.slice(0, 30000), kind: draft.kind, recipients: draft.recipients.filter((id: unknown) => typeof id === 'string'), sourceMessageId: typeof draft.sourceMessageId === 'string' ? draft.sourceMessageId : null };
  } catch { /* Unavailable or stale browser storage must not block the workspace. */ }
  return { text: '', kind: 'note', recipients: [], sourceMessageId: null };
}
const attention = (s: Session) => s.status === 'waiting_input' || s.status === 'waiting_approval' || s.status === 'error';
const relativeTime = (value: string) => {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 1) return '刚刚'; if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
};
const shortPath = (path: string) => path.replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/') || path;

function BackendAvatar({ backend, small = false }: { backend: Backend; small?: boolean }) {
  return <span className={`backend-avatar ${BACKEND[backend].color} ${small ? 'small' : ''}`} aria-label={BACKEND[backend].name}>{BACKEND[backend].glyph}</span>;
}
function StatusBadge({ session }: { session: Session }) {
  return <span className={`status-badge ${STATUS[session.status].className}`} title={`${session.statusDetail || STATUS[session.status].label} · ${session.statusSource === 'native' ? '来自后端' : session.statusSource === 'terminal' ? '根据终端输出推测' : session.statusSource === 'manual' ? '手动设置' : '进程状态'}`}><i />{STATUS[session.status].label}{session.statusSource === 'terminal' && <span className="estimated">估测</span>}</span>;
}
function ModalShell({ title, subtitle, close, children, wide = false }: { title: string; subtitle?: string; close: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, true, close);
  return <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭" onClick={close}><X size={20} /></button></div>{children}
  </div></div>;
}

function HelpDialog({ close }: { close: () => void }) {
  return <ModalShell title="使用说明与快捷键" subtitle="在卡片上看状态，进入原生会话继续工作。" close={close}>
    <div className="help-content">
      <h3>常用操作</h3>
      <dl className="shortcut-list"><div><dt>定位当前页面搜索</dt><dd><kbd>Ctrl / ⌘</kbd> + <kbd>K</kbd></dd></div><div><dt>打开这份说明</dt><dd><kbd>?</kbd></dd></div><div><dt>关闭当前面板</dt><dd><kbd>Esc</kbd></dd></div><div><dt>发布群组消息</dt><dd><kbd>Ctrl / ⌘</kbd> + <kbd>Enter</kbd></dd></div></dl>
      <p>搜索和帮助快捷键只在非输入区域生效。终端内的快捷键和 Esc 交给原生 Agent；群组输入框内可用发布快捷键。</p>
      <h3>如何理解状态</h3>
      <ul className="status-guide"><li><span className="status-badge running">运行中</span><span>后端正在执行任务。</span></li><li><span className="status-badge waiting">等待输入 / 审批</span><span>需要你进入会话回复或决定。</span></li><li><span className="status-badge idle">空闲 / 已停止</span><span>当前没有执行任务；不代表工作已验收。</span></li><li><span className="status-badge unknown">状态未知</span><span>目前没有足够信息确认状态，进入原生会话查看。</span></li></ul>
      <p>标有“估测”的状态来自终端输出。卡片上的提醒、来源说明和原生会话可帮助你判断；断线时保留最后收到的状态。</p>
      <h3>保留你的工作方式</h3><p>置顶联系人始终排在前面，其余可按活动、名称或创建时间排列。每个页面独立保存搜索和筛选，刷新后继续使用；Fork 继承上下文，原联系人保留。</p>
    </div><div className="modal-footer"><button className="button primary" onClick={close}>知道了</button></div>
  </ModalShell>;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const { view, selectedId, updateRoute } = useWorkspaceRoute();
  const setSelectedId = useCallback((id: string | null) => updateRoute({ selectedId: id }), [updateRoute]);
  const { query, backendFilter, statusFilter, setQuery, setBackendFilter, setStatusFilter, clearFilters } = useContactFilters(view);
  const [contactSort, setContactSort] = useContactSort();
  const [modal, setModal] = useState<Modal>(null);
  const [selection, setSelection] = useState('');
  const [connected, setConnected] = useState(false);
  const [hasConnected, setHasConnected] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [groupError, setGroupError] = useState('');
  const [groupReload, setGroupReload] = useState(0);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [notifications, setNotifications] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted' && readLocalPreference('sessiondeck.notifications') === 'on');
  const notificationRef = useRef(notifications);
  const sessionsRef = useRef<Session[] | null>(null);
  const stateRevisionRef = useRef(0);
  const serverSnapshotRef = useRef<{ instanceId: string; revision: number } | null>(null);
  const seenServerInstancesRef = useRef(new Set<string>());
  const operationRef = useRef(false);
  const drawerRef = useRef<HTMLElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const groupId = view.startsWith('group:') ? view.slice(6) : null;
  const selected = state?.sessions.find((session) => session.id === selectedId) ?? null;
  const currentGroup = state?.groups.find((group) => group.id === groupId);
  const selectedGroup = state?.groups.find((group) => group.id === selected?.groupId);
  const selectedParent = state?.sessions.find((session) => session.id === selected?.parentId);
  useDialog(drawerRef, !!selected, () => setSelectedId(null), true);
  notificationRef.current = notifications;

  const notify = useCallback((message: string) => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4200); }, []);
  const acceptState = useCallback((next: AppState) => {
    if (typeof next.instanceId === 'string' && typeof next.revision === 'number' && Number.isFinite(next.revision)) {
      const previous = serverSnapshotRef.current;
      const seen = seenServerInstancesRef.current;
      if (previous?.instanceId === next.instanceId && next.revision < previous.revision) return;
      // A restarted service begins a fresh sequence. Once we adopt that
      // instance, delayed HTTP responses from an earlier service stay ignored.
      if (previous?.instanceId !== next.instanceId && seen.has(next.instanceId)) return;
      seen.add(next.instanceId);
      if (seen.size > 8) seen.delete(seen.values().next().value!);
      serverSnapshotRef.current = { instanceId: next.instanceId, revision: next.revision };
    }
    stateRevisionRef.current += 1;
    setConnectionError('');
    if (notificationRef.current && sessionsRef.current && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      for (const session of next.sessions) {
        const previous = sessionsRef.current.find((old) => old.id === session.id);
        if (previous && !session.archived && attention(session) && session.unread > previous.unread) {
          try {
            const notification = new Notification(`${session.title} · ${STATUS[session.status].label}`, { body: session.statusDetail || '点击进入会话继续处理', tag: session.id, icon: '/favicon.svg' });
            notification.onclick = () => { window.focus(); setSelectedId(session.id); setSelection(''); notification.close(); void api(`/sessions/${session.id}/read`, {}).catch(() => {}); };
          } catch {
            // Some mobile browsers expose Notification but reject its constructor.
            setNotifications(false); writeLocalPreference('sessiondeck.notifications', 'off');
          }
        }
      }
    }
    sessionsRef.current = next.sessions; setState(next);
  }, [setSelectedId]);
  const refresh = useCallback(async () => {
    const revision = stateRevisionRef.current;
    try { const next = await api<AppState>('/state'); acceptState(next); }
    catch (cause) {
      // A newer SSE snapshot can recover the workspace before an older HTTP
      // request fails. Its late failure must not overwrite that recovery.
      if (revision === stateRevisionRef.current) setConnectionError(cause instanceof Error ? cause.message : '无法同步工作空间，请重试');
      throw cause;
    }
  }, [acceptState]);
  useEffect(() => {
    if (!state) return;
    const missingGroup = groupId && !state.groups.some((group) => group.id === groupId);
    const missingSession = selectedId && !state.sessions.some((session) => session.id === selectedId);
    if (!missingGroup && !missingSession) return;
    let live = true;
    // A link can arrive before the creation event in another tab. Verify against
    // fresh server state before treating its target as deleted.
    void api<AppState>('/state').then((next) => {
      if (!live) return;
      const absentGroup = groupId && !next.groups.some((group) => group.id === groupId);
      const absentSession = selectedId && !next.sessions.some((session) => session.id === selectedId);
      if (absentGroup || absentSession) {
        updateRoute({ view: absentGroup ? 'contacts' : view, selectedId: absentSession ? null : selectedId }, true);
        notify(absentSession ? '链接中的联系人已不存在，已返回会话列表' : '链接中的群组已不存在，已返回联系人');
      }
      acceptState(next);
    }).catch((cause) => { if (live) setConnectionError(`暂时无法打开此链接：${cause.message}`); });
    return () => { live = false; };
  }, [state, groupId, selectedId, view, updateRoute, notify, acceptState]);
  useEffect(() => {
    setMobileNav(false); setModal(null); setSelection('');
  }, [view]);
  useEffect(() => { setSelection(''); setModal(null); }, [selectedId]);
  useEffect(() => {
    if (!selected?.id || document.visibilityState !== 'visible') return;
    void api(`/sessions/${selected.id}/read`, {}).catch((cause) => setError(cause.message));
  }, [selected?.id]);
  useEffect(() => {
    void refresh().catch(() => {});
    const stream = new EventSource('/api/events');
    stream.onopen = () => { setConnected(true); setHasConnected(true); setGroupReload((value) => value + 1); void getToken(true).catch(() => {}); void refresh().catch(() => {}); };
    stream.onerror = () => setConnected(false);
    stream.addEventListener('state', (event) => {
      try { acceptState(JSON.parse((event as MessageEvent).data)); }
      catch { setConnectionError('无法读取状态更新，正在等待重新连接'); }
    });
    return () => stream.close();
  }, [refresh, acceptState]);
  useEffect(() => {
    const resume = () => { if (document.visibilityState === 'visible') void refresh().catch(() => {}); };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [refresh]);
  useEffect(() => {
    if (!groupId || !state?.groups.some((group) => group.id === groupId)) { setDetail(null); setGroupError(''); return; }
    let live = true;
    api<GroupDetail>(`/groups/${groupId}`).then((data) => { if (live) { setDetail(data); setGroupError(''); } }).catch((cause) => { if (live) setGroupError(cause.message); });
    return () => { live = false; };
  }, [groupId, currentGroup?.updatedAt, groupReload]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => { clearInterval(timer); clearTimeout(toastTimer.current); };
  }, []);
  useEffect(() => {
    const count = state?.sessions.filter((session) => !session.archived && attention(session)).length ?? 0;
    document.title = `${count ? `(${count}) ` : ''}${selected?.title ?? currentGroup?.title ?? ({ contacts: '会话联系人', attention: '需要你处理', running: '正在运行', archive: '已归档', backends: '连接与能力', activity: '最近活动' } as Record<string, string>)[view] ?? '会话联系人'} · SessionDeck`;
  }, [state, selected?.title, currentGroup?.title, view, clock]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const inNativeTerminal = event.target instanceof HTMLElement && event.target.closest('.terminal-pane');
      if (event.key === 'Escape' && !modal && !inNativeTerminal) setMobileNav(false);
      const editing = event.target instanceof HTMLElement && (!!event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || event.target.isContentEditable);
      if (editing || inNativeTerminal || event.isComposing || event.defaultPrevented) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === '?' && !selectedId && !modal) { event.preventDefault(); setModal({ type: 'help' }); }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k' && !selectedId && !modal) { event.preventDefault(); document.querySelector<HTMLInputElement>('#session-search, #activity-search')?.focus(); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [modal, selectedId]);
  const closeModal = useCallback(() => setModal(null), []);
  const run = async (key: string, operation: () => Promise<unknown>, success?: string) => {
    if (operationRef.current) return false;
    operationRef.current = true; setBusy(key); setError('');
    try {
      await operation();
      await refresh().catch(() => {});
      if (success) notify(success); return true;
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败，请重试'); return false; }
    finally { operationRef.current = false; setBusy(null); }
  };
  const navigate = (next: View) => { updateRoute({ view: next, selectedId: null }); setMobileNav(false); };
  const openSession = (session: Session) => {
    setSelectedId(session.id); setSelection('');
  };
  const copyText = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); notify(`已复制${label}`); }
    catch { setError('浏览器无法访问剪贴板，请选中对应文字后手动复制'); }
  };
  const patch = (session: Session, values: Partial<Session>) => run(`patch:${session.id}`, () => api(`/sessions/${session.id}`, values, 'PATCH'));
  const toggleNotifications = async () => {
    if (notifications) { setNotifications(false); writeLocalPreference('sessiondeck.notifications', 'off'); return; }
    if (typeof Notification === 'undefined') { notify('当前浏览器不支持系统通知，卡片提醒始终可用'); return; }
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') { setNotifications(true); writeLocalPreference('sessiondeck.notifications', 'on'); notify('已开启通知，需要你时会提醒'); }
      else notify('系统通知未开启，你仍可在卡片上查看提醒');
    } catch { notify('无法开启系统通知，请检查浏览器权限'); }
  };

  const sessions = state?.sessions ?? [];
  const personal = sessions.filter((session) => !session.archived && !session.groupId);
  const needsAttention = sessions.filter((session) => !session.archived && attention(session));
  const running = sessions.filter((session) => !session.archived && session.status === 'running');
  const archived = sessions.filter((session) => session.archived);
  const visible = sessions.filter((session) => {
    if (groupId ? session.groupId !== groupId || session.archived : view === 'archive' ? !session.archived : view === 'attention' ? session.archived || !attention(session) : view === 'running' ? session.archived || session.status !== 'running' : session.archived || !!session.groupId) return false;
    return (backendFilter === 'all' || session.backend === backendFilter)
      && (statusFilter === 'all' || (statusFilter === 'attention' ? attention(session) : statusFilter === 'unread' ? session.unread > 0 : session.status === statusFilter))
      && `${session.title} ${session.cwd} ${BACKEND[session.backend].name}`.toLowerCase().includes(query.trim().toLowerCase());
  }).sort((a, b) => {
    if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
    if (contactSort === 'name') return a.title.localeCompare(b.title, 'zh-CN', { numeric: true, sensitivity: 'base' });
    return contactSort === 'created' ? new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() : new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  });
  const title = currentGroup?.title ?? ({ contacts: '会话联系人', attention: '需要你处理', running: '正在运行', activity: '最近活动', archive: '已归档', backends: '连接与能力' } as Record<string, string>)[view] ?? '会话联系人';
  const subtitle = view === 'activity' ? '按时间回看创建、Fork、状态变化与任务投递，点击回到相关会话。' : currentGroup ? '围绕同一个目标协作，随时进入成员会话纠正方向。' : view === 'running' ? '正在执行任务的会话，包含独立联系人和群组成员。' : view === 'attention' ? '需要你介入的会话，都在这里。' : view === 'archive' ? '收起已完成的工作，保留随时回来的入口。' : view === 'backends' ? '复用本机 Agent 的原生能力，让每段上下文各归其位。' : '每一段上下文，都有自己的位置。';

  return <div className="app-shell">
    {mobileNav && <div className="nav-backdrop" onClick={() => setMobileNav(false)} />}
    <aside inert={!!selected || !!modal} className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); navigate('contacts'); }}><span className="brand-mark"><Layers3 size={22} strokeWidth={1.8} /></span><span>SessionDeck<small>YOUR AGENT WORKSPACE</small></span></a>
      <div className="workspace-label"><span className="workspace-icon">本</span><span>本地工作空间<small>所有会话，触手可及</small></span><span className="local-dot" /></div>
      <div className="nav-caption">工作空间</div>
      <nav className="primary-nav" aria-label="工作空间导航">
        <button className={view === 'contacts' ? 'active' : ''} onClick={() => navigate('contacts')}><LayoutGrid size={18} /><span>会话联系人</span><b>{personal.length}</b></button>
        <button className={view === 'attention' ? 'active' : ''} onClick={() => navigate('attention')}><Bell size={18} /><span>需要你处理</span>{needsAttention.length > 0 && <b className="attention-count">{needsAttention.length}</b>}</button>
        <button aria-current={view === 'running' ? 'page' : undefined} className={view === 'running' ? 'active' : ''} onClick={() => navigate('running')}><Radio size={18} /><span>正在运行</span>{running.length > 0 && <b>{running.length}</b>}</button>
        <button className={view === 'archive' ? 'active' : ''} onClick={() => navigate('archive')}><Archive size={18} /><span>已归档</span>{archived.length > 0 && <b>{archived.length}</b>}</button>
        <button aria-current={view === 'activity' ? 'page' : undefined} className={view === 'activity' ? 'active' : ''} onClick={() => navigate('activity')}><Clock3 size={18} /><span>最近活动</span></button>
      </nav>
      <div className="nav-caption groups-caption">协作群组<button className="icon-button" disabled={!state} aria-label="创建群组" title="创建群组" onClick={() => setModal({ type: 'group' })}><Plus size={16} /></button></div>
      <nav className="group-nav" aria-label="协作群组">{state?.groups.map((group) => <button key={group.id} title={group.title} className={groupId === group.id ? 'active' : ''} onClick={() => navigate(`group:${group.id}`)}><span className="group-hash">#</span><span>{group.title}</span>{sessions.some((session) => session.groupId === group.id && !session.archived && session.unread > 0) && <span className="group-unread-dot" aria-label="有未读提醒" title="群组成员有未读提醒" />}<span className="group-count">{sessions.filter((session) => session.groupId === group.id && !session.archived).length}</span></button>)}
      {!state?.groups.length && <button className="new-group-link" disabled={!state} onClick={() => setModal({ type: 'group' })}><Plus size={15} /> 创建第一个群组</button>}</nav>
      <div className="sidebar-bottom">
        <div className="native-note"><span className="native-note-icon"><TerminalSquare size={18} /></span><strong>你的 Agent，原生运行</strong><p>保留原生工具与上下文，<br />在这里连接每一段工作。</p></div>
        <button className={`settings-link ${view === 'backends' ? 'active' : ''}`} onClick={() => navigate('backends')}><Settings2 size={17} /><span>连接与能力</span><span className="backend-dots">{state?.backends.map((backend) => <i key={backend.id} className={backend.installed ? 'available' : ''} title={`${backend.label}：${backend.installed ? '已安装' : '未安装'}`} />)}</span></button>
        <button className="settings-link help-link" onClick={() => setModal({ type: 'help' })}><CircleHelp size={17} /><span>使用说明与快捷键</span></button>
        <div className="sidebar-footer"><span className={`connection-dot ${connected ? 'online' : ''}`} />{connected ? '本地服务已连接' : hasConnected ? '连接中断 · 正在重连' : '正在连接本地服务'}<span className="version">v0.2</span></div>
      </div>
    </aside>

    <main className="main-content" inert={!!selected || !!modal || mobileNav}>
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="打开导航" onClick={() => setMobileNav(true)}><Layers3 size={20} /></button><span>工作空间</span><ChevronRight size={13} /><strong>{currentGroup ? '协作群组' : title}</strong>{currentGroup && <><ChevronRight size={13} /><span>{currentGroup.title}</span></>}</div>
        <div className="topbar-right">{state?.demo && <span className="demo-badge">演示模式 · 示例数据</span>}<span className="local-label"><span /> LOCAL FIRST</span><button className={`icon-button notification-button ${notifications ? 'enabled' : ''}`} title={notifications ? '关闭系统通知' : '开启系统通知'} aria-label={notifications ? '关闭系统通知' : '开启系统通知'} onClick={() => void toggleNotifications()}>{notifications ? <Bell size={18} /> : <BellOff size={18} />}</button></div>
      </header>
      <div className="page-content">
        {state && !connected && <div className="connection-banner" role="status"><Radio size={16} /><span>{hasConnected ? '服务连接已中断，正在自动重连。卡片暂时显示上次收到的状态。' : '正在建立实时连接，卡片显示最近获取的状态。'}</span><button className="text-button" onClick={() => void refresh().catch(() => {})}>重新获取</button></div>}
        {connectionError && <div role="alert" className="error-banner connection-error"><span>{connectionError}</span><button className="text-button" onClick={() => void refresh().catch(() => {})}>重试连接</button></div>}
        {error && <div role="alert" className="error-banner"><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
        <section className="page-heading"><div><div className="eyebrow">{currentGroup ? 'SHARED CONTEXT, FOCUSED WORK' : 'A HOME FOR EVERY SESSION'}</div><h1>{title}{currentGroup && <span className="group-title-badge">群组</span>}</h1><p>{subtitle}</p></div><div className="heading-actions">
          {view === 'backends' ? <button className="button secondary" onClick={() => void run('refresh', () => api('/backends/refresh', {}), '已重新检测本机后端')}><Radio size={16} /> 刷新状态</button> : currentGroup ? <><button className="button secondary" onClick={() => setModal({ type: 'group', group: currentGroup })}><Pencil size={15} /> 编辑群组</button><button className="button primary" onClick={() => setModal({ type: 'addMember', groupId: currentGroup.id })}><Plus size={17} /> 添加成员</button></> : <><button className="button secondary" disabled={!state} onClick={() => setModal({ type: 'import' })}><ArrowDownToLine size={16} /> 导入会话</button><button className="button primary" disabled={!state} onClick={() => setModal({ type: 'create' })}><Plus size={18} /> 新建联系人</button></>}
        </div></section>

        {!state && !connectionError && <div className="loading-state"><LoaderCircle className="spin" size={25} /><p>正在连接你的工作空间…</p></div>}
        {state && view === 'activity' ? <ActivityView activities={state.activities} sessions={state.sessions} open={openSession} /> : state && view === 'backends' ? <BackendSettings state={state} onCreate={(backend) => { setBackendFilter(backend); setModal({ type: 'create', backend }); }} /> : state && <>
          {currentGroup ? <div className="group-goal"><span className="goal-icon"><UsersRound size={22} /></span><div><span className="section-eyebrow">共同目标</span><p>{currentGroup.goal || '为群组设置一个清晰的目标，让成员围绕它开展工作。'}</p></div><span className="member-count">{sessions.filter((session) => session.groupId === groupId && !session.archived).length} 位成员</span></div> : view === 'contacts' && <div className="overview-strip">
            <button onClick={clearFilters}><span className="stat-icon muted"><LayoutGrid size={18} /></span><div><span>独立会话</span><strong>{personal.length}</strong></div><small>各自保留上下文</small></button>
            <button onClick={() => navigate('attention')}><span className="stat-icon amber"><Bell size={18} /></span><div><span>需要你处理</span><strong>{needsAttention.length}</strong></div><small>{needsAttention.length ? '等你继续推进' : '暂时没有待办'}</small>{needsAttention.length > 0 && <ArrowRight size={17} />}</button>
            <button onClick={() => navigate('running')}><span className="stat-icon mint"><Radio size={18} /></span><div><span>正在运行</span><strong>{running.length}</strong></div><small>包含群组成员</small></button>
          </div>}

          <div className="section-heading"><div><h2>{currentGroup ? '群组成员' : view === 'archive' ? '归档会话' : view === 'attention' ? '待处理会话' : view === 'running' ? '运行中的会话' : '我的联系人'}</h2><span className="section-count">{visible.length}</span></div>{!currentGroup && <button className="section-tip status-help" onClick={() => setModal({ type: 'help' })}><span className={`tiny-live-dot ${connected ? '' : 'disconnected'}`} /> {connected ? '状态实时更新' : '等待状态同步'}<CircleHelp size={12} /></button>}</div>
          <div className="filter-bar"><div className="backend-tabs" aria-label="按后端筛选"><button aria-pressed={backendFilter === 'all'} className={backendFilter === 'all' ? 'selected' : ''} onClick={() => setBackendFilter('all')}>全部</button>{(['claude', 'codex', 'dsh'] as Backend[]).map((backend) => <button key={backend} aria-pressed={backendFilter === backend} className={backendFilter === backend ? 'selected' : ''} onClick={() => setBackendFilter(backend)}><span aria-hidden="true" className={`tab-glyph ${BACKEND[backend].color}`}>{BACKEND[backend].glyph}</span>{BACKEND[backend].short}</button>)}</div><div className="search-filters"><label className="search-field"><Search size={16} /><input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索联系人…" aria-label="搜索联系人" /><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</kbd></label><div className="status-select"><select aria-label="按状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SessionStatus | 'all' | 'attention' | 'unread')}><option value="all">全部状态</option><option value="attention">需要处理</option><option value="unread">未读提醒</option><option value="running">运行中</option><option value="waiting_input">等待输入</option><option value="waiting_approval">等待审批</option><option value="idle">空闲</option><option value="error">异常</option><option value="stopped">已停止</option><option value="unknown">状态未知</option></select><ChevronDown size={14} /></div></div></div>
          <div className="list-options"><span>{visible.some((session) => session.pinned) ? '置顶联系人优先' : '筛选条件按页面保留'}</span><div>{(!!query || backendFilter !== 'all' || statusFilter !== 'all') && visible.length > 0 && <button className="text-button" onClick={clearFilters}><X size={12} />清除筛选</button>}<label className="sort-select">排序<select aria-label="联系人排序" value={contactSort} onChange={(event) => setContactSort(event.target.value as ContactSort)}><option value="activity">最近活动</option><option value="name">名称</option><option value="created">创建时间</option></select></label></div></div>
          {visible.length > 0 ? <div className="contact-grid">{visible.map((session) => <SessionCard key={session.id} session={session} groupName={state.groups.find((group) => group.id === session.groupId)?.title} available={state.backends.find((backend) => backend.id === session.backend)?.installed ?? false} canFork={state.backends.find((backend) => backend.id === session.backend)?.capabilities.fork && !!session.nativeSessionId && !session.forkPending || false} onOpen={() => openSession(session)} onRename={() => setModal({ type: 'rename', session })} onFork={() => setModal({ type: 'fork', session, groupId: session.groupId ?? undefined })} onPin={() => void patch(session, { pinned: !session.pinned })} onArchive={() => void patch(session, { archived: !session.archived })} />)}{view !== 'archive' && <button className="add-contact-card" onClick={() => setModal(currentGroup ? { type: 'addMember', groupId: currentGroup.id } : { type: 'create' })}><span><Plus size={23} strokeWidth={1.5} /></span><strong>{currentGroup ? '添加一个协作成员' : '给下一段工作一个位置'}</strong><small>{currentGroup ? '新建会话，或从已有联系人 Fork' : '新建联系人，连接你的 Agent'}</small></button>}</div> : <EmptyState filtered={!!query || backendFilter !== 'all' || statusFilter !== 'all'} view={view} group={!!currentGroup} backendCount={state.backends.filter((backend) => backend.installed).length} connections={() => navigate('backends')} create={() => setModal(currentGroup ? { type: 'addMember', groupId: currentGroup.id } : { type: 'create' })} importSessions={() => setModal({ type: 'import' })} clear={clearFilters} />}

          {currentGroup && groupError && <div className="error-banner" role="alert"><span>群组动态加载失败：{groupError}</span><button className="text-button" onClick={() => setGroupReload((value) => value + 1)}>重试群组动态</button></div>}
          {currentGroup && !groupError && (!detail || detail.group.id !== currentGroup.id) && <div className="loading-state" role="status"><LoaderCircle size={22} className="spin" /><p>正在读取群组动态…</p></div>}
          {currentGroup && detail && detail.group.id === currentGroup.id && <GroupBoard key={currentGroup.id} detail={detail} members={sessions.filter((session) => session.groupId === groupId)} demo={state.demo} busy={busy} confirmReplace={(message, draft, proceed) => setModal({ type: 'replaceDraft', draft, sourceName: message.senderName || '我', proceed })} post={async (body) => {
            const ok = await run('message', () => api(`/groups/${currentGroup.id}/messages`, body), body.kind === 'task' ? '任务已记录，请在任务下方选择填入对应会话' : '已分享到群组'); return ok;
          }} deliver={(id, sessionId) => void run(`deliver:${id}`, async () => { await api(`/deliveries/${id}/send`, {}); const member = sessions.find((session) => session.id === sessionId); if (member) openSession(member); }, '已处理投递，请在成员私聊中查看')} cancel={(id) => void run(`cancel:${id}`, () => api(`/deliveries/${id}/cancel`, {}), '已取消投递')} open={(id) => { const session = sessions.find((item) => item.id === id); if (session) openSession(session); }} />}
          {!currentGroup && view === 'contacts' && <div className="workspace-footnote"><GitFork size={15} /><span>一个会话，一段专注的工作。Fork 延续上下文，群组连接彼此。</span><button onClick={() => setModal({ type: 'group' })}>创建群组 <ArrowRight size={13} /></button></div>}
        </>}
      </div>
      <footer className="main-footer"><span>SessionDeck <span className="footer-dot">·</span> 为并行工作留一点从容</span><span><span className="footer-dot" /> 数据保存在本机</span></footer>
    </main>

    {selected && state && <div className="drawer-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><section ref={drawerRef} inert={!!modal} className="session-drawer" role="dialog" aria-modal="true" aria-label={`${selected.title} 的私聊`}>
      <div className="drawer-top"><button className="text-button" onClick={() => setSelectedId(null)}><ArrowLeft size={16} /> 返回{currentGroup ? '群组' : title}</button><button className="icon-button" onClick={() => setSelectedId(null)} aria-label="关闭会话"><X size={20} /></button></div>
      <div className="drawer-heading"><BackendAvatar backend={selected.backend} /><div><div className="drawer-title"><h2 title={selected.title}>{selected.title}</h2><button className="icon-button" title="改名" aria-label="改名" onClick={() => setModal({ type: 'rename', session: selected })}><Pencil size={14} /></button></div><p>{BACKEND[selected.backend].name} <span>·</span> {selected.forkPending ? '等待原生 Fork · 启动后创建独立上下文' : selected.nativeSessionId ? `会话 ${selected.nativeSessionId.slice(0, 12)}` : '新会话，启动后连接'}</p></div><StatusBadge session={selected} /></div>
      {connectionError && <div role="alert" className="error-banner connection-error"><span>{connectionError}</span><button className="text-button" onClick={() => void refresh().catch(() => {})}>重试连接</button></div>}
      {error && <div role="alert" className="error-banner"><span>{error}</span><button className="icon-button" aria-label="关闭会话错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
      {selected.archived && <div className="session-status-detail"><Archive size={14} />此联系人已归档，恢复到列表后可以继续运行。<button className="text-button" onClick={() => void patch(selected, { archived: false })}>恢复联系人</button></div>}
      <div className="drawer-meta"><span title={selected.cwd}><Folder size={14} /><span className="selectable-value">{selected.cwd}</span></span><button className="icon-button" aria-label="复制工作目录" title="复制工作目录" onClick={() => void copyText(selected.cwd, '工作目录')}><Copy size={14} /></button></div>
      {(selectedGroup || selectedParent) && <nav className="session-context-links" aria-label="会话关系">{selectedGroup && <button className="text-button" onClick={() => navigate(`group:${selectedGroup.id}`)}><UsersRound size={14} />{selectedGroup.title}<ChevronRight size={12} /></button>}{selectedParent && <button className="text-button" onClick={() => openSession(selectedParent)}><GitFork size={14} />来源：{selectedParent.title}<ChevronRight size={12} /></button>}</nav>}
      <details key={selected.id} className="session-info"><summary>会话信息</summary><div className="session-info-content"><div><span>{selected.forkPending ? '来源会话标识' : '原生会话标识'}</span>{selected.nativeSessionId ? <><code>{selected.nativeSessionId}</code><button className="icon-button" aria-label="复制原生会话标识" title="复制原生会话标识" onClick={() => void copyText(selected.nativeSessionId!, '原生会话标识')}><Copy size={14} /></button></> : <small>首次启动后生成</small>}</div>{selected.forkPending && <p>原生 Fork 尚未完成；启动后会获得独立的会话标识。</p>}<div><span>创建时间</span><time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleString('zh-CN')}</time><button className="text-button" onClick={() => void copyText(`${location.origin}${location.pathname}${location.search}${workspaceHash({ view, selectedId: selected.id })}`, '会话链接')}>复制会话链接</button></div></div></details>
      {selected.unread > 0 && <div className="session-unread-notice" role="status" aria-live="polite"><Bell size={14} /><span>这个会话有 {selected.unread} 条新提醒</span><button className="text-button" disabled={!!busy} onClick={() => void run(`read:${selected.id}`, () => api(`/sessions/${selected.id}/read`, {}))}>标为已读</button></div>}
      {selected.statusDetail && <div role="status" aria-live="polite" className={`session-status-detail ${attention(selected) ? 'needs-attention' : ''}`}><span className={`status-point ${STATUS[selected.status].className}`} />{selected.statusDetail}<span className="source-label">{selected.statusSource === 'native' ? '后端状态' : selected.statusSource === 'terminal' ? '终端估测' : selected.statusSource === 'manual' ? '手动标记' : '进程状态'}</span></div>}
      <div className="drawer-actions"><div>{selected.running ? <button className="button secondary small-button" disabled={!!busy} onClick={() => void run(`stop:${selected.id}`, () => api(`/sessions/${selected.id}/stop`, {}), selected.backend === 'dsh' && !state.demo ? '已停止当前任务，原生会话历史仍保留' : '已停止进程，原生会话历史仍保留')}><Square size={13} />{selected.backend === 'dsh' && !state.demo ? '停止当前任务' : '停止进程'}</button> : <button className="button primary small-button" disabled={!!busy || selected.archived || !state.backends.find((backend) => backend.id === selected.backend)?.installed} onClick={() => void run(`start:${selected.id}`, () => api(`/sessions/${selected.id}/start`, {}))}>{busy === `start:${selected.id}` ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}{selected.forkPending ? '启动 Fork 会话' : selected.nativeSessionId ? '恢复原生会话' : '启动原生会话'}</button>}<button className="button secondary small-button" disabled={!state.backends.find((backend) => backend.id === selected.backend)?.capabilities.fork || !selected.nativeSessionId || selected.forkPending} title={!selected.nativeSessionId || selected.forkPending ? '请先启动来源会话并完成初始化，再进行 Fork' : '分叉当前上下文'} onClick={() => setModal({ type: 'fork', session: selected, groupId: selected.groupId ?? undefined })}><GitFork size={14} /> Fork</button></div><div>{selected.groupId && <button className="button secondary small-button" onClick={() => setModal({ type: 'share', session: selected, text: selection })}><Share2 size={14} /> 分享结果到群组</button>}{selected.nativeUrl && <a className="button secondary small-button" target="_blank" rel="noreferrer" href={selected.nativeUrl}><ExternalLink size={14} /> 原生窗口</a>}</div></div>
      {selected.backend === 'dsh' && !state.demo ? selected.nativeUrl ? <div className="native-web"><div className="native-web-heading"><span><TerminalSquare size={14} /> DeepSeek Harness 原生界面</span><a href={selected.nativeUrl} target="_blank" rel="noreferrer">在新窗口打开 <ExternalLink size={13} /></a></div><iframe title="DeepSeek Harness 会话" src={selected.nativeUrl} allow="clipboard-read; clipboard-write" /><div className="native-web-footnote">若原生界面无法嵌入，可通过“原生窗口”继续同一个会话。</div></div> : <div className="terminal-empty"><BackendAvatar backend="dsh" /><h3>直接使用 Harness 原生界面</h3><p>点击“{selected.forkPending ? '启动 Fork 会话' : selected.nativeSessionId ? '恢复原生会话' : '启动原生会话'}”，进入这个联系人的上下文。</p></div> : <TerminalPane sessionId={selected.id} running={selected.running} onSelection={setSelection} />}
      <div className="drawer-footer"><CircleHelp size={14} /><span>{selected.backend === 'dsh' && !state.demo ? '私聊、审批和工具调用由 DeepSeek Harness 原生界面处理。' : '这里运行原生 CLI。关闭面板不会停止任务；在终端中照常输入和审批。'}</span></div>
    </section></div>}

    {modal?.type === 'help' && <HelpDialog close={closeModal} />}
    {modal?.type === 'replaceDraft' && <ModalShell title="替换当前群组草稿？" subtitle={`将 ${modal.sourceName} 的消息转交为任务，当前草稿需要先处理。`} close={closeModal}><div className="modal-fields"><p className="draft-replace-preview">{modal.draft || '当前草稿已选择接收成员。'}</p><p className="form-note">保留草稿会取消这次转交。替换后，可编辑任务内容并选择接收成员；创建任务仍需你提交。</p></div><div className="modal-footer"><button className="button secondary" onClick={closeModal}>保留当前草稿</button><button className="button primary" onClick={() => { modal.proceed(); closeModal(); }}>替换为转交任务</button></div></ModalShell>}
    {modal && modal.type !== 'help' && modal.type !== 'replaceDraft' && state && <AppModal modal={modal} state={state} close={closeModal} done={async (session?: Session, group?: Group) => { await refresh().catch(() => {}); closeModal(); if (group) navigate(`group:${group.id}`); if (session) { if (session.groupId) navigate(`group:${session.groupId}`); openSession(session); } }} notify={notify} />}
    {toast && <div className="toast" role="status"><CheckCheck size={17} />{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
  </div>;
}

function SessionCard({ session, groupName, available, canFork, onOpen, onRename, onFork, onPin, onArchive }: {
  session: Session; groupName?: string; available: boolean; canFork: boolean; onOpen: () => void; onRename: () => void; onFork: () => void; onPin: () => void; onArchive: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    menuRef.current?.querySelector<HTMLButtonElement>('.dropdown-menu button:not(:disabled)')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setMenu(false); menuButtonRef.current?.focus(); }
      if (!menuRef.current?.contains(event.target as Node) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...menuRef.current.querySelectorAll<HTMLButtonElement>('.dropdown-menu button:not(:disabled)')];
      const current = items.findIndex((item) => item === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);
  return <article className={`session-card ${attention(session) ? 'has-attention' : ''} ${session.archived ? 'archived-card' : ''}`}>
    <div className="card-top"><BackendAvatar backend={session.backend} /><div className="card-backend"><span>{BACKEND[session.backend].name}</span><small>{session.groupId ? `群组 · ${groupName ?? '协作成员'}` : '独立会话'}{session.origin === 'forked' ? ' · Fork' : session.origin === 'imported' ? ' · 已导入' : ''}</small></div><div className="card-top-actions">{session.pinned && <Pin size={13} className="pinned-icon" />}<div className="card-menu-anchor" ref={menuRef}><button ref={menuButtonRef} className="icon-button" aria-label={`${session.title} 的更多操作`} aria-expanded={menu} onClick={() => setMenu(!menu)}><Ellipsis size={19} /></button>{menu && <div className="dropdown-menu"><button onClick={() => { menuButtonRef.current?.focus(); onRename(); setMenu(false); }}><Pencil size={14} />改名</button><button onClick={() => { menuButtonRef.current?.focus(); onPin(); setMenu(false); }}><Pin size={14} />{session.pinned ? '取消置顶' : '置顶联系人'}</button><button disabled={!canFork} onClick={() => { menuButtonRef.current?.focus(); onFork(); setMenu(false); }}><GitFork size={14} />Fork 会话</button><span /><button onClick={() => { onArchive(); setMenu(false); }}><Archive size={14} />{session.archived ? '恢复到列表' : '归档联系人'}</button></div>}</div></div></div>
    <button className="card-main" aria-label={`进入 ${session.title} 的会话`} onClick={onOpen}><h3 title={session.title}>{session.title}{session.unread > 0 && <span className="unread-dot" aria-label={`${session.unread} 条未读提醒`} />}</h3><div className="card-path" title={session.cwd}><Folder size={13} /><span>{shortPath(session.cwd)}</span></div><p className="card-description">{session.statusDetail || (session.forkPending ? '将在启动时通过后端原生能力分叉上下文。' : session.nativeSessionId ? '上下文已连接，点击进入会话继续工作。' : '准备就绪，进入会话开启下一段工作。')}</p></button>
    <div className="card-status-line"><StatusBadge session={session} />{!available && <span className="not-installed">后端未安装</span>}<time dateTime={session.lastActivity} title={new Date(session.lastActivity).toLocaleString('zh-CN')}>{relativeTime(session.lastActivity)}</time></div>
    <div className="card-footer"><button className="fork-button" title={canFork ? '分叉上下文，创建新联系人' : !session.nativeSessionId || session.forkPending ? '请先启动原生会话并完成初始化' : '该后端暂不可 Fork'} disabled={!canFork} onClick={onFork}><GitFork size={14} /> Fork</button><button className="enter-button" onClick={onOpen}>进入会话 <ArrowRight size={15} /></button></div>
  </article>;
}

function EmptyState({ filtered, view, group, backendCount, connections, create, importSessions, clear }: { filtered: boolean; view: View; group: boolean; backendCount: number; connections: () => void; create: () => void; importSessions: () => void; clear: () => void }) {
  const waiting = view === 'attention'; const archive = view === 'archive'; const running = view === 'running';
  return <div className="empty-state"><div className="empty-illustration"><span className="empty-card back" /><span className="empty-card front">{filtered ? <Search size={31} strokeWidth={1.4} /> : waiting ? <CheckCheck size={33} strokeWidth={1.4} /> : group ? <UsersRound size={32} strokeWidth={1.4} /> : archive ? <Archive size={31} strokeWidth={1.4} /> : <MessageSquare size={31} strokeWidth={1.4} />}</span><i /><b /></div><h3>{filtered ? '没有找到匹配的联系人' : running ? '目前没有正在执行的任务' : waiting ? '目前没有需要你处理的事项' : archive ? '这里还没有归档会话' : group ? '给这个目标找几位搭档' : '把你的第一段会话安放在这里'}</h3><p>{filtered ? '试试其他关键词，或调整后端与状态筛选。' : running ? '会话开始执行任务后会出现在这里，等待输入的会话可在“需要你处理”中查看。' : waiting ? '需要输入、审批或发生异常时，会话会出现在这里。' : archive ? '将暂时告一段落的联系人归档，工作空间会更清爽。' : group ? '新建会话，或将已有联系人 Fork 入群。原会话会完整保留。' : '连接 Claude Code、Codex 或 DeepSeek Harness，\n一眼看状态，点击继续原生会话。'}</p><div>{filtered ? <button className="button secondary" onClick={clear}>清除筛选</button> : !waiting && !archive && !running && <><button className="button primary" onClick={create}><Plus size={17} />{group ? '添加成员' : '新建联系人'}</button>{!group && <button className="button secondary" onClick={importSessions}><ArrowDownToLine size={16} /> 导入已有会话</button>}</>}</div>{!filtered && !waiting && !archive && !running && !group && <div className="first-contact-guide"><p>{backendCount ? '已有原生会话？选择“导入已有会话”继续上下文。新工作则创建联系人，选择后端和工作目录。' : '尚未检测到本机 Agent。先在连接与能力中查看后端安装情况，再创建联系人；已有历史仍可尝试导入。'}</p><button className="text-button" onClick={connections}>{backendCount ? '查看后端连接与能力' : '查看后端安装情况'}<ArrowRight size={13} /></button></div>} {!filtered && !waiting && !archive && !running && !group && <div className="empty-backends">{(['claude', 'codex', 'dsh'] as Backend[]).map((backend) => <span key={backend}><span aria-hidden="true" className={`tab-glyph ${BACKEND[backend].color}`}>{BACKEND[backend].glyph}</span>{BACKEND[backend].short}</span>)}</div>}</div>;
}

function BackendSettings({ state, onCreate }: { state: AppState; onCreate: (backend: Backend) => void }) {
  return <div className="backend-settings">{state.backends.map((backend) => <section className="backend-setting-card" key={backend.id}><div className="backend-setting-title"><BackendAvatar backend={backend.id} /><div><h2>{backend.label}</h2><p>{backend.version || (backend.installed ? '已检测到本机安装' : '未检测到本机安装')}</p></div><span className={`status-badge ${backend.installed ? 'running' : 'unknown'}`}><i />{backend.installed ? '已安装' : '未安装'}</span></div><p className="backend-note">{backend.note || (backend.id === 'dsh' ? '通过 Harness 原生 Web 界面继续交互。' : '在浏览器内运行原生 CLI，保留熟悉的操作方式。')}</p><div className="capability-list">{[['terminal', '原生终端'], ['resume', '恢复会话'], ['fork', '原生 Fork'], ['discovery', '发现已有会话']].map(([capability, label]) => <span key={capability} className={backend.capabilities[capability as keyof typeof backend.capabilities] ? 'supported' : ''}>{backend.capabilities[capability as keyof typeof backend.capabilities] ? <Check size={13} /> : <span className="capability-dash">—</span>}{label}</span>)}</div><button className="button secondary" disabled={!backend.installed} onClick={() => onCreate(backend.id)}><Plus size={15} /> 创建 {BACKEND[backend.id].short} 联系人</button></section>)}<div className="backend-info-note"><CircleHelp size={18} /><div><strong>会话能力以各后端实际支持为准</strong><p>SessionDeck 复用本机已安装的 Agent 与现有登录配置。会话卡片和群组数据保存在本机，Fork 上下文不会自动隔离工作目录。安装或升级后端后，点击“刷新状态”重新检测能力。</p></div></div></div>;
}

function GroupBoard({ detail, members, demo, busy, post, deliver, cancel, open, confirmReplace }: { detail: GroupDetail; members: Session[]; demo: boolean; busy: string | null; post: (body: { text: string; kind: GroupMessage['kind']; recipientIds: string[]; sourceMessageId?: string | null }) => Promise<boolean>; confirmReplace: (message: GroupMessage, draft: string, proceed: () => void) => void; deliver: (id: string, sessionId: string) => void; cancel: (id: string) => void; open: (id: string) => void }) {
  const [draft] = useState(() => readGroupDraft(detail.group.id));
  const [kind, setKind] = useState<GroupMessage['kind']>(draft.kind);
  const [text, setText] = useState(draft.text);
  const [recipients, setRecipients] = useState<string[]>(draft.recipients);
  const [sourceMessageId, setSourceMessageId] = useState<string | null>(draft.sourceMessageId);
  const currentDraftRef = useRef('');
  currentDraftRef.current = JSON.stringify({ text, kind, recipients, sourceMessageId });
  const sourceMessage = detail.messages.find(message => message.id === sourceMessageId);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const jumpToMessage = (id: string) => {
    const element = document.getElementById(`group-message-${id}`);
    element?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    element?.focus({ preventScroll: true });
  };
  const forwardMessage = (message: GroupMessage) => {
    const proceed = () => {
      setKind('task'); setText(message.text); setRecipients([]); setSourceMessageId(message.id); setLocalError('');
      requestAnimationFrame(() => { composerRef.current?.focus(); composerRef.current?.scrollIntoView({ block: 'center' }); });
    };
    if (text.trim() || recipients.length || sourceMessageId) confirmReplace(message, text, proceed);
    else proceed();
  };
  const [localError, setLocalError] = useState('');
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const activeMembers = members.filter((member) => !member.archived);
  const activeRecipients = recipients.filter((id) => activeMembers.some((member) => member.id === id));
  useEffect(() => {
    const submitted = (event: Event) => {
      const finished = (event as CustomEvent<{ groupId: string; draft: string }>).detail;
      if (finished.groupId === detail.group.id && finished.draft === currentDraftRef.current) {
        setText(''); setRecipients([]); setSourceMessageId(null);
      }
    };
    window.addEventListener('sessiondeck:group-draft-submitted', submitted);
    return () => window.removeEventListener('sessiondeck:group-draft-submitted', submitted);
  }, [detail.group.id]);
  useEffect(() => {
    try {
      const key = `sessiondeck.group-draft.${detail.group.id}`;
      if (text || recipients.length || sourceMessageId) sessionStorage.setItem(key, JSON.stringify({ text, kind, recipients, sourceMessageId }));
      else sessionStorage.removeItem(key);
    } catch { /* Draft persistence is optional when browser storage is disabled. */ }
  }, [detail.group.id, text, kind, recipients, sourceMessageId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLocalError('');
    if (!text.trim() || postingRef.current || busy) return;
    if (kind === 'task' && !activeRecipients.length) { setLocalError('请选择至少一位任务接收成员'); return; }
    const submittedDraft = currentDraftRef.current;
    const submittedGroupId = detail.group.id;
    postingRef.current = true; setPosting(true);
    try {
      if (await post({ text: text.trim(), kind, recipientIds: kind === 'task' ? activeRecipients : [], sourceMessageId })) {
        // The user may navigate away before the response arrives. Clear only
        // this submitted draft, including a remounted composer, never a new edit.
        try {
          const key = `sessiondeck.group-draft.${submittedGroupId}`;
          if (sessionStorage.getItem(key) === submittedDraft) sessionStorage.removeItem(key);
        } catch { /* The live composer still clears when storage is unavailable. */ }
        window.dispatchEvent(new CustomEvent('sessiondeck:group-draft-submitted', { detail: { groupId: submittedGroupId, draft: submittedDraft } }));
      }
    } finally { postingRef.current = false; setPosting(false); }
  };
  return <section className="group-board"><div className="section-heading"><div><h2>群组动态</h2><span className="section-count">{detail.messages.length}</span></div><span className="section-tip">共享目标 · 明确分工 · 汇总结果</span></div><div className="board-content">
    <div className="message-list">{detail.messages.length ? detail.messages.map((message) => <article id={`group-message-${message.id}`} tabIndex={-1} key={message.id} className={`group-message kind-${message.kind}`}><span className="message-avatar">{message.senderId ? <Command size={16} /> : '我'}</span><div className="message-body"><div className="message-heading"><strong>{message.senderName || '我'}</strong><span className="message-kind">{message.kind === 'task' ? '任务' : message.kind === 'result' ? '结果' : '记录'}</span><time>{relativeTime(message.createdAt)}</time></div>{message.sourceMessageId && <button className="message-source-link" onClick={() => jumpToMessage(message.sourceMessageId!)}><ArrowRight size={12} />来源：{detail.messages.find(item => item.id === message.sourceMessageId)?.senderName || '原消息'}<span>查看原消息</span></button>}<p>{message.text}</p>{message.recipientIds.length > 0 && <div className="message-recipients">{message.recipientIds.map((id) => <button key={id} onClick={() => open(id)}>@{members.find((member) => member.id === id)?.title || '已归档成员'}</button>)}</div>}<div className="delivery-list">{detail.deliveries.filter((delivery) => delivery.messageId === message.id).map((delivery) => {
      const member = members.find((item) => item.id === delivery.sessionId);
      return <div className="delivery-item" key={delivery.id}><span><Send size={13} />{member?.title || '群组成员'}</span>{delivery.status === 'pending' ? <div><button className="text-button" disabled={!!busy || !member || member.archived} onClick={() => deliver(delivery.id, delivery.sessionId)}>{busy === `deliver:${delivery.id}` ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />}{member?.backend === 'dsh' && !demo ? '发送到会话' : '填入会话'}</button><button className="icon-button" disabled={!!busy} aria-label="取消投递" title="取消投递" onClick={() => cancel(delivery.id)}><X size={13} /></button></div> : <span className="delivery-state">{delivery.status === 'sent' ? '已发送' : delivery.status === 'staged' ? '已填入 · 在私聊按回车发送' : '已取消'}{delivery.status === 'staged' && <button className="text-button" onClick={() => open(delivery.sessionId)}>进入 <ArrowRight size={12} /></button>}</span>}</div>;
    })}</div><div className="message-actions"><button className="text-button" disabled={posting || !!busy} onClick={() => forwardMessage(message)}><ArrowRight size={13} />转交为任务</button></div></div></article>) : <div className="board-empty"><MessageSquare size={25} strokeWidth={1.5} /><h3>从一个清晰的目标开始</h3><p>记录想法，向指定成员分配任务，再把成果带回群组。</p></div>}</div>
    <form className="message-composer" onSubmit={submit}><div className="composer-tabs">{(['note', 'task', 'result'] as const).map((value) => <button type="button" key={value} disabled={posting} aria-pressed={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{value === 'note' ? <MessageSquare size={14} /> : value === 'task' ? <Send size={14} /> : <CheckCheck size={14} />}{value === 'note' ? '记录' : value === 'task' ? '分配任务' : '分享结果'}</button>)}</div>{kind === 'task' && <div className="recipient-picker"><span>接收成员</span>{activeMembers.map((member) => <button type="button" disabled={posting} aria-pressed={recipients.includes(member.id)} key={member.id} className={recipients.includes(member.id) ? 'selected' : ''} onClick={() => setRecipients((current) => current.includes(member.id) ? current.filter((id) => id !== member.id) : [...current, member.id])}>{recipients.includes(member.id) && <Check size={12} />}<BackendAvatar backend={member.backend} small />{member.title}</button>)}{!activeMembers.length && <small>添加成员后，即可分配任务</small>}</div>}{sourceMessageId && <div className="composer-source"><button type="button" className="text-button" disabled={!sourceMessage} onClick={() => jumpToMessage(sourceMessageId)}><Share2 size={13} />来源：{sourceMessage?.senderName || '原消息'}<span>查看原消息</span></button><button type="button" className="icon-button" disabled={posting} aria-label="解除转交来源" title="解除来源，保留内容" onClick={() => setSourceMessageId(null)}><X size={13} /></button></div>}<textarea ref={composerRef} disabled={posting} aria-label="群组消息" onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={kind === 'task' ? '描述任务、期望结果与需要参考的上下文…' : kind === 'result' ? '把成员的结论、进展或待决策事项分享给群组…' : '记录目标、想法或决定…'} value={text} onChange={(event) => setText(event.target.value)} rows={3} required maxLength={30000} />{localError && <p role="alert" className="form-error">{localError}</p>}<div className="composer-footer"><span title="草稿保留在当前浏览器标签页；Ctrl / ⌘ + Enter 发布">{kind === 'task' ? '任务先入队，再由你投递到成员会话。' : '群组记录不会自动发送给成员。'}{text && <small className="draft-note">草稿保留 · Ctrl / ⌘ + Enter 发布</small>}</span><button className="button primary small-button" disabled={!!busy || posting || !text.trim() || (kind === 'task' && !activeMembers.length)}>{busy === 'message' ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}{kind === 'task' ? '创建任务' : '发布'}</button></div></form>
  </div></section>;
}

function AppModal({ modal, state, close, done, notify }: { modal: Exclude<NonNullable<Modal>, { type: 'help' | 'replaceDraft' }>; state: AppState; close: () => void; done: (session?: Session, group?: Group) => Promise<void>; notify: (message: string) => void }) {
  const [title, setTitle] = useState(modal.type === 'rename' ? modal.session.title : modal.type === 'fork' ? `${modal.session.title} · Fork` : modal.type === 'group' ? modal.group?.title ?? '' : '');
  const [backend, setBackend] = useState<Backend>((modal.type === 'create' ? modal.backend : undefined) ?? state.backends.find((item) => item.installed)?.id ?? 'claude');
  const recentSessions = useMemo(() => [...state.sessions].sort((first, second) => second.lastActivity.localeCompare(first.lastActivity)), [state.sessions]);
  const recentDirectories = [...new Set(recentSessions.map(session => session.cwd).filter(Boolean))].slice(0, 5);
  const creationGroupId = modal.type === 'create' || modal.type === 'addMember' ? modal.groupId : undefined;
  const [cwd, setCwd] = useState(() => {
    if (!creationGroupId) return state.defaultCwd;
    const groupMember = recentSessions.find(session => session.groupId === creationGroupId && !session.archived)
      ?? recentSessions.find(session => session.groupId === creationGroupId);
    return groupMember?.cwd || state.defaultCwd;
  });
  const [forkCwd, setForkCwd] = useState(modal.type === 'fork' ? modal.session.cwd : state.defaultCwd);
  const [goal, setGoal] = useState(modal.type === 'group' ? modal.group?.goal ?? '' : '');
  const [text, setText] = useState(modal.type === 'share' ? modal.text : '');
  const [groupId, setGroupId] = useState(modal.type === 'fork' || modal.type === 'create' ? modal.groupId ?? '' : '');
  const [sourceId, setSourceId] = useState('');
  const [memberMode, setMemberMode] = useState<'new' | 'fork'>('new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredSession[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [importId, setImportId] = useState<string | null>(null);
  const backendInfo = state.backends.find((item) => item.id === backend);
  const selectedSource = state.sessions.find((session) => session.id === sourceId);
  const filteredDiscovered = discovered?.filter((session) => `${session.title} ${session.cwd}`.toLowerCase().includes(discoverQuery.trim().toLowerCase()));
  useEffect(() => {
    if (modal.type !== 'import') return;
    let active = true; setDiscovered(null); setWarnings([]); setError('');
    api<{ sessions: DiscoveredSession[]; warnings?: string[] }>(`/discover?backend=${backend}`).then((result) => { if (active) { setDiscovered(result.sessions); setWarnings(result.warnings ?? []); } }).catch((cause) => { if (active) { setError(cause.message); setDiscovered([]); } });
    return () => { active = false; };
  }, [backend, modal.type]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (modal.type === 'rename') { await api(`/sessions/${modal.session.id}`, { title: title.trim() }, 'PATCH'); await done(); }
      if (modal.type === 'create') { const session = await api<Session>('/sessions', { title: title.trim(), backend, cwd: cwd.trim(), groupId: modal.groupId || undefined }); await done(session); }
      if (modal.type === 'fork') { const session = await api<Session>(`/sessions/${modal.session.id}/fork`, { title: title.trim(), groupId: groupId || undefined, cwd: modal.session.backend === 'dsh' ? undefined : forkCwd.trim() }); notify('已创建 Fork 联系人，原会话保留'); await done(session); }
      if (modal.type === 'group') { const group = modal.group ? await api<Group>(`/groups/${modal.group.id}`, { title: title.trim(), goal: goal.trim() }, 'PATCH') : await api<Group>('/groups', { title: title.trim(), goal: goal.trim() }); await done(undefined, group); }
      if (modal.type === 'addMember') {
        if (memberMode === 'fork' && !sourceId) throw new Error('请选择要 Fork 的联系人');
        const session = memberMode === 'new' ? await api<Session>('/sessions', { title: title.trim(), backend, cwd: cwd.trim(), groupId: modal.groupId }) : await api<Session>(`/sessions/${sourceId}/fork`, { title: title.trim() || `${selectedSource?.title} · 群组`, groupId: modal.groupId });
        notify(memberMode === 'fork' ? '已将上下文 Fork 入群，原会话保留' : '群组成员已创建'); await done(session);
      }
      if (modal.type === 'share') { await api(`/groups/${modal.session.groupId}/messages`, { text: text.trim(), kind: 'result', senderId: modal.session.id, recipientIds: [] }); notify('结果已分享到群组'); await done(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const importSession = async (session: DiscoveredSession) => {
    setBusy(true); setImportId(session.nativeSessionId); setError('');
    try { const imported = await api<Session>('/import', { backend: session.backend, nativeSessionId: session.nativeSessionId, title: session.title, cwd: session.cwd }); notify('已连接原生会话'); await done(imported); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败'); }
    finally { setBusy(false); setImportId(null); }
  };
  const titleLabel = modal.type === 'create' ? '新建会话联系人' : modal.type === 'rename' ? '给联系人改个名字' : modal.type === 'fork' ? 'Fork 会话' : modal.type === 'group' ? modal.group ? '编辑群组' : '创建协作群组' : modal.type === 'addMember' ? '添加群组成员' : modal.type === 'share' ? '分享结果到群组' : '导入已有会话';
  const subtitle = modal.type === 'create' ? '选择 Agent，让下一段工作拥有独立的上下文。' : modal.type === 'fork' ? '延续这段上下文，开启另一条思路。原会话会保留。' : modal.type === 'group' ? '把相关的会话组织起来，围绕同一个目标工作。' : modal.type === 'import' ? '发现本机已有的原生会话，添加到联系人列表。' : modal.type === 'addMember' ? '每一位成员都有独立私聊，可以随时进入并纠正。' : modal.type === 'share' ? '检查并编辑内容，再将它作为成员结果记录到群组。' : '名称只影响 SessionDeck 中的显示。';
  const backendPicker = <fieldset className="backend-picker"><legend>选择后端</legend>{state.backends.map((item) => <button type="button" key={item.id} aria-pressed={backend === item.id} disabled={busy || (modal.type !== 'import' && !item.installed)} className={backend === item.id ? 'selected' : ''} onClick={() => setBackend(item.id)}><BackendAvatar backend={item.id} small /><strong>{BACKEND[item.id].short}</strong><small>{item.installed ? '本机已安装' : '未安装'}</small>{backend === item.id && <Check size={14} />}</button>)}</fieldset>;
  const nameField = <label className="form-label">联系人名称<input autoComplete="off" placeholder="例如：登录功能实现" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required /></label>;
  const cwdField = <div className="cwd-field"><label className="form-label">工作目录<div className="input-with-icon"><Folder size={16} /><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/path/to/project" required /></div><small>Agent 将在这个本机目录中运行。</small></label>{recentDirectories.length > 0 && <details className="recent-directories"><summary>最近使用的目录</summary><div>{recentDirectories.map(directory => <button key={directory} type="button" title={directory} onClick={() => setCwd(directory)}><Folder size={13} /><span>{directory}</span>{cwd === directory && <Check size={13} />}</button>)}</div></details>}</div>;
  return <ModalShell title={titleLabel} subtitle={subtitle} close={busy ? () => {} : close} wide={modal.type === 'import'}><form onSubmit={submit}>
    {modal.type === 'import' ? <>{backendPicker}<label className="search-field import-search"><Search size={16} /><input aria-label="搜索可导入会话" placeholder="搜索标题或工作目录…" value={discoverQuery} onChange={(event) => setDiscoverQuery(event.target.value)} /></label>{warnings.map((warning) => <p className="form-note" key={warning}>{warning}</p>)}<div className="discovered-list">{discovered === null ? <div className="discovery-empty"><LoaderCircle size={24} className="spin" /><p>正在发现本机会话…</p></div> : filteredDiscovered?.map((session) => {
      const exists = state.sessions.some((item) => item.backend === session.backend && item.nativeSessionId === session.nativeSessionId);
      return <div className="discovered-item" key={session.nativeSessionId}><BackendAvatar backend={session.backend} small /><div><strong>{session.title || session.nativeSessionId.slice(0, 12)}</strong><small title={session.cwd}>{shortPath(session.cwd)} · {relativeTime(session.lastActivity)}</small><code>{session.nativeSessionId.slice(0, 24)}</code></div><button className="button secondary small-button" type="button" disabled={busy || exists} onClick={() => void importSession(session)}>{importId === session.nativeSessionId ? <LoaderCircle size={14} className="spin" /> : exists ? <Check size={14} /> : <Plus size={14} />}{exists ? '已添加' : '添加'}</button></div>;
    })}{!!discovered?.length && !filteredDiscovered?.length && <div className="discovery-empty"><Search size={26} /><p>没有匹配的原生会话</p><button type="button" className="text-button" onClick={() => setDiscoverQuery('')}>清除搜索</button></div>}{discovered?.length === 0 && <div className="discovery-empty"><Search size={26} /><p>尚未发现 {BACKEND[backend].short} 会话</p><small>先在原生工具中创建会话，或直接新建联系人。</small></div>}</div></> : <div className="modal-fields">
      {modal.type === 'addMember' && <div className="segmented-control"><button type="button" className={memberMode === 'new' ? 'selected' : ''} onClick={() => setMemberMode('new')}><Plus size={15} /> 新建会话</button><button type="button" className={memberMode === 'fork' ? 'selected' : ''} onClick={() => setMemberMode('fork')}><GitFork size={15} /> 从已有联系人 Fork</button></div>}
      {(modal.type === 'create' || (modal.type === 'addMember' && memberMode === 'new')) && backendPicker}
      {modal.type === 'addMember' && memberMode === 'fork' && <><label className="form-label">来源联系人<select required value={sourceId} onChange={(event) => { setSourceId(event.target.value); const source = state.sessions.find((session) => session.id === event.target.value); if (source) setTitle(`${source.title} · 群组`); }}><option value="">选择要延续的会话…</option>{state.sessions.filter((session) => !session.archived && !!session.nativeSessionId && !session.forkPending && state.backends.find((item) => item.id === session.backend)?.capabilities.fork).map((session) => <option key={session.id} value={session.id}>{session.title} · {BACKEND[session.backend].short}</option>)}</select></label><div className="form-note"><GitFork size={16} />通过后端原生能力 Fork 上下文。群组内的新会话独立运行，外面的原联系人保持不变。</div></>}
      {['create', 'rename', 'fork', 'addMember'].includes(modal.type) && nameField}
      {(modal.type === 'create' || (modal.type === 'addMember' && memberMode === 'new')) && cwdField}
      {modal.type === 'fork' && <><div className="fork-source"><BackendAvatar backend={modal.session.backend} small /><div><small>来源会话</small><strong>{modal.session.title}</strong></div><GitFork size={18} /></div><label className="form-label">新联系人放在哪里<select value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">独立联系人</option>{state.groups.map((group) => <option key={group.id} value={group.id}>群组 · {group.title}</option>)}</select></label>{modal.session.backend === 'dsh' ? <p className="form-note"><CircleHelp size={16} />DeepSeek Harness 的 Fork 由原生界面处理，继续使用原工作目录。</p> : <label className="form-label">新的工作目录<div className="input-with-icon"><Folder size={16} /><input value={forkCwd} onChange={(event) => setForkCwd(event.target.value)} placeholder={modal.session.cwd} required /></div><small>可与来源会话使用同一目录，也可以填写隔离的工作目录。</small></label>}<p className="form-note"><CircleHelp size={16} />Fork 继承上下文；它不会自动创建 Git 分支或隔离文件。</p></>}
      {modal.type === 'group' && <><label className="form-label">群组名称<input placeholder="例如：完成登录功能" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={120} /></label><label className="form-label">共同目标<textarea placeholder="希望完成什么？怎样算完成？" value={goal} onChange={(event) => setGoal(event.target.value)} rows={4} maxLength={4000} /></label><p className="form-note"><UsersRound size={16} />创建后可添加新会话，或将现有联系人 Fork 入群。</p></>}
      {modal.type === 'share' && <><div className="fork-source"><BackendAvatar backend={modal.session.backend} small /><div><small>结果来自</small><strong>{modal.session.title}</strong></div></div><label className="form-label">分享内容<textarea rows={8} required placeholder="粘贴或整理成员的输出、结论与下一步…" value={text} onChange={(event) => setText(event.target.value)} maxLength={30000} /></label><p className="form-note">可以先在终端选中内容，再打开“分享结果”；也可以直接粘贴内容。</p></>}
      {((modal.type === 'create' || (modal.type === 'addMember' && memberMode === 'new')) && !backendInfo?.installed) && <p className="form-error">请先在本机安装所选后端，再到“连接与能力”刷新检测。</p>}
    </div>}
    {error && <p role="alert" className="form-error modal-error">{error}</p>}
    <div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>{modal.type === 'import' ? '完成' : '取消'}</button>{modal.type !== 'import' && <button className="button primary" disabled={busy || ((modal.type === 'create' || (modal.type === 'addMember' && memberMode === 'new')) && !backendInfo?.installed)}>{busy ? <LoaderCircle size={15} className="spin" /> : modal.type === 'fork' ? <GitFork size={15} /> : modal.type === 'share' ? <Share2 size={15} /> : modal.type === 'rename' || (modal.type === 'group' && modal.group) ? <Check size={15} /> : <Plus size={15} />}{modal.type === 'rename' || (modal.type === 'group' && modal.group) ? '保存修改' : modal.type === 'fork' ? '创建 Fork' : modal.type === 'group' ? '创建群组' : modal.type === 'share' ? '分享到群组' : modal.type === 'addMember' ? memberMode === 'fork' ? 'Fork 入群' : '添加成员' : '创建联系人'}</button>}</div>
  </form></ModalShell>;
}
