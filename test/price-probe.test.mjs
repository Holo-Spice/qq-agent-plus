import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-price-probe-'));
process.env.QQ_AGENT_DATA_DIR = root;

const probe = await import('../src/pricing/price-probe.js');
const channel = await import('../src/pricing/channel-prices.js');
const prices = await import('../src/pricing/model-prices.js');
const feed = await import('../src/pricing/price-feed.js');

after(() => {
  prices.setChannelPrices('demo-渠道', null);
  fs.rmSync(root, { recursive: true, force: true });
});

/** 假 fetch：按 URL 返回预设载荷。 */
function fakeFetch(routes) {
  const impl = async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    impl.calls.push(String(url));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const route = routes[key];
    if (route && route.__status && route.__status !== 200) {
      return { ok: false, status: route.__status, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => route };
  };
  impl.calls = [];
  return impl;
}

const ONE_API = {
  data: [
    { model_name: 'deepseek/deepseek-v4.1-flash', quota_type: 0, model_ratio: 0.5, completion_ratio: 4 },
    { model_name: 'glm/glm-5.3', quota_type: 0, model_ratio: 4, completion_ratio: 3.5 },
    { model_name: 'per-call-model', quota_type: 1, model_ratio: 3 }
  ],
  group_ratio: { default: 1, vip: 0.8 }
};

test('one-api 倍率表 → 元/百万 token（含汇率与分组）', () => {
  const table = probe.oneApiPricesToTable(ONE_API, 7.2);
  assert.equal(table.group, 'default');
  assert.equal(table.groupRatio, 1);
  assert.equal(table.skipped, 1, '按次计费的条目要跳过');
  // 0.5 倍率 → 0.5 × 2 美元/百万 = $1 → ¥7.2；输出 ×4
  assert.equal(table.prices['deepseek/deepseek-v4.1-flash'].in, 7.2);
  assert.equal(table.prices['deepseek/deepseek-v4.1-flash'].out, 28.8);
  assert.equal(table.prices['deepseek/deepseek-v4.1-flash'].cached, 7.2, '渠道倍率没有缓存档，按输入价');
  assert.match(table.prices['glm/glm-5.3'].note, /倍率 4/);
  assert.equal(table.prices['glm/glm-5.3'].out, Number((4 * 2 * 3.5 * 7.2).toFixed(6)));
});

test('没给汇率就用 7.2，并在条目备注里写明', () => {
  const table = probe.oneApiPricesToTable({ data: [{ model_name: 'x', model_ratio: 1 }] }, 0);
  assert.equal(table.prices.x.in, 14.4);
  assert.match(table.prices.x.note, /汇率 7.2/);
});

test('探测：识别 one-api 站点，并从 /api/status 取汇率', async () => {
  const github = fakeFetch({
    '/api/pricing': ONE_API,
    '/api/status': { data: { usd_exchange_rate: 7.31 } }
  });
  const res = await probe.probeChannelPrices({ url: 'https://api.example.com/provider/v1', fetchImpl: github });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'one-api');
  assert.equal(res.sourceUrl, 'https://api.example.com/api/pricing');
  assert.equal(res.usdRate, 7.31);
  assert.equal(res.modelCount, 2);
  assert.equal(res.skipped, 1);
  assert.ok(res.prices['deepseek/deepseek-v4.1-flash'].in > 7 && res.prices['deepseek/deepseek-v4.1-flash'].in < 7.4);
});

test('探测：自家价目表形状直接采用（元/百万，不换算）', async () => {
  const github = fakeFetch({
    '/api/pricing': { prices: { 'my-model': { in: 1.5, out: 6, cached: 0.1 } } }
  });
  const res = await probe.probeChannelPrices({ url: 'https://api.example.com', fetchImpl: github });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'table');
  assert.equal(res.prices['my-model'].in, 1.5);
  assert.equal(res.modelCount, 1);
});

test('探测：认不出来就明确失败，并把试过的地址列出来', async () => {
  const github = fakeFetch({ '/api/pricing': { hello: 'world' } });
  const res = await probe.probeChannelPrices({ url: 'https://api.example.com', fetchImpl: github });
  assert.equal(res.ok, false);
  assert.match(res.error, /探测失败/);
  assert.ok(res.tried.length >= 2, '候选地址都试过');
  assert.equal(Object.keys(res.prices).length, 0);
});

