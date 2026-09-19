import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node-pty';
import { getBackendInfo } from '../server/adapters.ts';

// Read-only checks plus a short-lived local PTY. No agent is started and no model is called.
type Check = { label: string; state: 'ok' | 'warn' | 'error'; detail: string };
const checks: Check[] = [];
const dataDir = resolve(process.env.SESSIONDECK_DATA_DIR || join(homedir(), '.local/share', process.env.SESSIONDECK_DEMO === '1' ? 'sessiondeck-demo' : 'sessiondeck'));
const port = Number(process.env.PORT || process.env.SESSIONDECK_PORT || 4317);
checks.push({ label: 'Node.js', state: Number(process.versions.node.split('.')[0]) >= 24 ? 'ok' : 'error', detail: process.version });

try {
  let candidate = dataDir;
  while (true) {
    try {
      if (!(await stat(candidate)).isDirectory()) throw new Error('路径不是目录');
      await access(candidate, constants.W_OK | constants.X_OK);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === dirname(candidate)) throw error;
      candidate = dirname(candidate);
    }
  }
  checks.push({ label: '本地数据目录', state: 'ok', detail: dataDir });
} catch (error) { checks.push({ label: '本地数据目录', state: 'error', detail: `${dataDir}：${error instanceof Error ? error.message : '无法访问'}` }); }

try {
  await new Promise<void>((accept, reject) => {
    let output = '';
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("sessiondeck-pty-ok")'], { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
    const timer = setTimeout(() => { child.kill(); reject(new Error('终端响应超时')); }, 5000);
    child.onData(data => { output += data; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0 && output.includes('sessiondeck-pty-ok')) accept();
      else reject(new Error(`终端检查失败（退出码 ${exitCode}）`));
    });
  });
  checks.push({ label: '原生终端', state: 'ok', detail: 'node-pty 可以启动本地进程并读取输出' });
} catch (error) { checks.push({ label: '原生终端', state: 'error', detail: error instanceof Error ? error.message : String(error) }); }

for (const backend of await getBackendInfo()) checks.push({
  label: backend.label,
  state: backend.installed ? 'ok' : 'warn',
  detail: backend.installed ? `${backend.version || '已发现命令'}；恢复 ${backend.capabilities.resume ? '可用' : '未确认'}，Fork ${backend.capabilities.fork ? '可用' : '未确认'}` : '未找到命令；安装后在网页“连接与能力”中刷新',
});

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
  const state = await response.json() as { sessions?: unknown[]; groups?: unknown[]; demo?: boolean };
  if (!response.ok || !Array.isArray(state.sessions) || !Array.isArray(state.groups)) throw new Error('端口上运行的服务不是可用的 SessionDeck');
  checks.push({ label: 'Web 服务', state: 'ok', detail: `http://127.0.0.1:${port}${state.demo ? '（演示模式）' : ''}` });
} catch { checks.push({ label: 'Web 服务', state: 'warn', detail: `当前未连接；运行 npm run dev，或构建后 npm start（端口 ${port}）` }); }

console.log('SessionDeck 本地环境检查\n');
for (const check of checks) console.log(`${check.state === 'ok' ? '✓' : check.state === 'warn' ? '·' : '✗'} ${check.label}：${check.detail}`);
console.log('\n这里只检查本地运行条件，不检查账号凭据或调用模型。');
process.exitCode = checks.some(check => check.state === 'error') ? 1 : 0;
