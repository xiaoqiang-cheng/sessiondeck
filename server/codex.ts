import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { SessionStatus } from '../shared/types.js';
import { validateNativeId } from './adapters.js';
import { OwnedProcess } from './owned-process.ts';
import { sameDirectory } from './paths.ts';

export interface CodexNativeSession {
  nativeSessionId: string;
  /** Remote endpoint for the native Codex TUI. The token is intentionally
   * separate and is only passed to a child process by remoteLaunch(). */
  remoteUrl: string;
}

export interface CodexStatusEvent {
  status: SessionStatus;
  detail: string;
  timestamp: string;
  /** Stable native event identity, retained when a reconnect replays it. */
  attentionKey?: string;
}

export interface CodexLaunchCommand {
  file: string;
  args: string[];
  env: Record<string, string>;
}

export interface CodexBridgeOptions {
  /** Local SessionDeck data directory. Only runtime token files are written. */
  dataDir?: string;
  /** Override the executable for tests or a non-standard installation. */
  executable?: string;
  /** Use a fixed loopback port; 0 chooses an available port. */
  port?: number;
  /** Environment inherited by app-server and remote TUI children. */
  env?: NodeJS.ProcessEnv;
  /** Tests can attach to an already-running authenticated WS endpoint. */
  manageProcess?: boolean;
  remoteUrl?: string;
  remoteToken?: string;
  /** Optional timeout for app-server readiness. */
  startupTimeoutMs?: number;
  /** Timeout for the WebSocket HTTP upgrade and initialize handshake. */
  handshakeTimeoutMs?: number;
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: Record<string, unknown>;
};

type Thread = {
  id: string;
  cwd?: string;
  path?: string | null;
  status?: { type?: string; activeFlags?: string[] };
  forkedFromId?: string | null;
  canAcceptDirectInput?: boolean | null;
  name?: string | null;
  turns?: { id: string; status?: string }[];
};

