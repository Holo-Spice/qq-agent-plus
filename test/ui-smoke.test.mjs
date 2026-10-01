// UI 真实 DOM 冒烟（改进方案 #1 A 档）：happy-dom 提供真实 DOM 语义（对比 render-test 的
// 手写桩件），加载 index.html 骨架 + 全部 ui/*.js（按 script 清单顺序），断言：
// 11 个 tab 的渲染入口都不抛、api() 走 fetch 桩、登录表单提交走通。
// **缺 happy-dom 时自动跳过** —— D6 约定：更新器用 --omit=dev 不装 devDeps，
// 这条 skip 路径是必须守住的（不许删；删了更新器环境会红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';

let WindowClass = null;
try {
  ({ Window: WindowClass } = await import('happy-dom'));
} catch { /* devDeps 未装（生产/更新器环境）—— 走 skip */ }
const SKIP = WindowClass ? false : 'happy-dom 未安装（devDependencies；--omit=dev 环境按约定跳过）';

const UI = path.resolve('ui');
const RAW_HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const SCRIPT_FILES = [...RAW_HTML.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
const TABS = [...new Set([...RAW_HTML.matchAll(/data-tab="([a-z-]+)"/g)].map((m) => m[1]))];

function settle(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPage() {
  const window = new WindowClass({ url: 'http://127.0.0.1:3210/' });
  // 骨架进 DOM；script 标签不交给 happy-dom 自己加载，由测试按清单手动按序执行
  window.document.write(RAW_HTML.replace(/<script[^>]*>\s*<\/script>/g, ''));
  const fetchLog = [];
  const cfgStub = {
    api: { model: 'smoke-model', maxRounds: 3 },
    allow: { groups: ['10001'], private: [] },
    server: {}, runtime: { mode: 'observe' },
    webSearch: { enabled: false }, asr: {}, tts: {},
    identityPilot: {}, slangPilot: {}, incidentPilot: {}, memory: {}
  };
  window.fetch = async (url) => {
    fetchLog.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => (String(url).includes('/api/config') ? cfgStub : {})
    };
  };
  window.EventSource = class EventSourceStub {
    constructor() { this.readyState = 0; }
    addEventListener() {}
    close() {}
  };
  const errors = [];
  window.addEventListener('error', (event) => errors.push(String(event?.error ?? event?.message ?? event)));
  const ctx = vm.createContext(window);
  for (const file of SCRIPT_FILES) {
    const code = fs.readFileSync(path.join(UI, file), 'utf8');
    new vm.Script(code, { filename: `ui/${file}` }).runInContext(ctx);
  }
  return { window, fetchLog, errors };
}

test('真实 DOM 冒烟：加载全部脚本、11 个 tab 切换入口不抛', { skip: SKIP }, async () => {
  const { window, errors } = loadPage();
  await settle();
  try {
    assert.ok(SCRIPT_FILES.length >= 12, `脚本清单应含 i18n+core+app+8 外挂，实际 ${SCRIPT_FILES.length}`);
    assert.deepEqual(errors, [], `加载期出现未捕获错误：${errors.join(' | ')}`);
    assert.ok(typeof window.switchTab === 'function', 'switchTab 应可用');
    const failed = [];
    for (const tab of TABS) {
      try {
        window.switchTab(tab);
        await settle(30);
      } catch (error) {
        failed.push(`${tab}: ${error?.message ?? error}`);
      }
    }
    assert.deepEqual(failed, [], `这些 tab 的渲染入口抛错：${failed.join(' | ')}`);
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：api() 走 fetch 桩', { skip: SKIP }, async () => {
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const data = await window.api('/api/smoke-probe');
    assert.ok(fetchLog.includes('/api/smoke-probe'), `fetch 桩应收到调用，实际：${fetchLog.slice(0, 5).join(', ')}`);
    assert.deepEqual(data, {}, '桩返回空对象');
  } finally { window.happyDOM?.abort?.(); }
});

test('真实 DOM 冒烟：登录表单提交打到 /api/login 且不抛', { skip: SKIP }, async () => {
  const { window, fetchLog } = loadPage();
  await settle();
  try {
    const form = window.document.querySelector('#console-login-form');
    assert.ok(form, 'index.html 应含 #console-login-form');
    const input = form.querySelector('input');
    if (input) input.value = 'smoke-token';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(150);
    assert.ok(fetchLog.some((u) => u.includes('/api/login')), `提交应请求 /api/login，实际：${fetchLog.slice(0, 6).join(', ')}`);
  } finally { window.happyDOM?.abort?.(); }
});
