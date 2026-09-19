import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { findExecutable, validateNativeId } from './adapters.js';
import type { SessionStatus } from '../shared/types.js';
import { OwnedProcess } from './owned-process.ts';

export interface DshBridgeOptions {
  port?: number;
  dataDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests can exercise the real HTTP contract against a fixture server. */
  manageProcess?: boolean;
  /** Total readiness budget, including every HTTP probe and response body. */
  startupTimeoutMs?: number;
}
interface NativeSession { nativeSessionId: string; nativeUrl: string }
interface DshSummary { sessionId: string; running?: boolean; cwd?: string; updatedAt?: number }
export interface DshStatus { status: SessionStatus; detail?: string; attentionKey?: string }
interface TurnBoundary { type: 'turn/start' | 'turn/end'; seq: number; reason?: string }

/** Read-only invocation identity. A page returning 200 is not proof that the
 * process we spawned owns the port (another service may win the bind race). */
function dshHostPlugin(token: string): string {
  return `export default function sessiondeckLink(ctx){ctx.inject(['webServer'],function(ctx){ctx.effect(function(){return ctx.webServer.register({kind:'exact',path:'/sessiondeck/instance',handler:function(req,res){res.setHeader('content-type','text/plain');res.setHeader('cache-control','no-store');res.end(${JSON.stringify(token)});}});});});}\n`;
}

