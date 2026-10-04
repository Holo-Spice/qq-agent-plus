// setHtmlIfChanged 的"重画前后保留输入值"行为（真 DOM 用例，2026-10-03）
//
// 这里**只加载 ui/core/dom-util.js 一个模块**，不启动整个控制台：
// 启动完整控制台会起一条 1.5 秒自我续期的状态轮询（ui/app.js 的 scheduleStatusRefresh）
// 加一个 15 秒 interval；它们在 vm 里用的是 Node 定时器，window.close() 停不掉，
// node --test 的进程会一直等它 settle（实测超时）。只加载这一个模块就没有那些定时器，
// 而它正好是本用例要验的那个函数。整页启动的覆盖由 ui-smoke.test.mjs 负责。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { toClassicScript } from './helpers/ui-module-source.mjs';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;   // 装了却加载失败必须抛（别让门禁静默消失）
}
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

function loadDomUtil() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  window.document.write('<html><body><div id="host"></div></body></html>');
  const raw = fs.readFileSync(path.resolve('ui/core/dom-util.js'), 'utf8');
  new vm.Script(toClassicScript(raw, 'ui/core/dom-util.js'), { filename: 'ui/core/dom-util.js' })
    .runInContext(vm.createContext(window));
  return window;
}

test('整块重画不覆盖未保存的输入（好友管理/异常处理/人物印象三页共用这一条）', { skip: SKIP }, async () => {
  const window = loadDomUtil();
  const doc = window.document;
  const box = doc.createElement('div');
  const html = (value, live = 'x') => `<input id="cfg-num" type="number" value="${value}">`
    + '<select id="cfg-sel"><option value="a">A</option><option value="b">B</option></select>'
    + '<input id="cfg-flag" type="checkbox">'
    + `<span id="live">${live}</span>`;

  window.setHtmlIfChanged(box, html('1'));
  assert.equal(box.querySelector('#cfg-num').value, '1', '前提：首轮渲染出服务端值');

  // 用户改了三个控件（好友管理页有二十多个这样的数字框），焦点已经移开
  box.querySelector('#cfg-num').value = '42';
  box.querySelector('#cfg-sel').value = 'b';
  box.querySelector('#cfg-flag').checked = true;

  // 后台刷新：易变片段（真实页面里是时间戳与计数，一直在变）触发整块重写
  const changed = window.setHtmlIfChanged(box, html('1', 'y'));
  assert.equal(changed, true, 'live 片段变了 → 这一轮确实重画了');
  assert.equal(box.querySelector('#cfg-num').value, '42', '未保存的数字输入必须保住');
  assert.equal(box.querySelector('#cfg-sel').value, 'b', '未保存的下拉选择必须保住');
  assert.equal(box.querySelector('#cfg-flag').checked, true, '未保存的勾选必须保住');
  assert.equal(box.querySelector('#live').textContent, 'y', '数据本身仍要刷新（不能因为怕丢输入就整个页面停更）');
  assert.equal(window.setHtmlIfChanged(box, html('1', 'y')), false, '完全没变的一轮照旧跳过');

  // 下拉里那个选项没了 → 不强塞非法值，仍以新 HTML 为准
  const gone = doc.createElement('div');
  window.setHtmlIfChanged(gone, html('1'));
  gone.querySelector('#cfg-sel').value = 'b';
  window.setHtmlIfChanged(gone, '<select id="cfg-sel"><option value="a">A</option></select><span id="live">z</span>');
  assert.equal(gone.querySelector('#cfg-sel').value, 'a', '选项没了就不还原旧值（保持服务端那份合法值）');

  // 控件被删掉 → 不报错
  const removed = doc.createElement('div');
  window.setHtmlIfChanged(removed, html('1'));
  assert.doesNotThrow(() => window.setHtmlIfChanged(removed, '<span id="live">z</span>'));
  window.close();
});