test('候选地址：站点根优先，去重，也能直接填 /api/pricing', () => {
  assert.deepEqual(
    probe.probeCandidates('https://api.commandcode.ai/provider/v1'),
    [
      'https://api.commandcode.ai/api/pricing',
      'https://api.commandcode.ai/api/status',
      'https://api.commandcode.ai/provider/v1/api/pricing'
    ]
  );
  assert.deepEqual(
    probe.probeCandidates('https://api.example.com/api/pricing'),
    ['https://api.example.com/api/pricing', 'https://api.example.com/api/status']
  );
  assert.deepEqual(probe.probeCandidates(''), []);
});

test('渠道价目表参与查价：手填的价仍然优先', () => {
  prices.setChannelPrices('demo-渠道', { 'my-model': { in: 0.8, out: 3.2 } });
  try {
    const fromTable = prices.resolveModelPrice('my-model', { api: { useOfficialPrice: true } }, null, { vendor: 'demo-渠道' });
    assert.equal(fromTable.source, 'channel-table');
    assert.equal(fromTable.kind, 'actual');
    assert.equal(fromTable.in, 0.8);

    // 别的渠道不受影响（回落官方价或未定价）
    const other = prices.resolveModelPrice('my-model', { api: { useOfficialPrice: true } }, null, { vendor: '别的站' });
    assert.equal(other.unpriced, true);

    // 手填的模型价优先于渠道价目表
    const manual = prices.resolveModelPrice(
      'my-model',
      { api: { useOfficialPrice: true, modelPrices: { 'my-model': { in: 9, out: 36 } } } },
      null,
      { vendor: 'demo-渠道' }
    );
    assert.equal(manual.source, 'custom');
    assert.equal(manual.in, 9);

    // 手填的渠道价更优先
    const manualChannel = prices.resolveModelPrice(
      'my-model',
      { api: { useOfficialPrice: true, modelPrices: { 'demo-渠道：my-model': { in: 5, out: 20 } } } },
      null,
      { vendor: 'demo-渠道' }
    );
    assert.equal(manualChannel.source, 'channel');
    assert.equal(manualChannel.in, 5);
  } finally {
    prices.setChannelPrices('demo-渠道', null);
  }
});

test('渠道价目表落盘 + 拉取失败时保留上一次的表', async () => {
  const good = fakeFetch({ '/pricing.json': { prices: { 'keep-model': { in: 2, out: 8 } } } });
  let status = await channel.refreshChannelFeed('落盘渠道', 'https://data.example.com/pricing.json', { fetchImpl: good });
  assert.equal(status.length, 1);
  assert.equal(status[0].ok, true);
  assert.equal(status[0].count, 1);
  assert.deepEqual(channel.channelPriceCounts()['落盘渠道'], 1);

  const bad = fakeFetch({ '/pricing.json': { __status: 500 } });
  status = await channel.refreshChannelFeed('落盘渠道', 'https://data.example.com/pricing.json', { fetchImpl: bad });
  assert.equal(status[0].ok, false);
  assert.match(status[0].error, /HTTP 500/);
  assert.deepEqual(channel.channelPriceCounts()['落盘渠道'], 1, '失败不清表，继续用上一次的价');

  // 重启：缓存能读回来（配置里有这个渠道时才注入）
  channel.initChannelPrices([{ vendor: '落盘渠道', url: 'https://data.example.com/pricing.json' }]);
  assert.deepEqual(channel.channelPriceCounts()['落盘渠道'], 1);

  // 配置里删掉这个渠道 → 不再注入
  channel.initChannelPrices([]);
  assert.equal(channel.channelPriceCounts()['落盘渠道'], undefined);
  // 光"不再注入"不够：已经在查价层里的那张表也必须撤掉（手工改 config 删渠道时不能等重启）
  const revoked = prices.resolveModelPrice('keep-model', { api: { useOfficialPrice: true } }, null, { vendor: '落盘渠道' });
  assert.equal(revoked.unpriced, true, '配置里删掉的渠道，注入要当场撤销');

  channel.removeChannelFeed('落盘渠道');
  assert.equal(channel.channelPriceStatus().length, 0);
});

