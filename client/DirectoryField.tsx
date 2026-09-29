import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ChevronRight, Folder, FolderOpen, Home, Link2, LoaderCircle, Search, X } from 'lucide-react';
import type { DirectoryListing } from '../server/directories';
import { api } from './api';
import { useDialog } from './ui';
import './directory-picker.css';

interface DirectoryFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  help?: ReactNode;
  placeholder?: string;
  list?: string;
  required?: boolean;
}

export default function DirectoryField({ label, value, onChange, disabled, help, placeholder = '/path/to/project 或 file:// 目录链接', list, required = true }: DirectoryFieldProps) {
  const id = useId();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return <div ref={fieldRef} className="form-label directory-field">
    <label htmlFor={id}>{label}</label>
    <div className="directory-field-row"><div className="input-with-icon"><Folder size={16} /><input id={id} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} disabled={disabled} required={required} list={list} autoComplete="off" /></div>
      <button type="button" className="button secondary directory-browse-button" onClick={() => setOpen(true)} disabled={disabled} aria-label={`浏览${label}`} aria-haspopup="dialog"><FolderOpen size={16} />浏览</button>
    </div>
    {help && <small>{help}</small>}
    {open && <DirectoryDialog initialPath={value} parent={fieldRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null} close={() => setOpen(false)} choose={path => { onChange(path); setOpen(false); }} />}
  </div>;
}

function DirectoryDialog({ initialPath, parent, close, choose }: { initialPath: string; parent: HTMLElement | null; close: () => void; choose: (path: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const pathEditRef = useRef(0);
  const browsingPath = useRef(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  // This picker is portaled above an existing form dialog. Inert keeps its
  // focus trap and Escape handler asleep until the picker closes.
  useLayoutEffect(() => {
    if (!parent) return;
    const previous = parent.inert;
    parent.inert = true;
    return () => { parent.inert = previous; };
  }, [parent]);
  useDialog(ref, true, close);
  const load = useCallback(async (path: string) => {
    const request = ++requestRef.current;
    const pathEdit = pathEditRef.current;
    setLoading(true); setError('');
    try {
      const result = await api<DirectoryListing>('/directories/list', { path: path || undefined, showHidden });
      if (request !== requestRef.current) return null;
      browsingPath.current = result.path;
      setListing(result); setQuery('');
      // A slower LAN response must not replace a path the user has just pasted.
      if (pathEdit === pathEditRef.current) setPathInput(result.path);
      return result;
    } catch (cause) {
      if (request === requestRef.current) setError(cause instanceof Error ? cause.message : '无法读取目录');
      return null;
    } finally { if (request === requestRef.current) setLoading(false); }
  }, [showHidden]);
  useEffect(() => {
    void load(browsingPath.current);
    return () => { requestRef.current++; };
  }, [load]);
  const select = async () => {
    if (listing && listing.path === pathInput && !error) { choose(listing.path); return; }
    const result = await load(pathInput);
    if (result) choose(result.path);
  };
  const entries = listing?.entries.filter(entry => entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return createPortal(<div className="modal-overlay directory-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={ref} className="modal directory-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
      <div className="modal-heading"><div><h2 id={`${id}-title`}>选择工作目录</h2><p id={`${id}-description`}>浏览运行 Agent 的电脑上的目录，也可以粘贴目录路径或 file:// 链接。</p></div><button type="button" className="icon-button" aria-label="关闭目录选择器" onClick={close}><X size={20} /></button></div>
      <div className="directory-dialog-content">
        <div className="directory-location"><label htmlFor={`${id}-path`} className="sr-only">目录路径</label><div className="input-with-icon"><Folder size={16} /><input id={`${id}-path`} value={pathInput} onChange={event => { pathEditRef.current++; setPathInput(event.target.value); }} placeholder="输入路径或 file:// 链接" autoComplete="off" onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void load(pathInput); } }} /></div><button type="button" className="button secondary" onClick={() => void load(pathInput)} disabled={loading}>前往</button></div>
        <div className="directory-toolbar"><button type="button" className="button secondary small-button" onClick={() => void load(listing!.parentPath!)} disabled={loading || !listing?.parentPath}><ArrowUp size={15} />上一级</button><button type="button" className="button secondary small-button" onClick={() => void load(listing?.homePath ?? '~')} disabled={loading}><Home size={15} />主目录</button><label className="directory-hidden"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />显示隐藏目录</label></div>
        <label className="search-field directory-search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="筛选当前目录中的文件夹…" aria-label="筛选文件夹" /></label>
        {error && <p className="form-error directory-error" role="alert">{error}</p>}
        <div className="directory-list" aria-busy={loading} aria-label="子目录">
          {loading ? <div className="directory-empty" role="status"><LoaderCircle size={23} className="spin" /><p>正在读取目录…</p></div> : entries.length ? entries.map(entry => <button type="button" key={entry.path} className="directory-entry" onClick={() => void load(entry.path)} title={entry.path}><Folder size={19} /><span>{entry.name}</span>{entry.symlink && <Link2 size={14} aria-label="目录链接" />}<ChevronRight size={16} /></button>) : <div className="directory-empty"><FolderOpen size={28} /><p>{error ? '请检查路径或选择其他目录' : query ? '没有匹配的子目录' : '此目录下没有可见的子目录'}</p>{listing && !query && !error && <small>可以直接选择当前目录。</small>}</div>}
        </div>
        {listing?.truncated && !loading && <p className="directory-note">目录较多，仅显示部分结果。可以在上方粘贴完整路径前往目标目录。</p>}
        {listing && <p className="directory-current"><span>当前目录</span><code title={listing.path}>{listing.path}</code>{listing.canonicalPath !== listing.path && <small title={listing.canonicalPath}>链接目标：{listing.canonicalPath}</small>}</p>}
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={close}>取消</button><button type="button" className="button primary" disabled={loading || !pathInput.trim()} onClick={() => void select()}><FolderOpen size={16} />选择此目录</button></div>
    </div>
  </div>, document.body);
}
