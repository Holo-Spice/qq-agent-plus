// 控制台路由表测试（改进方案 #2）：精确/:param/RegExp 三种匹配、auth 默认与例外、
// keyEndpoint 闸门、405、未命中交回、apiFallthrough 收尾口径。
// 变异对照：把 matchPath 的 ':param' 分支删掉 → ':param' 用例红；
// 把 405 分支删掉 → 405 用例红。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createRouter } = await import('../src/console/router.js');

function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
    end(data = '') { this.body = String(data); }
  };
}

function fakeReq(url, method = 'GET', headers = {}) {
  return { url, method, headers };
}

const makeJson = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

function setup({ authed = true, keyOk = true, apiFallthrough } = {}) {
  const calls = [];
  const router = createRouter({
    authorize: () => authed,
    json: makeJson,
    keyEndpointAllowed: () => keyOk,
    // 不传＝生产默认（终态 false：未命中 /api/ 回 404）；仅显式 true 时走过渡语义
    ...(apiFallthrough === true ? { apiFallthrough: true } : {})
  });
  return { router, calls };
}

test('字面量路径：精确匹配并调用 handler', async () => {
  const { router } = setup();
  let hit = 0;
  router.add('GET', '/api/ping', async (req, res) => { hit += 1; res.writeHead(200); res.end('pong'); });
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/ping'), res), true);
  assert.equal(hit, 1);
  assert.equal(res.body, 'pong');
});

test(':param 段匹配：decode 后以命名对象进 params', async () => {
  const { router } = setup();
  let got = null;
  router.add('GET', '/api/chats/:key/wake', async (req, res, params) => { got = params; res.writeHead(200); res.end(); });
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/chats/group%3A1/wake'), res), true);
  assert.deepEqual(got, { key: 'group:1' });
});

test(':param 不跨段匹配（段数不同即不命中）', async () => {
  const { router } = setup({ apiFallthrough: true });  // 未命中要能被观测为 false（不吃 404 兜底）
  router.add('GET', '/api/chats/:key/wake', async () => {});
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/chats/a/b/wake'), res), false);
});

test('RegExp 路径：约束/交替/大小写标志生效，捕获组以数组进 params', async () => {
  const { router } = setup({ apiFallthrough: true });
  let got = null;
  router.add('GET', /^\/api\/incidents\/(inc_[a-f0-9]{16})$/i, async (req, res, params) => {
    got = params; res.writeHead(200); res.end();
  });
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/incidents/INC_ABCDEF0123456789'), res), true);
  assert.equal(got[1], 'INC_ABCDEF0123456789');
  const res2 = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/incidents/not-an-id'), res2), false, '约束不满足不该命中');
});

test('auth 默认 true：未授权回 401 且 handler 不执行', async () => {
  const { router } = setup({ authed: false });
  let hit = 0;
  router.add('GET', '/api/secret', async () => { hit += 1; });
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/secret'), res), true);
  assert.equal(res.statusCode, 401);
  assert.equal(hit, 0);
});

test('auth:false 例外（/healthz 形态）：未授权也放行', async () => {
  const { router } = setup({ authed: false });
  let hit = 0;
  router.add('GET', '/healthz', async (req, res) => { hit += 1; res.writeHead(200); res.end('ok'); }, { auth: false });
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/healthz'), res), true);
  assert.equal(hit, 1);
});

test('keyEndpoint:true 的端点走 keyEndpointAllowed，拒绝时 403', async () => {
  const { router } = setup({ keyOk: false });
  let hit = 0;
  router.add('GET', '/api/search-key', async () => { hit += 1; }, { keyEndpoint: true });
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/search-key'), res), true);
  assert.equal(res.statusCode, 403);
  assert.equal(hit, 0);
});

test('路径命中但方法不匹配 → 405 且 Allow 列出已注册方法', async () => {
  const { router } = setup();
  router.add('POST', '/api/config', async () => {});
  router.add('GET', '/api/config', async () => {});
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/config', 'DELETE'), res), true);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST, GET');
});

test('终态默认：未命中的 /api/ 回 404（文案与旧 if 链逐字一致），非 /api/ 交回静态兜底', async () => {
  const { router } = setup();
  router.add('GET', '/api/one', async () => {});
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/two'), res), true);
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /未知 API：GET \/api\/two/);
  const res2 = fakeRes();
  assert.equal(await router.handle(fakeReq('/index.html'), res2), false);
  assert.equal(res2.statusCode, 0, '非 /api/ 不写响应，交回兜底');
});

test('apiFallthrough:true（测试/过渡用）：未命中返回 false 交回调用方', async () => {
  const { router } = setup({ apiFallthrough: true });
  router.add('GET', '/api/one', async () => {});
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/two'), res), false);
  assert.equal(res.statusCode, 0);
});

test('同路径多方法注册多条：各自独立命中', async () => {
  const { router } = setup();
  const seen = [];
  router.add('GET', '/api/memory-files/:key', async (req, res, p) => { seen.push(`GET:${p.key}`); res.writeHead(200); res.end(); });
  router.add('PUT', '/api/memory-files/:key', async (req, res, p) => { seen.push(`PUT:${p.key}`); res.writeHead(200); res.end(); });
  await router.handle(fakeReq('/api/memory-files/group_1'), fakeRes());
  await router.handle(fakeReq('/api/memory-files/group_1', 'PUT'), fakeRes());
  assert.deepEqual(seen, ['GET:group_1', 'PUT:group_1']);
});

test('鉴权前置：无 token 时"存在路径的错方法"回 401，不是 405（不再泄露 API 面）', async () => {
  const { router } = setup({ authed: false });
  router.add('GET', '/api/config', async () => {});
  router.add('POST', '/api/config', async () => {});
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/config', 'DELETE'), res), true);
  assert.equal(res.statusCode, 401, '错方法也必须先鉴权');
  assert.equal(res.headers?.allow, undefined, '401 不带 Allow 头');
});

test('鉴权前置：无 token 时未知 /api/ 路径回 401，不是 404', async () => {
  const { router } = setup({ authed: false });
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/api/no-such'), res), true);
  assert.equal(res.statusCode, 401);
});

test('auth:false 的公开端点：错方法回 405 且无需鉴权（/healthz 形态）', async () => {
  const { router } = setup({ authed: false });
  router.add('GET', '/healthz', async () => {}, { auth: false });
  const res = fakeRes();
  assert.equal(await router.handle(fakeReq('/healthz', 'PUT'), res), true);
  assert.equal(res.statusCode, 405);
});
