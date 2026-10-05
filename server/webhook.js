const axios = require('axios');
const net = require('net');
const https = require('https');
const dns = require('dns');
const { promisify } = require('util');
const { getPool } = require('./utils');
const crypto = require('crypto');
const logger = require('./logger');

const dnsLookup = promisify(dns.lookup);
const WEBHOOK_URL_ALLOW_PROTOCOLS = ['http:', 'https:'];

// P2-129: SSRF 防护——仅允许公网 http/https 目标，拒绝环回/私网/链路本地/文档地址
// IPv4-mapped IPv6（::ffff:a.b.c.d / ::ffff:aabb:ccdd）与 IPv4-compatible IPv6（::a.b.c.d）
// 必须还原为 IPv4 后同规则判定，否则全部区间判断落空（parts[0]=NaN）被放行。
function _v4GroupToParts(hex) {
  const s = (hex || '0').padStart(4, '0');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16)];
}
function _extractEmbeddedIPv4(ip) {
  const lower = ip.toLowerCase();
  let m = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];
  m = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) return _v4GroupToParts(m[1]).concat(_v4GroupToParts(m[2])).join('.');
  m = lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) return _v4GroupToParts(m[1]).concat(_v4GroupToParts(m[2])).join('.');
  m = lower.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];
  return null;
}
function isBlockedWebhookAddress(ip) {
  if (!ip || net.isIP(ip) === 0) return true;
  if (net.isIP(ip) === 6) {
    const embedded = _extractEmbeddedIPv4(ip);
    if (embedded) return isBlockedWebhookAddress(embedded);
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (/^fe[89ab][0-9a-f]/i.test(lower)) return true; // fe80::/10 链路本地
    if (/^f[cd][0-9a-f]/i.test(lower)) return true;    // fc00::/7 ULA
    return false;
  }
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return true;
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

// P2-129: 校验 webhook URL（协议 + 主机可解析为公网地址）。返回 { ok } 或 { ok:false, reason }
// P2-160（R2）：解析与校验合并为不可分割的一步，并把解析结果（address）返回给发送方复用——
// 发送时直接以「校验过的 IP」直连（Host/SNI 保留原始域名），杜绝 DNS rebinding（TOCTOU）：
// 攻击者把域名第一次解析为公网 IP 通过校验、发送前二次解析改为内网 IP 的绕过路径被关闭。
async function _resolveAndValidateWebhookUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { ok: false, reason: 'URL 格式非法' };
  }
  if (!WEBHOOK_URL_ALLOW_PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, reason: '仅支持 http/https 协议' };
  }
  let address;
  try {
    ({ address } = await dnsLookup(parsed.hostname));
  } catch (e) {
    return { ok: false, reason: '域名解析失败' };
  }
  if (isBlockedWebhookAddress(address)) {
    return { ok: false, reason: '不允许指向内网/环回/本机地址的 URL' };
  }
  return { ok: true, parsed, address };
}

async function validateWebhookUrl(url) {
  const r = await _resolveAndValidateWebhookUrl(url);
  return { ok: r.ok, reason: r.reason };
}

const WEBHOOK_EVENTS = {
  USER_REGISTERED: 'user_registered',
  USER_LOGIN: 'user_login',
  POST_CREATED: 'post_created',
  POST_UPDATED: 'post_updated',
  POST_DELETED: 'post_deleted',
  EVENT_CREATED: 'event_created',
  EVENT_UPDATED: 'event_updated',
  EVENT_DELETED: 'event_deleted',
  ANNOUNCEMENT_CREATED: 'announcement_created',
  SECURITY_ALERT: 'security_alert',
  SYSTEM_ERROR: 'system_error'
};

// P3-72: 发送重试 + 有界待补发队列——失败指数退避重试（上限 3 次），仍失败入队定时重发，
// 避免事件（注册/安全告警/系统错误）因目标瞬时故障而永久静默丢失。
const WEBHOOK_RETRY_MAX = 3;
const WEBHOOK_RETRY_BASE_MS = 300;
const PENDING_QUEUE_MAX = 1000;
const PENDING_FLUSH_MS = 60 * 1000;
const PENDING_FLUSH_BATCH = 50;
const PENDING_ITEM_ATTEMPTS_MAX = 5;
const pendingDeliveries = [];