test('拉取过程中被删掉的渠道，晚到的响应不能把表复活', async () => {
  // 单次 fetch 最长 15 秒（探测更久），这期间用户完全可能把渠道删掉
  let release = () => {};
  const slow = () => {
    slow.calls += 1;
    return new Promise((resolve) => {
      release = () => resolve({ ok: true, status: 200, json: async () => ({ prices: { 'ghost-model': { in: 1, out: 2 } } }) });
    });
  };
  slow.calls = 0;

  const promise = channel.refreshChannelFeed('幽灵渠道', 'https://ghost.example.com/pricing.json', { fetchImpl: slow });
  await new Promise((r) => setTimeout(r, 0));      // 让请求先发出去
  channel.removeChannelFeed('幽灵渠道');            // 用户在这段时间里删掉了它
  release();
  await promise;

  assert.equal(channel.channelPriceCounts()['幽灵渠道'], undefined, '删掉的渠道不该被晚到的响应复活');
  const priced = prices.resolveModelPrice('ghost-model', { api: { useOfficialPrice: true } }, null, { vendor: '幽灵渠道' });
  assert.equal(priced.unpriced, true, '也不该再注入查价层');
  assert.equal(
    channel.channelPriceStatus().some((f) => f.vendor === '幽灵渠道'),
    false,
    '状态里也不该再出现'
  );
});

/* ── 自动探测（零配置路径） ── */

test('自动探测：成功就登记成渠道价目表并生效', async () => {
  const github = fakeFetch({
    '/api/pricing': { data: [{ model_name: 'auto-model', quota_type: 0, model_ratio: 1, completion_ratio: 2 }] }
  });
  let savedPatch = null;
  const res = await channel.maybeAutoProbeChannel({
    baseUrl: 'https://auto.example.com/provider/v1',
    vendor: '自动渠道',
    feedsConfig: [],
    options: {
      fetchImpl: github,
      getConfig: () => ({ api: { channelPriceFeeds: [] } }),
      updateConfig: (patch) => { savedPatch = patch; }
    }
  });
  assert.equal(res.probed, true);
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.ok(savedPatch, '要把渠道价目表写进配置');
  assert.equal(savedPatch.api.channelPriceFeeds[0].vendor, '自动渠道');
  assert.equal(savedPatch.api.channelPriceFeeds[0].auto, true);
  // 登记必须是**探测命中的价目地址**，不是用户填的 Base URL：
  // 登记 Base URL 的话之后每次刷新都拉不到 JSON，价目表会永久冻结在首次探测那一刻。
  assert.equal(
    savedPatch.api.channelPriceFeeds[0].url,
    'https://auto.example.com/api/pricing',
    '登记的是价目地址（probe.sourceUrl）'
  );
  assert.deepEqual(channel.channelPriceCounts()['自动渠道'], 1);
  // 用登记的地址能正常刷新（Base URL 在这个假站点上只会 404）
  const again = await channel.refreshChannelFeed('自动渠道', savedPatch.api.channelPriceFeeds[0].url, { fetchImpl: github });
  assert.equal(again[0].ok, true, '登记后的地址要能正常刷新');
  assert.equal(again[0].url, 'https://auto.example.com/api/pricing');
  // 价格也真的生效了（该渠道下 1 倍率 = ¥14.4/百万）
  const p = prices.resolveModelPrice('auto-model', { api: { useOfficialPrice: true } }, null, { vendor: '自动渠道' });
  assert.equal(p.source, 'channel-table');
  assert.ok(p.in > 14 && p.in < 15);
  channel.removeChannelFeed('自动渠道');
});

