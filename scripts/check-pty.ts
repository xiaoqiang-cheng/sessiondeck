import { checkPty } from '../server/pty-health.ts';

try { await checkPty(); }
catch (error) {
  console.error(`原生终端不可用：${error instanceof Error ? error.message : String(error)}。请运行 npm ci 后重试；原生编译需要系统开发工具。`);
  process.exitCode = 1;
}
