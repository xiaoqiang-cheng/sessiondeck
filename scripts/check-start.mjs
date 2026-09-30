import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Keep these settings aligned with server/index.ts. This runs before npm ci,
// so it deliberately depends only on Node builtins.
const port = Number(process.env.PORT || process.env.SESSIONDECK_PORT || 4317);
const host = (process.env.HOST || process.env.SESSIONDECK_HOST || '127.0.0.1').trim().replace(/^\[(.*)\]$/, '$1');
const dataDir = resolve(process.env.SESSIONDECK_DATA_DIR || join(homedir(), '.local/share', process.env.SESSIONDECK_DEMO === '1' ? 'sessiondeck-demo' : 'sessiondeck'));

async function checkPort() {
  const probe = createServer();
  try {
    await new Promise((accept, reject) => {
      probe.once('error', reject);
      probe.listen({ host, port, exclusive: true }, () => probe.close(error => error ? reject(error) : accept()));
    });
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(`端口 ${host}:${port} 已被占用，未安装依赖或构建。请使用现有实例，或设置不同的 PORT / SESSIONDECK_PORT 和 SESSIONDECK_DATA_DIR。`);
    }
    throw new Error(`无法监听 ${host}:${port}：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkDataDirectory() {
  const path = join(dataDir, 'instance-lock.sqlite');
  try { await stat(path); }
  catch (error) {
    // A new data directory has no lease to inspect. Do not create any files.
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  let db;
  try {
    // Probe only the existing lease, never the metadata database. Read-only
    // opening also prevents accidental recreation if the file disappears.
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK;');
  } catch (error) {
    if (error instanceof Error && /database is (?:locked|busy)/i.test(error.message)) {
      const canonical = await realpath(dataDir);
      throw new Error(`这个数据目录已有 SessionDeck 实例在使用：${canonical}。未安装依赖或构建。请使用现有实例，或设置不同的 SESSIONDECK_DATA_DIR 和 PORT / SESSIONDECK_PORT。`);
    }
    throw error;
  } finally { db?.close(); }
}

try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SESSIONDECK_PORT 必须是 1024–65535 的端口号（PORT 优先）。');
  if (!host) throw new Error('SESSIONDECK_HOST 不能为空（HOST 优先）。');
  await checkPort();
  await checkDataDirectory();
} catch (error) {
  console.error(`SessionDeck 启动检查未通过：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
