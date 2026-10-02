// 健康巡检测试（改进方案 C8/#7）：检查项分支、observe 跳过、失败连击抑制、恢复通知。
// 全桩件化（fetch/statfs/notify 注入），不打真实网络；health.json 落盘在临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { runHealthCheck } = await import('../src/core/health-check.js');
const { openDatabase } = await import('../src/core/sqlite.js');
const { readOwnerUin } = await import('../src/core/notify-owner.js');

function makeDataDir({ withDb = true, withUpdaterState = false, withMarker = false, outboundAgoMs = 0, inboundAgoMs = 0, inboundState = 'pending', inboundAvailableInMs = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-health-'));
  if (withDb) {
    const db = openDatabase(path.join(dir, 'messages.sqlite'));
    db.exec(`CREATE TABLE IF NOT EXISTS messages (
      chat_key TEXT NOT NULL, id INTEGER NOT NULL, mid TEXT, ts INTEGER NOT NULL,
      sender_id TEXT, sender_name TEXT, text TEXT NOT NULL, self INTEGER NOT NULL DEFAULT 0,
      reply TEXT, media TEXT NOT NULL DEFAULT '[]', mentions_self INTEGER NOT NULL DEFAULT 0,
      target_user_id TEXT NOT NULL DEFAULT '', event_kind TEXT NOT NULL DEFAULT 'message',
      state TEXT NOT NULL DEFAULT 'pending', lease_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL DEFAULT 0, error TEXT
    )`);
    const now = Date.now();
    db.prepare('INSERT INTO messages (chat_key, id, ts, text, self) VALUES (?, ?, ?, ?, 1)').run('group:1', 1, now - outboundAgoMs, 'hi');
    // inboundAgoMs = null 表示"库里从来没有入站记录"；
    // inboundAvailableInMs = null 表示 available_at=0（真实入库的默认值：立即到期）
    if (inboundAgoMs !== null) {
      const availableAt = inboundAvailableInMs === null ? 0 : now + inboundAvailableInMs;
      db.prepare('INSERT INTO messages (chat_key, id, ts, text, self, state, available_at) VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run('group:1', 2, now - inboundAgoMs, '有人吗', inboundState, availableAt);
    }
    db.close();
  }
  if (withUpdaterState) {
    fs.writeFileSync(path.join(dir, 'auto-update.json'), JSON.stringify({ status: 'failed', error: 'boom' }));
  }
  if (withMarker) fs.writeFileSync(path.join(dir, '.deploy-in-progress'), '{}');
  return dir;
}

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0 }) });
const badFetch = async () => { throw new Error('ECONNREFUSED'); };
const okStatfs = () => ({ bavail: 100, bsize: 1024 * 1024 * 1024 });          // 100GB
const lowStatfs = () => ({ bavail: 0.2, bsize: 1024 * 1024 * 1024 });          // 0.2GB

test('全绿：控件/OneBot/水位/磁盘/完整性都过 → healthy，退出码 0', async () => {
  const dir = makeDataDir();
  const r = await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify: null });
  assert.equal(r.healthy, true);
  assert.equal(r.code, 0);
  assert.equal(r.checks.find((c) => c.name === 'console-healthz').ok, true);
  assert.equal(r.checks.find((c) => c.name === 'onebot-status').ok, true);
  assert.equal(r.checks.find((c) => c.name === 'sqlite-integrity').ok, true);
});

test('控制台不可达 → 该项失败、healthy=false、退出码 1', async () => {
  const dir = makeDataDir();
  const r = await runHealthCheck({ dataDir: dir, fetchImpl: badFetch, statfs: okStatfs, notify: null });
  assert.equal(r.healthy, false);
  assert.equal(r.code, 1);
  assert.match(r.checks.find((c) => c.name === 'console-healthz').detail, /ECONNREFUSED/);
});

test('observe 模式跳过出站水位（不发消息不算故障）', async () => {
  const dir = makeDataDir();
  const r = await runHealthCheck({ dataDir: dir, mode: 'observe', fetchImpl: okFetch, statfs: okStatfs, notify: null });
  const item = r.checks.find((c) => c.name === 'outbound-freshness');
  assert.equal(item.ok, true);
  assert.match(item.detail, /observe/);
});

