import { parseArgs } from 'node:util';
import { backupMetadata } from '../server/backup.ts';

try {
  const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log('用法：npm run backup -- [--output /绝对路径/新备份.sqlite]\n\n备份本工具的联系人、群组、消息和投递记录；不包含原生工具历史。\n默认保存到当前 SESSIONDECK_DATA_DIR 的 backups 目录；遵循 SESSIONDECK_DEMO。\n可在 Web 服务运行时使用，不会启动 Agent 或改变运行状态，禁止覆盖已有文件。');
  } else {
    if (values.output !== undefined && !values.output.trim()) throw new Error('--output 不能为空');
    const result = await backupMetadata({ output: values.output });
    // Paths and counts only. No conversation content or credentials are printed.
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