type RpcConnection = {
  ws: WebSocket;
  generation: number;
  nextId: number;
  pending: Map<number, { resolve: (value: RpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
  initialized: Promise<void>;
  closed: boolean;
};

type StatusListener = (threadId: string, event: CodexStatusEvent) => void;
type ObservationAttempt = { version: number; connection?: RpcConnection; promise: Promise<void> };

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const DEFAULT_PORT = 4319;
const TOKEN_ENV = 'SESSIONDECK_CODEX_TOKEN';

function now(): string { return new Date().toISOString(); }

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return fallback;
}

async function availablePort(requested: number): Promise<number> {
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error('SESSIONDECK_CODEX_PORT 必须是 0–65535 的端口号');
  const server = createServer();
  await new Promise<void>((resolveCheck, reject) => {
    server.once('error', reject);
    server.listen(requested, '127.0.0.1', () => resolveCheck());
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : requested;
  await new Promise<void>(resolveCheck => server.close(() => resolveCheck()));
  return port;
}

/**
 * Owns one authenticated loopback Codex app-server. The server is deliberately
 * a separate process: Codex's native TUI can attach to exactly the same loaded
 * thread through `--remote`, while SessionDeck uses the stable JSON-RPC API for
 * identity, Fork and status. We never pass model/sandbox/approval overrides.
 */
export class CodexBridge {
  readonly remoteUrl: string;
  private readonly options: CodexBridgeOptions;
  private readonly env: NodeJS.ProcessEnv;
  private process: ChildProcess | null = null;
  private owners = new WeakMap<ChildProcess, OwnedProcess>();
  private retiring: Promise<void> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private ready = false;
  private closed = false;
  private port = 0;
  private token = '';
  private tokenFile: string | null = null;
  private bootGeneration = 0;
  private connections = new Set<RpcConnection>();
  private observers = new Map<string, RpcConnection>();
  private observing = new Map<string, ObservationAttempt>();
  private observationVersions = new Map<string, number>();
  private turnIds = new Map<string, string>();
  private completed = new Map<string, CodexStatusEvent>();
  private nativeAttention = new Map<string, CodexStatusEvent>();
  private listeners = new Set<StatusListener>();

  constructor(options: CodexBridgeOptions = {}) {
    this.options = options;
    this.env = { ...(options.env ?? process.env) };
    this.remoteUrl = options.remoteUrl ?? '';
  }

  /** Endpoint after start(). Before start() it is an empty string. */
  get endpoint(): string { return this.remoteUrl || (this.port ? `ws://127.0.0.1:${this.port}` : ''); }

  /** Token is intentionally not part of the public session object. */
  get remoteToken(): string | null { return this.ready ? this.token : null; }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Codex 桥接服务正在关闭');
    if (this.ready) return;
    if (this.starting) return this.starting;
    const generation = ++this.bootGeneration;
    const pending = this.boot(generation).finally(() => { if (this.starting === pending) this.starting = null; });
    this.starting = pending;
    return pending;
  }

  private async boot(generation: number): Promise<void> {
    const assertActive = () => { if (generation !== this.bootGeneration) throw new Error('Codex app-server 启动已取消'); };
    await this.retiring;
    assertActive();
    if (this.options.manageProcess === false) {
      if (!this.options.remoteUrl || !this.options.remoteToken) throw new Error('测试模式需要 remoteUrl 和 remoteToken');
      this.token = this.options.remoteToken;
      this.ready = true;
      return;
    }
    const executable = this.options.executable ?? await this.findExecutable();
    assertActive();
    if (!executable) throw new Error('未找到 Codex，请安装 codex CLI 并加入 PATH');
    this.port = await availablePort(this.options.port ?? Number(this.env.SESSIONDECK_CODEX_PORT ?? DEFAULT_PORT));
    assertActive();
    const dataDir = resolve(this.options.dataDir ?? this.env.SESSIONDECK_DATA_DIR ?? join(homedir(), '.local/share', 'sessiondeck'));
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    assertActive();
    // Codex refuses to start when CODEX_HOME is explicitly pointed at a path
    // that has not been created yet (common in tests and fresh profiles).
    if (this.env.CODEX_HOME) await mkdir(resolve(this.env.CODEX_HOME), { recursive: true, mode: 0o700 });
    assertActive();
    this.token = `sessiondeck-${randomBytes(24).toString('hex')}`;
    const tokenFile = join(dataDir, `.codex-app-server-${process.pid}-${randomUUID()}.token`);
    this.tokenFile = tokenFile;
    await writeFile(tokenFile, this.token, { mode: 0o600 });
    if (generation !== this.bootGeneration) { await this.removeTokenFile(tokenFile); assertActive(); }
    const childEnv = { ...this.env };
    const child = spawn(executable, [
      'app-server', '--listen', `ws://127.0.0.1:${this.port}`,
      '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
    ], { cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    const closed = new Promise<void>(accept => child.once('close', () => accept()));
    this.owners.set(child, new OwnedProcess(child.pid ?? 0, closed, signal => { child.kill(signal); }));
    this.process = child;
    let failure: Error | null = null;
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', error => { failure = error; });
    child.once('exit', code => {
      if (this.process !== child) return;
      if (!this.ready) failure = new Error(`Codex app-server 已退出（${code ?? 'signal'}）${stderr ? `：${stderr.trim().slice(-500)}` : ''}`);
      this.closeConnections(true);
      this.ready = false;
      this.process = null;
      this.turnIds.clear();
      this.completed.clear();
      this.nativeAttention.clear();
      void this.removeTokenFile(tokenFile);
    });
    const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        assertActive();
        if (failure) throw failure;
        try {
          const response = await fetch(`http://127.0.0.1:${this.port}/readyz`, { signal: AbortSignal.timeout(300) });
          assertActive();
          if (response.ok) {
            this.ready = true;
            return;
          }
        } catch { /* still booting */ }
        await delay(100);
      }
      throw new Error(`Codex app-server 启动超时${stderr ? `：${stderr.trim().slice(-500)}` : ''}`);
    } catch (error) {
      if (this.process === child) this.process = null;
      this.retire(child);
      await this.removeTokenFile(tokenFile);
      throw error;
    }
  }

  private async findExecutable(): Promise<string | null> {
    const configured = this.env.SESSIONDECK_CODEX_BIN;
    const candidates = configured ? [configured] : (this.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'codex'));
    for (const candidate of candidates) {
      try { await access(candidate, constants.X_OK); return resolve(candidate); } catch { /* continue */ }
    }
    return null;
  }

  async stop(): Promise<void> {
    const starting = this.starting;
    ++this.bootGeneration;
    this.starting = null;
    this.ready = false;
    this.closeConnections();
    this.turnIds.clear();
    this.completed.clear();
    this.nativeAttention.clear();
    if (this.process) this.retire(this.process);
    this.process = null;
    await this.removeTokenFile();
    await starting?.catch(() => undefined);
    await this.retiring;
  }

  async close(): Promise<void> { this.closed = true; await this.stop(); }

  private retire(child: ChildProcess): void {
    const retiring = this.owners.get(child)?.stop() ?? Promise.resolve();
    this.retiring = Promise.all([this.retiring, retiring]).then(() => undefined);
    void this.retiring.catch(() => undefined);
  }

  private async removeTokenFile(path = this.tokenFile): Promise<void> {
    if (path === this.tokenFile) this.tokenFile = null;
    if (path) try { await unlink(path); } catch { /* already removed */ }
  }

  private closeConnections(emitUnknown = false): void {
    for (const [threadId, attempt] of this.observing) {
      this.observationVersions.set(threadId, attempt.version + 1);
      if (attempt.connection) this.closeConnection(attempt.connection);
    }
    this.observing.clear();
    const observed = [...this.observers.keys()];
    for (const threadId of observed) this.invalidateObserver(threadId, 'Codex 原生状态连接已断开', emitUnknown);
    for (const connection of this.connections) this.closeConnection(connection);
    this.connections.clear();
    this.observers.clear();
  }

  private invalidateObserver(threadId: string, detail: string, forceEmit = false): void {
    const connection = this.observers.get(threadId);
    if (connection) this.closeConnection(connection);
    this.observers.delete(threadId);
    // A dropped observer does not end the native turn or acknowledge its
    // result. Keep that identity until resume reconciles it with native state.
    // Do not emit during an intentional stop. During a boot/process failure the
    // card must become explicitly unknown instead of retaining stale truth.
    if (this.ready || forceEmit) this.emitStatus(threadId, { status: 'unknown', detail, timestamp: now() });
  }

  private closeConnection(connection: RpcConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server 连接已关闭'));
    }
    connection.pending.clear();
    connection.ws.terminate();
  }

  private async connect(): Promise<RpcConnection> {
    await this.start();
    const endpoint = this.endpoint;
    const token = this.token;
    if (!endpoint || !token) throw new Error('Codex app-server 尚未就绪');
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    const pending = new Map<number, { resolve: (value: RpcMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    const generation = this.bootGeneration;
    const connection: RpcConnection = { ws, generation, nextId: 1, pending, initialized: Promise.resolve(), closed: false };
    this.connections.add(connection);
    ws.on('message', data => {
      let message: RpcMessage;
      try { message = JSON.parse(data.toString()) as RpcMessage; } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (connection.closed || connection.generation !== this.bootGeneration || !this.ready) return;
      if (message.method && message.id !== undefined) {
        this.handleServerRequest(connection, message);
        return;
      }
      if (message.method) this.handleNotification(connection, message);
      if (message.id === undefined || message.method || (!('result' in message) && !('error' in message))) return;
      if (typeof message.id !== 'number') return;
      const id = message.id;
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    });
    const fail = (reason: unknown) => {
      const error = new Error(errorMessage(reason, 'Codex app-server WebSocket 连接失败'));
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
      pending.clear();
    };
    ws.on('error', fail);
    ws.on('close', () => {
      connection.closed = true;
      fail(new Error('Codex app-server WebSocket 已关闭'));
      this.connections.delete(connection);
      for (const [threadId, observed] of this.observers) if (observed === connection) this.invalidateObserver(threadId, 'Codex 原生状态连接已断开');
    });
    connection.initialized = new Promise<void>((resolveInit, rejectInit) => {
      let handshakeTimer: NodeJS.Timeout;
      const onError = (error: Error) => { clearTimeout(handshakeTimer); rejectInit(error); };
      const onClose = () => { clearTimeout(handshakeTimer); rejectInit(new Error('Codex app-server 在握手完成前关闭了连接')); };
      handshakeTimer = setTimeout(() => {
        try { ws.terminate(); } catch { /* already closed */ }
        rejectInit(new Error('Codex app-server WebSocket 握手超时'));
      }, this.options.handshakeTimeoutMs ?? 5_000);
      const onOpen = () => {
        ws.off('error', onError);
        this.call(connection, 'initialize', { clientInfo: { name: 'sessiondeck', version: '0.2.0' }, capabilities: { experimentalApi: true } }, this.options.handshakeTimeoutMs ?? 5_000)
          .then(response => {
            if (response.error) throw this.rpcError(response, 'Codex initialize 失败');
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
          })
          .then(() => { clearTimeout(handshakeTimer); ws.off('close', onClose); resolveInit(); }, onError);
      };
      ws.once('error', onError);
      ws.once('close', onClose);
      ws.once('open', onOpen);
    });
    try { await connection.initialized; return connection; }
    catch (error) { this.closeConnection(connection); this.connections.delete(connection); throw error; }
  }

  private call(connection: RpcConnection, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<RpcMessage> {
    if (connection.closed || connection.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex app-server 连接尚未打开'));
    const id = connection.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => { connection.pending.delete(id); rejectCall(new Error(`Codex ${method} 请求超时`)); }, timeoutMs);
      connection.pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
      try { connection.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch (error) { clearTimeout(timer); connection.pending.delete(id); rejectCall(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private rpcError(response: RpcMessage, fallback: string): Error {
    return new Error(response.error?.message ? `Codex：${response.error.message}` : fallback);
  }

  private async rpc<T extends Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    const connection = await this.connect();
    try {
      const response = await this.call(connection, method, params);
      if (response.error) throw this.rpcError(response, `Codex ${method} 失败`);
      return (response.result ?? {}) as T;
    } finally { this.closeConnection(connection); this.connections.delete(connection); }
  }

  private handleServerRequest(connection: RpcConnection, message: RpcMessage): void {
    // Approval, user-input and other server requests belong to the native TUI
    // connection. SessionDeck never auto-approves or fabricates an answer.
    const params = message.params ?? {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!threadId || this.observers.get(threadId) !== connection) return;
    const item = params.item as { id?: unknown } | undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : typeof item?.id === 'string' ? item.id : undefined;
    let event: CodexStatusEvent | undefined;
    if (/approval|permission/i.test(message.method ?? '')) event = { status: 'waiting_approval', detail: 'Codex 正在等待原生会话处理审批', timestamp: now(), ...(itemId ? { attentionKey: `codex:${threadId}:approval:${itemId}` } : {}) };
    else if (/elicitation|user.?input/i.test(message.method ?? '')) event = { status: 'waiting_input', detail: 'Codex 正在等待原生会话处理输入', timestamp: now(), ...(itemId ? { attentionKey: `codex:${threadId}:input:${itemId}` } : {}) };
    if (event) { this.nativeAttention.set(threadId, event); this.emitStatus(threadId, event); }
    // Intentionally leave the request unanswered here. It can be broadcast to
    // both clients; sending even an error would race the user's TUI response.
  }

  private handleNotification(connection: RpcConnection, message: RpcMessage): void {
    if (connection.generation !== this.bootGeneration) return;
    const params = message.params ?? {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    if (!threadId || !UUID.test(threadId) || this.observers.get(threadId) !== connection) return;
    if (message.method === 'thread/status/changed' && threadId) {
      const status = params.status as { type?: string; activeFlags?: string[] } | undefined;
      if (status?.type === 'active') this.completed.delete(threadId);
      const event = this.currentStatus(threadId, status, 'Codex 原生状态已更新');
      this.emitStatus(threadId, event);
    } else if (message.method === 'turn/started' && threadId) {
      const turn = params.turn as { id?: string } | undefined;
      if (!turn?.id || !UUID.test(turn.id)) return;
      this.turnIds.set(threadId, turn.id);
      this.completed.delete(threadId);
      this.nativeAttention.delete(threadId);
      this.emitStatus(threadId, { status: 'running', detail: 'Codex 原生会话正在执行', timestamp: now() });
    } else if (message.method === 'turn/completed' && threadId) {
      const turn = params.turn as { id?: string; status?: string } | undefined;
      if (!turn?.id || !UUID.test(turn.id)) return;
      const activeId = this.turnIds.get(threadId);
      if (activeId && activeId !== turn.id) return;
      this.turnIds.delete(threadId);
      const event = this.completionEvent(threadId, turn as { id: string; status?: string });
      this.emitStatus(threadId, event);
    } else if (message.method === 'error' && threadId) {
      this.emitStatus(threadId, { status: 'error', detail: 'Codex 报告执行错误，请进入原生会话查看', timestamp: now() });
    }
  }

  private completionEvent(threadId: string, turn: { id: string; status?: string }): CodexStatusEvent {
    const attentionKey = `codex:${threadId}:${turn.id}:${turn.status ?? 'unknown'}`;
    const previous = this.completed.get(threadId);
    if (previous?.attentionKey === attentionKey) return previous;
    const event: CodexStatusEvent = turn.status === 'completed'
      ? { status: 'waiting_input', detail: 'Codex 本轮已结束，可以继续或验收', timestamp: now(), attentionKey }
      : turn.status === 'interrupted' ? { status: 'idle', detail: 'Codex 当前轮次已中断', timestamp: now(), attentionKey }
      : turn.status === 'failed' ? { status: 'error', detail: 'Codex 当前轮次执行失败，请进入原生会话查看', timestamp: now(), attentionKey }
      : { status: 'unknown', detail: 'Codex 返回了未知的轮次结束状态', timestamp: now(), attentionKey };
    this.completed.set(threadId, event);
    this.nativeAttention.delete(threadId);
    return event;
  }

  private currentStatus(threadId: string, status: Thread['status'], detail: string): CodexStatusEvent {
    if (status?.type === 'idle' && this.completed.has(threadId)) return this.completed.get(threadId)!;
    const mapped = this.mapStatus(status, detail);
    const attention = this.nativeAttention.get(threadId);
    if (attention?.status === mapped.status) return attention;
    if (mapped.status !== 'unknown') this.nativeAttention.delete(threadId);
    return mapped;
  }

  private restoreNativeState(thread: Thread): CodexStatusEvent {
    const latest = thread.turns?.at(-1);
    if (thread.status?.type === 'active') {
      this.completed.delete(thread.id);
      const active = thread.turns?.findLast(turn => turn.status === 'inProgress');
      if (active && UUID.test(active.id)) this.turnIds.set(thread.id, active.id);
    } else if (thread.status?.type === 'idle' && latest && UUID.test(latest.id) && latest.status !== 'inProgress') {
      this.turnIds.delete(thread.id);
      this.completionEvent(thread.id, latest);
    }
    return this.currentStatus(thread.id, thread.status, 'Codex 原生会话已连接');
  }

  private mapStatus(status: { type?: string; activeFlags?: string[] } | undefined, detail: string): CodexStatusEvent {
    if (!status?.type || !['active', 'idle', 'notLoaded', 'systemError'].includes(status.type)) return { status: 'unknown', detail: 'Codex 未返回可识别的原生状态', timestamp: now() };
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (status?.type === 'systemError') return { status: 'error', detail: 'Codex 原生会话发生系统错误', timestamp: now() };
    if (status?.type === 'notLoaded') return { status: 'unknown', detail: 'Codex 原生会话尚未加载', timestamp: now() };
    if (flags.includes('waitingOnApproval')) return { status: 'waiting_approval', detail: 'Codex 正在等待命令审批', timestamp: now() };
    if (flags.includes('waitingOnUserInput')) return { status: 'waiting_input', detail: 'Codex 正在等待你的输入', timestamp: now() };
    if (status?.type === 'active') return { status: 'running', detail: 'Codex 原生会话正在执行', timestamp: now() };
    return { status: 'idle', detail, timestamp: now() };
  }

  private emitStatus(threadId: string, event: CodexStatusEvent): void {
    for (const listener of this.listeners) {
      try { listener(threadId, event); } catch { /* status observers must not break the bridge */ }
    }
  }

  private async observe(threadId: string): Promise<void> {
    if (this.observers.has(threadId)) return;
    const version = this.observationVersions.get(threadId) ?? 0;
    const pending = this.observing.get(threadId);
    if (pending?.version === version) return pending.promise;
    const attempt: ObservationAttempt = { version, promise: Promise.resolve() };
    const assertActive = () => {
      if ((this.observationVersions.get(threadId) ?? 0) !== version || (attempt.connection && (attempt.connection.closed || attempt.connection.generation !== this.bootGeneration))) throw new Error('Codex 状态恢复已取消');
    };
    attempt.promise = (async () => {
      const connection = await this.connect();
      attempt.connection = connection;
      try {
        assertActive();
        // Include the native turns once on (re)connection. A completion can
        // occur while our observer is offline, without the TUI disconnecting.
        const response = await this.call(connection, 'thread/resume', { threadId, excludeTurns: false });
        assertActive();
        if (response.error) throw this.rpcError(response, 'Codex 会话恢复失败');
        const thread = (response.result as { thread?: Thread } | undefined)?.thread;
        if (thread?.id !== threadId) throw new Error('Codex 返回了不匹配的恢复会话');
        this.retainObserver(threadId, connection);
        this.emitStatus(threadId, this.restoreNativeState(thread));
      } catch (error) {
        this.closeConnection(connection);
        this.connections.delete(connection);
        throw error;
      }
    })().finally(() => { if (this.observing.get(threadId) === attempt) this.observing.delete(threadId); });
    this.observing.set(threadId, attempt);
    return attempt.promise;
  }

  private retainObserver(threadId: string, connection: RpcConnection): void {
    this.observers.set(threadId, connection);
    connection.ws.once('close', () => { if (this.observers.get(threadId) === connection) this.observers.delete(threadId); });
  }

  async createSession(cwd: string, title?: string): Promise<CodexNativeSession> {
    // Codex 0.154's default paginated history cannot resume an empty thread in
    // its native TUI ("missing source rollout"). Its supported legacy history
    // contract can. Request that contract instead of modifying native files.
    // Retain the creation connection as the live status observer.
    const connection = await this.connect();
    try {
      const response = await this.call(connection, 'thread/start', { cwd: resolve(cwd), ephemeral: false, historyMode: 'legacy' });
      if (response.error) throw this.rpcError(response, 'Codex 会话创建失败');
      const thread = (response.result as { thread?: Thread } | undefined)?.thread;
      if (!thread?.id || !UUID.test(thread.id)) throw new Error('Codex 未返回有效的原生会话 ID');
      this.retainObserver(thread.id, connection);
      if (title?.trim()) {
        // The native identity already exists. A transient title write failure
        // must not make the caller create a duplicate contact.
        try {
          await this.call(connection, 'thread/name/set', { threadId: thread.id, name: title.trim().slice(0, 160) });
        } catch { /* The local card title is authoritative; native naming is optional. */ }
      }
      this.emitStatus(thread.id, connection.closed
        ? { status: 'unknown', detail: 'Codex 会话已创建，状态连接已断开', timestamp: now() }
        : this.mapStatus(thread.status, 'Codex 原生会话已连接'));
      return { nativeSessionId: thread.id, remoteUrl: this.endpoint };
    } catch (error) {
      this.closeConnection(connection);
      this.connections.delete(connection);
      throw error;
    }
  }

  async openSession(id: string, cwd?: string): Promise<CodexNativeSession> {
    validateNativeId('codex', id);
    const result = await this.rpc<{ thread?: Thread }>('thread/read', { threadId: id, includeTurns: false });
    const thread = result.thread;
    if (thread?.id !== id) throw new Error('Codex 返回了不匹配的原生会话');
    if (cwd && thread.cwd && !await sameDirectory(thread.cwd, cwd)) throw new Error('Codex 会话工作目录与联系人不一致');
    await this.observe(id);
    return { nativeSessionId: id, remoteUrl: this.endpoint };
  }

  async forkSession(id: string, cwd?: string): Promise<CodexNativeSession> {
    validateNativeId('codex', id);
    const source = await this.rpc<{ thread?: Thread }>('thread/read', { threadId: id, includeTurns: false });
    if (source.thread?.id !== id) throw new Error('Codex 返回了不匹配的原生来源会话');
    const targetCwd = cwd ? resolve(cwd) : undefined;
    const connection = await this.connect();
    try {
      const response = await this.call(connection, 'thread/fork', { threadId: id, ...(targetCwd ? { cwd: targetCwd } : {}), ephemeral: false, excludeTurns: true });
      if (response.error) throw this.rpcError(response, 'Codex Fork 失败');
      const child = (response.result as { thread?: Thread } | undefined)?.thread;
      if (!child?.id || !UUID.test(child.id) || child.id === id || child.forkedFromId !== id) throw new Error('Codex 未创建独立 Fork 会话');
      if (targetCwd && child.cwd && !await sameDirectory(child.cwd, targetCwd)) throw new Error('Codex Fork 未使用请求的工作目录');
      this.retainObserver(child.id, connection);
      if (child.status) this.emitStatus(child.id, this.mapStatus(child.status, 'Codex Fork 会话已连接'));
      return { nativeSessionId: child.id, remoteUrl: this.endpoint };
    } catch (error) {
      this.closeConnection(connection);
      this.connections.delete(connection);
      throw error;
    }
  }

  async setName(id: string, name: string): Promise<void> {
    validateNativeId('codex', id);
    if (!name.trim()) throw new Error('Codex 会话名称不能为空');
    await this.rpc('thread/name/set', { threadId: id, name: name.trim().slice(0, 160) });
  }

  async stopSession(id: string): Promise<void> {
    validateNativeId('codex', id);
    // A dead app-server cannot own a live turn. Stopping its former TUI must
    // not launch a replacement service or resurrect the archived thread.
    if (!this.ready) return;
    const existing = this.observers.get(id);
    const connection = existing ?? await this.connect();
    const temporary = !existing;
    try {
      if (temporary) {
        const resumed = await this.call(connection, 'thread/resume', { threadId: id, excludeTurns: true });
        if (resumed.error) throw this.rpcError(resumed, 'Codex 任务停止前恢复失败');
        if ((resumed.result as { thread?: Thread } | undefined)?.thread?.id !== id) throw new Error('Codex 返回了不匹配的停止目标');
      }
      let turnId = this.turnIds.get(id);
      if (!turnId) {
        const current = await this.call(connection, 'thread/read', { threadId: id, includeTurns: true });
        if (current.error) throw this.rpcError(current, '无法读取 Codex 当前任务');
        const thread = (current.result as { thread?: Thread } | undefined)?.thread;
        if (thread?.id !== id) throw new Error('Codex 返回了不匹配的停止目标');
        const turns = thread.turns ?? [];
        const active = [...turns].reverse().find(turn => turn.status === 'inProgress');
        turnId = active?.id;
        if (turnId) this.turnIds.set(id, turnId);
        else if (thread.status?.type === 'active') throw new Error('Codex 任务仍在执行，但尚未返回可中断的轮次，请在原生终端中停止');
      }
      if (!turnId) {
        this.emitStatus(id, { status: 'idle', detail: 'Codex 当前没有正在执行的任务', timestamp: now() });
        return;
      }
      const response = await this.call(connection, 'turn/interrupt', { threadId: id, turnId });
      if (response.error && !/no active turn/i.test(response.error.message ?? '')) throw this.rpcError(response, 'Codex 任务停止失败');
      this.turnIds.delete(id);
      this.completed.delete(id);
      this.nativeAttention.delete(id);
      this.emitStatus(id, { status: 'idle', detail: 'Codex 当前任务已停止，原生会话仍保留', timestamp: now() });
    } finally {
      if (temporary) { this.closeConnection(connection); this.connections.delete(connection); }
    }
  }

  /** Release one observer when a card is archived or its native process stops. */
  releaseSession(id: string): void {
    validateNativeId('codex', id);
    this.observationVersions.set(id, (this.observationVersions.get(id) ?? 0) + 1);
    const pending = this.observing.get(id);
    this.observing.delete(id);
    if (pending?.connection) this.closeConnection(pending.connection);
    this.turnIds.delete(id);
    this.completed.delete(id);
    this.nativeAttention.delete(id);
    this.invalidateObserver(id, 'Codex 原生状态观察已释放');
  }

  async getStatus(id: string): Promise<CodexStatusEvent> {
    validateNativeId('codex', id);
    const version = this.observationVersions.get(id) ?? 0;
    let readObserver: RpcConnection | undefined;
    try {
      // A native TUI may still be healthy when just our observer socket drops.
      // Recover that subscription on the next status poll, without restarting
      // the app-server or losing the native TUI's execution/approval ownership.
      if (!this.ready) return { status: 'unknown', detail: 'Codex 原生服务已断开，请重新进入会话', timestamp: now() };
      if (!this.observers.has(id)) await this.observe(id);
      if ((this.observationVersions.get(id) ?? 0) !== version) return { status: 'unknown', detail: 'Codex 原生状态观察已释放', timestamp: now() };
      const observer = this.observers.get(id);
      if (!observer) return { status: 'unknown', detail: 'Codex 原生状态连接已断开', timestamp: now() };
      readObserver = observer;
      const response = await this.call(observer, 'thread/read', { threadId: id, includeTurns: false });
      if ((this.observationVersions.get(id) ?? 0) !== version) return { status: 'unknown', detail: 'Codex 原生状态观察已释放', timestamp: now() };
      if (response?.error) throw this.rpcError(response, 'Codex 状态读取失败');
      const result = (response.result ?? {}) as { thread?: Thread };
      if (result.thread?.id !== id) return { status: 'unknown', detail: 'Codex 未返回该会话', timestamp: now() };
      const event = this.currentStatus(id, result.thread.status, 'Codex 原生会话状态已读取');
      this.emitStatus(id, event);
      return event;
    } catch (error) {
      if ((this.observationVersions.get(id) ?? 0) === version && readObserver && this.observers.get(id) === readObserver) this.invalidateObserver(id, 'Codex 原生状态读取连接已断开');
      return { status: 'unknown', detail: errorMessage(error, '无法连接 Codex 原生会话'), timestamp: now() };
    }
  }

  /** Launch native TUI against this bridge without mutating process.env. */
  remoteLaunch(id: string, executable: string, cwd?: string): CodexLaunchCommand {
    validateNativeId('codex', id);
    if (!this.ready || !this.endpoint || !this.token) throw new Error('Codex app-server 尚未就绪');
    return {
      file: executable,
      args: ['--remote', this.endpoint, '--remote-auth-token-env', TOKEN_ENV, 'resume', id, '--no-alt-screen'],
      env: { [TOKEN_ENV]: this.token, ...(cwd ? { PWD: resolve(cwd) } : {}) },
    };
  }
}