test('active 模式：入站到期未处理（管道停滞）→ 失败；已处理 → 通过', async () => {
  // 判据（2026-10-02 修订）：看的不是"出站多新"，而是"**到期的入站有没有被处理**"。
  // 入站 40 分钟前到达、仍停在 pending（到期超过 30 分钟宽限）＝ 管道停滞 → 失败。
  const stale = makeDataDir({ outboundAgoMs: 7 * 60 * 60 * 1000, inboundAgoMs: 40 * 60 * 1000 });
  const staleRun = await runHealthCheck({
    dataDir: stale, fetchImpl: okFetch, statfs: okStatfs, notify: null,
    outboundStaleMs: 6 * 60 * 60 * 1000,
  });
  const staleItem = staleRun.checks.find((c) => c.name === 'outbound-freshness');
  assert.equal(staleItem.ok, false);
  assert.match(staleItem.detail, /未被处理/);

  // 同样的出站水位，入站已经评估过（acked：回了，或按概率决定不回）→ 不是故障。
  // 这条就是 2026-10-02 08:15 那次误报的回归用例：旧判据（入站新 → 出站必须新）在这里必红。
  const handled = makeDataDir({ outboundAgoMs: 7 * 60 * 60 * 1000, inboundAgoMs: 40 * 60 * 1000, inboundState: 'acked' });
  const handledRun = await runHealthCheck({
    dataDir: handled, fetchImpl: okFetch, statfs: okStatfs, notify: null,
    outboundStaleMs: 6 * 60 * 60 * 1000,
  });
  const handledItem = handledRun.checks.find((c) => c.name === 'outbound-freshness');
  assert.equal(handledItem.ok, true);
  assert.match(handledItem.detail, /均已处理/);
});

test('active 模式：入站刚到还在处理窗口内（pending 未满宽限）→ 不算故障', async () => {
  // 出站过旧 + 入站 10 分钟前（未超 30 分钟宽限）＝ 可能在处理中，不该告警
  const dir = makeDataDir({ outboundAgoMs: 7 * 60 * 60 * 1000, inboundAgoMs: 10 * 60 * 1000 });
  const r = await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify: null });
  const item = r.checks.find((c) => c.name === 'outbound-freshness');
  assert.equal(item.ok, true);
  assert.match(item.detail, /处理中/);
});

test('active 模式：入站被显式排期到未来（available_at 未到）→ 不算故障', async () => {
  // 到达 40 分钟前但排期在 1 小时后（重试退避/延迟处理）：还没到期，不算卡住
  const dir = makeDataDir({
    outboundAgoMs: 7 * 60 * 60 * 1000, inboundAgoMs: 40 * 60 * 1000, inboundAvailableInMs: 60 * 60 * 1000,
  });
  const r = await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify: null });
  assert.equal(r.checks.find((c) => c.name === 'outbound-freshness').ok, true);
});

test('active 模式：time-gate held 的入站 → 不算故障', async () => {
  // 静默时段收到的消息被故意持有到活跃时段：是延迟不是卡住
  const dir = makeDataDir({ outboundAgoMs: 7 * 60 * 60 * 1000, inboundAgoMs: 40 * 60 * 1000, inboundState: 'held' });
  const r = await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify: null });
  assert.equal(r.checks.find((c) => c.name === 'outbound-freshness').ok, true);
});

test('active 模式：窗口内没人说话（最后一条入站也在窗口外）→ 静默期，不算故障', async () => {
  // 2026-10-01 实测误报：凌晨 00:13 部署后群里没人说话，出站水位 6 小时越线，
  // 连击 3 次就私聊 owner 报"收发停止" —— 判据要是"有人说话而 bot 没回"，不是"bot 没说话"
  const dir = makeDataDir({ outboundAgoMs: 7 * 60 * 60 * 1000, inboundAgoMs: 7 * 60 * 60 * 1000 });
  const r = await runHealthCheck({
    dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify: null,
    outboundStaleMs: 6 * 60 * 60 * 1000,
  });
  const item = r.checks.find((c) => c.name === 'outbound-freshness');
  assert.equal(item.ok, true, '安静时段不该报"收发停止"');
  assert.match(item.detail, /静默期/);
});