test('自动探测：失败静默、不登记、不抛异常', async () => {
  const github = fakeFetch({ '/api/pricing': { hello: 'world' } });
  let called = 0;
  const res = await channel.maybeAutoProbeChannel({
    baseUrl: 'https://nope.example.com',
    vendor: '失败的渠道',
    feedsConfig: [],
    options: {
      fetchImpl: github,
      getConfig: () => ({ api: { channelPriceFeeds: [] } }),
      updateConfig: () => { called += 1; }
    }
  });
  assert.equal(res.probed, true);
  assert.equal(res.ok, false);
  assert.equal(called, 0, '失败不写配置');
  assert.equal(channel.channelPriceCounts()['失败的渠道'], undefined);
});

test('自动探测：已配过或刚探过就跳过', async () => {
  const github = fakeFetch({ '/api/pricing': { data: [{ model_name: 'x', model_ratio: 1 }] } });
  const configured = await channel.maybeAutoProbeChannel({
    baseUrl: 'https://x.example.com',
    vendor: '已有渠道',
    feedsConfig: [{ vendor: '已有渠道', url: 'https://x.example.com/pricing.json' }],
    options: { fetchImpl: github }
  });
  assert.equal(configured.probed, false);
  assert.equal(configured.reason, 'configured');

  const noUrl = await channel.maybeAutoProbeChannel({ baseUrl: '', vendor: '空地址', feedsConfig: [] });
  assert.equal(noUrl.probed, false);
  assert.equal(noUrl.reason, 'no-target');
});

/* ── 远程价格表：默认用项目自己的表，候选依次兜底 ── */

test('远程价格表默认地址：jsDelivr 优先、raw 兜底；填 none 关闭', async () => {
  assert.deepEqual(feed.priceFeedTargets(''), [
    'https://cdn.jsdelivr.net/gh/sakurawwwxh/qq-agent-plus@main/prices.json',
    'https://raw.githubusercontent.com/sakurawwwxh/qq-agent-plus/main/prices.json'
  ]);
  assert.deepEqual(feed.priceFeedTargets('https://mine.example.com/prices.json'), ['https://mine.example.com/prices.json']);
  assert.deepEqual(feed.priceFeedTargets('none'), []);
  assert.deepEqual(feed.priceFeedTargets('OFF'), []);

  const calls = [];
  const fake = async (url) => {
    calls.push(String(url));
    if (String(url).includes('jsdelivr')) return { ok: false, status: 502, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        prices: { 'from-feed': { in: 3, out: 9 } },
        aliases: { 'old-name': { to: 'from-feed', from: '2026-01-01T00:00:00+08:00' } }
      })
    };
  };
  const st = await feed.refreshPriceFeed('', { fetchImpl: fake });
  assert.equal(calls.length, 2, '第一个候选失败后要试第二个');
  assert.equal(st.ok, true);
  assert.match(st.sourceUrl, /raw\.githubusercontent\.com/);
  assert.equal(st.count, 1);
  assert.equal(st.aliasCount, 1);

  // 远程表带的"带时间区间别名"也要生效（生效期内指过去，生效前不指）
  const inRange = prices.resolveOfficialPrice('old-name', { at: Date.parse('2026-06-01T00:00:00+08:00') });
  assert.equal(inRange.matched, 'from-feed');
  const beforeRange = prices.resolveOfficialPrice('old-name', { at: Date.parse('2025-12-01T00:00:00+08:00') });
  assert.equal(beforeRange, null, '区间之外不该套用别名');
  prices.setRemotePrices({});
});

test('远程价格表：所有候选都失败时报错但不影响内置表', async () => {
  const fake = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const st = await feed.refreshPriceFeed('', { fetchImpl: fake, timeoutMs: 1000 });
  assert.equal(st.ok, false);
  assert.match(st.error, /jsdelivr/);
  assert.match(st.error, /raw\.githubusercontent/);
  // 内置表仍然可用
  assert.equal(prices.resolveOfficialPrice('deepseek-flash').in, 1);
});

/* ── 价格表条目校验：未定价 ≠ 免费 ── */

