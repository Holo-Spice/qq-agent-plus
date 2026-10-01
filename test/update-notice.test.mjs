import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-notice-'));
process.env.QQ_AGENT_DATA_DIR = root;

const {
  parseGithubRepo, checkForUpdate, ignoreVersion, githubApiBase
} = await import('../src/update-notice.js');
const { readAutoUpdateState } = await import('../src/auto-update.js');

after(() => fs.rmSync(root, { recursive: true, force: true }));

const CONFIG = {
  autoUpdate: {
    repository: 'https://github.com/sakurawwwxh/qq-agent-plus.git',
    branch: 'main'
  }
};
const DEPLOYED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// 与 GitHub compare 一致：按时间正序（最早的在前），客户端展示时反转成"最新在上"。
const DELTA_COMMITS = [
  { sha: 'dddddddddddddddddddddddddddddddddddddddd', subject: '更早的一个提交' },
  { sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', subject: '中间的一个提交' },
  { sha: 'ffffffffffffffffffffffffffffffffffffffff', subject: '最新的一个提交' }
];
const RELEASE = {
  tag_name: 'v9.9.9',
  name: 'v9.9.9 —— 测试版本',
  body: '- 新增了某某功能\n- 修了某某问题',
  published_at: '2026-09-20T00:00:00Z',
  html_url: 'https://example.com/release',
  draft: false,
  prerelease: false
};

function caseDir(deployed = DEPLOYED) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  if (deployed) fs.writeFileSync(path.join(dir, 'deployed-revision'), `${deployed}\n`);
  return dir;
}

/** 假的 GitHub：/releases/latest 与 /compare/{base}...{head} 两条路由。 */
function fakeGitHub({
  release = RELEASE,
  releaseHttp = 200,
  compareHttp = 200,
  compareStatus = 'ahead',
  commits = DELTA_COMMITS
} = {}) {
  const impl = async (url) => {
    const target = String(url);
    impl.calls.push(target);
    if (/\/releases\/latest$/.test(target)) {
      if (releaseHttp !== 200) return { ok: false, status: releaseHttp, json: async () => null };
      return { ok: true, status: 200, json: async () => release };
    }
    if (/\/compare\//.test(target)) {
      if (compareHttp !== 200) return { ok: false, status: compareHttp, json: async () => null };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: compareStatus,
          total_commits: commits.length,
          commits: commits.map((item) => ({ sha: item.sha, commit: { message: `${item.subject}\n\n细节` } }))
        })
      };
    }
    return { ok: false, status: 404, json: async () => null };
  };
  impl.calls = [];
  return impl;
}

test('parses GitHub repository slugs', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  assert.deepEqual(parseGithubRepo('https://github.com/a/b'), { owner: 'a', repo: 'b' });
  assert.equal(parseGithubRepo('https://gitlab.com/a/b'), null);
  assert.equal(parseGithubRepo(''), null);
});

test('advertises a published release with its notes and the commits it brings', async () => {
  const dir = caseDir();
  const github = fakeGitHub();
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(notice.available, true);
  assert.equal(notice.reason, '');
  assert.equal(notice.version, 'v9.9.9', '版本号用 Release tag');
  assert.equal(notice.revision, 'v9.9.9', '目标是 tag 本身，不是 branch 上的提交');
  assert.equal(notice.name, RELEASE.name);
  assert.equal(notice.commitCount, DELTA_COMMITS.length);
  assert.equal(notice.url, RELEASE.html_url);
  assert.match(notice.body, /【v9\.9\.9 发布说明】/);
  assert.match(notice.body, /最新的一个提交/);
  assert.ok(notice.body.indexOf('最新的一个提交') < notice.body.indexOf('更早的一个提交'), '最新提交在最上面');
  assert.ok(
    github.calls.some((url) => url.includes(`/compare/${DEPLOYED}...v9.9.9`)),
    '方向判定要比较「当前部署...Release tag」'
  );
  const state = readAutoUpdateState(dir);
  assert.equal(state.updateNotice.available, true);
  assert.equal(state.updateNotice.version, 'v9.9.9');
});

test('a release already contained in the deployment is "current", never a rollback', async () => {
  const dir = caseDir();
  // behind：当前部署比 Release 更靠前（例如自己跟着 main 走）→ 不能提示、更不能回退
  const notice = await checkForUpdate(dir, CONFIG, {
    fetchImpl: fakeGitHub({ compareStatus: 'behind' }),
    force: true
  });
  assert.equal(notice.available, false);
  assert.equal(notice.reason, 'ahead-of-release');
  assert.equal(notice.version, 'v9.9.9', '仍记录最新 Release，供面板说明');

  const same = await checkForUpdate(caseDir(), CONFIG, {
    fetchImpl: fakeGitHub({ compareStatus: 'identical' }),
    force: true
  });
  assert.equal(same.available, false);
  assert.equal(same.reason, '');
});

