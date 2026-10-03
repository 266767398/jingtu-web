/**
 * 境途同游 — 运行时可变设置（请求体大小限制等）
 *
 * 这些原本硬编码在 middleware/security.js 的 requestSizeLimiter 里，
 * 现改为由超级管理员在后台「系统设置」中可调，并持久化到 system_config 表。
 *
 * 设计：
 * - 内存缓存（cache）避免每个请求都查库；默认值保证即使 DB 未就绪也能工作。
 * - applyConfig(body)：把一次配置更新合并进缓存（前端 PUT /admin/config 时调用）。
 * - refreshFromDb(pool)：进程启动后从 system_config 载入（server.js 在 initDatabase 后调用）。
 */
const DEFAULTS = {
  req_max_upload_mb: 550, // 上传类请求（含 /upload、/photos、/videos）的安全闸上限
  req_max_body_mb: 20,    // 普通非上传请求体的上限
  req_max_other_mb: 5,    // 非上传的 POST/PUT 小请求上限
};

// 安全下限，防止管理员误配导致正常上传/接口被整体卡死
const FLOORS = {
  req_max_upload_mb: 50,
  req_max_body_mb: 1,
  req_max_other_mb: 1,
};

// P2-170：安全上限，防止管理员误配导致请求体安全闸静默失效——
// 大有限值会让 contentLength > uploadMaxBytes 恒假（闸门被无声禁用），
// 配合流式 body 解析形成 DoS 面；同时约束「上传闸 1GB / 普通请求 100MB」。
const CEILINGS = {
  req_max_upload_mb: 1024,
  req_max_body_mb: 100,
  req_max_other_mb: 50,
};

let cache = { ...DEFAULTS };

function mbToBytes(mb) {
  const n = Math.floor(Number(mb));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * 1024 * 1024;
}

function clamp(key, value) {
  const floor = FLOORS[key] || 1;
  const ceiling = Number.isFinite(CEILINGS[key]) ? CEILINGS[key] : floor;
  return Math.min(Math.max(value, floor), ceiling);
}

// P2-170：字节阈值预计算缓存——配置变更时重算一次，
// 请求路径上的 getLimits 不再每次做三次 mbToBytes 乘法。
let limitsCache = computeLimits();

function computeLimits() {
  return {
    uploadMaxBytes: mbToBytes(cache.req_max_upload_mb),
    bodyMaxBytes: mbToBytes(cache.req_max_body_mb),
    otherMaxBytes: mbToBytes(cache.req_max_other_mb),
  };
}

function getLimits() {
  return limitsCache;
}

// 把一次传入的配置对象（部分键）合并进缓存，越界值会被夹到 [下限, 上限] 区间
function applyConfig(body = {}) {
  for (const key of Object.keys(DEFAULTS)) {
    if (body[key] === undefined) continue;
    const raw = Math.floor(Number(body[key]));
    // P2-170：仅接受有限正数——'1e999' 经 Math.floor 得 Infinity，若写入缓存，
    // mbToBytes 判定非有限返回 0 → contentLength > 0 恒真，全部上传/请求被 413 拒绝。
    // 非有限值（Infinity/NaN）与非法值一律忽略，保留当前生效值。
    if (Number.isFinite(raw) && raw > 0) {
      cache[key] = clamp(key, raw);
    }
  }
  limitsCache = computeLimits();
}

async function refreshFromDb(pool) {
  try {
    const keys = Object.keys(DEFAULTS);
    const [rows] = await pool.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN (?, ?, ?)`,
      keys
    );
    const body = {};
    for (const r of rows) body[r.config_key] = r.config_value;
    applyConfig(body);
  } catch (e) {
    console.error('[settings] 载入请求大小限制失败，继续使用默认值:', e.message);
  }
}

module.exports = { DEFAULTS, getLimits, applyConfig, refreshFromDb };
