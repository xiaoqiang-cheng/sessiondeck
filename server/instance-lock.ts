import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface InstanceLock { release(): Promise<void> }

/** The lock must be acquired before Store recovery mutates persisted state.
 * Linux abstract sockets and Windows named pipes are kernel owned: they vanish
 * even after SIGKILL, so stale PIDs and PID reuse cannot steal another lock. */
export async function acquireInstanceLock(dataDir: string): Promise<InstanceLock> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const canonical = await realpath(dataDir);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 40);
  const filesystemSocket = process.platform !== 'linux' && process.platform !== 'win32';
  const path = process.platform === 'linux' ? `\0sessiondeck-${key}`
    : process.platform === 'win32' ? `\\\\.\\pipe\\sessiondeck-${key}`
    : join(canonical, '.instance.sock');
  const server = createServer(socket => socket.end());
  try {
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.removeListener('error', reject); accept(); });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`这个数据目录已有 SessionDeck 实例在使用：${canonical}。请关闭该实例，或设置不同的 SESSIONDECK_DATA_DIR。${filesystemSocket ? '若上次异常退出，请确认没有实例运行后删除目录中的 .instance.sock。' : ''}`);
    }
    throw error;
  }
  server.unref();
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
      // Node normally removes its filesystem socket on close. Do not remove
      // any path after releasing the lock: another instance may already own it.
    },
  };
}