test('active 模式：库里从来没有入站记录 → 静默期，不算故障', async () => {
  const dir = makeDataDir({ outboundAgoMs: 7 * 60 * 60 * 1000, inboundAgoMs: null });
  const r = await runHealthCheck({
    dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify: null,
    outboundStaleMs: 6 * 60 * 60 * 1000,
  });
  const item = r.checks.find((c) => c.name === 'outbound-freshness');
  assert.equal(item.ok, true);
  assert.match(item.detail, /静默期/);
});

test('磁盘余量不足 → 失败', async () => {
  const dir = makeDataDir();
  const r = await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: lowStatfs, notify: null });
  assert.equal(r.checks.find((c) => c.name === 'disk-space').ok, false);
});

test('自动更新 failed 与部署中断标记 → 相应检查项失败', async () => {
  const dir = makeDataDir({ withUpdaterState: true, withMarker: true });
  const r = await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify: null });
  assert.equal(r.checks.find((c) => c.name === 'auto-update').ok, false);
  assert.equal(r.checks.find((c) => c.name === 'deploy-interrupted').ok, false);
  assert.match(r.checks.find((c) => c.name === 'deploy-interrupted').detail, /LINUX\.md/);
});

test('连续 3 次失败才通知；恢复时补发一次"已恢复"', async () => {
  const dir = makeDataDir();
  const notes = [];
  const notify = async (text) => { notes.push(text); };
  // 三连失败：前两次静默，第三次告警
  for (let i = 1; i <= 3; i++) {
    const r = await runHealthCheck({ dataDir: dir, fetchImpl: badFetch, statfs: okStatfs, notify });
    assert.equal(r.healthy, false);
  }
  // 失败源有多个检查项（console-healthz / onebot-status 都失败）：各自在第 3 次触发
  const alerts = notes.filter((t) => t.includes('健康告警'));
  assert.ok(alerts.length >= 1, '第 3 次应发告警');
  assert.match(notes.at(-1), /healthz|状态|检查/);
  // 前两次巡检（共 2 轮 × 多项）不应有任何告警
  assert.equal(notes.filter((t) => t.includes('健康告警')).length, 2, '失败项就是 console-healthz 与 onebot-status 两项');
  // 恢复
  const ok = await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify });
  assert.equal(ok.healthy, true);
  assert.match(notes.at(-1), /健康恢复/);
  // 恢复两次（两个失败类别各一条，与告警对称）
  assert.equal(notes.filter((t) => t.includes('健康恢复')).length, 2);
  // 恢复后再正常，不应重复发恢复通知
  const before = notes.length;
  const again = await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify });
  assert.equal(again.healthy, true);
  assert.equal(notes.length, before, '状态没变化就不该再发任何通知');
});

// ── 2026-09-30 审查 P1：注入的通知器（生产是 notify-owner 的 sendOwnerText）**失败时返回
//    { ok:false } 而不抛**，原来只 try/catch，于是"没发出去"被记成"已送达"、且因为触发条件是
//    count===3 的硬相等，一次瞬时失败 = 整段故障期再也不告警。以下两条锁住修复。
test('通知失败（返回 ok:false）不得记成已送达，且下一轮要继续重试', async () => {
  const dir = makeDataDir();
  const attempts = [];
  // 前 2 次返回失败，第 3 次成功（模拟 OneBot 短暂不可用后恢复）
  const notify = async (text) => {
    attempts.push(text);
    const alertCount = attempts.filter((t) => t.includes('健康告警') && t.includes('onebot-status')).length;
    return alertCount >= 3 ? { ok: true, detail: '' } : { ok: false, detail: 'OneBot HTTP 500' };
  };
  for (let i = 1; i <= 5; i++) {
    await runHealthCheck({ dataDir: dir, fetchImpl: badFetch, statfs: okStatfs, notify });
  }
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8'));
  const ob = state.streaks['onebot-status'];
  assert.ok(ob.lastNotifiedAt, '重试到成功那轮应记下送达时间');
  assert.ok(!ob.notifyError, '送达成功后应清掉错误痕迹');
  // 第 1、2 次尝试都失败（每轮 1 次 onebot-status 告警），第 3 次成功 → 共 3 次
  const onebotAlerts = attempts.filter((t) => t.includes('健康告警') && t.includes('onebot-status'));
  assert.equal(onebotAlerts.length, 3, '失败后每轮都要重试，直到送达');
});

