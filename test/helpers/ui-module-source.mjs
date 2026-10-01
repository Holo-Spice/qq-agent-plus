// 把 ui/*.js 的 ES module 源码降级成 classic script 源码，供 vm 沙箱按**老语义**加载。
//
// 为什么需要：三套 vm 沙箱（render-test / scroll-test / usage-e2e）与 happy-dom 冒烟
// 把每个文件单独 `vm.Script` 塞进**同一个 context**，靠 classic script 的全局词法环境
// 让跨文件名字互相可见。ui/ 转 ES module 后，模块源码不能直接喂给 vm.Script（import 会
// SyntaxError），所以在这里把 import/export 语法去掉 —— 去掉之后所有顶层声明又落回同一个
// 全局词法环境，行为与转换前**逐字节一致**，176 + 19 + 冒烟断言的含义不变。
//
// 代价必须说清楚：这条路径**不校验模块图**（import 指向的文件、名字是否真的存在）。
// 那是 test/ui-module-graph.test.mjs 的活（静态解析每个文件的 import/export 并断言
// 解析得通），以及真浏览器（服务器实测、烟测）的活。两处加起来才是完整的网。
//
// 而 strip 之后**不许剩下任何 import/export 残渣** —— 残留会静默变成"少加载一个依赖"，
// 所以这里遇到不认识的形态直接抛错（宁可炸，不要静默）。

const RE_IMPORT_LINE = /^[ \t]*import\s+[^;]*?from\s*['"][^'"]+['"];?[ \t]*$/gm;
const RE_IMPORT_SIDE_EFFECT = /^[ \t]*import\s*['"][^'"]+['"];?[ \t]*$/gm;
const RE_EXPORT_BLOCK = /^[ \t]*export\s*\{[\s\S]*?\};?/gm;
const RE_EXPORT_KEYWORD = /^([ \t]*)export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm;

export function toClassicScript(src, file = 'ui/*.js') {
  const out = src
    .replace(RE_IMPORT_LINE, '')
    .replace(RE_IMPORT_SIDE_EFFECT, '')
    .replace(RE_EXPORT_BLOCK, '')
    .replace(RE_EXPORT_KEYWORD, '$1');
  const leftover = out
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /^[ \t]*(?:import|export)\b/.test(line));
  if (leftover.length) {
    const where = leftover.map(([n, line]) => `${file}:${n} ${line.trim()}`).join(' | ');
    throw new Error(`toClassicScript 没能处理完 module 语法（形态漏了，别静默放行）：${where}`);
  }
  return out;
}
