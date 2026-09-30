import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, CircleAlert, Copy, Globe, KeyRound, Link2, LoaderCircle, LogOut, MonitorSmartphone, Plug, ShieldCheck, Trash2, Unplug } from 'lucide-react';
import type { Session } from '../shared/types';
import type { AuthDevice, AuthStatus, RemoteSettings, RemoteStatus, Share, ShareMode } from '../shared/auth';
import { api } from './api';
import { copyToClipboard } from './clipboard';
import ModalShell from './Modal';

const when = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '永久';
const device = (agent: string) => /iPhone|iPad|Android/i.test(agent) ? '手机' : /Mac/i.test(agent) ? 'Mac' : /Windows/i.test(agent) ? 'Windows' : /Linux/i.test(agent) ? 'Linux' : '浏览器';
// A share covers the session directory. Warn when that is a whole home or root.
const broadDirectory = (cwd: string) => cwd === '/' || /^\/(?:Users|home)\/[^/]+\/?$/.test(cwd) || /^[A-Z]:\\?$/i.test(cwd);

export function ShareDialog({ session, close, notify }: { session: Session; close: () => void; notify: (message: string) => void }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [mode, setMode] = useState<ShareMode>('read');
  const [ttl, setTtl] = useState<string>('7');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ url: string; remoteReady: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api<Share[]>(`/sessions/${session.id}/shares`).then(setShares).catch(cause => setError(cause.message)), [session.id]);
  useEffect(() => { void load(); }, [load]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<{ share: Share; url: string; remoteReady: boolean }>(`/sessions/${session.id}/shares`, { mode, ttlDays: ttl === 'never' ? null : Number(ttl), label: label.trim() });
      setCreated(result); setLabel('');
      await copyToClipboard(result.url).then(() => notify('分享链接已复制')).catch(() => {});
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法创建分享'); }
    finally { setBusy(false); }
  };
  const revoke = async (share: Share) => {
    setBusy(true); setError('');
    try { await api(`/shares/${share.id}`, {}, 'DELETE'); notify('已撤销分享，相关设备立即断开'); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法撤销'); }
    finally { setBusy(false); }
  };
  return <ModalShell title="分享会话" subtitle={`把「${session.title}」分享给同事。对方打开链接、留下名字即可进入，只能访问这一个会话。`} close={close}>
    <form onSubmit={submit}><div className="modal-fields">
      <div className="segmented-control" role="group" aria-label="分享权限">
        <button type="button" aria-pressed={mode === 'read'} className={mode === 'read' ? 'selected' : ''} onClick={() => setMode('read')}>只读</button>
        <button type="button" aria-pressed={mode === 'write'} className={mode === 'write' ? 'selected' : ''} onClick={() => setMode('write')}>可协作</button>
      </div>
      <p className="form-note">{mode === 'read' ? '可以查看终端输出、对话记录、文件和改动，不能输入或操作。' : '和你一样操作这个会话：输入、处理审批、启动和停止。Agent 能在你的电脑上执行命令，只分享给完全信任的人。'}</p>
      {mode === 'write' && broadDirectory(session.cwd) && <p className="form-error"><CircleAlert size={14} />工作目录是 {session.cwd}，范围过大。建议先把会话放到具体项目目录再分享。</p>}
      <div className="share-form-row">
        <label className="form-label">有效期<select value={ttl} onChange={event => setTtl(event.target.value)}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="never">永久</option></select></label>
        <label className="form-label">备注（可选）<input maxLength={80} placeholder="例如：给前端同事" value={label} onChange={event => setLabel(event.target.value)} /></label>
      </div>
      {created && <div className="share-created"><Link2 size={14} /><code title={created.url}>{created.url}</code><button type="button" className="icon-button" aria-label="复制分享链接" onClick={() => void copyToClipboard(created.url).then(() => notify('分享链接已复制'))}><Copy size={14} /></button></div>}
      {created && !created.remoteReady && <p className="form-note"><CircleAlert size={14} />远程访问尚未启用，这个链接只能在本机打开。请在「连接与能力 → 远程访问」配置域名。</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <h3 className="share-list-title">已有分享</h3>
      {shares === null ? <LoaderCircle size={16} className="spin" /> : !shares.length ? <p className="form-note">还没有有效的分享链接。</p> : <ul className="share-list">{shares.map(share => <li key={share.id}>
        <div><strong>{share.mode === 'write' ? '可协作' : '只读'}{share.label && ` · ${share.label}`}</strong><small>创建于 {when(share.createdAt)} · 到期 {when(share.expiresAt)}</small>
          <small>{share.devices.length ? share.devices.map(item => `${item.name}（${device(item.userAgent)}，${when(item.lastSeenAt)}）`).join('、') : '尚未有人打开'}</small></div>
        <button type="button" className="button secondary small-button" disabled={busy} onClick={() => void revoke(share)}><Trash2 size={13} />撤销</button>
      </li>)}</ul>}
    </div>
    <div className="modal-footer"><button type="button" className="button secondary" onClick={close}>完成</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Link2 size={15} />}生成并复制链接</button></div></form>
  </ModalShell>;
}

