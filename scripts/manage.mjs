import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openDatabase, backup } from '../src/core/sqlite.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readJson(file, hint) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${hint} (${file}): ${error?.message ?? error}`);
  }
}
const deploy = readJson(path.join(root, '.deployment.json'),
  'Cannot read the deployment record — run manage.sh from the installation directory (the one holding .deployment.json)');
const cfg = readJson(path.join(deploy.data, 'config.json'),
  'Cannot read the deployed configuration');
const command = process.argv[2] || 'status';
const systemctl = (action) => {
  const r = spawnSync('systemctl', ['--user', action, `${deploy.service}.service`, '--no-pager'], { stdio: 'inherit' });
  process.exitCode = r.status || 0;
};
const host = cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host;
const base = `http://${host}:${cfg.server.port}`;
async function api(route, body) {
  const res = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-console-token': cfg.server.token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
  return result;
}
if (['start', 'stop', 'restart', 'status'].includes(command)) {
  systemctl(command);
} else if (command === 'logs') {
  spawnSync('journalctl', ['--user', '-u', `${deploy.service}.service`, '-n', '100', '--no-pager'], { stdio: 'inherit' });
} else if (command === 'token') {
  console.log(cfg.server.token);
} else if (command === 'observe' || command === 'activate') {
  const active = command === 'activate';
  const confirm = process.argv.includes('--confirm-exclusive');
  if (active && !confirm) throw new Error('Stop/exclude the old instance first, then use activate --confirm-exclusive');
  console.log(await api('/api/runtime', { mode: active ? 'active' : 'observe',
    confirmExclusive: confirm, skipBacklog: active && !process.argv.includes('--with-backlog') }));
} else if (command === 'health') {
  console.log(JSON.stringify(await api('/api/status'), null, 2));
} else if (command === 'update-status') {
  console.log(JSON.stringify(await api('/api/auto-update/status'), null, 2));
} else if (command === 'update-now') {
  if (!process.argv.includes('--confirm')) {
    throw new Error('Use update-now --confirm');
  }
  console.log(JSON.stringify(await api('/api/auto-update/run', { confirm: true }), null, 2));
} else if (command === 'update-resume') {
  if (!process.argv.includes('--confirm')) {
    throw new Error('Use update-resume --confirm after configuring the administrator in the console');
  }
  console.log(JSON.stringify(await api('/api/auto-update/resume', {
    confirm: true,
    ownerUin: cfg.autoUpdate?.ownerUin || '',
    intervalHours: cfg.autoUpdate?.intervalHours || 6
  }), null, 2));
} else if (command === 'update-pause') {
  if (!process.argv.includes('--confirm')) throw new Error('Use update-pause --confirm');
  console.log(JSON.stringify(await api('/api/auto-update/pause', { confirm: true }), null, 2));
} else if (command === 'retry-failed' || command === 'resolve-held') {
  const key = process.argv[3];
  if (!/^(group|private):\d+$/.test(key || '') || !process.argv.includes('--confirm')) {
    throw new Error(`${command} group:123 --confirm (resolve-held acknowledges reviewed delivery; it does not resend)`);
  }
  console.log(await api(`/api/chats/${key.replace(':', '_')}/${command}`, { confirm: true }));
} else if (command === 'backup') {
  const target = process.argv[3];
  if (!target || fs.existsSync(target)) throw new Error('Provide a new backup directory');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const db = openDatabase(path.join(deploy.data, 'messages.sqlite'), { readOnly: true });
  try { await backup(db, path.join(target, 'messages.sqlite')); } finally { db.close(); }
  // 复制数据目录下的全部条目，只跳过可重建的临时物。写死清单会随功能增加而漏掉东西
  // （身份/关系/事故台账、daily-moments、群动态与主动发言状态都曾经在清单之外）。
  const skip = new Set(['deploy-backups', 'update-work', 'update-repository.git']);
  for (const entry of fs.readdirSync(deploy.data, { withFileTypes: true })) {
    const { name } = entry;
    if (skip.has(name) || name.startsWith('.')) continue;
    // messages.sqlite 已用 SQLite backup API 取了一致快照；WAL/SHM 跟过去反而会
    // 让恢复时的库和旧日志对不上。
    if (name === 'messages.sqlite' || name.startsWith('messages.sqlite-')) continue;
    if (name.endsWith('.lock')) continue;
    fs.cpSync(path.join(deploy.data, name), path.join(target, name), { recursive: true });
  }
  console.log(`Backup saved to ${target}`);
} else {
  throw new Error('Commands: status start stop restart logs health token observe activate update-status update-now update-resume update-pause retry-failed resolve-held backup');
}
