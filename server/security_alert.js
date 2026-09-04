const logger = require('./logger');

const ALERT_THRESHOLDS = {
  loginFailures: 5,
  suspiciousRequests: 10,
  rateLimitTriggered: 5,
  csrfFailures: 5
};

const alertStats = {
  loginFailures: new Map(),
  suspiciousRequests: new Map(),
  rateLimitTriggered: new Map(),
  csrfFailures: new Map()
};

let notificationService = null;

function setNotificationService(ns) {
  notificationService = ns;
}

function checkThreshold(type, key, count) {
  const threshold = ALERT_THRESHOLDS[type];
  if (!threshold) return false;
  
  const current = alertStats[type].get(key) || 0;
  const newCount = current + count;
  alertStats[type].set(key, newCount);
  
  if (newCount >= threshold && newCount - count < threshold) {
    return true;
  }
  return false;
}

async function triggerAlert(type, details) {
  const alert = {
    type,
    details,
    timestamp: new Date().toISOString(),
    level: type === 'security_breach' ? 'CRITICAL' : 'WARNING'
  };
  
  logger.warn('security', `安全告警: ${type}`, details);
  
  if (notificationService) {
    let title, message;
    switch (type) {
      case 'login_failures':
        title = '🔒 登录失败告警';
        message = `IP ${details.ip} 在短时间内登录失败 ${details.count} 次，可能存在暴力破解攻击`;
        break;
      case 'suspicious_request':
        title = '⚠️ 可疑请求告警';
        message = `IP ${details.ip} 触发了可疑请求检测: ${details.reason}`;
        break;
      case 'rate_limit':
        title = '🚨 限流告警';
        message = `IP ${details.ip} 触发了速率限制，路径: ${details.path}`;
        break;
      case 'csrf_failure':
        title = '🛡️ CSRF攻击告警';
        message = `IP ${details.ip} 连续 CSRF 验证失败 ${details.count} 次`;
        break;
      case 'security_breach':
        title = '🔴 安全入侵告警';
        message = `检测到安全入侵: ${details.description}`;
        break;
      default:
        title = '📢 安全告警';
        message = `${type}: ${JSON.stringify(details)}`;
    }
    
    try {
      await notificationService.notifyAllAdmins(type, title, message, {
        ip: details.ip,
        type,
        timestamp: alert.timestamp
      });
    } catch (e) {
      logger.error('security', '通知管理员失败:', e.message);
    }
  }
}

async function onLoginFailure(ip, username) {
  const key = `${ip}_${username || 'unknown'}`;
  if (checkThreshold('loginFailures', key, 1)) {
    const count = alertStats.loginFailures.get(key);
    await triggerAlert('login_failures', { ip, username, count });
  }
}

async function onSuspiciousRequest(ip, reason, path) {
  const key = `${ip}_${path}`;
  if (checkThreshold('suspiciousRequests', key, 1)) {
    await triggerAlert('suspicious_request', { ip, reason, path });
  }
}

async function onRateLimitTriggered(ip, path) {
  const key = `${ip}_${path}`;
  if (checkThreshold('rateLimitTriggered', key, 1)) {
    await triggerAlert('rate_limit', { ip, path });
  }
}

async function onCsrfFailure(ip) {
  const key = ip;
  if (checkThreshold('csrfFailures', key, 1)) {
    const count = alertStats.csrfFailures.get(key);
    await triggerAlert('csrf_failure', { ip, count });
  }
}

async function onSecurityBreach(description, details = {}) {
  await triggerAlert('security_breach', { description, ...details });
}

function resetStats() {
  for (const key of Object.keys(alertStats)) {
    alertStats[key].clear();
  }
}

function getStats() {
  return {
    loginFailures: alertStats.loginFailures.size,
    suspiciousRequests: alertStats.suspiciousRequests.size,
    rateLimitTriggered: alertStats.rateLimitTriggered.size,
    csrfFailures: alertStats.csrfFailures.size
  };
}

setInterval(resetStats, 60 * 60 * 1000).unref(); // unref：纯内存统计定时器不阻塞进程退出（Jest worker 引入本模块时不再挂起）

module.exports = {
  setNotificationService,
  onLoginFailure,
  onSuspiciousRequest,
  onRateLimitTriggered,
  onCsrfFailure,
  onSecurityBreach,
  getStats
};
