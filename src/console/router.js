// 控制台路由表（改进方案 #2，设计定稿见方案附录 J.1）。
// 背景：旧形态是 handleHttp 里 100+ 处 `pathname === ...` 内联 if 链 + 一条
// 「摘掉 server 监听再包一层」的例外路由。本模块提供注册式路由，迁移方式为
// **加壳并行**：handleHttp 开头先 `if (await router.handle(req, res)) return;`，
// 每次搬 5–10 条分支进表、搬走即删原分支；未迁移的自动落回 if 链（handle 返回 false）。
//
// 契约（与方案附录 J.1 一致）：
// - add(method, path, handler, opts)：handler(req, res, params, url)
//   - path 支持三种形态：字面量 '/api/x'；带 ':param' 的路径（按段匹配，decode 后进 params）；
//     **RegExp**（捕获组以数组进 params —— 现有 28 处正则路由靠它安放：约束/交替/大小写标志
//     是 ':param' 表达不了的）
//   - opts.auth       默认 true；false 仅限 /healthz、/api/login、/api/events 三处
//   - opts.keyEndpoint true 时经 keyEndpointAllowed（明文密钥回读端点专用）
//   - opts.audit      #5 完成后填动作名（本批只留挂点）
// - handle(req, res) → true 已处理；false 交回 if 链 / 静态兜底。
//   路径命中但方法不匹配 → 405（带 Allow 头，附录 J.1 拍板的行为变化）。
//   迁移期「未命中的 /api/ 一律 404 不落静态」暂不启用：那会吃掉 if 链里尚未迁移的路由；
//   等迁移收尾时用 apiFallthrough:false 打开。

export function createRouter(deps = {}) {
  // 显式取别名而不是解构参数：ops.js 的未定义调用扫描器不认识解构参数，
  // 会把 authorize(...) 误报成"可疑未定义调用"（CI 门禁 --strict 会红）。
  const authorize = deps.authorize;
  const json = deps.json;
  const keyEndpointAllowed = deps.keyEndpointAllowed || (() => true);
  const apiFallthrough = deps.apiFallthrough !== false;
  const routes = [];

  function add(method, path, handler, opts = {}) {
    if (typeof handler !== 'function') throw new Error('router.add 需要 handler 函数');
    routes.push({
      method: String(method || 'GET').toUpperCase(),
      path,
      handler,
      auth: opts.auth !== false,
      keyEndpoint: opts.keyEndpoint === true,
      audit: opts.audit || ''
    });
  }

  // 返回 { matched: bool, params }；params：':param' 路由为命名对象，RegExp 路由为捕获组数组
  function matchPath(route, pathname) {
    if (route.path instanceof RegExp) {
      const m = route.path.exec(pathname);
      return m ? { matched: true, params: [...m] } : { matched: false, params: null };
    }
    const want = String(route.path).split('/');
    const got = pathname.split('/');
    if (want.length !== got.length) return { matched: false, params: null };
    const params = {};
    for (let i = 0; i < want.length; i++) {
      const seg = want[i];
      if (seg.startsWith(':')) {
        if (!got[i]) return { matched: false, params: null };
        try { params[seg.slice(1)] = decodeURIComponent(got[i]); } catch { return { matched: false, params: null }; }
      } else if (seg !== got[i]) {
        return { matched: false, params: null };
      }
    }
    return { matched: true, params };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = String(req.method || 'GET').toUpperCase();
    const allowed = new Set();
    for (const route of routes) {
      const { matched, params } = matchPath(route, pathname);
      if (!matched) continue;
      allowed.add(route.method);
      if (route.method !== method) continue;
      if (route.auth && !authorize(req)) {
        json(res, 401, { error: '未授权' });
        return true;
      }
      if (route.keyEndpoint && !keyEndpointAllowed(req)) {
        json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return true;
      }
      await route.handler(req, res, params, url);   // 异常冒泡给 createServer 的统一处理（记 incident + 500）
      return true;
    }
    if (allowed.size > 0) {
      // 路径命中但方法不匹配：405（附录 J.1 拍板；旧的 if 链形态这里会落空成 404）
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: [...allowed].join(', ') });
      res.end(JSON.stringify({ error: `方法不允许：${method}` }));
      return true;
    }
    if (!apiFallthrough && pathname.startsWith('/api/')) {
      // 迁移收尾后才启用：未命中的 /api/ 一律 404 JSON，不落静态服务（防路径探测泄漏文件）
      json(res, 404, { error: '未找到接口' });
      return true;
    }
    return false;
  }

  return { add, handle, routes };
}
