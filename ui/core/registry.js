// 渲染钩子注册表（改进方案 §11 C2「去插件化」）
//
// 背景：stable-features.js 与 status-refresh.js 原先靠**改写全局**来包裹 app.js 的渲染入口
// （`window[name] = wrapped` / 裸赋值 `refreshStatus = ...`）。那只在"脚本顺序恰好正确、
// 且大家都还是 classic script"时成立：ES module 的绑定只读、模块作用域也不挂 window，
// 任何一步模块化都会让这些覆盖**静默失效**（页面看着正常，只是那段改造不再生效）。
//
// 这里把"包裹/覆盖"变成**显式注册**，由 app.js 侧主动调用：
//   register(name, fn)  app.js 登记内置实现（override 的默认值，也是插件取回原实现的入口）
//   onTransform(name, fn)  html 变换链：fn(html, args) → html（注册顺序执行）
//   onAfter(name, fn)      原实现跑完后的副作用链：fn(args)
//   override(name, fn)     整体接管某个入口（后者覆盖前者）
//   transform / after / dispatch / base  app.js 侧的调用与取用点
//
// 钩子抛错只记一条 warn 并继续 —— 一个失手的钩子不该让整块 UI 空白（异常隔离）。
// 载入顺序：core/registry.js 必须最先（app.js 载入时就会 register）。
// 2026-10-01（ESM 化）：改成顶层 const + 显式挂 window。ui/ 内部一律 `import { QARegistry }`，
// 不再靠"全局对象上的属性恰好能被裸标识符找到"这层隐式解析；window 上那份是**有意保留**
// 的对外面（白盒测试、控制台排查、将来可能的第三方外挂）。
const QARegistry = (function createRegistry() {
  const bases = new Map();
  const overrides = new Map();
  const transforms = new Map();
  const afters = new Map();

  function push(map, name, fn) {
    if (typeof fn !== 'function') return;
    const list = map.get(name);
    if (list) list.push(fn);
    else map.set(name, [fn]);
  }

  function warn(scope, error) {
    try {
      console.warn(`[QARegistry] ${scope} 抛错，已跳过该钩子`, error);
    } catch { /* 控制台不可用：钩子异常不改变页面行为 */ }
  }

  return {
    register(name, fn) {
      bases.set(name, fn);
      return fn;
    },
    base(name) {
      return bases.get(name);
    },
    onTransform(name, fn) {
      push(transforms, name, fn);
    },
    onAfter(name, fn) {
      push(afters, name, fn);
    },
    override(name, fn) {
      overrides.set(name, fn);
    },
    transform(name, html, args) {
      let out = html;
      for (const fn of transforms.get(name) || []) {
        try {
          out = fn(out, args);
        } catch (error) {
          warn(`transform(${name})`, error);
        }
      }
      return out;
    },
    after(name, args) {
      for (const fn of afters.get(name) || []) {
        try {
          fn(args);
        } catch (error) {
          warn(`after(${name})`, error);
        }
      }
    },
    dispatch(name, ...args) {
      const fn = overrides.get(name) || bases.get(name);
      if (typeof fn !== 'function') throw new Error(`QARegistry: ${name} 没有注册实现`);
      return fn(...args);
    },
    // 只读快照：给测试与线上排查用（不暴露函数本体，避免被当改写入口）
    snapshot() {
      const counts = (map) => [...map.entries()].map(([key, list]) => [key, list.length]);
      return {
        bases: [...bases.keys()],
        overrides: [...overrides.keys()],
        transforms: counts(transforms),
        afters: counts(afters)
      };
    }
  };
})();

window.QARegistry = QARegistry;


export { QARegistry };