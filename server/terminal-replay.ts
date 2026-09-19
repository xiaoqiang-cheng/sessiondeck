import headless from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal as BrowserTerminal } from '@xterm/xterm';

/** Keep terminal state, rather than a raw suffix that can begin mid escape sequence.
 * Memory is bounded by scrollback rows; nothing is written to disk. */
export class TerminalReplay {
  private terminal: headless.Terminal;
  private serialize: SerializeAddon;
  private pending = new Map<number, string>();
  private sequence = 0;
  private closed = false;
  private pendingSize = 0;
  private onDrain?: () => void;

  constructor(cols = 100, rows = 30) {
    this.terminal = new headless.Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true, logLevel: 'off' });
    this.serialize = new SerializeAddon();
    // The official addon supports the shared buffer API of headless and browser xterm;
    // its published TypeScript signature only names the browser class.
    this.serialize.activate(this.terminal as unknown as BrowserTerminal);
  }

  write(data: string, onDrain?: () => void) {
    if (this.closed) return;
    const sequence = ++this.sequence;
    this.pending.set(sequence, data);
    this.pendingSize += data.length;
    if (onDrain) this.onDrain = onDrain;
    this.terminal.write(data, () => {
      if (this.closed) return;
      this.pending.delete(sequence);
      this.pendingSize -= data.length;
      if (this.pendingSize < 262144) this.onDrain?.();
    });
  }

  get backlogged() { return this.pendingSize > 1_048_576; }

  snapshot(): string {
    if (this.closed) return '';
    // xterm writes asynchronously. Include unparsed writes exactly once so a just-opened
    // browser never misses output produced in the current event-loop turn.
    return this.serialize.serialize({ scrollback: 1000 }) + [...this.pending.values()].join('');
  }

  resize(cols: number, rows: number) {
    if (!this.closed) this.terminal.resize(cols, rows);
  }

  close() {
    this.closed = true;
    this.pending.clear();
    this.onDrain = undefined;
    this.serialize.dispose();
    this.terminal.dispose();
  }
}
