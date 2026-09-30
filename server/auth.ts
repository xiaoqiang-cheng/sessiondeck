import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthDevice, Share, ShareMode } from '../shared/auth.ts';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const OWNER_DEVICE_TTL = 30 * 24 * 3600_000;
const now = () => new Date().toISOString();
// Bearer secrets never touch SQLite in plain text. A database copy or backup
// alone cannot be replayed as an owner login or share link.
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

/** Who a remote request acts as. Local loopback requests are always the owner. */
export type Principal =
  | { kind: 'owner'; local: true }
  | { kind: 'owner'; local: false; deviceId: string }
  | { kind: 'share'; deviceId: string; shareId: string; sessionId: string; mode: ShareMode; name: string };

type DeviceRow = AuthDevice & { tokenHash: string };
type ShareRow = Omit<Share, 'devices'> & { tokenHash: string };

export class AuthStore {
  private failures = new Map<string, { count: number; until: number }>();
  constructor(private readonly db: DatabaseSync, private readonly csrfKey: string) {
    for (const table of ['auth_settings', 'auth_devices', 'auth_shares']) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    this.pruneExpired();
  }

  private read<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }
  private all<T>(table: string): T[] {
    return this.db.prepare(`SELECT data FROM ${table}`).all().map(row => JSON.parse(String(row.data)) as T);
  }
  private write(table: string, id: string, data: unknown) {
    this.db.prepare(`INSERT INTO ${table} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(data));
  }
  private remove(table: string, id: string) { this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id); }

  setting<T>(key: string): T | undefined { return this.read<{ value: T }>('auth_settings', key)?.value; }
  setSetting(key: string, value: unknown) { this.write('auth_settings', key, { value }); }

  hasPassword() { return !!this.setting<{ hash: string }>('owner-password'); }
  async setPassword(password: string) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 256) throw Object.assign(new Error('密码需要 10–256 个字符'), { status: 400 });
    const salt = randomBytes(16);
    const hash = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT);
    this.setSetting('owner-password', { salt: salt.toString('base64'), hash: hash.toString('base64'), updatedAt: now() });
    // A new password signs out every remote owner device, including a stolen one.
    for (const device of this.all<DeviceRow>('auth_devices')) if (device.kind === 'owner') this.remove('auth_devices', device.id);
  }

  /** Throttles per client address and globally; guessing stays slow even across many IPs. */
  async login(password: unknown, client: string, userAgent: string) {
    const blocked = [client, '*'].map(key => this.failures.get(key)).find(entry => entry && entry.until > Date.now());
    if (blocked) throw Object.assign(new Error(`尝试次数过多，请 ${Math.ceil((blocked.until - Date.now()) / 1000)} 秒后再试`), { status: 429 });
    const saved = this.setting<{ salt: string; hash: string }>('owner-password');
    if (!saved) throw Object.assign(new Error('尚未设置所有者密码，请在本机打开 SessionDeck 设置'), { status: 409 });
    const actual = await scrypt(typeof password === 'string' ? password.normalize('NFKC') : '', Buffer.from(saved.salt, 'base64'), 64, SCRYPT);
    const expected = Buffer.from(saved.hash, 'base64');
    if (typeof password !== 'string' || !timingSafeEqual(actual, expected)) {
      for (const key of [client, '*']) {
        const previous = this.failures.get(key);
        const count = (previous?.count ?? 0) + 1;
        const threshold = key === '*' ? 20 : 5;
        this.failures.set(key, { count, until: count >= threshold ? Date.now() + Math.min(2 ** (count - threshold) * 30_000, 3600_000) : 0 });
      }
      if (this.failures.size > 5000) this.failures.clear();
      throw Object.assign(new Error('密码不正确'), { status: 401 });
    }
    this.failures.delete(client);
    return this.createDevice({ kind: 'owner', name: '所有者', userAgent, expiresAt: new Date(Date.now() + OWNER_DEVICE_TTL).toISOString() });
  }

  private createDevice(fields: Omit<AuthDevice, 'id' | 'createdAt' | 'lastSeenAt'>) {
    const token = secret();
    const device: DeviceRow = { ...fields, id: digest(token).slice(0, 24), tokenHash: digest(token), createdAt: now(), lastSeenAt: now() };
    this.write('auth_devices', device.id, device);
    return { token, device: this.publicDevice(device) };
  }
  private publicDevice({ tokenHash: _hash, ...device }: DeviceRow): AuthDevice { return device; }

  /** Resolves a device cookie. Revoked shares and expired devices stop working immediately. */
  principal(token: unknown): Principal | null {
    if (typeof token !== 'string' || token.length > 128) return null;
    const hash = digest(token);
    const device = this.read<DeviceRow>('auth_devices', hash.slice(0, 24));
    if (!device || device.tokenHash !== hash) return null;
    if (device.expiresAt && Date.parse(device.expiresAt) <= Date.now()) { this.remove('auth_devices', device.id); return null; }
    if (Date.now() - Date.parse(device.lastSeenAt) > 60_000) this.write('auth_devices', device.id, { ...device, lastSeenAt: now() });
    if (device.kind === 'owner') return { kind: 'owner', local: false, deviceId: device.id };
    const share = device.shareId ? this.liveShare(device.shareId) : undefined;
    if (!share) { this.remove('auth_devices', device.id); return null; }
    return { kind: 'share', deviceId: device.id, shareId: share.id, sessionId: share.sessionId, mode: share.mode, name: device.name };
  }

  /** CSRF tokens are bound to the device, so a share's token is useless elsewhere. */
  csrf(principal: Principal) {
    return principal.kind === 'owner' && principal.local ? this.csrfKey : createHmac('sha256', this.csrfKey).update(principal.deviceId).digest('hex');
  }

  logout(principal: Principal) { if (!(principal.kind === 'owner' && principal.local)) this.remove('auth_devices', principal.deviceId); }

  private liveShare(id: string) {
    const share = this.read<ShareRow>('auth_shares', id);
    if (!share || share.revokedAt || (share.expiresAt && Date.parse(share.expiresAt) <= Date.now())) return undefined;
    return share;
  }

  createShare(sessionId: string, mode: ShareMode, ttlDays: number | null, label: string) {
    const token = secret();
    const share: ShareRow = {
      id: digest(token).slice(0, 24), tokenHash: digest(token), sessionId, mode, label,
      createdAt: now(), expiresAt: ttlDays ? new Date(Date.now() + ttlDays * 24 * 3600_000).toISOString() : null, revokedAt: null,
    };
    this.write('auth_shares', share.id, share);
    return { token, share: this.publicShare(share) };
  }
  private publicShare({ tokenHash: _hash, ...share }: ShareRow): Share {
    const devices = this.all<DeviceRow>('auth_devices').filter(device => device.shareId === share.id).map(device => this.publicDevice(device));
    return { ...share, devices };
  }

  /** A link holder names themselves once; the browser then keeps a device cookie. */
  redeemShare(token: unknown, name: unknown, userAgent: string) {
    if (typeof token !== 'string' || token.length > 128) throw Object.assign(new Error('分享链接无效'), { status: 404 });
    const hash = digest(token);
    const share = this.liveShare(hash.slice(0, 24));
    if (!share || share.tokenHash !== hash) throw Object.assign(new Error('分享链接无效、已过期或已被撤销'), { status: 404 });
    const display = typeof name === 'string' ? name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40) : '';
    if (!display) throw Object.assign(new Error('请填写你的名字'), { status: 400 });
    return this.createDevice({ kind: 'share', shareId: share.id, name: display, userAgent, expiresAt: share.expiresAt });
  }

  shares(sessionId?: string) {
    return this.all<ShareRow>('auth_shares').filter(share => !share.revokedAt && (!sessionId || share.sessionId === sessionId)
      && !(share.expiresAt && Date.parse(share.expiresAt) <= Date.now())).map(share => this.publicShare(share))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  revokeShare(id: string) {
    const share = this.read<ShareRow>('auth_shares', id);
    if (!share) throw Object.assign(new Error('分享不存在'), { status: 404 });
    this.write('auth_shares', id, { ...share, revokedAt: now() });
    for (const device of this.all<DeviceRow>('auth_devices')) if (device.shareId === id) this.remove('auth_devices', device.id);
  }
  revokeSessionShares(sessionId: string) {
    for (const share of this.all<ShareRow>('auth_shares')) if (share.sessionId === sessionId && !share.revokedAt) this.revokeShare(share.id);
  }
  ownerDevices() {
    return this.all<DeviceRow>('auth_devices').filter(device => device.kind === 'owner').map(device => this.publicDevice(device))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }
  revokeDevice(id: string) {
    if (!this.read('auth_devices', id)) throw Object.assign(new Error('设备不存在'), { status: 404 });
    this.remove('auth_devices', id);
  }

  private pruneExpired() {
    for (const device of this.all<DeviceRow>('auth_devices')) if (device.expiresAt && Date.parse(device.expiresAt) <= Date.now()) this.remove('auth_devices', device.id);
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    for (const share of this.all<ShareRow>('auth_shares')) {
      const ended = share.revokedAt ? Date.parse(share.revokedAt) : share.expiresAt ? Date.parse(share.expiresAt) : Infinity;
      if (ended < cutoff) this.remove('auth_shares', share.id);
    }
  }
}
