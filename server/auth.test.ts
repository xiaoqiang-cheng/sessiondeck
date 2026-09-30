import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { authorize, matchRoute } from './access.ts';
import { AuthStore } from './auth.ts';
import { allowedRemoteRequest } from './security.ts';
import { normalizeRemote, DEFAULT_REMOTE, sshTarget } from './remote.ts';
import type { AppState, Session } from '../shared/types.ts';
import type { AuthStatus, Share } from '../shared/auth.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('every registered API route has an explicit access rule', () => {
  const sources = ['server/index.ts', 'server/chat-api.ts'].map(file => readFileSync(join(root, file), 'utf8')).join('\n');
  const routes = [...sources.matchAll(/app\.(get|post|patch|delete)\('(\/api\/[^']+)'/g)].map(match => ({ method: match[1].toUpperCase(), path: match[2] }));
  assert.ok(routes.length > 40, 'route scan found the API');
  for (const route of routes) {
    const concrete = route.path.replace(/:([a-zA-Z]+)/g, 'x1');
    assert.ok(matchRoute(route.method, concrete), `${route.method} ${route.path} is missing from server/access.ts`);
  }
});

test('shares are scoped to one session and owner-only routes stay closed', () => {
  const read = { kind: 'share', deviceId: 'd', shareId: 's', sessionId: 'mine', mode: 'read', name: 'A' } as const;
  const write = { ...read, mode: 'write' } as const;
  assert.equal(authorize(null, true, 'GET', '/api/state').allowed, false);
  assert.equal(authorize(null, true, 'POST', '/api/auth/login').allowed, true);
  assert.equal(authorize(read, true, 'GET', '/api/sessions/mine/workspace/git/diff').allowed, true);
  assert.equal(authorize(read, true, 'GET', '/api/sessions/other/workspace/file').allowed, false);
  assert.equal(authorize(read, true, 'POST', '/api/sessions/mine/start').allowed, false);
  assert.equal(authorize(write, true, 'POST', '/api/sessions/mine/start').allowed, true);
  assert.equal(authorize(write, true, 'POST', '/api/sessions/other/start').allowed, false);
  for (const [method, path] of [['GET', '/api/shells'], ['POST', '/api/directories/list'], ['POST', '/api/sessions'], ['PATCH', '/api/sessions/mine'], ['POST', '/api/sessions/mine/shares'], ['GET', '/api/groups/g']]) {
    assert.equal(authorize(write, true, method, path).allowed, false, `${method} ${path}`);
  }
  // Local-only routes refuse even a logged-in remote owner.
  assert.equal(authorize({ kind: 'owner', local: false, deviceId: 'o' }, true, 'POST', '/api/native-event/x').allowed, false);
  assert.equal(authorize({ kind: 'owner', local: false, deviceId: 'o' }, true, 'POST', '/api/auth/password').allowed, false);
  assert.equal(authorize({ kind: 'owner', local: true }, false, 'POST', '/api/native-event/x').allowed, true);
  assert.equal(authorize({ kind: 'owner', local: true }, false, 'GET', '/api/unknown').allowed, false);
});

test('remote requests need the configured host and a same-origin mutation', () => {
  const publicUrl = 'https://deck.example.com';
  assert.equal(allowedRemoteRequest({ headers: { host: 'deck.example.com', origin: publicUrl }, method: 'POST' }, publicUrl, 4318), true);
  assert.equal(allowedRemoteRequest({ headers: { host: 'deck.example.com' }, method: 'POST' }, publicUrl, 4318), false);
  assert.equal(allowedRemoteRequest({ headers: { host: 'deck.example.com', origin: 'https://evil.example' }, method: 'GET' }, publicUrl, 4318), false);
  assert.equal(allowedRemoteRequest({ headers: { host: 'evil.example' }, method: 'GET' }, publicUrl, 4318), false);
  assert.throws(() => normalizeRemote({ sshHost: '-oProxyCommand=x' }, { ...DEFAULT_REMOTE, localPort: 4318 }), /格式无效/);
  assert.throws(() => normalizeRemote({ publicUrl: 'https://a.example/path' }, { ...DEFAULT_REMOTE, localPort: 4318 }), /不要包含路径/);
  assert.throws(() => normalizeRemote({ enabled: true }, { ...DEFAULT_REMOTE, localPort: 4318 }), /请先填写/);
  // The SSH target defaults to the public domain (port stripped).
  const inferred = normalizeRemote({ enabled: true, publicUrl: 'https://deck.example.com:8443', sshUser: 'ubuntu' }, { ...DEFAULT_REMOTE, localPort: 4318 });
  assert.equal(sshTarget(inferred), 'deck.example.com');
  assert.equal(sshTarget({ ...inferred, sshHost: 'bastion.example.com' }), 'bastion.example.com');
});

