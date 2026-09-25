import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Native tools canonicalize cwd, including macOS /var and /tmp aliases. */
export async function sameDirectory(first: string, second: string): Promise<boolean> {
  try {
    const paths = await Promise.all([realpath(resolve(first)), realpath(resolve(second))]);
    return paths[0] === paths[1];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
