import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function copyAtomically(source: string, target: string) {
  const temporary = join(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Keep old hashed chunks for open tabs and switch HTML only after all new
 * assets exist. Neither a failed build nor a rebuild empties the live site. */
export async function publishClientBuild(staging: string, destination: string) {
  const index = join(staging, 'index.html');
  if (!(await stat(index)).isFile()) throw new Error('前端构建缺少 index.html');
  async function copyDirectory(source: string, target: string) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name), to = join(target, entry.name);
      if (from === index) continue;
      if (entry.isDirectory()) await copyDirectory(from, to);
      else if (entry.isFile()) await copyAtomically(from, to);
      else throw new Error(`前端构建包含不支持的文件类型：${entry.name}`);
    }
  }
  await copyDirectory(staging, destination);
  await copyAtomically(index, join(destination, 'index.html'));
}

async function buildClient() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const destination = resolve(process.env.SESSIONDECK_CLIENT_DIR || join(root, 'dist/client'));
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.sessiondeck-build-'));
  try {
    const { build } = await import('vite');
    await build({ root, build: { outDir: staging, emptyOutDir: true } });
    await publishClientBuild(staging, destination);
    console.log(`前端构建就绪：${destination}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildClient();
