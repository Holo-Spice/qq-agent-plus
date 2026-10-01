// 跨文件全局契约冻结（改进方案 §11 C3）
//
// 背景：classic script 时代 ui/ 下的 JS 靠"全局词法环境"互相看见 —— 顶层函数被别的文件
// 直接调用。这类隐式耦合没有任何编译期检查：谁都能随手引一个新全局，而某处删掉一个函数
// 也不会有人报错。这个用例把当前事实**钉死**：
//
//   ① 任一文件引用的"别的文件顶层名字"，必须全部登记在 eslint.config.mjs 的
//      uiSharedGlobals 清单里（新增跨文件耦合 = 必须显式改清单 = 当场红）；
//   ② 清单里每个名字都还能在 ui/ 的某个文件里找到顶层声明（防清单腐烂：删了函数忘了删清单）；
//   ③ 没有任何文件再靠改写全局来"包裹"渲染入口（改进方案 §11 C2 去插件化后的纪律：
//      要接管请走 QARegistry，别再 `window[name] = wrapped` / 裸赋值）。
//
// 2026-10-01 拆模块（ui/app.js → ui/core/** + ui/pages/**）后，判定改为**分层无关**：
// 不再假设"定义只在 app.js / ui/core"，否则搬家即误报。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const UI = path.resolve('ui');
const CONFIG = path.resolve('eslint.config.mjs');

// 全项目共用一套"抹掉注释/字符串/模板串/正则、保留换行"的预处理：否则字符串与注释里的
// 词会被当成引用（例如 'failed-state' 里的 state）。正则字面量按"前一个有效字符不是值"判定，
// 与 src/ops.js 的 scan 同一套口径。
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

function blankSource(src) {
  const out = [];
  const length = src.length;
  let i = 0;
  let last = '';
  const emit = (chunk) => { out.push(chunk); };
  while (i < length) {
    const char = src[i];
    const next = i + 1 < length ? src[i + 1] : '';
    if (char === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      let end = src.indexOf('*/', i + 2);
      end = end < 0 ? length : end + 2;
      let newlines = 0;
      for (let k = i; k < end; k += 1) if (src[k] === '\n') newlines += 1;
      emit('\n'.repeat(newlines));
      i = end;
      continue;
    }
    if (char === '/' && REGEX_PRECEDERS.has(last)) {
      let j = i + 1;
      let inClass = false;
      while (j < length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { j += 1; break; }
        else if (src[j] === '\n') break;
        j += 1;
      }
      emit(' '.repeat(Math.max(0, j - i)));
      last = '/';
      i = j;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let j = i + 1;
      while (j < length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === quote) { j += 1; break; }
        j += 1;
      }
      emit(' '.repeat(Math.max(0, j - i)));
      last = quote;
      i = j;
      continue;
    }
    // 模板串要单独处理：`${...}` 里是**真代码**，整个抹掉会漏掉
    // `${esc(x)}`、`${fmtTokens(n)}` 这类引用（src/ops.js 的 scan 有同样的盲区，
    // 它只看函数调用、影响有限；这里要判定"引用了哪些全局"，不能照抄）。
    if (char === '`') {
      let j = i + 1;
      emit(' ');
      while (j < length) {
        if (src[j] === '\\') { emit('  '); j += 2; continue; }
        if (src[j] === '`') { emit(' '); j += 1; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let k = j + 2;
          let depth = 1;
          while (k < length && depth) {
            const inner = src[k];
            if (inner === '\\') { k += 2; continue; }
            if (inner === '"' || inner === "'" || inner === '`') {
              k += 1;
              while (k < length) {
                if (src[k] === '\\') { k += 2; continue; }
                if (src[k] === inner) { k += 1; break; }
                k += 1;
              }
              continue;
            }
            if (inner === '{') depth += 1;
            else if (inner === '}') depth -= 1;
            if (depth === 0) break;
            k += 1;
          }
          emit('${' + blankSource(src.slice(j + 2, k)) + '}');
          j = k + 1;
          continue;
        }
        emit(src[j] === '\n' ? '\n' : ' ');
        j += 1;
      }
      last = '`';
      i = j;
      continue;
    }
    emit(char);
    if (char.trim() !== '') last = char;
    i += 1;
  }
  return out.join('');
}

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.name.endsWith('.js') ? [path.relative(UI, full).split(path.sep).join('/')] : [];
  });
}

// eslint.config.mjs 里的 uiSharedGlobals 是这份契约的**唯一真相源**（不在这里抄第二份）
function sharedGlobals() {
  const src = fs.readFileSync(CONFIG, 'utf8');
  const block = /const uiSharedGlobals = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'eslint.config.mjs 里找不到 uiSharedGlobals 对象字面量');
  const names = new Set();
  for (const line of block[1].split('\n')) {
    const match = /^\s*([A-Za-z_$][\w$]*)\s*:\s*'readonly'/.exec(line);
    if (match) names.add(match[1]);
  }
  assert.ok(names.size >= 20, `uiSharedGlobals 只解析出 ${names.size} 个名字，解析器可能坏了`);
  return names;
}

