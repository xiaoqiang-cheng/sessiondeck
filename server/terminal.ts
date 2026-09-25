import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { TerminalReplay } from './terminal-replay.ts';
import { OwnedProcess } from './owned-process.ts';
import type { Session, SessionStatus } from '../shared/types.ts';

export interface LaunchCommand { file: string; args: string[]; nativeSessionId?: string; env?: Record<string, string> }
interface LiveTerminal { process: pty.IPty; owner: OwnedProcess; replay: TerminalReplay; tail: string; paused: boolean }

export function stripTerminal(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

/** Hints are explicitly marked as terminal estimates, never native truth. */
export function inferTerminalStatus(text: string): { status: SessionStatus; detail: string } | null {
  const tail = stripTerminal(text).slice(-2500);
  if (/(?:do you (?:want to |wish to )?(?:allow|approve|proceed)|allow this (?:command|tool)|requires? (?:your )?approval|需要.{0,8}(?:批准|授权))/i.test(tail))
    return { status: 'waiting_approval', detail: '终端提示可能需要审批，请进入确认' };
  if (/(?:press enter to (?:continue|confirm)|select (?:an? )?option|waiting for (?:your |user )?input|需要你.{0,5}(?:确认|输入)|enter to select)/i.test(tail))
    return { status: 'waiting_input', detail: '终端提示可能需要输入，请进入确认' };
  if (/\besc(?:ape)? to interrupt\b/i.test(tail))
    return { status: 'running', detail: '原生终端显示任务执行中（估测）' };
  return null;
}

export class Terminals extends EventEmitter {
  private live = new Map<string, LiveTerminal>();
  private ended = new Map<string, string>();
  private stopping = new Map<string, Promise<void>>();
  private closed = false;
  has(id: string) { return this.live.has(id); }
  isStopping(id: string) { return this.stopping.has(id); }
  buffer(id: string) { return this.live.get(id)?.replay.snapshot() ?? this.ended.get(id) ?? ''; }
  start(session: Session, command: LaunchCommand) {
    if (this.closed) throw new Error('终端管理服务正在关闭');
    if (this.stopping.has(session.id)) throw new Error('会话正在停止，请等待原生进程退出');
    if (this.live.has(session.id)) return;
    const env = { ...process.env, ...command.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
    delete env.SESSIONDECK_TOKEN;
    // Each new Claude instance is an independent contact, not a nested SDK call.
    delete env.CLAUDECODE;
    const child = pty.spawn(command.file, command.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: session.cwd, env });
    this.ended.delete(session.id);
    let exited!: () => void;
    const exit = new Promise<void>(accept => { exited = accept; });
    const owner = new OwnedProcess(child.pid, exit, signal => child.kill(signal));
    const live: LiveTerminal = { process: child, owner, replay: new TerminalReplay(), tail: '', paused: false };
    this.live.set(session.id, live);
    child.onData(data => {
      if (this.live.get(session.id) !== live) return;
      live.replay.write(data, () => {
        if (live.paused && this.live.get(session.id) === live) { live.paused = false; live.process.resume(); }
      });
      if (live.replay.backlogged && !live.paused) { live.paused = true; live.process.pause(); }
      live.tail = (live.tail + data).slice(-4000);
      this.emit('data', session.id, data);
      const hint = inferTerminalStatus(live.tail);
      if (hint) this.emit('hint', session.id, hint);
    });
    child.onExit(event => {
      exited();
      if (this.stopping.has(session.id)) return; // stop owns the final event, including descendant cleanup.
      if (this.live.get(session.id) !== live) return;
      this.remember(session.id, live, event.exitCode);
      this.live.delete(session.id);
      this.emit('exit', session.id, event.exitCode);
    });
  }
  input(id: string, data: string) {
    if (this.stopping.has(id)) throw new Error('会话正在停止，暂时无法输入');
    const live = this.live.get(id);
    if (!live) throw new Error('会话尚未启动或已经退出');
    live.tail = '';
    live.process.write(data);
    this.emit('input', id, data);
  }
  stage(id: string, text: string) {
    // Never submit on the user's behalf: a TUI might be at an approval prompt.
    // A single line is safe even if a native TUI doesn't implement bracketed paste.
    const clean = text.replace(/[\r\n]+/g, '  ').replace(/[\x00-\x1f\x7f]/g, '');
    this.input(id, `\x1b[200~${clean}\x1b[201~`);
  }
  resize(id: string, cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 500 || rows < 3 || rows > 300) return;
    const live = this.live.get(id);
    live?.replay.resize(cols, rows);
    live?.process.resize(cols, rows);
  }
  stop(id: string): Promise<void> {
    const pending = this.stopping.get(id);
    if (pending) return pending;
    const live = this.live.get(id);
    if (!live) return Promise.resolve();
    // Install the per-contact barrier before signaling. A failed cleanup keeps
    // the barrier and live entry: never claim success or launch a replacement.
    const stopped = Promise.resolve().then(() => live.owner.stop('SIGHUP')).then(() => {
      this.remember(id, live, 0);
      this.live.delete(id);
      this.stopping.delete(id);
      this.emit('exit', id, 0);
    });
    this.stopping.set(id, stopped);
    return stopped;
  }
  private remember(id: string, live: LiveTerminal, exitCode: number) {
    this.ended.delete(id);
    this.ended.set(id, `${live.replay.snapshot()}\r\n\x1b[90m[进程已退出 · ${exitCode}]\x1b[0m\r\n`);
    live.replay.close();
    while (this.ended.size > 10) this.ended.delete(this.ended.keys().next().value!);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live.keys()].map(id => this.stop(id)));
    this.ended.clear();
  }
}