const tunnelLabel: Record<RemoteStatus['tunnel']['state'], string> = { off: '未启用', connecting: '正在连接', connected: '已连接', error: '连接失败，正在重试' };

/** Owner security: password, remote access through the owner's own server, devices. */
export function SecuritySettings({ auth, notify }: { auth: Extract<AuthStatus, { kind: 'owner' }>; notify: (message: string) => void }) {
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [draft, setDraft] = useState<RemoteSettings | null>(null);
  const [sshPassword, setSshPassword] = useState('');
  const [devices, setDevices] = useState<AuthDevice[]>([]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordSet, setPasswordSet] = useState(auth.passwordSet);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const local = !auth.remote;
  const load = useCallback(async () => {
    const [status, list] = await Promise.all([api<RemoteStatus>('/remote'), api<AuthDevice[]>('/auth/devices')]);
    setRemote(status); setDevices(list); setDraft(current => current ?? status.settings);
  }, []);
  useEffect(() => {
    void load().catch(cause => setError(cause.message));
    const timer = window.setInterval(() => { void api<RemoteStatus>('/remote').then(setRemote).catch(() => {}); }, 4000);
    return () => window.clearInterval(timer);
  }, [load]);
  const run = async (key: string, operation: () => Promise<unknown>, success: string) => {
    setBusy(key); setError('');
    try { await operation(); notify(success); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(''); }
  };
  const savePassword = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) { setError('两次输入的密码不一致'); return; }
    void run('password', async () => { await api('/auth/password', { password }); setPassword(''); setConfirm(''); setPasswordSet(true); await load(); }, '密码已保存，其他远程登录已退出');
  };
  const saveRemote = (enabled: boolean) => draft && run('remote', async () => {
    const { hasPassword: _saved, ...settings } = draft;
    const status = await api<RemoteStatus>('/remote', { ...settings, enabled, ...(sshPassword ? { sshPassword } : {}) });
    setRemote(status); setDraft(status.settings); setSshPassword('');
  }, enabled ? '已保存并连接远程访问' : '已停用远程访问');
  const field = (key: keyof RemoteSettings, label: string, placeholder = '', type = 'text') => <label className="form-label">{label}<input disabled={!local} type={type} placeholder={placeholder} value={String(draft?.[key] ?? '')} onChange={event => setDraft(current => current && { ...current, [key]: type === 'number' ? Number(event.target.value) : event.target.value })} /></label>;
  const tunnel = remote?.tunnel;
  return <section className="backend-setting-card security-settings" aria-label="远程访问与安全">
    <div className="backend-setting-title"><ShieldCheck size={20} /><div><h2>远程访问与安全</h2><p>{local ? '本机访问无需密码；远程地址需要登录或分享链接。' : '你正在通过远程地址访问。密码和远程配置只能在运行 SessionDeck 的电脑上修改。'}</p></div></div>
    {error && <p role="alert" className="form-error">{error}</p>}

    <h3>所有者密码</h3>
    {local ? <form className="security-password" onSubmit={savePassword}>
      <input type="password" aria-label="新密码" autoComplete="new-password" placeholder={passwordSet ? '输入新密码以更换' : '设置密码（至少 10 个字符）'} value={password} onChange={event => setPassword(event.target.value)} minLength={10} required />
      <input type="password" aria-label="确认密码" autoComplete="new-password" placeholder="再次输入" value={confirm} onChange={event => setConfirm(event.target.value)} required />
      <button className="button secondary small-button" disabled={!!busy || !password}>{busy === 'password' ? <LoaderCircle size={13} className="spin" /> : <KeyRound size={13} />}{passwordSet ? '更换密码' : '设置密码'}</button>
    </form> : <p className="form-note">{passwordSet ? '已设置。' : '未设置。'}</p>}

    <h3>远程访问</h3>
    <p className="form-note">SessionDeck 从这台电脑通过 SSH 连到你的服务器，服务器上的 Caddy 用你的域名提供 HTTPS。电脑不需要公网 IP。</p>
    <div className="security-grid">
      {field('publicUrl', '公开地址', 'https://deck.example.com')}
      {field('sshHost', '服务器地址', '203.0.113.10 或 ssh 别名')}
      {field('sshUser', 'SSH 用户', 'deploy')}
      {field('sshPort', 'SSH 端口', '22', 'number')}
      <label className="form-label">SSH 密码（可选）<input disabled={!local} type="password" autoComplete="new-password" placeholder={draft?.hasPassword ? '已保存，输入新密码以更换' : '使用密钥时留空'} value={sshPassword} onChange={event => setSshPassword(event.target.value)} /></label>
      {field('identityFile', 'SSH 密钥（可选）', '~/.ssh/id_ed25519')}
      {field('serverPort', '服务器转发端口', '17317', 'number')}
    </div>
    <div className="security-status">
      <span className={`status-badge ${tunnel?.state === 'connected' ? 'running' : tunnel?.state === 'error' ? 'error' : 'idle'}`}><i />{tunnel ? tunnelLabel[tunnel.state] : '读取中'}</span>
      {tunnel?.error && <small title={tunnel.error}>{tunnel.error}</small>}
      {local && <div>{remote?.settings.enabled ? <><button className="button secondary small-button" disabled={!!busy} onClick={() => void saveRemote(true)}><Plug size={13} />保存并重连</button><button className="button secondary small-button" disabled={!!busy} onClick={() => void saveRemote(false)}><Unplug size={13} />停用</button></> : <button className="button primary small-button" disabled={!!busy || !passwordSet} title={passwordSet ? undefined : '请先设置所有者密码'} onClick={() => void saveRemote(true)}>{busy === 'remote' ? <LoaderCircle size={13} className="spin" /> : <Globe size={13} />}启用远程访问</button>}</div>}
    </div>
    {local && !passwordSet && <p className="form-note"><CircleAlert size={14} />启用远程访问前请先设置所有者密码。</p>}
    <details className="security-caddy"><summary>服务器配置（一次性）</summary>
      <ol><li>确认服务器已安装 Caddy，并把域名解析到服务器 IP。</li><li>把下面的配置写入 <code>/etc/caddy/Caddyfile</code>，然后执行 <code>sudo systemctl reload caddy</code>。</li><li>确认这台电脑能 SSH 登录服务器（<code>ssh {draft?.sshUser || 'user'}@{draft?.sshHost || 'server'}</code>）：配置密钥，或在上面填写 SSH 密码。</li></ol>
      <pre>{remote?.caddy}</pre>
      <button className="text-button" onClick={() => remote && void copyToClipboard(remote.caddy).then(() => notify('已复制 Caddy 配置'))}><Copy size={13} />复制配置</button>
    </details>

    <h3>已登录的远程设备</h3>
    {!devices.length ? <p className="form-note">还没有远程登录的设备。</p> : <ul className="share-list">{devices.map(item => <li key={item.id}><div><strong><MonitorSmartphone size={13} />{device(item.userAgent)}</strong><small>最近使用 {when(item.lastSeenAt)} · 到期 {when(item.expiresAt)}</small></div>
      <button className="button secondary small-button" disabled={!!busy} onClick={() => void run(`device:${item.id}`, async () => { await api(`/auth/devices/${item.id}`, {}, 'DELETE'); await load(); }, '已退出该设备')}><Trash2 size={13} />退出</button></li>)}</ul>}
    {auth.remote && <button className="button secondary small-button" onClick={() => void api('/auth/logout', {}).finally(() => location.reload())}><LogOut size={13} />退出当前设备</button>}
    {passwordSet && <p className="form-note"><Check size={14} />更换密码会让所有远程登录的设备退出；分享链接不受影响，可在各会话的分享中单独撤销。</p>}
  </section>;
}
