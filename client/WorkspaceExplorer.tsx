import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileCode2, FileDiff, Folder, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type { Session } from '../shared/types';
import { api } from './api';
import Markdown from './Markdown';

type Entry = { name: string; path: string; kind: 'file' | 'directory'; size?: number };
type Tree = { path: string; entries: Entry[]; truncated: boolean };
type FileResult = { path: string; content: string; truncated: boolean; binary: boolean; size: number };
type DiffResult = { path: string; diff: string; truncated?: boolean; available: boolean };
type GitStatus = { entries: { path: string; status: string }[]; available: boolean };
type Preview = { kind: 'file'; result: FileResult } | { kind: 'diff'; result: DiffResult };

function markdownPath(path: string) { return /\.(?:md|markdown|mdx)$/i.test(path); }
function formatSize(size?: number) { if (size === undefined) return ''; if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`; return `${(size / 1024 / 1024).toFixed(1)} MB`; }
function diffLineClass(line: string) {
  if (/^(?:diff |index |--- |\+\+\+ |@@)/.test(line)) return 'workspace-diff-meta';
  if (line.startsWith('+')) return 'workspace-diff-added';
  if (line.startsWith('-')) return 'workspace-diff-removed';
  return '';
}

export default function WorkspaceExplorer(props: { session: Session; close: () => void }) {
  // Remount immediately when switching workspaces; pending responses from the
  // previous panel cannot expose another contact's file or error.
  return <WorkspaceExplorerPanel key={`${props.session.id}:${props.session.cwd}`} {...props} />;
}

function WorkspaceExplorerPanel({ session, close }: { session: Session; close: () => void }) {
  const [tab, setTab] = useState<'files' | 'git'>('files');
  const [trees, setTrees] = useState<Record<string, Tree>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [selectedPath, setSelectedPath] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
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
      for (const entry of trees[path]?.entries ?? []) {
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
  const diffLines = useMemo(() => diff?.diff.split('\n') ?? [], [diff]);
  const visibleErrors = Object.entries(errors).filter(([scope]) => scope === 'preview' || (tab === 'git' ? scope === 'git' : scope.startsWith('tree:')));

  return <aside className="workspace-explorer" aria-label="资源管理器">
    <header className="workspace-explorer-header"><div><strong>资源管理器</strong><small title={session.cwd}>{session.cwd}</small></div><button className="icon-button" aria-label="关闭资源管理器" title="关闭" onClick={close}><X size={16} /></button></header>
    <nav className="workspace-tabs" aria-label="资源管理器视图"><button className={tab === 'files' ? 'active' : ''} aria-pressed={tab === 'files'} onClick={() => selectTab('files')}><Folder size={14} />文件</button><button className={tab === 'git' ? 'active' : ''} aria-pressed={tab === 'git'} onClick={() => selectTab('git')}><FileDiff size={14} />Git diff</button><button className="icon-button" aria-label="刷新资源管理器" title="刷新" onClick={refresh}><RefreshCw size={14} /></button></nav>
    {visibleErrors.map(([scope, message]) => <div key={scope} className="workspace-error" role="alert">{message}</div>)}
    {loading && <div className="workspace-loading" role="status"><LoaderCircle size={14} className="spin" />读取中…</div>}
    {tab === 'files' ? <div className="workspace-tree">
      {!root && !pending.has('tree:') && <button className="workspace-empty" onClick={() => void loadTree('')}>读取工作区</button>}
      {root && !root.entries.length && <p className="workspace-note">此目录为空。</p>}
      {rows.map(({ entry, depth }) => <button key={entry.path} className={`workspace-entry ${selectedPath === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} onClick={() => toggle(entry)}>{entry.kind === 'directory' ? expanded.has(entry.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : markdownPath(entry.path) ? <FileCode2 size={14} /> : <File size={14} />}<span title={entry.path}>{entry.name}</span>{entry.kind === 'file' && <small>{formatSize(entry.size)}</small>}</button>)}
      {Object.entries(trees).filter(([path, tree]) => expanded.has(path) && tree.truncated).map(([path, tree]) => <p key={path} className="workspace-note">{path || '工作目录'}内容过多，仅显示前 {tree.entries.length} 项</p>)}
    </div> : <div className="workspace-git">{!git?.available && git && <p className="workspace-note">当前目录不是 Git 仓库，或 Git 不可用。</p>}{git?.entries.map(entry => <button key={`${entry.status}:${entry.path}`} className={`workspace-git-entry ${selectedPath === entry.path ? 'selected' : ''}`} onClick={() => openDiff(entry.path)}><code>{entry.status}</code><span title={entry.path}>{entry.path}</span></button>)}{git?.available && !git.entries.length && <p className="workspace-note">工作区没有未提交变更。</p>}</div>}
    {file && <section className="workspace-preview"><header><strong>{file.path}</strong><button className="icon-button" aria-label="关闭文件预览" onClick={clearPreview}><X size={14} /></button></header>{file.binary ? <p className="workspace-note">二进制文件不支持预览。</p> : markdownPath(file.path) ? <Markdown text={file.content} /> : <pre>{file.content}</pre>}{file.truncated && <p className="workspace-note">文件过大，预览已截断。</p>}</section>}
    {diff && <section className="workspace-preview workspace-diff"><header><strong>{diff.path}</strong><button className="icon-button" aria-label="关闭 diff 预览" onClick={clearPreview}><X size={14} /></button></header>{!diff.available ? <p className="workspace-note">Git diff 不可用。</p> : !diff.diff ? <p className="workspace-note">此文件没有可显示的文本差异。</p> : <pre>{diffLines.map((line, index) => <span key={index} className={diffLineClass(line)}>{line}{index < diffLines.length - 1 ? '\n' : ''}</span>)}</pre>}{diff.truncated && <p className="workspace-note">差异过大，预览已截断。</p>}</section>}
  </aside>;
}
