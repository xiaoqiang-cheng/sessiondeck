import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface InstanceLock { release(): Promise<void> }

/** An exclusive transaction holds an OS file lock until close or process death.
 * Keep the file: unlinking it could let two owners lock different inodes.
 * Unlike Unix sockets this handles long paths without stale PID recovery. */
export async function acquireInstanceLock(dataDir: string): Promise<InstanceLock> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const canonical = await realpath(dataDir);
  const path = join(canonical, 'instance-lock.sqlite');
  const db = new DatabaseSync(path);
  try {
    await chmod(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch (error) {
    db.close();
    if (error instanceof Error && /database is (?:locked|busy)/i.test(error.message))
      throw new Error(`这个数据目录已有 SessionDeck 实例在使用：${canonical}。请关闭该实例，或设置不同的 SESSIONDECK_DATA_DIR。`);
    throw error;
  }
  let released = false;
  return { async release() { if (!released) { released = true; db.close(); } } };
}
