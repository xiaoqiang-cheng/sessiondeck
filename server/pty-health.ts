import { spawn } from 'node-pty';

export async function checkPty(): Promise<void> {
  await new Promise<void>((accept, reject) => {
    let output = '';
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("sessiondeck-pty-ok")'], {
      name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string>,
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('终端响应超时')); }, 5000);
    child.onData(data => { output += data; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 && output.includes('sessiondeck-pty-ok')) accept();
      else reject(new Error(`终端检查失败（退出码 ${exitCode}）`));
    });
  });
}
