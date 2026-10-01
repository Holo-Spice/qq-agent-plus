// QARegistry 单元用例（改进方案 §11 C2「去插件化」附录 D 列出的 5 例 + 边界）
//
// 这个注册表取代了原先"改写全局"的插件机制（stable-features.js 的 `window[name] = wrapped`、
// status-refresh.js 的裸赋值）。它现在承载三件事，任何一件坏掉都是**静默**的 UI 退化
// （页面照常渲染，只是不再改造），所以逐条钉住：钩子顺序、原实现的取回、异常隔离。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';

const REGISTRY = path.resolve('ui', 'core', 'registry.js');

// 注释里会提到 `window[name] = wrapped` 这种写法（正是被替换掉的老机制），
// 判定"有没有真的改写全局"时必须先把注释抹掉，否则注释自己会把用例判红。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function loadRegistry() {
  const sandbox = { console: { warn() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(toClassicScript(fs.readFileSync(REGISTRY, 'utf8'), 'core/registry.js'), { filename: 'ui/core/registry.js' }).runInContext(sandbox);
  return sandbox;
}

test('注册表挂在 window 上（index.html 靠经典脚本顺序共享，不能只在模块作用域里）', () => {
  const sandbox = loadRegistry();
  assert.equal(typeof sandbox.QARegistry.dispatch, 'function');
  assert.equal(sandbox.QARegistry, sandbox.window.QARegistry);
});

test('dispatch 走底座；base() 能取回底座（插件取原实现的唯一入口）', () => {
  const { QARegistry } = loadRegistry();
  const impl = (a, b) => `${a}+${b}`;
  QARegistry.register('sum', impl);
  assert.equal(QARegistry.base('sum'), impl);
  assert.equal(QARegistry.dispatch('sum', 1, 2), '1+2');
});

test('override 覆盖底座，且 base() 仍返回原实现（否则插件会自递归）', () => {
  const { QARegistry } = loadRegistry();
  const impl = () => 'base';
  QARegistry.register('x', impl);
  QARegistry.override('x', () => 'over');
  assert.equal(QARegistry.dispatch('x'), 'over');
  assert.equal(QARegistry.base('x'), impl, 'override 之后 base 必须还是原实现');
  // 后者覆盖前者（同一入口只应有一个接管者）
  QARegistry.override('x', () => 'over2');
  assert.equal(QARegistry.dispatch('x'), 'over2');
});

test('transform 链按注册顺序执行，html 逐级传递', () => {
  const { QARegistry } = loadRegistry();
  QARegistry.onTransform('sec', (html) => `${html}A`);
  QARegistry.onTransform('sec', (html, args) => `${html}B${args[0]}`);
  assert.equal(QARegistry.transform('sec', '', ['c']), 'ABc');
});

test('after 链按注册顺序执行，并收到原调用的入参', () => {
  const { QARegistry } = loadRegistry();
  const seen = [];
  QARegistry.onAfter('page', (args) => seen.push(['one', ...args]));
  QARegistry.onAfter('page', (args) => seen.push(['two', ...args]));
  QARegistry.after('page', [1, 2]);
  assert.deepEqual(seen, [['one', 1, 2], ['two', 1, 2]]);
});

test('异常隔离：钩子抛错不中断渲染、不影响别的钩子，也不改变返回值', () => {
  const { QARegistry } = loadRegistry();
  const seen = [];
  QARegistry.onTransform('sec', () => { throw new Error('bad transform'); });
  QARegistry.onTransform('sec', (html) => `${html}ok`);
  assert.equal(QARegistry.transform('sec', 'x'), 'xok', '前一个钩子抛错不能把 html 变成 undefined');

  QARegistry.onAfter('page', () => { throw new Error('bad after'); });
  QARegistry.onAfter('page', () => seen.push('after-ran'));
  assert.doesNotThrow(() => QARegistry.after('page', []));
  assert.deepEqual(seen, ['after-ran'], '抛错的那个 after 不能拦住后面的');
});

test('dispatch 到没注册的名字要明确报错（而不是 undefined 崩在调用方）', () => {
  const { QARegistry } = loadRegistry();
  assert.throws(() => QARegistry.dispatch('nothing'), /没有注册实现/);
});

test('snapshot 只暴露名字与钩子数量（排查用，不作为改写入口）', () => {
  const { QARegistry } = loadRegistry();
  QARegistry.register('a', () => {});
  QARegistry.override('b', () => {});
  QARegistry.onTransform('a', () => {});
  QARegistry.onAfter('a', () => {});
  const snap = QARegistry.snapshot();
  // 注意：注册表跑在 vm 沙箱里，返回的数组属于另一个 realm —— deepStrictEqual 会因原型不同
  // 而失败，所以先摊平到宿主 realm 再比。
  assert.deepEqual([...snap.bases], ['a']);
  assert.deepEqual([...snap.overrides], ['b']);
  assert.deepEqual(Array.from(snap.transforms, (entry) => Array.from(entry)), [['a', 1]]);
  assert.deepEqual(Array.from(snap.afters, (entry) => Array.from(entry)), [['a', 1]]);
});

test('接上真实 app.js：8 个渲染入口都注册了底座（漏一个就是静默失效）', () => {
  // 不去跑整个 app.js（那是 render-test / ui-smoke 的活），只断言这张接线表本身：
  // app.js 顶层必须把 8 个入口登记进注册表，否则插件注册的钩子永远没人调用。
  const src = fs.readFileSync(path.resolve('ui', 'app.js'), 'utf8');
  for (const name of [
    'renderExperimentalSettingsSection', 'renderSettings',
    'renderIdentityFeaturePage', 'renderFriendFeaturePage', 'renderIncidentFeaturePage',
    'refreshStatus', 'renderLifecycleOverview', 'loadFriendFeaturePage'
  ]) {
    assert.match(src, new RegExp(`QARegistry\\.register\\('${name}'`), `app.js 应把 ${name} 登记为底座`);
  }
  // 插件侧不许再出现"改全局"的包裹写法
  for (const file of ['stable-features.js', 'status-refresh.js']) {
    const plugin = stripComments(fs.readFileSync(path.resolve('ui', file), 'utf8'));
    assert.doesNotMatch(plugin, /window\[[^\]]+\]\s*=/, `${file} 不应改写 window[...]`);
  }
});