function _retryDelay(attempt) {
  const base = process.env.NODE_ENV === 'test' ? 5 : WEBHOOK_RETRY_BASE_MS;
  return Math.min(10000, base * Math.pow(2, attempt));
}
const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueuePending(item) {
  if (pendingDeliveries.length >= PENDING_QUEUE_MAX) {
    logger.error('webhook', '[webhook] 待补发队列已满，丢弃:', item.eventType, item.url);
    return false;
  }
  pendingDeliveries.push(item);
  return true;
}

// 待补发队列定时重发（尽力而为；单条累计 >PENDING_ITEM_ATTEMPTS_MAX 轮仍失败则彻底放弃）
async function flushPendingDeliveries() {
  if (pendingDeliveries.length === 0) return;
  const batch = pendingDeliveries.splice(0, PENDING_FLUSH_BATCH);
  for (const item of batch) {
    const r = await sendWebhook(item.url, item.eventType, item.data, item.secret, { noPending: true });
    if (!r.success) {
      item.attempts = (item.attempts || 0) + 1;
      if (item.attempts < PENDING_ITEM_ATTEMPTS_MAX) {
        enqueuePending(item);
      } else {
        logger.error('webhook', '[webhook] 待补发重发超限，彻底放弃:', item.eventType, item.url);
      }
    }
  }
}
setInterval(() => { flushPendingDeliveries().catch(() => {}); }, PENDING_FLUSH_MS).unref();

async function getWebhooks(eventType = null) {
  try {
    const pool = getPool();
    const query = eventType 
      ? 'SELECT * FROM webhooks WHERE enabled = 1 AND FIND_IN_SET(?, events)'
      : 'SELECT * FROM webhooks WHERE enabled = 1';
    const params = eventType ? [eventType] : [];
    const [rows] = await pool.query(query, params);
    return rows;
  } catch (e) {
    logger.error('webhook', '[webhook] 获取webhook失败:', e);
    return [];
  }
}

async function createWebhook(url, events, secret = '') {
  try {
    const urlCheck = await validateWebhookUrl(url);
    if (!urlCheck.ok) throw new Error('Webhook URL 校验失败: ' + urlCheck.reason);
    const pool = getPool();
    const [result] = await pool.query(
      'INSERT INTO webhooks (url, events, secret, enabled) VALUES (?, ?, ?, 1)',
      [url, Array.isArray(events) ? events.join(',') : events, secret]
    );
    return result.insertId;
  } catch (e) {
    logger.error('webhook', '[webhook] 创建webhook失败:', e);
    throw e;
  }
}

// P2-129: 显式白名单列更新——字段名即 SQL 片段（列名不转义），杜绝透传任意列
const WEBHOOK_UPDATE_ALLOWED = ['url', 'events', 'secret', 'enabled'];
function _normalizeWebhookUpdate(updates) {
  const out = {};
  if (!updates || typeof updates !== 'object') return out;
  for (const key of WEBHOOK_UPDATE_ALLOWED) {
    if (updates[key] !== undefined) out[key] = updates[key];
  }
  return out;
}

async function updateWebhook(id, updates) {
  try {
    const pool = getPool();
    const allowed = _normalizeWebhookUpdate(updates);
    const keys = Object.keys(allowed);
    if (keys.length === 0) {
      const [hasRows] = await pool.query('SELECT id FROM webhooks WHERE id = ?', [id]);
      return hasRows.length > 0;
    }
    // 显式列构造 SET 子句（列名来自白名单常量，不使用用户字段名拼接）
    const sets = keys.map(k => k + ' = ?');
    const vals = keys.map(k => (k === 'events' && Array.isArray(allowed[k]) ? allowed[k].join(',') : allowed[k]));
    if (allowed.url !== undefined) {
      const urlCheck = await validateWebhookUrl(allowed.url);
      if (!urlCheck.ok) throw new Error('Webhook URL 校验失败: ' + urlCheck.reason);
    }
    const [result] = await pool.query(
      'UPDATE webhooks SET ' + sets.join(', ') + ' WHERE id = ?',
      vals.concat([id])
    );
    return result.affectedRows > 0;
  } catch (e) {
    logger.error('webhook', '[webhook] 更新webhook失败:', e);
    throw e;
  }
}

