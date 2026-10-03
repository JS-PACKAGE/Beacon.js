import { lstat, mkdir } from 'node:fs/promises';
import { dirname, parse, resolve, sep } from 'node:path';

export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory');
  }
  const info = await lstat(absolute);
  if ((info.mode & 0o077) !== 0) throw new Error('Directory must be private');
  return absolute;
}

export async function privateParent(path: string): Promise<void> { await privateDirectory(dirname(resolve(path))); }
