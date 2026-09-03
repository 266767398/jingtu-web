/**
 * 分享令牌媒体鉴权的纯函数工具（可被单元测试直接引入，无副作用）。
 *
 * 背景：/uploads 中间件的「分享令牌」仅应放行该分享绑定的具体媒体资源，
 * 严禁用任一有效分享码访问全站其它私有媒体。
 */

/**
 * 严格边界匹配：分享令牌仅能访问精确命中的资源，或其子目录资源。
 * 用于 /uploads 鉴权，防止 `/uploads/album/123.jpg` 越权匹配 `/uploads/album/1234.jpg`（前缀误伤）。
 * @param {string} reqPath 请求路径（不含 query）
 * @param {string[]} authPaths 该分享允许访问的资源路径集合
 * @returns {boolean}
 */
function sharePathAllowed(reqPath, authPaths) {
  if (!reqPath || typeof reqPath !== 'string') return false;
  if (!Array.isArray(authPaths)) return false;
  return authPaths.some((p) => reqPath === p || reqPath.startsWith(p + '/'));
}

module.exports = { sharePathAllowed };