test('auth store hashes secrets, throttles guesses and revokes share devices', async () => {
  const db = new DatabaseSync(':memory:');
  const auth = new AuthStore(db, 'k'.repeat(64));
  await auth.setPassword('correct horse battery');
  await assert.rejects(auth.login('wrong', '1.1.1.1', 'ua'), /密码不正确/);
  const { token } = await auth.login('correct horse battery', '1.1.1.1', 'ua');
  assert.equal(auth.principal(token)?.kind, 'owner');
  const dump = db.prepare('SELECT data FROM auth_devices UNION ALL SELECT data FROM auth_settings').all().map(row => String(row.data)).join('\n');
  assert.ok(!dump.includes(token) && !dump.includes('correct horse'), 'no plaintext secret is stored');
  for (let index = 0; index < 5; index++) await auth.login('nope', '2.2.2.2', 'ua').catch(() => {});
  await assert.rejects(auth.login('correct horse battery', '2.2.2.2', 'ua'), /尝试次数过多/);
  const { token: link, share } = auth.createShare('session-1', 'write', 1, '');
  const device = auth.redeemShare(link, '  张三  ', 'ua');
  assert.deepEqual(auth.principal(device.token), { kind: 'share', deviceId: device.device.id, shareId: share.id, sessionId: 'session-1', mode: 'write', name: '张三' });
  assert.notEqual(auth.csrf(auth.principal(device.token)!), auth.csrf({ kind: 'owner', local: true }));
  auth.revokeShare(share.id);
  assert.equal(auth.principal(device.token), null);
  assert.throws(() => auth.redeemShare(link, '李四', 'ua'), /已被撤销/);
  await auth.setPassword('another long password');
  assert.equal(auth.principal(token), null, 'a new password signs out remote owners');
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((accept, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', accept); });
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(accept => probe.close(() => accept()));
  return address.port;
}
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error(message);
}
async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  child.kill('SIGTERM');
  const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(hard); }
}

/** Minimal browser-like client: one cookie jar, same-origin headers, CSRF token. */
function client(base: string) {
  let cookie = '';
  let csrf = '';
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const response = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), origin: base, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-sessiondeck-token': csrf } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return {
    call,
    get cookie() { return cookie; },
    get csrf() { return csrf; },
    async refreshCsrf() { const result = await call('/api/config'); csrf = result.json?.csrfToken ?? ''; return result.status; },
  };
}

