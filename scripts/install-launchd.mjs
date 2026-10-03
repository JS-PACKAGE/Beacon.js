import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, access, chmod, chown, lstat } from 'node:fs/promises';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--directory', '--user', '--node', '--config'].includes(key) || !value || options.has(key)) {
    throw new Error('Usage: sudo node scripts/install-launchd.mjs --directory PATH --user NONROOT_USER --node ABSOLUTE_NODE [--config PATH]');
  }
  options.set(key, value);
}
if (process.platform !== 'darwin') throw new Error('launchd installer requires macOS');
const directory = resolve(options.get('--directory') ?? '.');
const user = options.get('--user');
const node = options.get('--node');
if (!user || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(user) || user === 'root') throw new Error('--user must name a non-root target user');
if (!node || !isAbsolute(node)) throw new Error('--node must be an absolute Node 26 binary path');
if (process.getuid() !== 0) throw new Error('LaunchDaemon installation requires sudo; application runs as the non-root target user');
const safeEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
function identity(args) {
  const result = spawnSync('/usr/bin/id', args, { encoding: 'utf8', env: safeEnv });
  if (result.error || result.status !== 0) throw new Error('Cannot resolve target user identity');
  return result.stdout.trim();
}
const uid = Number(identity(['-u', user]));
const gid = Number(identity(['-g', user]));
const group = identity(['-gn', user]);
if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0 || !group) throw new Error('Invalid non-root target identity');
const homeResult = spawnSync('/usr/bin/dscl', ['/Search', '-read', `/Users/${user}`, 'NFSHomeDirectory'], { encoding: 'utf8', env: safeEnv });
const home = homeResult.stdout?.trim().replace(/^NFSHomeDirectory:\s*/, '');
if (homeResult.error || homeResult.status !== 0 || !home || !isAbsolute(home)) throw new Error('Cannot resolve target user home');
const env = { ...safeEnv, HOME: home, USER: user, LOGNAME: user };
await access(node);
await access(join(directory, 'dist/main.js'));
await access(join(directory, 'dist/config.js'));
const configPath = resolve(directory, options.get('--config') ?? 'config.yaml');
function run(binary, args, asTarget = false) {
  const result = spawnSync(binary, args, { cwd: directory, stdio: 'inherit', env, ...(asTarget ? { uid, gid } : {}) });
  if (result.error || result.status !== 0) throw new Error('Deployment prerequisite or launchctl action failed');
}
// Compile and typecheck as the standard user before invoking this installer.
// Even validation of project code executes with the target uid/gid, never root.
run(node, ['--input-type=module', '-e', 'if(Number(process.versions.node.split(".")[0])<26)process.exit(1)'], true);
run(node, ['--input-type=module', '-e', `const {loadConfig}=await import(${JSON.stringify(pathToFileURL(join(directory, 'dist/config.js')).href)});await loadConfig(${JSON.stringify(configPath)});`], true);
const plistPath = '/Library/LaunchDaemons/app.ysgs.beacon.plist';
const logs = join(directory, 'logs');
await mkdir(dirname(plistPath), { recursive: true });
await mkdir(logs, { recursive: true, mode: 0o700 });
if (!(await lstat(logs)).isDirectory() || (await lstat(logs)).isSymbolicLink()) throw new Error('Logs path must be a real directory');
await chmod(logs, 0o700);
await chown(logs, uid, gid);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>app.ysgs.beacon</string>
<key>UserName</key><string>${escape(user)}</string>
<key>GroupName</key><string>${escape(group)}</string>
<key>ProgramArguments</key><array>${[node, join(directory, 'dist/main.js'), '--config', configPath].map(v => `<string>${escape(v)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escape(directory)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${escape(key)}</key><string>${escape(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${escape(join(logs, 'beacon.out.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(logs, 'beacon.err.log'))}</string>
</dict></plist>
`;
// Exclusive creation preserves any existing deployment, including a symlink.
await writeFile(plistPath, plist, { flag: 'wx', mode: 0o644 });
await chown(plistPath, 0, 0); // root:wheel on macOS
await chmod(plistPath, 0o644);
run('/bin/launchctl', ['bootstrap', 'system', plistPath]);
console.log('Boot-start LaunchDaemon installed; application runs as the non-root target user. Check launchctl print system/app.ysgs.beacon and private logs.');
