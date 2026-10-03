const logger = require('../logger');

// endpoints 对象键数量上限（LRU 兜底），防止高基数路径参数导致内存无限增长
const MAX_ENDPOINT_KEYS = 500;

const requestStats = {
  total: 0,
  success: 0,
  error: 0,
  slow: 0,
  latency: {
    min: Infinity,
    max: 0,
    avg: 0,
    sum: 0,
    count: 0
  },
  endpoints: {},
  statusCodes: {}
};

/**
 * 路由模板归一化：把路径中高基数段替换为占位符，避免 /api/users/123、/api/users/usr_xxx…
 * 各自占用一个键导致 endpoints 对象无限增长（高基数键内存泄漏）。
 * P3-78: 在纯数字（:id）之外，扩展覆盖 UUID 形态与 VRChat ID（usr_/wrld_/avtr_/grp_ 前缀 UUID）。
 */
function normalizePath(p) {
  if (!p || typeof p !== 'string') return p;
  return p.split('/').map(seg => {
    if (/^\d+$/.test(seg)) return ':id';
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F-]{20,36}$/.test(seg)) return ':uuid';
    if (/^[a-z]+_[0-9a-fA-F-]{12,}$/.test(seg)) return ':vrcid';
    return seg;
  }).join('/');
}

function metricsMiddleware(req, res, next) {
  const startTime = Date.now();
  const path = normalizePath(req.path);
  const method = req.method;

  function trackResponse(statusCode) {
    const duration = Date.now() - startTime;

    requestStats.total++;

    if (statusCode >= 200 && statusCode < 400) {
      requestStats.success++;
    } else {
      requestStats.error++;
    }

    requestStats.latency.count++;
    requestStats.latency.sum += duration;
    requestStats.latency.avg = Math.round(requestStats.latency.sum / requestStats.latency.count);
    requestStats.latency.min = Math.min(requestStats.latency.min, duration);
    requestStats.latency.max = Math.max(requestStats.latency.max, duration);

    if (!requestStats.endpoints[path]) {
      // LRU 兜底：键数量超限时丢弃最旧条目（按 count+latency.sum 综合排序的近似策略）
      const keys = Object.keys(requestStats.endpoints);
      if (keys.length >= MAX_ENDPOINT_KEYS) {
        // 简单策略：删除第一个键（插入顺序即大致最旧）
        delete requestStats.endpoints[keys[0]];
      }
      requestStats.endpoints[path] = { count: 0, latency: { min: Infinity, max: 0, avg: 0, sum: 0 } };
    }
    const ep = requestStats.endpoints[path];
    ep.count++;
    ep.latency.sum += duration;
    ep.latency.avg = Math.round(ep.latency.sum / ep.count);
    ep.latency.min = Math.min(ep.latency.min, duration);
    ep.latency.max = Math.max(ep.latency.max, duration);

    if (!requestStats.statusCodes[statusCode]) {
      requestStats.statusCodes[statusCode] = 0;
    }
    requestStats.statusCodes[statusCode]++;

    if (duration > 5000) {
      requestStats.slow++;
      logger.warn('metrics', `慢请求警告: ${method} ${path} 耗时 ${duration}ms`);
    }
  }

  res.on('finish', () => {
    trackResponse(res.statusCode);
  });

  next();
}

function getStats() {
  return {
    uptime: process.uptime(),
    requests: {
      total: requestStats.total,
      success: requestStats.success,
      error: requestStats.error,
      slow: requestStats.slow,
      successRate: requestStats.total > 0 
        ? ((requestStats.success / requestStats.total) * 100).toFixed(1) + '%' 
        : '0%'
    },
    latency: {
      min: requestStats.latency.min === Infinity ? 0 : requestStats.latency.min,
      max: requestStats.latency.max,
      avg: requestStats.latency.avg
    },
    endpoints: requestStats.endpoints,
    statusCodes: requestStats.statusCodes
  };
}

function resetStats() {
  requestStats.total = 0;
  requestStats.success = 0;
  requestStats.error = 0;
  requestStats.slow = 0;
  requestStats.latency = { min: Infinity, max: 0, avg: 0, sum: 0, count: 0 };
  requestStats.endpoints = {};
  requestStats.statusCodes = {};
}

module.exports = { metricsMiddleware, getStats, resetStats };
