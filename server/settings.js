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

let cache = { ...DEFAULTS };

function mbToBytes(mb) {
  const n = Math.floor(Number(mb));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n * 1024 * 1024;
}

function clamp(key, value) {
  const floor = FLOORS[key] || 1;
  if (value < floor) return floor;
  return value;
}

function getLimits() {
  return {
    uploadMaxBytes: mbToBytes(cache.req_max_upload_mb),
    bodyMaxBytes: mbToBytes(cache.req_max_body_mb),
    otherMaxBytes: mbToBytes(cache.req_max_other_mb),
  };
}

// 把一次传入的配置对象（部分键）合并进缓存，越界值会被夹到下限
function applyConfig(body = {}) {
  for (const key of Object.keys(DEFAULTS)) {
    if (body[key] === undefined) continue;
    const raw = Math.floor(Number(body[key]));
    if (!Number.isNaN(raw) && raw > 0) {
      cache[key] = clamp(key, raw);
    }
  }
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
