import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Layers3, LoaderCircle, UserRound } from 'lucide-react';
import type { AuthStatus } from '../shared/auth';
import { api, getToken } from './api';
import App from './App';

const ShareApp = lazy(() => import('./ShareApp'));
const SHARE_HASH = /^#\/share\/([A-Za-z0-9_-]{20,128})$/;

/** Decides what this browser may see: owner workbench, one shared session, or a gate. */
export default function AuthGate() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState('');
  const [shareToken] = useState(() => SHARE_HASH.exec(location.hash)?.[1] ?? null);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/status');
      if (!response.ok) throw new Error(`无法连接 SessionDeck（${response.status}）`);
      setStatus(await response.json() as AuthStatus); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法连接 SessionDeck'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const expired = () => void load();
    window.addEventListener('sessiondeck:auth-required', expired);
    return () => window.removeEventListener('sessiondeck:auth-required', expired);
  }, [load]);
  const accept = (next: AuthStatus) => {
    // Clear the one-time link from the address bar and history before continuing.
    if (SHARE_HASH.test(location.hash)) history.replaceState(history.state, '', `${location.pathname}${location.search}#/`);
    void getToken(true).catch(() => {});
    setStatus(next);
  };

  if (error && !status) return <div className="auth-page"><div className="auth-card"><p className="form-error">{error}</p><button className="button secondary" onClick={() => void load()}>重试</button></div></div>;
  if (!status) return <div className="auth-page"><LoaderCircle className="spin" size={22} /></div>;
  if (shareToken && status.kind !== 'share') return <RedeemPage token={shareToken} done={accept} />;
  if (status.kind === 'anonymous') return <LoginPage passwordSet={status.passwordSet} done={accept} />;
  if (status.kind === 'share') return <Suspense fallback={<div className="auth-page"><LoaderCircle className="spin" size={22} /></div>}><ShareApp status={status} /></Suspense>;
  return <App auth={status} />;
}

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <div className="auth-page"><main className="auth-card">
    <span className="brand-mark auth-mark"><Layers3 size={18} /></span>
    <h1>{title}</h1><p className="auth-subtitle">{subtitle}</p>
    {children}
  </main></div>;
}

function LoginPage({ passwordSet, done }: { passwordSet: boolean; done: (status: AuthStatus) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { done(await api<AuthStatus>('/auth/login', { password })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败'); setPassword(''); }
    finally { setBusy(false); }
  };
  return <AuthCard title="登录 SessionDeck" subtitle="这是远程访问地址，请输入所有者密码。">
    {!passwordSet ? <p className="form-note">尚未设置密码。请在运行 SessionDeck 的电脑上打开「连接与能力 → 远程访问与安全」设置密码。</p> : <form className="auth-form" onSubmit={submit}>
      <label className="form-label">所有者密码<input type="password" autoComplete="current-password" autoFocus value={password} onChange={event => setPassword(event.target.value)} required /></label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <button className="button primary" disabled={busy || !password}>{busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}登录</button>
    </form>}
  </AuthCard>;
}

function RedeemPage({ token, done }: { token: string; done: (status: AuthStatus) => void }) {
  const [name, setName] = useState(() => { try { return localStorage.getItem('sessiondeck.share-name') ?? ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const status = await api<AuthStatus>('/auth/redeem', { token, name: name.trim() });
      try { localStorage.setItem('sessiondeck.share-name', name.trim()); } catch { /* Optional convenience. */ }
      done(status);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法打开分享'); }
    finally { setBusy(false); }
  };
  return <AuthCard title="打开共享会话" subtitle="留下你的名字，你在会话中的操作会以这个名字记录。">
    <form className="auth-form" onSubmit={submit}>
      <label className="form-label">你的名字<input autoComplete="name" autoFocus maxLength={40} placeholder="例如：张三" value={name} onChange={event => setName(event.target.value)} required /></label>
      {error && <p role="alert" className="form-error">{error}</p>}
      <button className="button primary" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <UserRound size={15} />}进入会话</button>
    </form>
  </AuthCard>;
}
