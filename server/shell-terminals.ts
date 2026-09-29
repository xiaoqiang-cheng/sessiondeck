import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { Terminals } from './terminal.ts';
import type { ShellTerminal } from '../shared/shell.ts';

/** Interactive shells own a separate PTY namespace from agent contacts. */
export class ShellTerminals extends EventEmitter {
  private readonly terminals = new Terminals();
  private readonly entries = new Map<string, ShellTerminal>();
  private serial = 0;
  private closed = false;
  constructor(private readonly shell = loginShell()) {
    super();
    this.terminals.on('data', (id: string, data: string) => this.emit('data', id, data));
    this.terminals.on('exit', (id: string, exitCode: number) => {
      const entry = this.entries.get(id);
      if (entry) { entry.running = false; entry.exitCode = exitCode; }
      this.emit('exit', id, exitCode);
    });
  }
  list(): ShellTerminal[] { return [...this.entries.values()].map(entry => ({ ...entry })); }
  get(id: string): ShellTerminal | undefined { const entry = this.entries.get(id); return entry ? { ...entry } : undefined; }
  buffer(id: string) { return this.terminals.buffer(id); }
  generation(id: string) { return this.terminals.generation(id); }
  create(cwd: string, sessionId: string | null = null): ShellTerminal {
    if (this.closed) throw Object.assign(new Error('终端服务正在关闭'), { status: 503 });
    if (this.entries.size >= 16) throw Object.assign(new Error('最多同时保留 16 个终端，请先关闭不再使用的终端'), { status: 409 });
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('终端工作目录无效');
    const id = randomUUID();
    const entry: ShellTerminal = { id, title: `${basename(this.shell)} ${++this.serial}`, cwd, sessionId, shell: this.shell, createdAt: new Date().toISOString(), running: true, exitCode: null };
    const name = basename(this.shell).toLowerCase();
    const args = process.platform === 'win32' ? name.startsWith('powershell') || name.startsWith('pwsh') ? ['-NoLogo'] : [] : ['-i'];
    this.entries.set(id, entry);
    try {
      this.terminals.start({ id, cwd }, { file: this.shell, args });
      return { ...entry };
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
  }
  input(id: string, data: string) { this.terminals.input(id, data); }
  resize(id: string, cols: number, rows: number) { this.terminals.resize(id, cols, rows); }
  async remove(id: string) {
    await this.terminals.stop(id);
    this.entries.delete(id);
  }
  async close() {
    this.closed = true;
    await this.terminals.close();
    this.entries.clear();
  }
}

function loginShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  // Read the service user's account setting; a nested Agent's environment is
  // not authoritative about which interactive shell that user configured.
  try { const shell = userInfo().shell; if (shell && isAbsolute(shell)) return shell; } catch { /* Fall back when account databases are unavailable. */ }
  return process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
}