test('价格表条目校验：null/空串/负数不会被当成 0 元免费价', () => {
  const norm = feed.normalizePriceFeed({
    prices: {
      'free-ok': { in: 0, out: 0 },            // 写出来的 0/0：真·免费模型，保留
      'only-out': { out: 5 },                  // 只写输出：输入按 0
      'str-num': { in: '3', out: '9' },        // 数字串：接受
      'null-both': { in: null, out: null },    // 写了但没值 → 丢弃
      'empty-in': { in: '', out: 3 },          // 空串 → 丢弃（不能当 0 元）
      'negative': { in: -1, out: 2 },          // 负数 → 丢弃
      'bool-in': { in: true, out: 2 },         // 布尔 → 丢弃
      'junk': 'not-an-object'
    }
  });
  assert.ok(norm, '整表仍是合法的');
  assert.deepEqual(Object.keys(norm.prices).sort(), ['free-ok', 'only-out', 'str-num']);
  assert.equal(norm.prices['free-ok'].in, 0, '0/0 是合法的免费价');
  assert.equal(norm.prices['only-out'].out, 5);
  assert.equal(norm.prices['str-num'].in, 3);
  assert.equal(norm.dropped, 5, '坏条目要计数（界面能看出有东西被丢了）');

  // 关键：被丢弃的模型在查价链里是"未定价"，而不是"0 元免费"
  prices.setRemotePrices(norm.prices, norm.aliases);
  assert.equal(prices.resolveOfficialPrice('null-both'), null);
  assert.equal(prices.resolveOfficialPrice('negative'), null);
  assert.ok(prices.resolveOfficialPrice('free-ok'), '免费模型仍要能匹配到');
  assert.equal(prices.resolveOfficialPrice('free-ok').in, 0);
  prices.setRemotePrices({});
});

test('探测：显式给的汇率优先于站点上的 /api/status', async () => {
  const routes = {
    '/api/status': { data: { usd_exchange_rate: 7.2 } },
    '/api/pricing': { data: [{ model_name: 'r-model', quota_type: 0, model_ratio: 1, completion_ratio: 2 }] }
  };
  const fake = fakeFetch(routes);
  // 1 倍率 = 2 美元/百万 → 汇率 8 时 ¥16/百万
  const res = await probe.probeChannelPrices({
    url: 'https://rate.example.com',
    usdRate: 8,
    fetchImpl: fake
  });
  assert.equal(res.ok, true);
  assert.equal(res.usdRate, 8, '显式传入的汇率要被采用');
  assert.equal(res.prices['r-model'].in, 16);

  // 不给就用站点汇率
  const auto = await probe.probeChannelPrices({ url: 'https://rate.example.com', fetchImpl: fake });
  assert.equal(auto.usdRate, 7.2);
  assert.equal(auto.prices['r-model'].in, 14.4);
});

test('同进程内删掉再加回同一个渠道：拉取不能被 revoked 永久挡住', async () => {
  const cfgMod = await import('../src/core/config.js');
  const good = fakeFetch({ '/pricing.json': { prices: { 'again-model': { in: 1, out: 2 } } } });
  const url = 'https://again.example.com/pricing.json';

  await channel.refreshChannelFeed('重生渠道', url, { fetchImpl: good });
  assert.equal(channel.channelPriceCounts()['重生渠道'], 1);

  // 控制台删除：先从配置里摘掉，再撤销注入
  cfgMod.updateConfig({ api: { ...(cfgMod.getConfig().api || {}), channelPriceFeeds: [] } });
  channel.removeChannelFeed('重生渠道');
  assert.equal(channel.channelPriceCounts()['重生渠道'], undefined);

  // 控制台「添加并拉取」：只写配置 + 拉取，不会再走 initChannelPrices 去解禁
  cfgMod.updateConfig({
    api: { ...(cfgMod.getConfig().api || {}), channelPriceFeeds: [{ vendor: '重生渠道', url }] }
  });
  await channel.refreshChannelFeed('重生渠道', url, { fetchImpl: good });
  assert.equal(good.calls.length, 2, `加回来之后必须真的发请求（实际 ${good.calls.length} 次）`);
  assert.equal(channel.channelPriceCounts()['重生渠道'], 1, '并且要重新注入');

  cfgMod.updateConfig({ api: { ...(cfgMod.getConfig().api || {}), channelPriceFeeds: [] } });
  channel.removeChannelFeed('重生渠道');
});