async function deleteWebhook(id) {
  try {
    const pool = getPool();
    const [result] = await pool.query('DELETE FROM webhooks WHERE id = ?', [id]);
    return result.affectedRows > 0;
  } catch (e) {
    logger.error('webhook', '[webhook] 删除webhook失败:', e);
    throw e;
  }
}

// P2-129: 签名规范化序列化——按 key 排序后 stringify，接收方按排序键重建对象即可验签
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + canonicalStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

function signPayload(payload, secret) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(canonicalStringify(payload)).digest('hex');
}

async function sendWebhook(url, eventType, data, secret = '', opts = {}) {
  const { noPending = false } = opts || {};
  try {
    // P2-129/P2-160: 发送前校验目标 URL——拒绝内网/环回/链路本地，阻断 SSRF + 数据外带。
    // _resolveAndValidateWebhookUrl 一次性完成「解析 + 校验」并返回解析结果；
    // 发送将以该已验证的 IP 直连，不再二次解析（关闭 DNS rebinding）。
    const urlCheck = await _resolveAndValidateWebhookUrl(url);
    if (!urlCheck.ok) {
      logger.error('webhook', '[webhook] URL 校验拦截:', urlCheck.reason, url);
      return { success: false, error: 'Webhook URL 被安全策略拦截: ' + urlCheck.reason };
    }
    const { parsed, address } = urlCheck;
    const ipHost = net.isIP(address) === 6 ? `[${address}]` : address;
    const ipPort = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);
    const pinnedUrl = `${parsed.protocol}//${ipHost}:${ipPort}${parsed.pathname}${parsed.search}`;

    const payload = {
      event: eventType,
      timestamp: Date.now(),
      data: data
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-JingTu-Event': eventType,
      'X-JingTu-Timestamp': payload.timestamp.toString(),
      // R2：直连 IP 时保留原始 Host 头，接收方（按域名做虚拟主机/白名单）不受影响
      Host: parsed.host
    };

    if (secret) {
      headers['X-JingTu-Signature'] = signPayload(payload, secret);
    }

    const axiosOpts = { headers, timeout: 5000 };
    // R2：HTTPS 直连 IP 时，SNI 与证书校验主机名仍用原始域名（等同 curl --resolve），
    // 既锁定连接目标又避免证书域名不匹配。
    if (parsed.protocol === 'https:') {
      axiosOpts.httpsAgent = new https.Agent({ servername: parsed.hostname });
    }

    // P3-72: 指数退避重试（单次发送最多 WEBHOOK_RETRY_MAX 次重试），仍失败入待补发队列
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await axios.post(pinnedUrl, payload, axiosOpts);
        logger.info('webhook', '[webhook] 发送成功:', eventType, url);
        return { success: true, status: response.status };
      } catch (e) {
        if (attempt < WEBHOOK_RETRY_MAX) {
          await _sleep(_retryDelay(attempt));
          continue;
        }
        // 重试耗尽：写入待补发队列并升级告警日志（flushPendingDeliveries 重发时不再二次入队）
        if (!noPending) {
          const enqueued = enqueuePending({ url, eventType, data, secret, attempts: 0 });
          logger.error('webhook', '[webhook] 发送失败（已达最大重试）:', eventType, url, e.message, enqueued ? '(已入待补发队列)' : '(待补发队列已满)');
        } else {
          logger.error('webhook', '[webhook] 待补发重发失败:', eventType, url, e.message);
        }
        return { success: false, error: e.message };
      }
    }
  } catch (e) {
    logger.error('webhook', '[webhook] 发送失败:', eventType, url, e.message);
    return { success: false, error: e.message };
  }
}

