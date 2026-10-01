import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { autoUpdateOwner } from '../src/auto-update.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('promoted-feature UI uses render-boundary normalization instead of DOM mutation polling', () => {
  const source = read('ui/stable-features.js');
  assert.doesNotMatch(source, /new\s+MutationObserver\s*\(/);
  assert.match(source, /renderExperimentalSettingsSection/);
  assert.match(source, /renderFriendFeaturePage/);
  assert.match(source, /renderIncidentFeaturePage/);
  assert.match(source, /cfg-global-admin-owner/);
});

// 2026-10-01 审查：本模块原来手抄了第 6 份配置请求（自己拼 x-console-token、自己判 ok），
// 于是 401 时拿不到中央处理（弹登录框、收起 loading 壳），令牌常量也各写一份。
// 现在必须交给共享的 api()。
test('stable-features 的配置请求走共享 api()，不再自己手抄一份', () => {
  const source = read('ui/stable-features.js');
  assert.match(source, /import\s*\{[^}]*\bapi\b[^}]*\}\s*from\s*'\.\/core\/api\.js'/,
    '要 import 共享的 api()');
  assert.match(source, /await api\('\/api\/config'/, '配置请求要交给 api()');
  assert.doesNotMatch(source, /fetch\('\/api\/config'/, '不许自己再拼一份 fetch');
  assert.doesNotMatch(source, /x-console-token/, '鉴权头由 api() 统一加，本模块里不该再出现');
});

test('auto update uses global admin once migrated and only falls back for pre-admin legacy files', () => {
  assert.equal(autoUpdateOwner({
    admin: { ownerUin: '12345678' },
    autoUpdate: { ownerUin: '87654321' },
    incidentPilot: { ownerUin: '22222222' },
    identityPilot: { friendProposal: { ownerUin: '33333333' } }
  }), '12345678');

  // An explicitly empty admin remains authoritative; old mirrors cannot revive it.
  assert.equal(autoUpdateOwner({
    admin: { ownerUin: '' },
    autoUpdate: { ownerUin: '87654321' }
  }), '');

  // The standalone updater can start before the main process migrates an old
  // config.json, so a file with no admin section gets one read-only fallback.
  assert.equal(autoUpdateOwner({
    autoUpdate: { ownerUin: '87654321' }
  }), '87654321');
});

test('retired slang research has no canonical owner or tuning configuration', async () => {
  const mod = await import(`../src/core/stable-feature-policy.js?test=${Date.now()}`);
  const cfg = {
    admin: { ownerUin: '12345678' },
    slangPilot: {
      enabled: true,
      graduated: true,
      ownerUin: '87654321',
      minOccurrences: 1,
      maxResearchRounds: 99,
      webResearch: true
    }
  };
  mod.applyStableFeaturePolicy(cfg);
  assert.deepEqual(cfg.slangPilot, { enabled: false, graduated: false });
});