async function prepareLaunch(dataDir: string, token: string): Promise<{ directory: string; loaderPath: string; patchPath: string }> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // A cancelled boot may still have an outstanding filesystem write. Each
  // launch gets its own files so it cannot corrupt a replacement's plugin.
  const directory = await mkdtemp(join(dataDir, 'dsh-launch-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-sessiondeck-link', version: '1.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' }, dsh: { client: { inject: ['sessions'], platform: 'web' } } }, null, 2), { mode: 0o600 });
    await writeFile(join(directory, 'index.js'), dshHostPlugin(token), { mode: 0o600 });
    await writeFile(join(directory, 'client.js'), dshDeepLinkClient('dsh-sessiondeck-link'), { mode: 0o600 });
    const loaderPath = join(directory, 'loader.mjs');
    const moduleUrls = { 'dsh-sessiondeck-link': pathToFileURL(join(directory, 'index.js')).href, 'dsh-sessiondeck-link/package.json': pathToFileURL(join(directory, 'package.json')).href };
    await writeFile(loaderPath, `import { registerHooks } from 'node:module';\nconst urls=${JSON.stringify(moduleUrls)};\nregisterHooks({resolve(specifier,context,next){return Object.hasOwn(urls,specifier)?{url:urls[specifier],shortCircuit:true}:next(specifier,context);}});\n`, { mode: 0o600 });
    const patchPath = join(directory, 'patch.yml');
    // JSON is a YAML subset; the overlay adds only this invocation's plugin.
    await writeFile(patchPath, JSON.stringify([{ insert: [{ id: 'sessiondeck-link', name: 'dsh-sessiondeck-link' }] }]), { mode: 0o600 });
    return { directory, loaderPath, patchPath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The original UI provides a public sessions.open() service but no URL routing.
 * This invocation-only client plugin adds a deep link without copying any UI. */
export function dshDeepLinkClient(moduleId: string): string {
  return `window.__ModuleLoader__.load({id:${JSON.stringify(moduleId)},factory:function(){return {inject:['sessions'],apply:function(ctx){
    const target=new URLSearchParams(location.search).get('sessiondeckSession');
    if(!target || !/^session-[a-f\\d-]{36}$/i.test(target))return;
    let opened=false;
    const tryOpen=function(){if(opened)return;const state=ctx.sessions.list.getSnapshot();if(state.byId && state.byId[target]){opened=true;ctx.sessions.open(target);}};
    ctx.effect(function(){const unsubscribe=ctx.sessions.list.subscribe(tryOpen);tryOpen();return unsubscribe;});
  }}}});`;
}

export class DshBridge {
  readonly baseUrl: string;
  private process: ChildProcess | null = null;
  private owners = new WeakMap<ChildProcess, OwnedProcess>();
  private starting: Promise<void> | null = null;
  private bootAbort: AbortController | null = null;
  private bootGeneration = 0;
  private ready = false;
  private closed = false;
  private retiring: Promise<void> = Promise.resolve();
  private cleanups = new Set<Promise<void>>();
  private requests = new Set<AbortController>();
  private streams: WebSocket[] = [];
  private streamGeneration = 0;
  private streamReady = false;
  private muxSynchronized = false;
  private pending = new Map<string, Map<string, 'waiting_approval' | 'waiting_input'>>();
  private observedRunning = new Map<string, boolean>();
  private boundaries = new Map<string, TurnBoundary>();
  private historyFresh = new Set<string>();
  private revisions = new Map<string, number>();
  private completed = new Map<string, string>();
  private failed = new Map<string, string>();
  private options: DshBridgeOptions;
  constructor(options: DshBridgeOptions = {}) {
    const port = options.port ?? Number(process.env.SESSIONDECK_DSH_PORT ?? 4318);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效的 DSH 端口');
    if (options.startupTimeoutMs !== undefined && (!Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs <= 0)) throw new Error('无效的 DSH 启动超时');
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('DeepSeek Harness 桥接服务正在关闭');
    if (this.ready) return;
    if (this.starting) return this.starting;
    const generation = ++this.bootGeneration;
    const pending = this.boot(generation).finally(() => {
      if (this.starting === pending) this.starting = null;
      // boot() has an inner finally once a child exists. Earlier failures
      // (missing executable, occupied port, filesystem setup) need the same
      // abort-controller cleanup, but an older cancelled generation must not
      // clear a replacement's controller.
      if (this.bootGeneration === generation && !this.ready) this.bootAbort = null;
    });
    this.starting = pending;
    return pending;
  }

  private async boot(generation: number): Promise<void> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 20_000);
    const abort = new AbortController();
    this.bootAbort = abort;
    const timedOut = () => new Error('DeepSeek Harness 启动超时，请检查 dsh web 是否能正常运行');
    const assertActive = () => {
      if (this.bootGeneration !== generation) throw new Error('DeepSeek Harness 启动已取消');
      if (Date.now() >= deadline) throw timedOut();
    };
    const probeSignal = () => {
      assertActive();
      return AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, Math.min(500, deadline - Date.now())))]);
    };
    await this.retiring;
    assertActive();
    if (this.options.manageProcess === false) { this.ready = true; return; }
    const file = await findExecutable('dsh');
    assertActive();
    if (!file) throw new Error('未找到 dsh 命令，请安装 DeepSeek Harness');
    const port = Number(new URL(this.baseUrl).port);
    await new Promise<void>((resolveCheck, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(new Error(`DSH 端口 ${port} 已被占用，请设置 SESSIONDECK_DSH_PORT 为其他端口`)));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolveCheck()));
    });
    assertActive();
    const dataDir = resolve(this.options.dataDir ?? process.env.SESSIONDECK_DATA_DIR ?? join(homedir(), '.sessiondeck'));
    const launchToken = randomUUID();
    const { directory, loaderPath, patchPath } = await prepareLaunch(dataDir, launchToken);
    try { assertActive(); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    const baseEnv = this.options.env ?? process.env;
    const env = { ...baseEnv, SESSIONDECK_DSH_LAUNCH_TOKEN: launchToken, NODE_OPTIONS: `${baseEnv.NODE_OPTIONS ?? ''} --import ${JSON.stringify(pathToFileURL(loaderPath).href)}`.trim() };
    const child = spawn(file, ['--profile', 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', String(port), '--no-open'], { cwd: this.options.cwd ?? process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] });
    const closed = new Promise<void>(accept => child.once('close', () => accept()));
    const cleaned = closed.then(() => rm(directory, { recursive: true, force: true }));
    this.cleanups.add(cleaned);
    void cleaned.then(() => this.cleanups.delete(cleaned), () => this.cleanups.delete(cleaned));
    this.owners.set(child, new OwnedProcess(child.pid ?? 0, cleaned, signal => { child.kill(signal); }));
    // Keep cleanup covered even when the native process exits on its own.
    void cleaned.catch(() => undefined);
    this.process = child;
    let failure: Error | null = null;
    child.stderr?.resume();
    child.once('error', error => { failure = error; });
    child.once('exit', code => {
      failure = new Error(`DeepSeek Harness 已退出（${code ?? 'signal'}）`);
      if (this.process !== child) return;
      this.ready = false; this.process = null; this.closeStreams();
      this.clearStatus(); this.abortRequests();
    });
    try {
      while (Date.now() < deadline) {
        assertActive();
        if (failure) throw failure;
        try {
          const response = await fetch(`${this.baseUrl}/sessiondeck/instance`, { signal: probeSignal(), redirect: 'error' });
          const token = response.ok ? await response.text() : '';
          assertActive();
          if (failure) throw failure;
          if (token === launchToken) {
            // The plugin route can become available before the native API has
            // finished mounting. Probe a read-only native method as well.
            const rpcId = randomUUID();
            const api = await fetch(`${this.baseUrl}/api/session.list`, { method: 'POST', headers: { 'content-type': 'application/json', origin: this.baseUrl }, body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.list', payload: {} }), signal: probeSignal(), redirect: 'error' });
            if (api.ok) {
              const result = await api.json() as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: { items?: unknown } } };
              assertActive();
              if (!failure && result.type === 'server-response' && result.rpcId === rpcId && result.result?.ok === true && Array.isArray(result.result.value?.items)) { this.ready = true; this.connectEvents(); return; }
            }
          }
        } catch { /* boot not yet bound */ }
        assertActive();
        await delay(Math.min(200, deadline - Date.now()), undefined, { signal: abort.signal });
      }
      throw timedOut();
    } catch (error) {
      const failure = this.bootGeneration !== generation ? new Error('DeepSeek Harness 启动已取消') : Date.now() >= deadline ? timedOut() : error;
      if (this.process === child) this.process = null;
      // Failed start is not complete until its owned process and invocation
      // files are gone. The bounded process grace period remains under the
      // browser's 30s request timeout after the default 20s readiness budget.
      await this.retire(child);
      throw failure;
    } finally {
      if (this.bootAbort === abort) this.bootAbort = null;
    }
  }

  async stop(): Promise<void> {
    const starting = this.starting;
    this.bootGeneration++;
    this.bootAbort?.abort();
    this.bootAbort = null;
    this.starting = null;
    this.closeStreams();
    this.clearStatus(); this.abortRequests();
    if (this.process) this.retire(this.process);
    this.process = null;
    this.ready = false;
    await starting?.catch(() => undefined);
    await this.retiring;
    await Promise.all([...this.cleanups]);
  }

  async close(): Promise<void> { this.closed = true; await this.stop(); }

  private clearStatus(): void {
    this.observedRunning.clear(); this.completed.clear(); this.failed.clear();
    this.boundaries.clear(); this.historyFresh.clear(); this.revisions.clear();
  }

  private abortRequests(): void { for (const request of this.requests) request.abort(); }

  private retire(child: ChildProcess): Promise<void> {
    const retiring = this.owners.get(child)?.stop() ?? Promise.resolve();
    this.retiring = Promise.all([this.retiring, retiring]).then(() => undefined);
    void this.retiring.catch(() => undefined);
    return retiring;
  }

  private closeStreams(): void {
    this.streamGeneration++;
    this.streams.forEach(socket => socket.terminate());
    this.streams = [];
    this.pending.clear();
    this.streamReady = false;
    this.muxSynchronized = false;
  }

  private connectEvents(): void {
    const generation = ++this.streamGeneration;
    this.pending.clear();
    this.historyFresh.clear();
    this.streamReady = false;
    this.muxSynchronized = false;
    let opened = 0;
    let reconnecting = false;
    this.streams = ['events.mux', 'events.host'].map(method => {
      const socket = new WebSocket(`${this.baseUrl.replace('http:', 'ws:')}/api/${method}`, { origin: this.baseUrl, handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
      socket.on('open', () => { if (generation === this.streamGeneration && ++opened === 2) this.streamReady = true; });
      socket.on('message', data => {
        if (generation !== this.streamGeneration || reconnecting) return;
        try {
          const envelope = JSON.parse(data.toString());
          const frame = envelope.payload;
          if (frame?.type === 'stream/error') { reconnect(); return; }
          if (envelope.type !== 'server-request' || !frame || typeof frame.sessionId !== 'string') return;
          validateNativeId('dsh', frame.sessionId);
          const requests = this.pending.get(frame.sessionId) ?? new Map<string, 'waiting_approval' | 'waiting_input'>();
          if (frame.type === 'approval/requested' && typeof frame.approvalId === 'string') requests.set(`approval:${frame.approvalId}`, 'waiting_approval');
          else if (frame.type === 'question/requested' && typeof envelope.rpcId === 'string') requests.set(`question:${envelope.rpcId}`, 'waiting_input');
          else if (frame.type === 'approval/resolved' && typeof frame.approvalId === 'string') { requests.delete(`approval:${frame.approvalId}`); if (method === 'events.mux') this.muxSynchronized = true; }
          else if (frame.type === 'question/resolved' && typeof frame.questionRpcId === 'string') { requests.delete(`question:${frame.questionRpcId}`); if (method === 'events.mux') this.muxSynchronized = true; }
          else if (frame.type === 'session/event' && method === 'events.mux' && frame.event && Number.isSafeInteger(frame.event.seq) && frame.event.seq >= 0) {
            // Live events follow the entire pending-request replay in this FIFO.
            // Socket open (and WS pong) alone cannot certify that baseline.
            this.muxSynchronized = true;
            this.observeBoundary(frame.sessionId, frame.event);
            if (frame.event.type === 'turn/end' && this.boundaries.get(frame.sessionId)?.seq === frame.event.seq) requests.clear();
          }
          else if (frame.type === 'host/agent-error' && typeof envelope.rpcId === 'string') this.failed.set(frame.sessionId, `dsh:error:${frame.sessionId}:${envelope.rpcId}`);
          else if (frame.type === 'host/session-status' && typeof frame.running === 'boolean') {
            this.observeRunning(frame.sessionId, frame.running);
          }
          this.pending.set(frame.sessionId, requests);
        } catch { /* unsupported stream frame never fabricates status */ }
      });
      const reconnect = () => {
        if (generation !== this.streamGeneration || reconnecting) return;
        reconnecting = true;
        this.streamReady = false;
        this.muxSynchronized = false;
        this.pending.clear();
        this.streams.forEach(stream => stream.terminate());
        const timer = setTimeout(() => { if (this.ready && generation === this.streamGeneration) this.connectEvents(); }, 2000);
        timer.unref();
      };
      socket.on('error', reconnect);
      socket.on('close', reconnect);
      return socket;
    });
  }

  private async rpc<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.ready) throw new Error('DeepSeek Harness 原生服务尚未启动');
    const generation = this.bootGeneration;
    const abort = new AbortController();
    this.requests.add(abort);
    const rpcId = randomUUID();
    try {
      const response = await fetch(`${this.baseUrl}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: this.baseUrl }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), redirect: 'error' });
      if (!response.ok) throw new Error(`DeepSeek Harness API 请求失败（HTTP ${response.status}）`);
      const chunks: Uint8Array[] = []; let length = 0;
      if (!response.body) throw new Error('DeepSeek Harness 返回了空响应');
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('DeepSeek Harness API 响应超过大小限制'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: T; error?: { message?: string; code?: string } } };
      if (generation !== this.bootGeneration || !this.ready) throw new Error('DeepSeek Harness 请求所属服务已停止');
      if (result.type !== 'server-response') throw new Error('DeepSeek Harness 返回了无效的响应类型');
      if (result.rpcId !== rpcId) throw new Error('DeepSeek Harness 返回了不匹配的请求 ID');
      if (result.result?.ok !== true) throw new Error(`DeepSeek Harness：${result.result?.error?.message ?? result.result?.error?.code ?? '无效的 API 响应'}`);
      return result.result.value as T;
    } finally { this.requests.delete(abort); }
  }

  private reference(id: string): NativeSession {
    validateNativeId('dsh', id);
    return { nativeSessionId: id, nativeUrl: `${this.baseUrl}/?sessiondeckSession=${encodeURIComponent(id)}` };
  }

  async createSession(cwd: string, _title?: string): Promise<NativeSession> {
    await this.start();
    const result = await this.rpc<{ sessionId: string }>('session.create', { cwd, sessionId: `session-${randomUUID()}` });
    return this.reference(result.sessionId);
  }

  async forkSession(id: string, cwd?: string): Promise<NativeSession> {
    validateNativeId('dsh', id);
    await this.start();
    if (cwd) {
      const { items } = await this.rpc<{ items: DshSummary[] }>('session.list', {});
      const source = items.find(item => item.sessionId === id);
      if (!source?.cwd || resolve(source.cwd) !== resolve(cwd)) throw new Error('DeepSeek Harness 原生 Fork 保留原工作目录，暂不支持修改目录');
    }
    const result = await this.rpc<{ sessionId: string }>('session.fork', { sessionId: id });
    if (result.sessionId === id) throw new Error('DeepSeek Harness 未创建独立分叉会话');
    return this.reference(result.sessionId);
  }

  async openSession(id: string): Promise<NativeSession> {
    validateNativeId('dsh', id);
    await this.start();
    const result = await this.rpc<{ items: DshSummary[] }>('session.list', {});
    if (!Array.isArray(result.items) || !result.items.some(item => item.sessionId === id)) throw new Error('未找到对应的 DeepSeek Harness 会话');
    return this.reference(id);
  }

  async prompt(id: string, text: string): Promise<void> {
    validateNativeId('dsh', id);
    if (!text.trim()) throw new Error('消息不能为空');
    if (!this.ready) throw new Error('请先打开 DeepSeek Harness 会话');
    await this.rpc('session.prompt', { sessionId: id, mode: 'queue', content: [{ type: 'text', text }] });
  }

  async stopSession(id: string): Promise<void> {
    validateNativeId('dsh', id);
    if (!this.ready) return;
    // Persisted sessions are visible before the native UI attaches an agent.
    // The native API documents running=false for these cold sessions, whereas
    // session.cancel rejects them as not attached. There is no turn to cancel.
    const result = await this.rpc<{ items: DshSummary[] }>('session.list', {});
    const item = Array.isArray(result.items) ? result.items.find(row => row?.sessionId === id) : undefined;
    if (item?.running === false) return;
    await this.rpc('session.cancel', { sessionId: id });
  }

  private observeRunning(id: string, running: boolean): void {
    // Host status and mux boundaries travel on different sockets. A delayed
    // host "running" must not erase a newer turn/end from the mux stream.
    // Only an identified turn/start retires the preceding attention state.
    if (running) this.historyFresh.delete(id);
    this.observedRunning.set(id, running);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  private observeBoundary(id: string, event: unknown): void {
    if (!event || typeof event !== 'object') return;
    const value = event as { type?: unknown; seq?: unknown; data?: { reason?: { kind?: unknown } } };
    if (value.type !== 'turn/start' && value.type !== 'turn/end') return;
    if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0) return;
    const previous = this.boundaries.get(id);
    if (previous && previous.seq >= value.seq) return;
    const reason = typeof value.data?.reason?.kind === 'string' ? value.data.reason.kind : undefined;
    this.boundaries.set(id, { type: value.type, seq: value.seq, reason });
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    if (value.type === 'turn/start') {
      this.observeRunning(id, true);
      this.completed.delete(id); this.failed.delete(id);
    } else {
      this.observeRunning(id, false);
      this.pending.delete(id);
      const key = `dsh:turn:${id}:${value.seq}:${reason ?? 'ended'}`;
      if (reason === 'error') { this.failed.set(id, key); this.completed.delete(id); }
      else { this.completed.set(id, key); this.failed.delete(id); }
    }
  }

  private async recoverHistory(id: string, running: boolean): Promise<void> {
    if (this.historyFresh.has(id)) return;
    const generation = this.streamGeneration;
    try {
      // Native history is read-only and does not resume cold agents. A single
      // message tail carries the final boundary; no prompt bodies are retained.
      const history = await this.rpc<{ events?: { event?: unknown }[] }>('session.history', { sessionId: id, maxMessages: 1 });
      if (generation !== this.streamGeneration || !Array.isArray(history.events)) return;
      const last = history.events.map(entry => entry.event).findLast(event => !!event && typeof event === 'object' && ['turn/start', 'turn/end'].includes((event as { type: string }).type)) as { type: string } | undefined;
      if (last?.type === 'turn/end' || (running && last?.type === 'turn/start')) this.observeBoundary(id, last);
      if (last?.type !== 'turn/start') this.historyFresh.add(id);
    } catch { /* an unavailable history never manufactures a completion */ }
  }

  async getStatus(id: string): Promise<DshStatus> {
    validateNativeId('dsh', id);
    if (!this.ready) return { status: 'unknown', detail: '原生 Web 服务尚未启动' };
    try {
      const generation = this.bootGeneration;
      const revision = this.revisions.get(id) ?? 0;
      const result = await this.rpc<{ items: DshSummary[] }>('session.list', {});
      const item = Array.isArray(result.items) ? result.items.find(row => row?.sessionId === id) : undefined;
      if (!item) return { status: 'unknown', detail: '原生服务未返回该会话' };
      if (typeof item.running !== 'boolean') return { status: 'unknown', detail: '原生服务未返回可识别的运行状态' };
      // Live events received while the HTTP snapshot was in flight are newer.
      if (revision === (this.revisions.get(id) ?? 0)) this.observeRunning(id, item.running);
      const nativeRunning = this.observedRunning.get(id) ?? item.running;
      // A durable turn error may be superseded while the socket is offline.
      // Host errors have no log position; only an identified newer turn can
      // clear those, never a pre-existing history tail.
      if ((!nativeRunning && !this.failed.get(id)?.startsWith('dsh:error:')) || (nativeRunning && !this.muxSynchronized && this.failed.has(id))) await this.recoverHistory(id, nativeRunning);
      if (generation !== this.bootGeneration || !this.ready) return { status: 'unknown', detail: '原生服务已停止' };
      const running = this.observedRunning.get(id) ?? item.running;
      const pending = this.pending.get(id);
      const approval = pending && [...pending].find(([, status]) => status === 'waiting_approval');
      const question = pending && [...pending].find(([, status]) => status === 'waiting_input');
      if (approval) return { status: 'waiting_approval', detail: 'DeepSeek Harness 正在等待审批', attentionKey: `dsh:${id}:${approval[0]}` };
      if (question) return { status: 'waiting_input', detail: 'DeepSeek Harness 正在等待回答', attentionKey: `dsh:${id}:${question[0]}` };
      if (this.failed.has(id)) return { status: 'error', detail: 'DeepSeek Harness 报告执行错误，请进入原生会话查看', attentionKey: this.failed.get(id) };
      if (running && this.options.manageProcess !== false && (!this.streamReady || !this.muxSynchronized)) return { status: 'unknown', detail: '原生服务正在运行；等待事件流确认执行或审批状态' };
      if (!running && this.completed.has(id)) return { status: 'waiting_input', detail: 'DeepSeek Harness 本轮已结束，可以继续或验收', attentionKey: this.completed.get(id) };
      return { status: running ? 'running' : 'idle', detail: running ? 'DeepSeek Harness 报告运行中' : 'DeepSeek Harness 报告空闲' };
    } catch { return { status: 'unknown', detail: '无法连接 DeepSeek Harness 原生服务' }; }
  }
}
