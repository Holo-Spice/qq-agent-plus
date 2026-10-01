// 文档索引防漂移（改进方案 C9/#12）：docs/README.md 里链接的每篇文档都必须存在，
// 反向：docs/ 下的主要 markdown（research/ 与 assets/ 除外）都必须被索引到。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const docsDir = path.resolve('docs');
const index = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8');

test('docs/README.md 索引里的每个链接目标都存在', () => {
  const links = [...index.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1])
    .filter((href) => !/^https?:/.test(href));
  const missing = [];
  for (const href of links) {
    const target = path.resolve(docsDir, href);
    if (!fs.existsSync(target)) missing.push(href);
  }
  assert.deepEqual(missing, [], `索引里有链接指向不存在的文件：${missing.join(', ')}`);
});

test('docs/ 下的主要文档都被索引到（research/ 除外）', () => {
  const indexed = new Set([...index.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]));
  const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const unindexed = files.filter((f) => !indexed.has(f) && !indexed.has(`./${f}`));
  assert.deepEqual(unindexed, [], `docs/ 下这些文件没进索引：${unindexed.join(', ')}`);
});
