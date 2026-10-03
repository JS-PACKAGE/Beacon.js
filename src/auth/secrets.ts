import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';

export function readSecretFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 8192 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    const bytes = Buffer.alloc(8193);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    const token = bytes.subarray(0, used).toString('utf8').trim();
    if (used > 8192 || !token || /[^\x21-\x7e]/u.test(token)) throw new Error();
    return token;
  } catch { throw new Error('Invalid private token file'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