test('diverged lines still follow the release', async () => {
  const dir = caseDir();
  const notice = await checkForUpdate(dir, CONFIG, {
    fetchImpl: fakeGitHub({ compareStatus: 'diverged' }),
    force: true
  });
  assert.equal(notice.available, true);
  assert.equal(notice.version, 'v9.9.9');
});

test('a repository without any release never advertises an update', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ releaseHttp: 404 });
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(notice.available, false);
  assert.equal(notice.reason, 'no-release');
  assert.equal(notice.version, '');
  assert.equal(github.calls.filter((url) => /\/compare\//.test(url)).length, 0, '没有 Release 就不必比较');
  assert.ok(notice.checkedAt > 0, '“没有 Release”是稳定结论，可以缓存');
});

test('draft and prerelease builds are not advertised', async () => {
  const dir = caseDir();
  const draft = await checkForUpdate(dir, CONFIG, {
    fetchImpl: fakeGitHub({ release: { ...RELEASE, draft: true } }),
    force: true
  });
  assert.equal(draft.available, false);
  assert.equal(draft.reason, 'no-release');

  const prerelease = await checkForUpdate(caseDir(), CONFIG, {
    fetchImpl: fakeGitHub({ release: { ...RELEASE, prerelease: true } }),
    force: true
  });
  assert.equal(prerelease.available, false);
  assert.equal(prerelease.reason, 'no-release');
});

test('an unknown deployment baseline is described but not advertised', async () => {
  const dir = caseDir('');
  const notice = await checkForUpdate(dir, CONFIG, { fetchImpl: fakeGitHub(), force: true });

  assert.equal(notice.available, false);
  assert.equal(notice.reason, 'unknown-deployed');
  assert.equal(notice.version, 'v9.9.9', '面板要能告诉用户最新 Release 是哪个');
});

test('a failed release lookup is neither cached nor reported as "no release"', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ releaseHttp: 503 });
  const first = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(first.available, false);
  assert.equal(first.reason, 'unreachable');
  assert.equal(first.checkedAt, 0, '读不到就不写缓存，下次重试');
  assert.match(String(first.error), /GitHub 返回 503/);

  const callsAfterFirst = github.calls.length;
  const second = await checkForUpdate(dir, CONFIG, { fetchImpl: github });
  assert.equal(second.cached, undefined);
  assert.ok(github.calls.length > callsAfterFirst, '失败后下一次打开控制台应重试');
});

test('a failed comparison neither advertises nor caches, so the direction is never guessed', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ compareHttp: 502 });
  const first = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });

  assert.equal(first.available, false);
  assert.equal(first.reason, 'compare-failed');
  assert.equal(first.checkedAt, 0);
  assert.match(String(first.error), /502/);
  assert.equal(readAutoUpdateState(dir).updateNotice.available, false);

  const callsAfterFirst = github.calls.length;
  const second = await checkForUpdate(dir, CONFIG, { fetchImpl: github });
  assert.equal(second.cached, undefined);
  assert.ok(github.calls.length > callsAfterFirst);
});

test('serves cached results within the TTL and refreshes once the baseline moves', async () => {
  const dir = caseDir();
  const github = fakeGitHub({ compareStatus: 'identical' });
  const first = await checkForUpdate(dir, CONFIG, { fetchImpl: github, force: true });
  const callsAfterFirst = github.calls.length;

  const cached = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    now: Number(first.checkedAt) + 60_000
  });
  assert.equal(cached.cached, true);
  assert.equal(github.calls.length, callsAfterFirst, '缓存命中时不请求 GitHub');

  // 基线变了（刚部署完）→ 立即重新检查
  fs.writeFileSync(path.join(dir, 'deployed-revision'), `${'1'.repeat(40)}\n`);
  const refreshed = await checkForUpdate(dir, CONFIG, {
    fetchImpl: github,
    now: Number(first.checkedAt) + 60_000
  });
  assert.equal(refreshed.cached, undefined);
  assert.ok(github.calls.length > callsAfterFirst);
});

test('the GitHub API base can be pointed elsewhere for tests and mirrors', () => {
  assert.equal(githubApiBase(), 'https://api.github.com');
  process.env.QQ_AGENT_GITHUB_API = 'http://127.0.0.1:9/api/';
  try {
    assert.equal(githubApiBase(), 'http://127.0.0.1:9/api', '去掉尾部斜杠');
  } finally {
    delete process.env.QQ_AGENT_GITHUB_API;
  }
});

test('ignores exactly one release tag at a time', () => {
  const dir = caseDir();
  assert.equal(ignoreVersion(dir, 'v9.9.9'), 'v9.9.9');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
  assert.equal(ignoreVersion(dir, ''), '', '空版本号不写入');
  assert.equal(readAutoUpdateState(dir).ignoredVersion, 'v9.9.9');
});
