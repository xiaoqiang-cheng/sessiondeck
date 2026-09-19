import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

interface ProcessIdentity { pid: number; parent: number; session: number; birth: string; state: string }

function identity(pid: number): ProcessIdentity | undefined {
  if (process.platform !== 'linux') return;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, parent: Number(fields[1]), session: Number(fields[3]), state: fields[0]!, birth: fields[19]! };
  } catch { return; }
}

function sameProcess(expected: ProcessIdentity): boolean {
  const current = identity(expected.pid);
  return !!current && current.birth === expected.birth && current.state !== 'Z' && current.state !== 'X';
}

/** Captures only current descendants of this exact Linux process instance.
 * Signals never target a process group or an unverified, potentially reused PID.
 * A descendant already deliberately detached before this snapshot is not owned. */
function descendants(root: ProcessIdentity | undefined): ProcessIdentity[] {
  if (!root || !sameProcess(root)) return [];
  const children = new Map<number, ProcessIdentity[]>();
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const item = identity(Number(entry));
      if (!item) continue;
      const siblings = children.get(item.parent) ?? [];
      siblings.push(item); children.set(item.parent, siblings);
    }
  } catch { return []; }
  if (!sameProcess(root)) return [];
  const found: ProcessIdentity[] = [], visited = new Set<number>([root.pid]);
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child.pid) || child.session !== root.session) continue;
      visited.add(child.pid); visit(child.pid); found.push(child);
    }
  };
  visit(root.pid);
  return found;
}

/** One owner per child instance. Repeated stop calls join the same cleanup;
 * callbacks and the captured birth identity prevent a late timer touching a
 * replacement. The promise deliberately keeps shutdown alive through escalation. */
export class OwnedProcess {
  private readonly original: ProcessIdentity | undefined;
  private exited = false;
  private stopping?: Promise<void>;
  constructor(private readonly pid: number, exited: Promise<void>, private readonly signal: (signal: NodeJS.Signals) => void) {
    this.original = identity(pid);
    void exited.then(() => { this.exited = true; }, () => { this.exited = true; });
  }

  stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    return this.stopping ??= this.retire(signal);
  }

  private async retire(initial: NodeJS.Signals): Promise<void> {
    const children = descendants(this.original);
    const signalOwned = (signal: NodeJS.Signals) => {
      for (const child of children) if (sameProcess(child)) {
        try { process.kill(child.pid, signal); } catch { /* already exited */ }
      }
      if (!this.exited && (process.platform !== 'linux' || (this.original && sameProcess(this.original)))) {
        try { this.signal(signal); } catch { /* already exited */ }
      }
    };
    signalOwned(initial);
    const deadline = Date.now() + 1000;
    while ((!this.exited || children.some(sameProcess)) && Date.now() < deadline) await delay(20);
    if (!this.exited || children.some(sameProcess)) signalOwned('SIGKILL');
    const killDeadline = Date.now() + 2000;
    while ((!this.exited || children.some(sameProcess)) && Date.now() < killDeadline) await delay(20);
    if (!this.exited || children.some(sameProcess)) throw new Error(`原生进程 ${this.pid} 未能在关闭期限内退出`);
  }
}