test('通知一直失败：记下 notifyError，且不谎报在 notified 里', async () => {
  const dir = makeDataDir();
  const notify = async () => ({ ok: false, detail: 'OneBot HTTP 500' });
  let last = null;
  for (let i = 1; i <= 4; i++) {
    last = await runHealthCheck({ dataDir: dir, fetchImpl: badFetch, statfs: okStatfs, notify });
  }
  assert.ok(!last.notified.some((n) => n.startsWith('告警:onebot-status')), '没送达就不该出现在 notified');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8'));
  assert.match(state.streaks['onebot-status'].notifyError, /500/);
  assert.ok(!state.streaks['onebot-status'].lastNotifiedAt, '失败不得留下送达时间');
});

test('health.json 落盘含 streaks 与最后结果，权限 0600', async () => {
  const dir = makeDataDir();
  await runHealthCheck({ dataDir: dir, fetchImpl: okFetch, statfs: okStatfs, notify: null });
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8'));
  assert.equal(typeof state.lastRunAt, 'number');
  assert.ok(Array.isArray(state.lastResults));
  assert.equal(state.healthy, true);
  assert.ok((state.streaks['console-healthz']?.count ?? 0) === 0, '全绿时该类别无连击');
});

test('readOwnerUin：admin 一节存在时是唯一真相，老字段只在无 admin 时回退', () => {
  assert.equal(readOwnerUin({ admin: { ownerUin: '10001' }, autoUpdate: { ownerUin: '99999' } }), '10001');
  assert.equal(readOwnerUin({ admin: { ownerUin: '' }, autoUpdate: { ownerUin: '99999' } }), '');
  assert.equal(readOwnerUin({ autoUpdate: { ownerUin: '99999' } }), '99999');
});

// 2026-10-01 审查：两个本机探测必须带超时。原来交给 undici 的默认上限（约 300 秒），
// 控制台"接受连接但不响应"时一轮巡检就被拖住整个窗口 —— 而健康定时器就是 5 分钟一次，
// 巡检会自己叠在一起排不上。变异对照：把 signal 去掉 → 桩走"没传超时信号"分支，断言全红。
test('巡检：探测带超时，挂死的服务拖不住整轮', async () => {
  const dir = makeDataDir();
  // 桩：像真实 fetch 一样尊重 signal；没有 signal 就当"永远不响应"（1.2 秒后报错收场）
  // 兜底计时器必须是 **ref 的**：AbortSignal.timeout 自带的定时器是 unref 的，
  // 若桩里只有它，事件循环会被抽空、node:test 判 cancelledByParent（Linux 实测踩到）。
  const hangingFetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      setTimeout(() => reject(new Error('没有拿到 AbortSignal')), 1200);
      return;
    }
    const guard = setTimeout(() => reject(new Error('既没中止也没超时')), 5000);
    const onAbort = () => { clearTimeout(guard); reject(signal.reason ?? new Error('aborted')); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const started = Date.now();
  const r = await runHealthCheck({
    dataDir: dir, mode: 'observe', fetchImpl: hangingFetch, fetchTimeoutMs: 60, statfs: okStatfs, notify: null
  });
  const elapsed = Date.now() - started;

  for (const name of ['console-healthz', 'onebot-status']) {
    const check = r.checks.find((c) => c.name === name);
    assert.equal(check.ok, false, `${name} 挂死时必须判失败`);
    assert.ok(
      !/没有拿到 AbortSignal|既没中止也没超时/.test(check.detail),
      `${name} 的探测必须带 AbortSignal：${check.detail}`
    );
    assert.match(check.detail, /abort/i, `${name} 的失败原因应是被中止：${check.detail}`);
  }
  // 两个探测各 60ms 上限；放宽到 1 秒只为避开 CI 抖动，仍然远小于 undici 的默认上限
  assert.ok(elapsed < 1000, `整轮巡检不该被挂死服务拖住，实测 ${elapsed}ms`);
  assert.equal(r.healthy, false);
  assert.equal(r.code, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
