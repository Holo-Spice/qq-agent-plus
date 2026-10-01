// 图片格式嗅探（按魔数判断，不看扩展名/Content-Type）。
//
// 收敛前这段判断在三个地方各有一份，返回值约定还不一样（sticker-manager 给空串、
// tools-core 给 null、daily-moments 带 content-type 回退）。这里统一成一份：
// 认不出返回空串，怎么回退由调用方决定（只有它知道有没有服务端给的 MIME 可用）。
//
// 控制台「试画一张」的预览 data URL 也用这里 —— 2026-10-01 实测：智谱 CogView-3-Flash
// 返回的是 JPEG，而那条路由此前把前缀写死成 `data:image/png`。浏览器靠嗅探照样能显示，
// 但右键「图片另存为」会得到一个扩展名是 .png 的 JPEG 文件（MIME 与实际内容不符）。
export const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
});

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

export function imageType(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (
    buf.length >= 12
    && buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return '';
}
