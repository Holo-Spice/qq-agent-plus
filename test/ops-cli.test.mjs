// ops.js 子命令的参数透传（2026-09-30 审查 P2 回归护栏）。
//
// 背景：`audit-prune` 的 help 与 docs/OPS.md 都写了 `--data=目录`，但它原先用 `config({})`，
// 完全忽略该参数 —— 未知参数在这个 CLI 里不算错误，于是 `--data=/other/data` 会静默去删
// **默认**数据目录（或 /data/qq-agent/data）的审计文件。同类子命令都透传了 --data。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

const repo = path.resolve('.');

function runOps(args, env = {}) {
  // 关键：清掉 QQ_AGENT_DATA_DIR 等回退来源 —— 否则 config({}) 会从环境变量取到同一目录，
  // 测试就分不出"--data 被透传"和"碰巧环境也是这个目录"，变异验证不会变红（实测踩到）。
  const base = { ...process.env, ...env };
  for (const k of ['QQ_AGENT_DATA_DIR', 'QQ_AGENT_DIR', 'QQ_AGENT_APP_DIR']) delete base[k];
  const r = spawnSync(process.execPath, [path.join(repo, 'src/ops.js'), ...args], {
    encoding: 'utf8',
    cwd: repo,
    env: base,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('audit-prune --data 透传：列出的是传入目录的文件（P2）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ops-audit-'));
  const logDir = path.join(dir, 'audit-log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'audit-202001.jsonl'), '{}\n');

  const r = runOps(['audit-prune', '--dry-run', `--data=${dir}`]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /audit-202001\.jsonl/, '应列出 --data 传入目录里的审计文件');
  assert.ok(fs.existsSync(path.join(logDir, 'audit-202001.jsonl')), 'dry-run 不得删除文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit-prune 无 --confirm 时拒绝执行（破坏性操作要有闸门）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ops-audit2-'));
  fs.mkdirSync(path.join(dir, 'audit-log'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audit-log', 'audit-202001.jsonl'), '{}\n');

  const r = runOps(['audit-prune', `--data=${dir}`]);
  assert.notEqual(r.code, 0, '无 --confirm 应拒绝（非 0 退出）');
  assert.match(r.out, /--confirm/);
  assert.ok(fs.existsSync(path.join(dir, 'audit-log', 'audit-202001.jsonl')), '拒绝时不得删除文件');
  fs.rmSync(dir, { recursive: true, force: true });
});
