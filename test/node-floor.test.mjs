// 声明的 Node 低限必须罩住运行期依赖自己的 engines 要求。
//
// 背景（2026-10-01）：Dependabot 把 undici 从 6 升到 8，而 undici 8 声明 `engines: node >=22.19`，
// 项目的 `engines` 与 `deploy.sh` 的低限还写着 22.13 —— 这种"依赖悄悄越过自家地板"的偏差，
// CI 与本地都看不见，只有在用户那台旧一点的 Node 上装依赖时报一句 EBADENGINE 警告，
// 或者动态 import 时才炸。所以钉一条用例：依赖涨了，地板就得跟着涨（或换版本）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repo = path.resolve('.');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

function floorOf(spec) {
  const m = String(spec || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

test('项目的 Node 低限覆盖所有直接运行期依赖的 engines 要求', () => {
  const ours = floorOf(pkg.engines?.node);
  assert.ok(ours, `package.json engines.node 应写成 >=x.y.z，实际：${pkg.engines?.node}`);
  const deps = Object.keys(pkg.dependencies || {});
  assert.ok(deps.length > 0, '应至少有一个运行期依赖');
  const violations = [];
  for (const name of deps) {
    const file = path.join(repo, 'node_modules', name, 'package.json');
    if (!fs.existsSync(file)) continue;            // 没装就跳过（CI/部署会装）
    const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
    const need = floorOf(dep.engines?.node);
    if (!need) continue;                           // 依赖自己没声明 engines
    if (cmp(ours, need) < 0) {
      violations.push(`${name}@${dep.version} 要求 node ${dep.engines.node}，我们只声明 ${pkg.engines.node}`);
    }
  }
  assert.deepEqual(violations, [], `运行期依赖的 Node 要求越过项目地板的低限：\n${violations.join('\n')}`);
});

test('deploy.sh 的 Node 低限与 package.json 的 engines 一致', () => {
  const src = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  const m = src.match(/major===22 && minor<(\d+)/);
  assert.ok(m, 'deploy.sh 的 node_ready 应有 `major===22 && minor<N` 的检查（结构变了就更新这条用例）');
  const enginesMinor = Number(String(pkg.engines?.node).match(/22\.(\d+)/)?.[1] ?? NaN);
  assert.ok(Number.isFinite(enginesMinor), `engines.node 应写 22.x：${pkg.engines?.node}`);
  assert.equal(Number(m[1]), enginesMinor, 'deploy.sh 的 Node 低限要与 package.json 的 engines 同步');
});

test('package-lock.json 根条目的 engines 与 package.json 一致', () => {
  // 2026-10-02 复审：地板从 22.13 抬到 22.19 时漏了 lockfile 的根条目（npm ci 不校验根
  // engines，CI 不会报；但两边元数据对账必须一致，否则下次 npm install 重写时又会漂）。
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  const lockFloor = lock?.packages?.['']?.engines?.node;
  assert.ok(lockFloor, 'package-lock 根条目应有 engines.node（结构变了就更新这条用例）');
  assert.equal(lockFloor, pkg.engines?.node, 'lockfile 根 engines 要与 package.json 保持一致');
});
