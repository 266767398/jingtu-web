/**
 * 分享令牌媒体鉴权边界回归测试（纯函数，无副作用、无需数据库）
 * 运行：node --test server/test/share-auth-boundary.test.js
 * 固化第十一轮修复：/uploads 分享令牌前缀越权（/uploads/album/123.jpg 不得匹配 /uploads/album/1234.jpg）
 */
const test = require('node:test');
const assert = require('node:assert');
const { sharePathAllowed } = require('../share-auth-util');

test('精确命中应放行', () => {
  const paths = ['/uploads/album/123.jpg', '/uploads/album/thumbs/123.jpg'];
  assert.strictEqual(sharePathAllowed('/uploads/album/123.jpg', paths), true);
  assert.strictEqual(sharePathAllowed('/uploads/album/thumbs/123.jpg', paths), true);
});

test('前缀误伤应拒绝（防越权：123.jpg 不得放行 1234.jpg）', () => {
  const paths = ['/uploads/album/123.jpg'];
  assert.strictEqual(sharePathAllowed('/uploads/album/1234.jpg', paths), false);
  assert.strictEqual(sharePathAllowed('/uploads/album/12345.jpg', paths), false);
  assert.strictEqual(sharePathAllowed('/uploads/album/123.jpg.bak', paths), false);
});

test('子目录资源应放行（缩略图场景）', () => {
  const paths = ['/uploads/album/123'];
  assert.strictEqual(sharePathAllowed('/uploads/album/123/thumb.jpg', paths), true);
  // 但另一资源的子目录不应放行
  assert.strictEqual(sharePathAllowed('/uploads/album/1234/thumb.jpg', paths), false);
});

test('空/非法输入安全返回 false', () => {
  assert.strictEqual(sharePathAllowed('', ['/uploads/album/123.jpg']), false);
  assert.strictEqual(sharePathAllowed('/uploads/album/123.jpg', null), false);
  assert.strictEqual(sharePathAllowed('/uploads/album/123.jpg', undefined), false);
  assert.strictEqual(sharePathAllowed('/uploads/album/123.jpg', []), false);
});

test('非分享资源路径绝不匹配', () => {
  const paths = ['/uploads/album/123.jpg'];
  assert.strictEqual(sharePathAllowed('/uploads/avatars/me.png', paths), false);
  assert.strictEqual(sharePathAllowed('/uploads/private/secret.jpg', paths), false);
});
