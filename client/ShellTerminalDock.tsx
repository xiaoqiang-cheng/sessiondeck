import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Columns2, LoaderCircle, Plus, RefreshCw, TerminalSquare, X } from 'lucide-react';
import type { ShellTerminal } from '../shared/shell';
import { api, ApiError } from './api';
import TerminalPane from './TerminalPane';

const ignoreSelection = () => {};
const clampHeight = (height: number) => Math.max(180, Math.min(height, window.innerHeight * .7));

export default function ShellTerminalDock({ open, sessionId, onClose, inert = false }: {
  open: boolean; sessionId?: string; onClose: () => void; inert?: boolean;
}) {
  const [shells, setShells] = useState<ShellTerminal[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [splitId, setSplitId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [height, setHeight] = useState(() => clampHeight(340));
  const busyRef = useRef(false);
  const revisionRef = useRef(0);
  const initializedRef = useRef(false);
  const contextRef = useRef({ open, sessionId, generation: 0 });
  if (contextRef.current.open !== open || contextRef.current.sessionId !== sessionId) {
    contextRef.current = { open, sessionId, generation: contextRef.current.generation + 1 };
  }
  const resolvedContextRef = useRef(-1);
  const [focusTarget, setFocusTarget] = useState<{ id: string; request: number } | null>(null);
  const requestFocus = useCallback((id: string) => setFocusTarget(current => ({ id, request: (current?.request ?? 0) + 1 })), []);
  const dragRef = useRef<{ y: number; height: number } | null>(null);

  const refresh = useCallback(async () => {
    const revision = revisionRef.current;
    const entries = await api<ShellTerminal[]>('/shells');
    if (revision === revisionRef.current && !busyRef.current) setShells(entries);
    return entries;
  }, []);
  const createShell = useCallback(async () => {
    if (busyRef.current) return;
    const context = contextRef.current;
    const focusedBefore = document.activeElement;
    busyRef.current = true; revisionRef.current++; setBusy(true); setError('');
    try {
      const shell = await api<ShellTerminal>('/shells', context.sessionId ? { sessionId: context.sessionId } : {});
      setShells(current => [...current.filter(entry => entry.id !== shell.id), shell]);
      if (contextRef.current === context && context.open) {
        setActiveId(shell.id);
        if (document.activeElement === focusedBefore) requestFocus(shell.id);
      }
      return shell;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法启动终端');
      // A response lost after spawn must not silently create a duplicate.
      try { setShells(await api<ShellTerminal[]>('/shells')); } catch { /* Keep the original error visible. */ }
      return undefined;
    } finally { revisionRef.current++; busyRef.current = false; setBusy(false); }
  }, [requestFocus]);

  useEffect(() => {
    if (!open || busy) return;
    let cancelled = false;
    const context = contextRef.current;
    const load = async () => {
      if (busyRef.current) return;
      const revision = revisionRef.current;
      try {
        const entries = await refresh();
        if (cancelled || contextRef.current !== context || revision !== revisionRef.current || busyRef.current) return;
        const needsContext = resolvedContextRef.current !== context.generation;
        if (needsContext && sessionId) {
          resolvedContextRef.current = context.generation;
          const contextual = entries.findLast(shell => shell.sessionId === sessionId && shell.running) ?? entries.findLast(shell => shell.sessionId === sessionId);
          if (contextual) { setActiveId(contextual.id); requestFocus(contextual.id); }
          else { setSplitId(null); await createShell(); }
          initializedRef.current = true;
        } else if (needsContext && !initializedRef.current) {
          resolvedContextRef.current = context.generation;
          initializedRef.current = true;
          if (!entries.length) await createShell();
          else requestFocus(entries.at(-1)!.id);
        } else if (needsContext) {
          resolvedContextRef.current = context.generation;
        }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : '无法读取终端列表'); }
      finally { if (!cancelled) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, refresh, createShell, sessionId, busy, requestFocus]);
  useEffect(() => {
    const resize = () => setHeight(current => clampHeight(current));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const removeShell = async (id: string) => {
    if (busyRef.current) return;
    busyRef.current = true; revisionRef.current++; setBusy(true); setError('');
    try {
      await api(`/shells/${encodeURIComponent(id)}`, {}, 'DELETE');
      setShells(current => current.filter(entry => entry.id !== id));
      if (id === splitId) setSplitId(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) setShells(current => current.filter(entry => entry.id !== id));
      else setError(cause instanceof Error ? cause.message : '无法关闭终端');
    } finally { revisionRef.current++; busyRef.current = false; setBusy(false); }
  };
  const active = shells.find(shell => shell.id === activeId) ?? shells.at(-1);
  const split = shells.find(shell => shell.id === splitId && shell.id !== active?.id);
  const toggleSplit = async () => {
    if (split) { setSplitId(null); return; }
    if (!active) return;
    const other = shells.find(shell => shell.id !== active.id);
    if (other) { setSplitId(other.id); requestFocus(other.id); }
    else {
      const context = contextRef.current;
      const created = await createShell();
      if (created && contextRef.current === context && context.open) setSplitId(active.id);
    }
  };
  const select = (id: string) => {
    if (id === splitId) setSplitId(active?.id ?? null);
    setActiveId(id);
    requestFocus(id);
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { y: event.clientY, height };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  if (!open) return null;
  const panes = [active, split].filter((shell): shell is ShellTerminal => !!shell);
  return <section className={`terminal-dock ${split ? 'split' : ''}`} style={{ height }} aria-label="底部终端面板" inert={inert}>
    <div className="terminal-dock-resizer" role="separator" tabIndex={0} aria-label="调整终端面板高度" aria-orientation="horizontal" aria-valuemin={180} aria-valuemax={Math.round(window.innerHeight * .7)} aria-valuenow={Math.round(height)}
      onPointerDown={pointerDown} onPointerMove={event => { if (dragRef.current) setHeight(clampHeight(dragRef.current.height + dragRef.current.y - event.clientY)); }}
      onPointerUp={event => { dragRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragRef.current = null; }}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setHeight(current => clampHeight(current + (event.key === 'ArrowUp' ? 30 : -30))); } }} />
    <header className="terminal-dock-header">
      <span className="terminal-dock-label"><TerminalSquare size={14} />终端</span>
      <div className="terminal-dock-tabs" role="tablist" aria-label="打开的终端">
        {shells.map(shell => <div className={`terminal-dock-tab ${shell.id === active?.id ? 'active' : ''}`} key={shell.id}>
          <button id={`shell-tab-${shell.id}`} role="tab" aria-selected={shell.id === active?.id} aria-controls={`shell-pane-${shell.id}`} title={`${shell.shell}\n${shell.cwd}${shell.running ? '' : `\n已退出 · ${shell.exitCode}`}`} onClick={() => select(shell.id)}><TerminalSquare size={13} /><span>{shell.title}{!shell.running && ` · 已退出 ${shell.exitCode ?? ''}`}</span></button>
          <button className="terminal-dock-tab-close" aria-label={`关闭 ${shell.title} 终端`} title="关闭终端并结束 Shell" disabled={busy} onClick={() => void removeShell(shell.id)}><X size={13} /></button>
        </div>)}
      </div>
      <div className="terminal-dock-actions">
        <button className="icon-button" aria-label="新建终端" title="新建独立 Shell 终端" disabled={busy} onClick={() => void createShell()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}</button>
        <button className={`icon-button ${split ? 'active' : ''}`} aria-label={split ? '关闭终端分屏' : '终端分屏'} aria-pressed={!!split} title={split ? '收起分屏，保留终端' : '左右分屏'} disabled={busy || !active} onClick={() => void toggleSplit()}><Columns2 size={16} /></button>
        <button className="icon-button" aria-label="隐藏终端面板" title="隐藏面板，Shell 继续运行" onClick={onClose}><X size={16} /></button>
      </div>
    </header>
    {error && <div className="terminal-dock-error" role="alert"><span>{error}</span><button className="text-button" onClick={() => { setError(''); void refresh().catch(cause => setError(cause.message)); }}><RefreshCw size={13} />刷新列表</button></div>}
    <div className="terminal-dock-body">
      {panes.map(shell => <div className="terminal-dock-pane" key={shell.id} id={`shell-pane-${shell.id}`} role="tabpanel" aria-label={`${shell.title} 终端`} aria-labelledby={`shell-tab-${shell.id}`}>
        <div className="terminal-dock-pane-heading"><span title={shell.cwd}>{shell.cwd}</span>{!shell.running && <small>已退出 · {shell.exitCode}</small>}</div>
        <TerminalPane sessionId={shell.id} running={shell.running} channel="shell" focusRequest={focusTarget?.id === shell.id ? focusTarget.request : undefined} onSelection={ignoreSelection} onExit={exitCode => setShells(current => current.some(entry => entry.id === shell.id && (entry.running || entry.exitCode !== exitCode)) ? current.map(entry => entry.id === shell.id ? { ...entry, running: false, exitCode } : entry) : current)} />
      </div>)}
      {!panes.length && <div className="terminal-dock-empty">{loading || busy ? <><LoaderCircle size={18} className="spin" /><span>正在打开 Shell…</span></> : <><TerminalSquare size={22} /><span>新建终端，在工作目录运行命令。</span><button className="button secondary small-button" onClick={() => void createShell()}><Plus size={14} />新建终端</button></>}</div>}
    </div>
  </section>;
}