test('remote listener requires login, shares see one session and read-only terminals drop input', { timeout: 60_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sessiondeck-auth-test-'));
  const port = await freePort();
  const remotePort = await freePort();
  const local = `http://127.0.0.1:${port}`;
  const remote = `http://127.0.0.1:${remotePort}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: { ...process.env, SESSIONDECK_PORT: String(port), PORT: String(port), SESSIONDECK_REMOTE_PORT: String(remotePort), SESSIONDECK_DEMO: '1', SESSIONDECK_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  child.stderr?.on('data', chunk => { logs = (logs + chunk).slice(-8000); });
  const sockets: WebSocket[] = [];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await stopProcess(child); rmSync(directory, { recursive: true, force: true }); });
  await until(async () => { try { return (await fetch(`${remote}/api/auth/status`)).ok; } catch { return false; } }, `both listeners start\n${logs}`);

  // Loopback stays the owner; the remote listener starts anonymous.
  const owner = client(local);
  await owner.refreshCsrf();
  assert.equal((await owner.call('/api/auth/status')).json.kind, 'owner');
  const anonymous = client(remote);
  assert.deepEqual((await anonymous.call('/api/auth/status')).json, { kind: 'anonymous', remote: true, passwordSet: false } satisfies AuthStatus);
  assert.equal((await anonymous.call('/api/state')).status, 401);
  assert.equal((await anonymous.call('/api/config')).status, 401);
  assert.equal((await anonymous.call('/api/auth/login', { body: { password: 'x' } })).status, 409, 'no password yet');
  // The first password can only be set on the owner's own machine.
  assert.equal((await anonymous.call('/api/auth/password', { body: { password: 'remote takeover attempt' } })).status, 403);
  assert.equal((await owner.call('/api/auth/password', { body: { password: 'owner long password' } })).status, 200);

  const remoteOwner = client(remote);
  assert.equal((await remoteOwner.call('/api/auth/login', { body: { password: 'wrong password!' } })).status, 401);
  assert.equal((await remoteOwner.call('/api/auth/login', { body: { password: 'owner long password' } })).json.kind, 'owner');
  assert.match(remoteOwner.cookie, /^sessiondeck_device=/);
  await remoteOwner.refreshCsrf();
  const state = (await remoteOwner.call('/api/state')).json as AppState;
  assert.ok(state.sessions.length >= 2, 'owner sees the whole workspace remotely');
  assert.equal((await remoteOwner.call('/api/shells')).status, 200);
  assert.equal((await remoteOwner.call('/api/native-event/x', { body: {} })).status, 403, 'native hooks are loopback only');

  const target = state.sessions.find(item => !item.archived) as Session;
  const other = state.sessions.find(item => item.id !== target.id) as Session;
  await owner.call(`/api/sessions/${target.id}/start`, { body: {} });
  const created = (await owner.call(`/api/sessions/${target.id}/shares`, { body: { mode: 'read', ttlDays: 7 } })).json as { share: Share; url: string };
  const secret = created.url.split('/#/share/')[1];
  assert.ok(secret && created.url.startsWith(remote));

  const colleague = client(remote);
  assert.equal((await colleague.call('/api/auth/redeem', { body: { token: secret, name: '' } })).status, 400);
  assert.equal((await colleague.call('/api/auth/redeem', { body: { token: 'nope', name: '王五' } })).status, 404);
  const redeemed = (await colleague.call('/api/auth/redeem', { body: { token: secret, name: '王五' } })).json as AuthStatus;
  assert.deepEqual(redeemed, { kind: 'share', remote: true, sessionId: target.id, mode: 'read', name: '王五' });
  await colleague.refreshCsrf();
  const shared = (await colleague.call('/api/state')).json as AppState;
  assert.deepEqual(shared.sessions.map(item => item.id), [target.id]);
  assert.deepEqual(shared.groups, []);
  assert.equal(shared.defaultCwd, '');
  assert.ok(shared.activities.every(activity => activity.sessionId === target.id));
  assert.equal((await colleague.call(`/api/sessions/${target.id}/workspace/git/status`)).status, 200);
  assert.equal((await colleague.call(`/api/sessions/${other.id}/workspace/tree`)).status, 404);
  assert.equal((await colleague.call(`/api/sessions/${target.id}/stop`, { body: {} })).status, 403, 'read shares cannot act');
  for (const [path, body] of [['/api/shells', {}], ['/api/directories/list', { path: '/' }], ['/api/sessions', {}], [`/api/sessions/${target.id}/shares`, { mode: 'write', ttlDays: 1 }]] as const) {
    assert.equal((await colleague.call(path, { body })).status, 403, path);
  }
  // A share device's CSRF token does not unlock the owner's loopback token.
  assert.notEqual(colleague.csrf, owner.csrf);

  // The shared terminal streams output but discards the viewer's keystrokes.
  const frames: string[] = [];
  const socket = new WebSocket(`${remote.replace('http:', 'ws:')}/api/terminal/${target.id}?token=${colleague.csrf}`, { origin: remote, headers: { cookie: colleague.cookie } });
  sockets.push(socket);
  socket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'data') frames.push(message.data); if (message.type === 'ready') frames.push(`READY:${message.readOnly}`); });
  await until(() => frames.some(frame => frame === 'READY:true'), 'read-only terminal connects');
  socket.send(JSON.stringify({ type: 'input', data: 'READ-ONLY-SHOULD-NOT-ARRIVE\r' }));
  const denied = new WebSocket(`${remote.replace('http:', 'ws:')}/api/terminal/${other.id}?token=${colleague.csrf}`, { origin: remote, headers: { cookie: colleague.cookie } });
  sockets.push(denied);
  await new Promise<void>(accept => { denied.once('error', () => accept()); denied.once('close', () => accept()); });
  await delay(600);
  assert.ok(!frames.join('').includes('READ-ONLY-SHOULD-NOT-ARRIVE'), 'demo PTY never echoed the read-only input');

  // Writable shares act on their session and every action is attributed.
  const writeLink = (await owner.call(`/api/sessions/${target.id}/shares`, { body: { mode: 'write', ttlDays: null } })).json as { share: Share; url: string };
  const collaborator = client(remote);
  await collaborator.call('/api/auth/redeem', { body: { token: writeLink.url.split('/#/share/')[1], name: '赵六' } });
  await collaborator.refreshCsrf();
  assert.equal((await collaborator.call(`/api/sessions/${target.id}/stop`, { body: {} })).status, 200);
  const afterStop = (await owner.call('/api/state')).json as AppState;
  assert.ok(afterStop.activities.some(activity => activity.text === '赵六（分享）停止了会话'));
  const listed = (await owner.call(`/api/sessions/${target.id}/shares`)).json as Share[];
  assert.equal(listed.find(share => share.id === writeLink.share.id)?.devices[0]?.name, '赵六');

  // Revocation ends the session for the device, including its live terminal.
  const closed = new Promise<number>(accept => socket.once('close', code => accept(code)));
  assert.equal((await owner.call(`/api/shares/${created.share.id}`, { method: 'DELETE', body: {} })).status, 200);
  assert.equal(await closed, 4401);
  assert.equal((await colleague.call('/api/state')).status, 401);
  assert.equal((await collaborator.call('/api/state')).status, 200, 'other shares keep working');
});

test('SSH password reaches ssh through askpass, never argv, and is sealed at rest', async () => {
  const { Tunnel, SecretBox, secretKey } = await import('./remote.ts');
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'sessiondeck-askpass-'));
  const record = join(dir, 'record.txt');
  // A fake ssh records its argv and what SSH_ASKPASS returns, then stays up.
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nprintf 'ARGV:%s\\n' "$*" > "${record}"\nprintf 'ASKPASS:%s\\n' "$("$SSH_ASKPASS")" >> "${record}"\nexec sleep 30\n`);
  chmodSync(join(dir, 'ssh'), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  const tunnel = new Tunnel(dir);
  try {
    const settings = { ...DEFAULT_REMOTE, enabled: true, publicUrl: 'https://deck.example.com', sshHost: '', sshUser: 'ubuntu', localPort: 4318 };
    await tunnel.configure(settings, 'p@ss word$`x');
    await until(() => { try { return readFileSync(record, 'utf8').includes('ASKPASS:'); } catch { return false; } }, 'fake ssh ran');
    const recorded = readFileSync(record, 'utf8');
    assert.match(recorded, /ASKPASS:p@ss word\$`x/);
    assert.ok(!/ARGV:.*p@ss/.test(recorded), 'password is not in argv');
    assert.match(recorded, /BatchMode=no/);
    assert.match(recorded, /-R 127\.0\.0\.1:17317:127\.0\.0\.1:4318/);
    assert.match(recorded, /ubuntu@deck\.example\.com/);
  } finally {
    await tunnel.close(); process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true });
  }
  const box = new SecretBox(secretKey(Buffer.from('k')));
  const sealed = box.seal('secret-value');
  assert.ok(!sealed.includes('secret-value'));
  assert.equal(box.open(sealed), 'secret-value');
  assert.throws(() => new SecretBox(secretKey(Buffer.from('other'))).open(sealed));
});
