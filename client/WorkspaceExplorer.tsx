import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Braces, ChevronDown, ChevronRight, Columns2, File, FileCode2, FileDiff, FileImage, FileText, Folder, LoaderCircle, RefreshCw, Rows3, X } from 'lucide-react';
import type { Session } from '../shared/types';
import { api } from './api';
import Markdown from './Markdown';
import DiffView, { DiffStats, type DiffMode } from './DiffView';
import { readLocalPreference, writeLocalPreference } from './ui';

type Entry = { name: string; path: string; kind: 'file' | 'directory'; size?: number };
type Tree = { path: string; entries: Entry[]; truncated: boolean };
type FileResult = { path: string; content: string; truncated: boolean; binary: boolean; size: number };
type DiffResult = { path: string; diff: string; truncated?: boolean; available: boolean };
type GitStatus = { entries: { path: string; status: string }[]; available: boolean };
type Preview = { kind: 'file'; result: FileResult } | { kind: 'diff'; result: DiffResult };

function markdownPath(path: string) { return /\.(?:md|markdown|mdx)$/i.test(path); }
function formatSize(size?: number) { if (size === undefined) return ''; if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`; return `${(size / 1024 / 1024).toFixed(1)} MB`; }
function fileIconClass(path: string) {
  const name = path.split('/').pop() ?? path;
  if (markdownPath(name)) return 'workspace-file-icon-markdown';
  if (/\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|css|scss|less|html|xml)$/i.test(name)) return 'workspace-file-icon-code';
  if (/\.(?:json|ya?ml|toml|ini|env)$/i.test(name) || /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(name)) return 'workspace-file-icon-config';
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(name)) return 'workspace-file-icon-image';
  return 'workspace-file-icon-file';
}
function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === 'directory') return <Folder size={14} className="workspace-entry-icon workspace-folder-icon" />;
  const className = fileIconClass(entry.path);
  const Icon = className.endsWith('-markdown') ? FileText : className.endsWith('-config') ? Braces : className.endsWith('-image') ? FileImage : className.endsWith('-code') ? FileCode2 : File;
  return <Icon size={14} className={`workspace-entry-icon ${className}`} />;
}
function gitStatusClass(status: string) {
  if (status === '??' || status.includes('A')) return 'git-added';
  if (status.includes('D')) return 'git-deleted';
  if (status.includes('R')) return 'git-renamed';
  if (status.includes('U')) return 'git-conflict';
  return 'git-modified';
}
function gitStatusLabel(status: string) {
  if (status === '??') return 'U';
  return status.replace(/\s/g, '').at(-1) ?? status;
}

// Tree and preview have independent pixel widths, like the VS Code explorer and
// an editor group. The preview only takes space while a file is open.
const TREE = { min: 180, max: 520, fallback: 260, key: 'sessiondeck.layout.explorer-tree-px' };
const PREVIEW = { min: 320, fallback: 560, key: 'sessiondeck.layout.explorer-preview-px' };
const MAIN_RESERVE = 360;
function savedWidth(key: string, fallback: number) {
  const raw = readLocalPreference(key);
  const saved = raw === null ? NaN : Number(raw);
  return Number.isFinite(saved) ? saved : fallback;
}
function useViewportWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return width;
}

function Splitter({ label, value, min, max, onChange, onCommit }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; onCommit: (value: number) => void }) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const clamp = (next: number) => Math.round(Math.max(min, Math.min(max, next)));
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Pointer capture keeps the drag alive over terminals and iframes, which
    // would otherwise swallow document-level pointer events.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: value, last: value };
    document.body.classList.add('workspace-resizing');
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = clamp(drag.current.width + event.clientX - drag.current.x);
    drag.current.last = next;
    onChange(next);
  };
  const finish = () => {
    if (!drag.current) return;
    onCommit(drag.current.last);
    drag.current = null;
    document.body.classList.remove('workspace-resizing');
  };
  useEffect(() => () => document.body.classList.remove('workspace-resizing'), []);
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = clamp(value + (event.key === 'ArrowRight' ? 24 : -24));
    onChange(next); onCommit(next);
  };
  return <div className="workspace-splitter" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} title="拖动调整宽度"
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onKeyDown={keyDown}><span /></div>;
}

export default function WorkspaceExplorer(props: { session: Session; close: () => void; picker?: ReactNode }) {
  // Remount immediately when switching workspaces; pending responses from the
  // previous panel cannot expose another contact's file or error.
  return <WorkspaceExplorerPanel key={`${props.session.id}:${props.session.cwd}`} {...props} />;
}

function WorkspaceExplorerPanel({ session, close, picker }: { session: Session; close: () => void; picker?: ReactNode }) {
  const [tab, setTab] = useState<'files' | 'git'>('files');
  const [trees, setTrees] = useState<Record<string, Tree>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [selectedPath, setSelectedPath] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [treeWidth, setTreeWidth] = useState(() => savedWidth(TREE.key, TREE.fallback));
  const [previewWidth, setPreviewWidth] = useState(() => savedWidth(PREVIEW.key, PREVIEW.fallback));
  const [diffMode, setDiffMode] = useState<DiffMode>(() => readLocalPreference('sessiondeck.diff-mode') === 'inline' ? 'inline' : 'split');
  const viewport = useViewportWidth();
  const live = useRef(true);
  const sequence = useRef(0);
  const requests = useRef(new Map<string, number>());
  const base = `/sessions/${encodeURIComponent(session.id)}/workspace`;

  // Each tree, Git status and the single preview have their own request scope.
  // An older completion cannot clear a newer request's loading/error state.
  const request = useCallback(async <T,>(scope: string, url: string, apply: (value: T) => void, failure: string) => {
    const version = ++sequence.current;
    requests.current.set(scope, version);
    setPending(current => new Set(current).add(scope));
    setErrors(current => { const next = { ...current }; delete next[scope]; return next; });
    const currentRequest = () => live.current && requests.current.get(scope) === version;
    try {
      const result = await api<T>(url);
      if (currentRequest()) apply(result);
    } catch (cause) {
      if (currentRequest()) setErrors(current => ({ ...current, [scope]: cause instanceof Error ? cause.message : failure }));
    } finally {
      if (currentRequest()) {
        requests.current.delete(scope);
        setPending(current => { const next = new Set(current); next.delete(scope); return next; });
      }
    }
  }, []);
  const loadTree = useCallback((path: string) => request<Tree>(`tree:${path}`, `${base}/tree${path ? `?path=${encodeURIComponent(path)}` : ''}`, result => {
    setTrees(current => ({ ...current, [path]: result }));
  }, '无法读取文件树'), [base, request]);
  const loadGit = useCallback(() => request<GitStatus>('git', `${base}/git/status`, setGit, '无法读取 Git 状态'), [base, request]);

  useEffect(() => {
    live.current = true;
    void loadTree(''); void loadGit();
    return () => { live.current = false; requests.current.clear(); };
  }, [loadTree, loadGit]);

  const clearPreview = () => {
    requests.current.delete('preview');
    setPending(current => { const next = new Set(current); next.delete('preview'); return next; });
    setErrors(current => { const next = { ...current }; delete next.preview; return next; });
    setSelectedPath(''); setPreview(null);
  };
  const openFile = (path: string) => {
    setSelectedPath(path); setPreview(null);
    void request<FileResult>('preview', `${base}/file?path=${encodeURIComponent(path)}`, result => setPreview({ kind: 'file', result }), '无法读取文件');
  };
  const openDiff = (path: string) => {
    setSelectedPath(path); setPreview(null);
    void request<DiffResult>('preview', `${base}/git/diff?path=${encodeURIComponent(path)}`, result => setPreview({ kind: 'diff', result: { ...result, path: result.path || path } }), '无法读取 Git diff');
  };
  const selectTab = (next: typeof tab) => {
    if (next !== tab) { clearPreview(); setTab(next); }
    if (next === 'git') void loadGit();
  };
  const refresh = () => {
    // Drop collapsed-directory caches, then refresh every expanded directory.
    // New and deleted files appear without reopening their parent directories.
    for (const scope of requests.current.keys()) if (scope.startsWith('tree:')) requests.current.delete(scope);
    setPending(current => new Set([...current].filter(scope => !scope.startsWith('tree:'))));
    setErrors(current => Object.fromEntries(Object.entries(current).filter(([scope]) => !scope.startsWith('tree:'))));
    setTrees(current => Object.fromEntries(Object.entries(current).filter(([path]) => expanded.has(path))));
    for (const path of expanded) void loadTree(path);
    void loadGit();
    if (selectedPath) { if (tab === 'git') openDiff(selectedPath); else openFile(selectedPath); }
  };
  const root = trees[''];
  const rows = useMemo(() => {
    const result: { entry: Entry; depth: number }[] = [];
    const visited = new Set<string>();
    const visit = (path: string, depth: number) => {
      if (visited.has(path) || depth > 64) return;
      visited.add(path);
      const entries = [...(trees[path]?.entries ?? [])].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      });
      for (const entry of entries) {
        result.push({ entry, depth });
        if (entry.kind === 'directory' && expanded.has(entry.path)) visit(entry.path, depth + 1);
      }
    };
    visit('', 0); return result;
  }, [trees, expanded]);
  const toggle = (entry: Entry) => {
    if (entry.kind !== 'directory') return openFile(entry.path);
    const next = new Set(expanded);
    if (next.has(entry.path)) next.delete(entry.path);
    else { next.add(entry.path); if (!trees[entry.path]) void loadTree(entry.path); }
    setExpanded(next);
  };
  const loading = pending.size > 0;
  const file = preview?.kind === 'file' ? preview.result : null;
  const diff = preview?.kind === 'diff' ? preview.result : null;
  const gitEntries = useMemo(() => [...(git?.entries ?? [])].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true, sensitivity: 'base' })), [git]);
  const visibleErrors = Object.entries(errors).filter(([scope]) => scope === 'preview' || (tab === 'git' ? scope === 'git' : scope.startsWith('tree:')));

  // Saved widths are preferences; the rendered widths always leave the main
  // workbench usable on the current window size.
  const treeMax = Math.max(TREE.min, Math.min(TREE.max, viewport - MAIN_RESERVE));
  const shownTree = Math.max(TREE.min, Math.min(treeWidth, treeMax));
  const previewOpen = !!selectedPath;
  const previewMax = Math.max(PREVIEW.min, viewport - MAIN_RESERVE - shownTree);
  const shownPreview = Math.max(PREVIEW.min, Math.min(previewWidth, previewMax));
  const chooseDiffMode = (mode: DiffMode) => { setDiffMode(mode); writeLocalPreference('sessiondeck.diff-mode', mode); };

  return <aside className={`workspace-explorer ${previewOpen ? 'preview-open' : ''}`} aria-label="资源管理器" style={{ '--workspace-tree-width': `${shownTree}px`, '--workspace-preview-width': `${shownPreview}px` } as CSSProperties}>
    <div className="workspace-list-pane">
      <header className="workspace-explorer-header"><div><strong>资源管理器</strong><small title={session.cwd}><bdi>{session.cwd}</bdi></small></div><button className="icon-button" aria-label="刷新资源管理器" title="刷新" onClick={refresh}><RefreshCw size={14} /></button><button className="icon-button" aria-label="关闭资源管理器" title="关闭" onClick={close}><X size={16} /></button></header>
      {picker}
      <nav className="workspace-tabs" aria-label="资源管理器视图"><button className={tab === 'files' ? 'active' : ''} aria-pressed={tab === 'files'} onClick={() => selectTab('files')}><Folder size={14} />文件</button><button className={tab === 'git' ? 'active' : ''} aria-pressed={tab === 'git'} onClick={() => selectTab('git')}><FileDiff size={14} />Git diff{!!git?.entries.length && <b>{git.entries.length}</b>}</button></nav>
      {visibleErrors.filter(([scope]) => scope !== 'preview').map(([scope, message]) => <div key={scope} className="workspace-error" role="alert">{message}</div>)}
      {loading && <div className="workspace-loading" role="status"><LoaderCircle size={14} className="spin" />读取中…</div>}
      {tab === 'files' ? <div className="workspace-tree">
        {!root && !pending.has('tree:') && <button className="workspace-empty" onClick={() => void loadTree('')}>读取工作区</button>}
        {root && !root.entries.length && <p className="workspace-note">此目录为空。</p>}
        {rows.map(({ entry, depth }) => <button key={entry.path} className={`workspace-entry ${selectedPath === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} onClick={() => toggle(entry)}>{entry.kind === 'directory' ? expanded.has(entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span className="workspace-file-spacer" aria-hidden="true" />}<EntryIcon entry={entry} /><span title={entry.path}>{entry.name}</span>{entry.kind === 'file' && <small>{formatSize(entry.size)}</small>}</button>)}
        {Object.entries(trees).filter(([path, tree]) => expanded.has(path) && tree.truncated).map(([path, tree]) => <p key={path} className="workspace-note">{path || '工作目录'}内容过多，仅显示前 {tree.entries.length} 项</p>)}
      </div> : <div className="workspace-git">{!git?.available && git && <p className="workspace-note">当前目录不是 Git 仓库，或 Git 不可用。</p>}{gitEntries.map(entry => { const name = entry.path.split('/').pop() ?? entry.path; const folder = entry.path.slice(0, entry.path.length - name.length).replace(/\/$/, ''); return <button key={`${entry.status}:${entry.path}`} className={`workspace-git-entry ${gitStatusClass(entry.status)} ${selectedPath === entry.path ? 'selected' : ''}`} title={`${entry.path} · ${entry.status}`} onClick={() => openDiff(entry.path)}><EntryIcon entry={{ name: entry.path, path: entry.path, kind: 'file' }} /><span className="workspace-git-name">{name}</span>{folder && <small>{folder}</small>}<code>{gitStatusLabel(entry.status)}</code></button>; })}{git?.available && !gitEntries.length && <p className="workspace-note">工作区没有未提交变更。</p>}</div>}
    </div>
    <Splitter label="调整文件树宽度" value={shownTree} min={TREE.min} max={treeMax} onChange={setTreeWidth} onCommit={value => writeLocalPreference(TREE.key, String(value))} />
    {previewOpen && <><div className="workspace-preview-pane">
      {visibleErrors.filter(([scope]) => scope === 'preview').map(([scope, message]) => <div key={scope} className="workspace-error" role="alert">{message}</div>)}
      {file && <section className="workspace-preview"><header><EntryIcon entry={{ name: file.path, path: file.path, kind: 'file' }} /><strong title={file.path}><bdi>{file.path}</bdi></strong><button className="icon-button" aria-label="关闭文件预览" onClick={clearPreview}><X size={14} /></button></header>{file.binary ? <p className="workspace-note">二进制文件不支持预览。</p> : markdownPath(file.path) ? <Markdown text={file.content} /> : <pre>{file.content}</pre>}{file.truncated && <p className="workspace-note">文件过大，预览已截断。</p>}</section>}
      {diff && <section className="workspace-preview workspace-diff"><header><FileDiff size={14} className="workspace-entry-icon" /><strong title={diff.path}><bdi>{diff.path}</bdi></strong>{diff.available && diff.diff && <DiffStats diff={diff.diff} />}<div className="diff-mode-switch" role="group" aria-label="差异显示方式"><button className="icon-button" aria-label="并排显示" title="并排显示" aria-pressed={diffMode === 'split'} onClick={() => chooseDiffMode('split')}><Columns2 size={14} /></button><button className="icon-button" aria-label="内联显示" title="内联显示" aria-pressed={diffMode === 'inline'} onClick={() => chooseDiffMode('inline')}><Rows3 size={14} /></button></div><button className="icon-button" aria-label="关闭 diff 预览" onClick={clearPreview}><X size={14} /></button></header>{!diff.available ? <p className="workspace-note">Git diff 不可用。</p> : !diff.diff ? <p className="workspace-note">此文件没有可显示的文本差异。</p> : <DiffView diff={diff.diff} mode={diffMode} />}{diff.truncated && <p className="workspace-note">差异过大，预览已截断。</p>}</section>}
      {!file && !diff && pending.has('preview') && <div className="workspace-preview workspace-preview-empty"><LoaderCircle size={18} className="spin" /><p>正在打开 {selectedPath}</p></div>}
    </div>
    <Splitter label="调整预览宽度" value={shownPreview} min={PREVIEW.min} max={previewMax} onChange={setPreviewWidth} onCommit={value => writeLocalPreference(PREVIEW.key, String(value))} /></>}
  </aside>;
}