async function trigger(eventType, data) {
  const webhooks = await getWebhooks(eventType);
  if (webhooks.length === 0) {
    logger.info('webhook', '[webhook] 没有匹配的webhook:', eventType);
    return;
  }

  logger.info('webhook', '[webhook] 触发事件:', eventType, '目标:', webhooks.length, '个');

  const results = await Promise.allSettled(
    webhooks.map(async (webhook) => {
      return await sendWebhook(webhook.url, eventType, data, webhook.secret);
    })
  );

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  const failCount = results.length - successCount;

  if (failCount > 0) {
    logger.warn('webhook', '[webhook] 部分发送失败:', failCount, '/', results.length);
  }
}

async function triggerUserRegistered(user) {
  await trigger(WEBHOOK_EVENTS.USER_REGISTERED, {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    email: user.email,
    created_at: user.created_at
  });
}

async function triggerUserLogin(user) {
  await trigger(WEBHOOK_EVENTS.USER_LOGIN, {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    login_at: new Date().toISOString()
  });
}

async function triggerPostCreated(post) {
  await trigger(WEBHOOK_EVENTS.POST_CREATED, {
    id: post.id,
    user_id: post.user_id,
    content: post.content,
    created_at: post.created_at
  });
}

async function triggerPostUpdated(post) {
  await trigger(WEBHOOK_EVENTS.POST_UPDATED, {
    id: post.id,
    user_id: post.user_id,
    content: post.content,
    updated_at: post.updated_at
  });
}

async function triggerPostDeleted(postId, userId) {
  await trigger(WEBHOOK_EVENTS.POST_DELETED, {
    id: postId,
    user_id: userId,
    deleted_at: new Date().toISOString()
  });
}

async function triggerEventCreated(event) {
  await trigger(WEBHOOK_EVENTS.EVENT_CREATED, {
    id: event.id,
    title: event.title,
    description: event.description,
    start_time: event.start_time,
    end_time: event.end_time,
    created_at: event.created_at
  });
}

async function triggerEventUpdated(event) {
  await trigger(WEBHOOK_EVENTS.EVENT_UPDATED, {
    id: event.id,
    title: event.title,
    description: event.description,
    start_time: event.start_time,
    end_time: event.end_time,
    updated_at: event.updated_at
  });
}

async function triggerEventDeleted(eventId) {
  await trigger(WEBHOOK_EVENTS.EVENT_DELETED, {
    id: eventId,
    deleted_at: new Date().toISOString()
  });
}

async function triggerAnnouncementCreated(announcement) {
  await trigger(WEBHOOK_EVENTS.ANNOUNCEMENT_CREATED, {
    id: announcement.id,
    title: announcement.title,
    content: announcement.content,
    created_at: announcement.created_at
  });
}

async function triggerSecurityAlert(message, details = {}) {
  await trigger(WEBHOOK_EVENTS.SECURITY_ALERT, {
    message,
    details,
    timestamp: new Date().toISOString()
  });
}

async function triggerSystemError(error, context = {}) {
  await trigger(WEBHOOK_EVENTS.SYSTEM_ERROR, {
    error: error.message || error.toString(),
    context,
    timestamp: new Date().toISOString()
  });
}

// §P2-149: 纯函数导出（测试专用）——signPayload/规范化序列化/SSRF 地址校验此前零测试
module.exports = {
  WEBHOOK_EVENTS,
  getWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  sendWebhook,
  trigger,
  triggerUserRegistered,
  triggerUserLogin,
  triggerPostCreated,
  triggerPostUpdated,
  triggerPostDeleted,
  triggerEventCreated,
  triggerEventUpdated,
  triggerEventDeleted,
  triggerAnnouncementCreated,
  triggerSecurityAlert,
  triggerSystemError,
  signPayload,
  canonicalStringify,
  validateWebhookUrl,
  isBlockedWebhookAddress,
  getPendingCount: () => pendingDeliveries.length,
  flushPendingDeliveries,
  enqueuePending,
  // 测试专用：清空待补发队列（避免跨用例串扰）
  resetPendingQueue: () => { pendingDeliveries.length = 0; }
};
