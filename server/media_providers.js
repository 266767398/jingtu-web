/**
 * 境途同游 — 可配置媒体代理源池（F-5，docs/19 §11.4 O-5）
 *
 * 背景：头像/媒体代理（routes/avatar.js）此前是"单源"——只直连 VRChat CDN。
 *       一旦 amlcdn 故障、限流或被墙，整站头像/世界图全部裂图，只能干等恢复。
 *
 * 设计（对齐 server/settings.js 的运行时可变设置模式）：
 * - provider 链：内置 vrchat-cdn（直连白名单源，带防盗链头）+ 管理员可配置的
 *   备用镜像源（URL 模板，{url} 占位符 = URL 编码后的原始地址）。
 * - 失败自动切换（failover）：按链序逐个回源，任一成功即返回；全败抛最后一个错误
 *   （由调用方走"旧缓存 → 占位图"兜底，行为与旧单源一致）。
 * - 熔断冷却：某源连续失败 ≥3 次进入 60s 冷却，期间跳过，避免每次请求都先撞死源。
 * - 配置持久化于 system_config 表（media_provider_mirrors / media_provider_mirror_first /
 *   media_provider_timeout_ms），启动时 refreshFromDb 载入内存，超管后台改后立即生效。
 * - 安全：镜像模板必须 https:// 开头、长度受限、最多 5 条；模板里不能出现换行/空格
 *   混淆，原始 URL 仅以 encodeURIComponent 后的形态注入，杜绝 SSRF/头注入面。
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const logger = require('./logger');
const { promisify } = require('util');

const dnsLookup = promisify(dns.lookup);

const DEFAULTS = {
  media_provider_mirrors: '[]', 
  media_provider_mirror_first: '0', 
  media_provider_timeout_ms: 10000, 
};

const FLOORS = { media_provider_timeout_ms: 3000 };
const CEILS = { media_provider_timeout_ms: 30000 };
const MAX_MIRRORS = 5;
const MAX_TEMPLATE_LEN = 512;
const MAX_NAME_LEN = 32;

// 回源最大体积（与旧 avatar.js 保持一致，防止经代理拉取超大资源撑爆内存/磁盘）
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// 熔断参数：连续失败阈值与冷却时长
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60 * 1000;

let cache = { ...DEFAULTS };

// 熔断状态：name -> { fails, cooldownUntil, ts }
const _breaker = new Map();

// 校验镜像配置数组：逐项清洗，非法项丢弃；全部非法返回 []
function sanitizeMirrors(raw) {
  const out = [];
  let arr;
  try {
    arr = JSON.parse(typeof raw === 'string' && raw.trim() ? raw : '[]');
  } catch (e) {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (out.length >= MAX_MIRRORS) break;
    if (!item || typeof item !== 'object') continue;
    if (item.enabled === false) continue;
    const name = String(item.name || '').trim().slice(0, MAX_NAME_LEN) || ('mirror-' + (out.length + 1));
    const tpl = String(item.urlTemplate || '').trim();
    if (!/^https:\/\//i.test(tpl)) continue; // 必须 https，防明文/相对地址
    if (tpl.length > MAX_TEMPLATE_LEN) continue;
    if (!tpl.includes('{url}')) continue; 
    if (/[\r\n\s]/.test(tpl)) continue; 
    const entry = { name, urlTemplate: tpl };
    const referer = String(item.referer || '').trim();
    const origin = String(item.origin || '').trim();
    if (/^https:\/\//i.test(referer)) entry.referer = referer;
    if (/^https:\/\//i.test(origin)) entry.origin = origin;
    out.push(entry);
  }
  return out;
}

// 把一次传入的配置对象（部分键）合并进内存缓存（对齐 settings.applyConfig）
function applyConfig(body = {}) {
  if (body.media_provider_mirrors !== undefined) {
    cache.media_provider_mirrors = JSON.stringify(sanitizeMirrors(String(body.media_provider_mirrors)));
  }
  if (body.media_provider_mirror_first !== undefined) {
    const on = body.media_provider_mirror_first === '1' || body.media_provider_mirror_first === 1 || body.media_provider_mirror_first === true;
    cache.media_provider_mirror_first = on ? '1' : '0';
  }
  if (body.media_provider_timeout_ms !== undefined) {
    const n = Math.floor(Number(body.media_provider_timeout_ms));
    if (Number.isFinite(n) && n > 0) {
      cache.media_provider_timeout_ms = Math.min(CEILS.media_provider_timeout_ms, Math.max(FLOORS.media_provider_timeout_ms, n));
    }
  }
}

// 进程启动后从 system_config 载入（server.js 在 initDatabase 后调用）
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
    logger.error('media', '[media-providers] 载入媒体代理源池配置失败，继续使用默认值:', e.message);
  }
}

// ============ 熔断器 ============
function _mark(name, ok) {
  const now = Date.now();
  let b = _breaker.get(name);
  if (!b || now - b.ts > BREAKER_COOLDOWN_MS * 2) b = { fails: 0, cooldownUntil: 0, ts: now };
  b.ts = now;
  if (ok) {
    b.fails = 0;
    b.cooldownUntil = 0;
  } else {
    b.fails += 1;
    if (b.fails >= BREAKER_THRESHOLD) {
      b.cooldownUntil = now + BREAKER_COOLDOWN_MS;
      b.fails = 0;
    }
  }
  _breaker.set(name, b);
  if (_breaker.size > 200) {
    for (const [k, v] of _breaker) {
      if (now - v.ts > BREAKER_COOLDOWN_MS * 4) _breaker.delete(k);
    }
  }
}
function markSuccess(name) { _mark(name, true); }
function markFailure(name) { _mark(name, false); }
function isCoolingDown(name) {
  const b = _breaker.get(name);
  return !!(b && b.cooldownUntil > Date.now());
}

// ============ Provider 链 ============
// 链序：mirror_first=1 → [镜像..., vrchat-cdn]；否则 [vrchat-cdn, 镜像...]
// 未配置镜像时等价于旧单源行为，完全向后兼容。
function getChain() {
  const mirrors = sanitizeMirrors(cache.media_provider_mirrors).map((m) => ({
    name: m.name,
    buildUrl: (u) => m.urlTemplate.replace('{url}', encodeURIComponent(u)),
    headers: (m.referer || m.origin)
      ? { Referer: m.referer, Origin: m.origin }
      : undefined,
  }));
  const builtin = {
    name: 'vrchat-cdn',
    buildUrl: (u) => u,
    headers: { Referer: 'https://vrchat.com/', Origin: 'https://vrchat.com' },
  };
  return cache.media_provider_mirror_first === '1' ? [...mirrors, builtin] : [builtin, ...mirrors];
}

// ============ 重定向目标 SSRF 防护（P3-74）============
// 上游一旦被劫持或镜像源被诱导返回恶意 302，可回源任意地址（含内网）。
// 跟随重定向前校验：协议必须 https，且主机/解析地址非内网/环回/链路本地。
function _isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return true;
  if (parts[0] === 0 || parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; 
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
  if (parts[0] === 198 && parts[1] === 18) return true;
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
  if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
  return false;
}

function _isPrivateIPv6(ip) {
  const lower = String(ip).toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; 
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; 
  return false;
}

// 校验重定向目标：协议 https + 主机名/IP 非内网。非法时抛错由调用方拒绝跟随。
async function _assertPublicRedirectTarget(targetUrl) {
  if (targetUrl.protocol !== 'https:') throw new Error('redirect to non-https blocked');
  // URL.hostname 对 IPv6 字面量保留方括号（如 [::1]），先剥除再判断
  const host = String(targetUrl.hostname).replace(/^\[|\]$/g, '');
  const asIp = net.isIP(host);
  if (asIp === 4 && _isPrivateIPv4(host)) throw new Error('redirect to internal address blocked');
  if (asIp === 6 && _isPrivateIPv6(host)) throw new Error('redirect to internal address blocked');
  if (asIp === 0) {
    if (host.toLowerCase() === 'localhost') throw new Error('redirect to localhost blocked');
    const { address } = await dnsLookup(host);
    const resolvedIp = net.isIP(address);
    if (resolvedIp === 4 && _isPrivateIPv4(address)) throw new Error('redirect to internal address blocked');
    if (resolvedIp === 6 && _isPrivateIPv6(address)) throw new Error('redirect to internal address blocked');
  }
}

// 单次 HTTP(S) 拉取（由 avatar.js 迁入，零依赖，支持可配 headers/timeout）。
// _retry 用于 429 / 网络抖动的指数退避重试。
function fetchRemote(u, opts, redirects, _retry) {
  opts = opts || {};
  redirects = redirects || 0;
  _retry = _retry || 0;
  const timeoutMs = opts.timeoutMs || 10000;
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const parsed = new URL(u);
    const lib = parsed.protocol === 'http:' ? http : https;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/png,image/*,*/*',
      ...(opts.headers || {}),
    };
    const req = lib.request(u, { method: 'GET', headers, timeout: timeoutMs }, (resp) => {
      const { statusCode, headers: h } = resp;
      if (statusCode >= 300 && statusCode < 400 && h.location) {
        resp.resume();
        // P3-74: 跟随重定向前校验目标（协议 + 公网主机），拒绝回源内网
        return (async () => {
          let next;
          try {
            next = new URL(h.location, u);
            await _assertPublicRedirectTarget(next);
          } catch (e) {
            return reject(e);
          }
          return resolve(fetchRemote(next.toString(), opts, redirects + 1, _retry));
        })();
      }
      if (statusCode === 429) {
        resp.resume();
        if (_retry < 3) { setTimeout(() => resolve(fetchRemote(u, opts, redirects, _retry + 1)), Math.min(4000, 800 * (_retry + 1))); return; }
        return reject(new Error('upstream status 429'));
      }
      if (statusCode !== 200) {
        resp.resume();
        return reject(new Error('upstream status ' + statusCode));
      }
      const len = parseInt(h['content-length'] || '0', 10);
      if (len > MAX_BODY_BYTES) {
        resp.resume();
        return reject(new Error('payload too large'));
      }
      let total = 0;
      const chunks = [];
      resp.on('data', (c) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          resp.destroy(new Error('payload too large'));
          return;
        }
        chunks.push(c);
      });
      resp.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: h['content-type'] || 'image/jpeg' }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// 依序尝试 provider 链，任一成功即返回 { buffer, contentType, provider }。
// 全部失败时抛出最后一个错误；所有源都在冷却时抛出专用错误。
async function fetchWithFailover(u) {
  const chain = getChain();
  const timeoutMs = cache.media_provider_timeout_ms;
  let lastErr = null;
  for (const p of chain) {
    if (isCoolingDown(p.name)) continue;
    try {
      const r = await fetchRemote(p.buildUrl(u), { headers: p.headers, timeoutMs }, 0);
      markSuccess(p.name);
      return { buffer: r.buffer, contentType: r.contentType, provider: p.name };
    } catch (e) {
      markFailure(p.name);
      lastErr = e;
    }
  }
  if (!lastErr) lastErr = new Error('all media providers cooling down');
  throw lastErr;
}

// 供管理面板/调试查看当前生效配置
function getConfig() { return { ...cache }; }

module.exports = {
  DEFAULTS,
  applyConfig,
  refreshFromDb,
  getChain,
  fetchWithFailover,
  fetchRemote,
  getConfig,
  markSuccess,
  markFailure,
  isCoolingDown,
  _assertPublicRedirectTarget, 
};
