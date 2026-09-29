export interface ShellTerminal {
  id: string;
  title: string;
  cwd: string;
  sessionId: string | null;
  shell: string;
  createdAt: string;
  running: boolean;
  exitCode: number | null;
}
