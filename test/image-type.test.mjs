// 魔数嗅探（src/core/image-type.js）：三处重复实现收敛成一份后的契约锁定。
// 认得出返回 MIME、认不出返回空串（回退策略由调用方决定 —— 只有它知道有没有
// 服务端给的 Content-Type 可用）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { imageType, IMAGE_EXTENSIONS } = await import('../src/core/image-type.js');

test('imageType 认 PNG / JPEG / GIF87a / GIF89a / WebP', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const gif87 = Buffer.from('GIF87a' + '\u0000'.repeat(10), 'binary');
  const gif89 = Buffer.from('GIF89a' + '\u0000'.repeat(10), 'binary');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(imageType(png), 'image/png');
  assert.equal(imageType(jpeg), 'image/jpeg');
  assert.equal(imageType(gif87), 'image/gif');
  assert.equal(imageType(gif89), 'image/gif');
  assert.equal(imageType(webp), 'image/webp');
});

test('imageType 认不出就返回空串（不给 null/不给猜测）', () => {
  assert.equal(imageType(Buffer.from('not an image at all')), '');
  assert.equal(imageType(Buffer.alloc(0)), '');
  assert.equal(imageType(null), '');
  assert.equal(imageType(undefined), '');
  // 只有 2 字节的 JPEG 前缀：长度不够，不能当成 JPEG（旧实现里 tools-core 那份要求 ≥12 字节）
  assert.equal(imageType(Buffer.from([0xff, 0xd8])), '');
  // GIF 只认 GIF87a/GIF89a，别的 GIF8Xa 不算
  assert.equal(imageType(Buffer.from('GIF88a000000', 'binary')), '');
});

test('imageType 接受 Uint8Array（不只有 Buffer）；扩展名表与 MIME 一一对应', () => {
  const png = new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  assert.equal(imageType(png), 'image/png');
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.ok(IMAGE_EXTENSIONS[mime], `${mime} 必须有对应扩展名`);
  }
});
