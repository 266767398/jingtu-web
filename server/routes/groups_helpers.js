/**
 * 境途同游 V6.14 — VRChat 群组路由共享 helper
 *
 * P2-66 god-route 拆分时自 routes/groups.js 抽出，实现逐字保留：
 * - sleep：原 groups.js L11 模块级实现，逐字移动。
 * - parseVrcLocation：原 groups.js L32–68 实现（含注释），逐字移动。
 * - vrcWithFallback：原 groups.js L107–142 工厂内闭包的机械改写，唯一差别是把
 *   getVRCCookieFn / getUserVRCCookieFn 由闭包捕获改为显式入参；401 判定、
 *   invalidate 条件、降级重试顺序逐字不变。
 */

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

// ==================== VRChat 实例字符串解析（借鉴 VRCX $location） ====================
// 输入形如 wrld_xxx:84292~group(grp_yyy)~groupAccessType(plus)~region(jp) 的 location，
// 拆解为结构化对象：房间数字名 / 所属群 / 区域 / 访问类型 / 是否离线或私密。
// 注意：location 为空 / 形如 "offline" / 不含 ":" 表示离线，返回 null。
function parseVrcLocation(location) {
  if (!location || typeof location !== 'string') return null;
  const loc = location.trim();
  if (loc === 'offline' || loc === 'private' || !loc.includes(':')) return null;
  const [worldId, instanceId = ''] = loc.split(':');
  const out = {
    worldId: worldId || '',
    instanceId: instanceId || '',
    instanceName: '',          // 房间随机数字名
    groupId: '',               // 当前房间所属群组
    groupAccessType: '',       // plus / public 等
    accessTypeName: '',        // groupPlus / public 等
    region: '',                // 服务器区域
    isOffline: false,
    isPrivate: false,
    isTraveling: false
  };
  // 房间数字名：instanceId 第一个 ~ 之前的片段
  const parts = instanceId.split('~');
  out.instanceName = (parts[0] || '').trim();
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const g = seg.match(/^group\(([^)]+)\)$/);
    if (g) { out.groupId = g[1]; continue; }
    const ga = seg.match(/^groupAccessType\(([^)]+)\)$/);
    if (ga) { out.groupAccessType = ga[1]; out.accessTypeName = ga[1] === 'plus' ? 'groupPlus' : ga[1]; continue; }
    const rg = seg.match(/^region\(([^)]+)\)$/);
    if (rg) { out.region = rg[1]; continue; }
    if (/^(private|hidden)/.test(seg)) out.isPrivate = true;
    if (/^traveling/.test(seg)) out.isTraveling = true;
  }
  return out;
}

/**
 * 执行一次 VRChat 调用。若首选 cookie 确实已失效（上游返回 401），
 * 标记其失效并自动降级到下一个候选（用户绑定 cookie -> 系统账号 cookie）后重试一次。
 * 修复：用户绑定的 cookie 过期后，getVRCCookie 会一直返回这份死 cookie，
 * 永远不会 fallback 到有效的系统 cookie，导致「面板显示已登录、点同步却报登录已过期」。
 *
 * 注意这里**只认 401**：早先的判据是 `result === null || result?.status === 401`，
 * 而 vrchatGetCurrentUser 对任何非 2xx（429 限流、500、超时）都返回 null，
 * 于是 VRChat 偶发抖动一次就会把用户 session 里的 VRChat cookie 清空，
 * 用户刷新后发现"绑定又没了"。上游临时故障绝不能销毁用户的登录凭据。
 * 因此传进来的 run 必须返回带 status 的结果（见 vrchatGetCurrentUserResult）。
 * @param {object} req
 * @param {(cookie: string) => Promise<any>} run 用给定 cookie 执行的实际调用
 * @returns {Promise<{cookie: string|null, result: any}>}
 * @param {Function} getVRCCookieFn 取首选 cookie 的函数（带 .invalidate）
 * @param {Function} [getUserVRCCookieFn] 取用户绑定 cookie 的函数
 */
async function vrcWithFallback(req, run, getVRCCookieFn, getUserVRCCookieFn) {
  let cookie = getVRCCookieFn(req);
  if (!cookie) return { cookie: null, result: null };
  let result = await run(cookie);
  const unauthorized = result?.status === 401;
  if (unauthorized && typeof getVRCCookieFn.invalidate === 'function') {
    // 仅当 401 来自「用户自己绑定的 cookie」时，才标记失效并降级到系统账号重试。
    // 若 cookie 实际来自系统账号兜底（用户未绑定 VRChat 的常态），绝不调用 invalidate，
    // 避免把一次偶发 401（VRChat 2FA 重查）误当成"系统账号过期"而注销全站系统登录。
    const userCookie = (typeof getUserVRCCookieFn === 'function' ? getUserVRCCookieFn(req) : null);
    const isUserCookie = !!userCookie && userCookie === cookie;
    if (isUserCookie && await getVRCCookieFn.invalidate(req, cookie)) {
      const next = getVRCCookieFn(req);
      if (next && next !== cookie) {
        cookie = next;
        result = await run(cookie);
      }
    }
  }
  return { cookie, result };
}

module.exports = { sleep, parseVrcLocation, vrcWithFallback };
