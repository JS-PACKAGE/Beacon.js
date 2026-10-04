import { spawnSync } from 'node:child_process';
import { access, chmod, chown, lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--directory', '--user', '--node', '--config'].includes(key) || !value || options.has(key)) {
    throw new Error('Usage: sudo node scripts/install-systemd.mjs --directory PATH --user NONROOT_USER --node ABSOLUTE_NODE [--config PATH]');
  }
  options.set(key, value);
}
if (process.platform !== 'linux') throw new Error('systemd installer requires Linux');
const directory = resolve(options.get('--directory') ?? '.');
const user = options.get('--user');
const node = options.get('--node');
if (!user || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(user) || user === 'root') throw new Error('--user must name a non-root target user');
if (!node || !isAbsolute(node)) throw new Error('--node must be an absolute Node 26 binary path');
if (process.getuid() !== 0) throw new Error('systemd installation requires sudo; application runs as the non-root target user');
const id = spawnSync('/usr/bin/id', ['-u', user], { encoding: 'utf8' });
const group = spawnSync('/usr/bin/id', ['-gn', user], { encoding: 'utf8' });
if (id.status !== 0 || group.status !== 0) throw new Error('Cannot resolve target user identity');
const uid = Number(id.stdout.trim());
const gid = Number(spawnSync('/usr/bin/id', ['-g', user], { encoding: 'utf8' }).stdout.trim());
if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error('Invalid non-root target identity');
await access(node);
await access(join(directory, 'dist/main.js'));
await access(join(directory, 'dist/config.js'));
const configPath = resolve(directory, options.get('--config') ?? 'config.yaml');
const validate = spawnSync(node, ['--input-type=module', '-e', `const {loadConfig}=await import(${JSON.stringify(pathToFileURL(join(directory, 'dist/config.js')).href)});await loadConfig(${JSON.stringify(configPath)});`], { cwd: directory, uid, gid, stdio: 'inherit' });
if (validate.status !== 0) throw new Error('Config validation failed as the target user');
const unitPath = '/etc/systemd/system/beacon.service';
const logs = join(directory, 'logs');
await mkdir(logs, { recursive: true, mode: 0o700 });
if (!(await lstat(logs)).isDirectory() || (await lstat(logs)).isSymbolicLink()) throw new Error('Logs path must be a real directory');
await chmod(logs, 0o700);
await chown(logs, uid, gid);
const unit = `[Unit]
Description=Beacon.js game lobby
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${group.stdout.trim()}
WorkingDirectory=${directory}
ExecStart=${node} ${join(directory, 'dist/main.js')} --config ${configPath}
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${directory}
UMask=0077
StandardOutput=append:${join(logs, 'beacon.out.log')}
StandardError=append:${join(logs, 'beacon.err.log')}

[Install]
WantedBy=multi-user.target
`;
await writeFile(unitPath, unit, { flag: 'wx', mode: 0o644 });
const reload = spawnSync('/usr/bin/systemctl', ['daemon-reload'], { stdio: 'inherit' });
if (reload.status !== 0) throw new Error('systemctl daemon-reload failed');
const enable = spawnSync('/usr/bin/systemctl', ['enable', '--now', 'beacon.service'], { stdio: 'inherit' });
if (enable.status !== 0) throw new Error('systemctl enable failed');
console.log('systemd unit installed; application runs as the non-root target user. Check systemctl status beacon.service and private logs.');
