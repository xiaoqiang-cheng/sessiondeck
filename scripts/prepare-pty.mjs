import { createRequire } from 'node:module';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// node-pty 1.1.0 ships some macOS prebuilt helpers without executable bits.
// Repair only the dependency's known helpers, including restored caches.
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
    const helper = join(root, directory, 'spawn-helper');
    if (existsSync(helper)) {
      const mode = statSync(helper).mode;
      if (!(mode & 0o100)) chmodSync(helper, (mode & 0o777) | 0o111);
    }
  }
}
