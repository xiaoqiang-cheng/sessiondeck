import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RemoteSettings, RemoteStatus, TunnelState } from '../shared/auth.ts';

export const DEFAULT_REMOTE: Omit<RemoteSettings, 'localPort'> = {
  enabled: false, publicUrl: '', sshHost: '', sshUser: '', sshPort: 22, identityFile: '', hasPassword: false, serverPort: 17_317,
};

/**
 * The SSH password is sealed with a key file kept next to the database (0600).
 * A copied database alone does not reveal it; neither does the settings API.
 */
export class SecretBox {
  constructor(private readonly key: Buffer) {}
  seal(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(part => part.toString('base64')).join('.');
  }
  open(sealed: string) {
    const [iv, tag, data] = sealed.split('.').map(part => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}
export const secretKey = (material: Buffer) => createHash('sha256').update(material).digest();

function fail(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
const port = (value: unknown, name: string) => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || (number as number) < 1 || (number as number) > 65535) fail(`${name}必须是 1–65535 的端口`);
  return number as number;
};
// ssh arguments are passed as an argv array (no shell), but a leading '-' would
// still be parsed as an option, and user@host must not smuggle another target.
const sshWord = (value: unknown, name: string, pattern: RegExp) => {
  if (typeof value !== 'string' || !pattern.test(value.trim())) fail(`${name}格式无效`);
  return value.trim();
};

/** Validates a settings patch from the owner's local settings page. */
export function normalizeRemote(input: Record<string, unknown>, current: RemoteSettings): RemoteSettings {
  const next = { ...current };
  if ('publicUrl' in input) {
    const raw = typeof input.publicUrl === 'string' ? input.publicUrl.trim().replace(/\/+$/, '') : '';
    if (raw) {
      let url: URL;
      try { url = new URL(raw); } catch { fail('公开地址需要是完整网址，例如 https://deck.example.com'); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('公开地址只支持 http 或 https');
      if (url.pathname !== '/' || url.search || url.hash || url.username) fail('公开地址只填写协议和域名，不要包含路径');
      next.publicUrl = url.origin;
    } else next.publicUrl = '';
  }
  if ('sshHost' in input) next.sshHost = input.sshHost === '' ? '' : sshWord(input.sshHost, '服务器地址', /^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/);
  if ('sshUser' in input) next.sshUser = input.sshUser === '' ? '' : sshWord(input.sshUser, 'SSH 用户', /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/);
  if ('identityFile' in input) {
    const file = typeof input.identityFile === 'string' ? input.identityFile.trim() : '';
    if (file && (file.startsWith('-') || file.length > 1024 || /[\x00\n]/.test(file))) fail('密钥路径无效');
    next.identityFile = file;
  }
  if ('sshPassword' in input && (typeof input.sshPassword !== 'string' || input.sshPassword.length > 256 || /[\x00\n\r]/.test(input.sshPassword))) fail('SSH 密码无效');
  if ('sshPort' in input) next.sshPort = port(input.sshPort, 'SSH 端口');
  if ('serverPort' in input) next.serverPort = port(input.serverPort, '服务器转发端口');
  if ('localPort' in input) next.localPort = port(input.localPort, '远程监听端口');
  if ('enabled' in input) next.enabled = input.enabled === true;
  if (next.enabled && (!next.publicUrl || !next.sshUser)) fail('请先填写公开地址和 SSH 用户');
  return next;
}

/** The SSH target defaults to the public domain; set sshHost only when they differ. */
export const sshTarget = (settings: RemoteSettings) => settings.sshHost || (settings.publicUrl ? new URL(settings.publicUrl).hostname : '');

export function caddyConfig(settings: RemoteSettings) {
  // A non-default port (443 already taken, for example) is kept in the site
  // address; Caddy then serves TLS there and obtains the certificate over :80.
  const host = settings.publicUrl ? new URL(settings.publicUrl).host : 'deck.example.com';
  // Live updates are a text/event-stream. A site-wide `encode` would gzip it
  // and hold events in the compressor, so the stream stays uncompressed and
  // the proxy flushes every chunk.
  return `# 追加到 /etc/caddy/Caddyfile（服务器上执行一次，Caddy 会自动申请证书）
# 不要给这个站点加整站的 encode：实时推送（text/event-stream）被压缩后会一直卡在缓冲里。
${host} {
\treverse_proxy 127.0.0.1:${settings.serverPort} {
\t\tflush_interval -1
\t}
}`;
}

/**
 * Owns one `ssh -N -R` reverse tunnel from the server's loopback to this
 * machine's authenticated remote listener. It reconnects with backoff and is
 * stopped with the service. BatchMode keeps ssh from ever prompting.
 */
export class Tunnel extends EventEmitter {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private settings: RemoteSettings | null = null;
  private state: TunnelState = 'off';
  private since: string | null = null;
  private error = '';
  private attempts = 0;
  private closed = false;
  private password: string | null = null;
  constructor(private readonly runtimeDir: string) { super(); }

  status(): RemoteStatus['tunnel'] { return { state: this.state, since: this.since, error: this.error, attempts: this.attempts }; }

  private set(state: TunnelState, error = this.error) {
    if (this.state !== state) this.since = new Date().toISOString();
    this.state = state; this.error = error;
    this.emit('change');
  }

  async configure(settings: RemoteSettings | null, password: string | null = null) {
    this.settings = settings?.enabled ? settings : null;
    this.password = password;
    this.attempts = 0;
    await this.kill();
    if (this.settings) this.connect(); else this.set('off', '');
  }

  private connect() {
    const settings = this.settings;
    if (!settings || this.closed) return;
    const identity = settings.identityFile.replace(/^~(?=\/|$)/, homedir());
    const password = this.password;
    // With a password, ssh asks SSH_ASKPASS instead of a terminal. The helper
    // reads it from this child's environment: never argv, never a shell string.
    const askpass = password ? this.askpassHelper() : null;
    const auth = password
      ? ['-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PreferredAuthentications=publickey,password,keyboard-interactive']
      : ['-o', 'BatchMode=yes'];
    const args = [
      '-N', '-T', ...auth, '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-p', String(settings.sshPort),
      ...(identity ? ['-i', identity, '-o', 'IdentitiesOnly=yes'] : []),
      // Bind only the server's loopback: the public side is Caddy's TLS, never ssh.
      '-R', `127.0.0.1:${settings.serverPort}:127.0.0.1:${settings.localPort}`,
      '--', `${settings.sshUser}@${sshTarget(settings)}`,
    ];
    this.set('connecting');
    let stderr = '';
    const env = askpass ? { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0', SESSIONDECK_SSH_PASSWORD: password! } : process.env;
    // detached gives ssh no controlling terminal, so it cannot prompt on ours.
    const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], env, detached: !!askpass });
    this.child = child;
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    // ssh has no "forward established" signal; ExitOnForwardFailure exits
    // within a few seconds if the bind fails, so staying up means connected.
    const ready = setTimeout(() => { if (this.child === child) { this.attempts = 0; this.set('connected', ''); } }, 4000);
    child.once('error', error => { stderr ||= error.message; });
    child.once('exit', code => {
      clearTimeout(ready);
      if (this.child !== child) return;
      this.child = null;
      if (this.closed || !this.settings) return;
      this.attempts++;
      const last = stderr.trim().split('\n').filter(line => !/^Warning: Permanently added/.test(line)).at(-1) || `ssh 已退出（${code ?? '信号'}）`;
      const message = /Permission denied/.test(last) ? `SSH 认证失败：${password ? '请检查密码' : '请配置密钥或填写 SSH 密码'}（${last}）` : last;
      this.set('error', message);
      const delay = Math.min(2000 * 2 ** Math.min(this.attempts - 1, 5), 60_000);
      this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
    });
  }

  private askpassHelper() {
    const file = join(this.runtimeDir, 'ssh-askpass.sh');
    writeFileSync(file, '#!/bin/sh\nprintf \'%s\\n\' "$SESSIONDECK_SSH_PASSWORD"\n', { mode: 0o700 });
    chmodSync(file, 0o700);
    return file;
  }

  private async kill() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(accept => child.once('exit', () => accept()));
    child.kill('SIGTERM');
    const hard = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited.finally(() => clearTimeout(hard));
  }

  async close() { this.closed = true; await this.kill(); }
}