function declaredTopLevel(src) {
  const names = new Set();
  const blanked = blankSource(src);
  for (const match of blanked.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  for (const match of blanked.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  for (const match of blanked.matchAll(/^class\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  // 跨文件内核的另一种常见形态：core/registry.js 用 `window.QARegistry = ...` 挂出去
  for (const match of blanked.matchAll(/^(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=/gm)) names.add(match[1]);
  return names;
}

const shared = sharedGlobals();

// ── 统一口径（2026-10-01 拆模块后） ──
// 加载分层：ui/core/**  →  ui/pages/**  →  ui/app.js  →  8 个外挂插件（见 index.html）。
// 「跨文件全局」= 某个 ui 文件顶层声明、被**另一个** ui 文件引用的名字 —— 判定不再关心
// 名字住在哪一层。拆模块把约六成定义从 app.js 搬进了 ui/pages/**，继续拿「app.js + core」
// 当定义方，会把它们集体误判成"清单腐烂"。
const UI_FILES = listJs(UI);
const declByFile = new Map(UI_FILES.map((rel) => [rel, declaredTopLevel(fs.readFileSync(path.join(UI, rel), 'utf8'))]));
const declHomes = new Map(); // name -> Set(声明它的文件)
for (const [rel, names] of declByFile) {
  for (const name of names) {
    if (!declHomes.has(name)) declHomes.set(name, new Set());
    declHomes.get(name).add(rel);
  }
}

// 一个文件"引用到"的名字，分两路收，用途不同：
//   identifierRefs —— 代码里的标识符引用（eslint 的 no-undef 看得见的那一路）；
//   registryKeys   —— QARegistry 的字符串键。去插件化（§11 C2）后"接管某个入口"只以键名
//                     出现（代码里不再有该标识符），所以它**不算**标识符引用（登记进
//                     uiSharedGlobals 也治不了 no-undef），但确实是"有人在用"。
function identifierRefs(rel) {
  const raw = fs.readFileSync(path.join(UI, rel), 'utf8');
  // `...X` 展开：`.` 被排除在标识符边界外（为躲属性访问 a.b），先把连续三点抹成空格，
  // 否则 `[...FOO]` 会被当成"没引用"（曾把 STICKER_MAX_CHOICES 误报成冗余）。
  const blanked = blankSource(raw).replace(/\.\.\./g, '   ');
  const names = new Set();
  for (const match of blanked.matchAll(/(?<![\w$.\-])([A-Za-z_$][\w$]*)(?![\w$\-])/g)) names.add(match[1]);
  return names;
}

function registryKeys(rel) {
  const raw = fs.readFileSync(path.join(UI, rel), 'utf8');
  return new Set([...raw.matchAll(/QARegistry\.(?:onTransform|onAfter|override|register)\(\s*'([^']+)'/g)].map((m) => m[1]));
}

const refsByFile = new Map(UI_FILES.map((rel) => [rel, identifierRefs(rel)]));
const keysByFile = new Map(UI_FILES.map((rel) => [rel, registryKeys(rel)]));

// name -> Set(引用了它、且自己没声明它的文件)：只看标识符引用，即"必须登记在清单里"的那批
const externalUsers = new Map();
for (const rel of UI_FILES) {
  for (const name of refsByFile.get(rel)) {
    if (!declHomes.has(name)) continue;         // 浏览器全局 / 局部名，不在契约范围
    if (declHomes.get(name).has(rel)) continue; // 自家声明的，不算跨文件
    if (!externalUsers.has(name)) externalUsers.set(name, new Set());
    externalUsers.get(name).add(rel);
  }
}

// name -> 是否"被声明它的文件之外的文件用到"（标识符或注册表键，任一即可）—— 防冗余用
const usedOutsideHome = new Set();
for (const rel of UI_FILES) {
  for (const name of refsByFile.get(rel)) {
    if (declHomes.has(name) && !declHomes.get(name).has(rel)) usedOutsideHome.add(name);
  }
  for (const name of keysByFile.get(rel)) {
    if (declHomes.has(name) && !declHomes.get(name).has(rel)) usedOutsideHome.add(name);
  }
}

test('引用别的文件顶层名字 = 必须登记在 uiSharedGlobals（新增耦合必须显式改清单）', () => {
  const offenders = [];
  for (const [name, users] of externalUsers) {
    if (shared.has(name)) continue;
    for (const rel of users) offenders.push(`${rel} → ${name}`);
  }
  assert.deepEqual([...new Set(offenders)].sort(), [],
    '这些跨文件全局没登记在 eslint.config.mjs 的 uiSharedGlobals 里（新增请显式登记，或改用 QARegistry/局部实现）');
});

test('uiSharedGlobals 里每个名字都还有定义（防清单腐烂）', () => {
  const dead = [...shared].filter((name) => !declHomes.has(name)).sort();
  assert.deepEqual(dead, [], `这些名字在 ui/ 里已无顶层声明（删了函数忘了删清单），请从 uiSharedGlobals 删除：${dead.join(', ')}`);
});

test('uiSharedGlobals 里每个名字都被"声明它的文件之外"的文件用到（防清单冗余）', () => {
  const redundant = [...shared].filter((name) => !usedOutsideHome.has(name)).sort();
  assert.deepEqual(redundant, [], `这些名字只在自家文件里用，请从 uiSharedGlobals 删除：${redundant.join(', ')}`);
});

test('再没有文件靠改写全局包裹渲染入口（要接管请走 QARegistry）', () => {
  const offenders = [];
  for (const rel of listJs(UI)) {
    if (rel === 'core/registry.js') continue; // 注册表本身是唯一的全局归属地
    const src = fs.readFileSync(path.join(UI, rel), 'utf8');
    const blanked = blankSource(src);
    // window[x] = ... / globalThis[x] = ... 这类改写；以及裸改写的 managed 名字
    if (/\b(?:window|globalThis)\s*\[[^\]]+\]\s*=/.test(blanked)) offenders.push(`${rel}: 改写全局（window[...] = ）`);
    for (const name of shared) {
      const bare = new RegExp(`^${name}\\s*=[^=]`, 'm');
      if (bare.test(blanked)) offenders.push(`${rel}: 裸赋值 ${name} = ...`);
    }
  }
  assert.deepEqual(offenders, [], `去插件化（§11 C2）后不许再改写全局：${offenders.join('; ')}`);
});
