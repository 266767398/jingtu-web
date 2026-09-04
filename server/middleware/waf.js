const logger = require('../logger');
const { onSuspiciousRequest } = require('../security_alert');

const SQL_INJECTION_PATTERNS = [
  // 引号开头的精确模式（不会误伤正常文本中讨论 SQL 的场景）
  /(['"])\s*OR\s+\d+\s*=\s*\d+/i,
  /(['"])\s*AND\s+\d+\s*=\s*\d+/i,
  /(['"])\s*UNION\s+SELECT/i,
  /(['"])\s*DROP\s+TABLE/i,
  /(['"])\s*INSERT\s+INTO/i,
  /(['"])\s*UPDATE\s+\w+/i,
  /(['"])\s*DELETE\s+FROM/i,
  /(['"])\s*EXEC\s+\(/i,
  /(['"])\s*EXECUTE\s+\(/i,
  /(['"])\s*XP_\w+/i,
  /(['"])\s*SYS_\w+/i,
  /(['"])\s*@@\w+/i,
  /(['"])\s*--\s*/i,
  /(['"])\s*#\s*/i,
  /(['"])\s*\/\*/i,
  /(['"])\s*\*\//i,
  /(['"])\s*OR\s+1\s*=\s*1/i,
  /(['"])\s*AND\s+1\s*=\s*1/i,
  /(['"])\s*OR\s+TRUE/i,
  /(['"])\s*AND\s+TRUE/i,
  // 精确模式：仅在引号上下文或紧邻 SQL 关键字组合时触发
  /\bUNION\s+(?:ALL\s+)?SELECT\b/i,
  /\bINFORMATION_SCHEMA\b/i,
  /\bGROUP_CONCAT\b/i,
  // 已移除易误伤用户内容的宽泛模式（SELECT...FROM、COUNT(、LENGTH(、CASE WHEN、LEFT/RIGHT FROM、SUBSTRING FROM、TABLE_NAME、COLUMN_NAME 等）
  // 用户内容端点（posts/comments/album）依赖参数化查询与 XSS 转义，而非 WAF
];

const XSS_PATTERNS = [
  /<script[^>]*>.*<\/script>/gi,
  /<script[^>]*\/>/gi,
  /javascript:/gi,
  /vbscript:/gi,
  /onerror\s*=\s*['"]?[^'"]*['"]?/gi,
  /onload\s*=\s*['"]?[^'"]*['"]?/gi,
  /onclick\s*=\s*['"]?[^'"]*['"]?/gi,
  /onmouseover\s*=\s*['"]?[^'"]*['"]?/gi,
  /onfocus\s*=\s*['"]?[^'"]*['"]?/gi,
  /onblur\s*=\s*['"]?[^'"]*['"]?/gi,
  /onchange\s*=\s*['"]?[^'"]*['"]?/gi,
  /onkeydown\s*=\s*['"]?[^'"]*['"]?/gi,
  /onkeyup\s*=\s*['"]?[^'"]*['"]?/gi,
  /<iframe[^>]*>.*<\/iframe>/gi,
  /<iframe[^>]*\/>/gi,
  /<img[^>]*src\s*=\s*['"]?javascript:/gi,
  /<svg[^>]*onload/gi,
  /<object[^>]*>/gi,
  /<embed[^>]*>/gi,
  /<form[^>]*>/gi,
  /<link[^>]*href\s*=\s*['"]?javascript:/gi,
  /<a[^>]*href\s*=\s*['"]?javascript:/gi,
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\/\.\./,
  /\.\.\\\.\./,
  /\/\.\.\//,
  /\\\.\.\\/,
  /\.\.\/etc\//,
  /\.\.\/var\//,
  /\.\.\/home\//,
  /\.\.\/usr\//,
  /\.\.\/tmp\//,
  /\.\.\/root\//,
  /\.\.\/boot\//,
  /\.\.\/proc\//,
  /\.\.\/sys\//,
  /\.\.\/dev\//,
  /%2e%2e\//,
  /%2E%2E\//,
  /%2e%2e\\/,
  /%252e%252e\//,
  /%c0%ae%c0%ae\//,
];

const LFI_PATTERNS = [
  /etc\/passwd/i,
  /etc\/shadow/i,
  /etc\/hosts/i,
  /etc\/resolv\.conf/i,
  /etc\/mysql/i,
  /etc\/apache/i,
  /etc\/nginx/i,
  /var\/log/i,
  /var\/www/i,
  /var\/run/i,
  /tmp\//i,
  /proc\/self\/environ/i,
  /proc\/version/i,
  /proc\/cpuinfo/i,
  /proc\/meminfo/i,
];

const RFI_PATTERNS = [
  /http:\/\/[^\/]+\/.+\.php/i,
  /https:\/\/[^\/]+\/.+\.php/i,
  /ftp:\/\/[^\/]+\/.+\.php/i,
  /data:\/\/.+/i,
  /php:\/\/input/i,
];

const SHELL_CMD_PATTERNS = [
  /;.*(ls|dir|cat|echo|rm|cp|mv|mkdir|rmdir|chmod|chown)/i,
  /\|\s*(ls|dir|cat|echo|rm|cp|mv|mkdir|rmdir|chmod|chown)/i,
  /\$\(.*\)/i,
  /`.*`/i,
  /\/bin\/(sh|bash|zsh)/i,
  /\/usr\/bin\/(sh|bash|zsh)/i,
];

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return null;
  }
}

function testPattern(pattern, str) {
  // 带 g 标志的正则 test() 会推进 lastIndex，跨请求复用时可能漏检，这里每次重置
  pattern.lastIndex = 0;
  const matched = pattern.test(str);
  pattern.lastIndex = 0;
  return matched;
}

function scanString(str, patterns, type) {
  if (!str || typeof str !== 'string') return false;
  // 先扫原文，再对 URL 编码载荷最多做两轮解码复扫（%3Csvg onload、%253C 双重编码等）
  let candidate = str;
  for (let round = 0; round < 3; round++) {
    for (const pattern of patterns) {
      if (testPattern(pattern, candidate)) {
        return { matched: pattern, type };
      }
    }
    const decoded = safeDecode(candidate);
    if (decoded === null || decoded === candidate) break;
    candidate = decoded;
  }
  return false;
}

function scanObject(obj, patterns, type) {
  if (!obj || typeof obj !== 'object') return false;
  for (const key of Object.keys(obj)) {
    // 对象 key 同样是攻击载体（如 {"onerror=alert(1)": "..."}），与值一并扫描
    const keyResult = scanString(key, patterns, type);
    if (keyResult) return keyResult;
    const value = obj[key];
    if (typeof value === 'string') {
      const result = scanString(value, patterns, type);
      if (result) return result;
    } else if (typeof value === 'object') {
      const result = scanObject(value, patterns, type);
      if (result) return result;
    }
  }
  return false;
}

function detectAttack(req) {
  const targets = [
    { data: req.url, name: 'URL' },
    { data: req.body, name: 'Body' },
    { data: req.query, name: 'Query' },
    { data: req.params, name: 'Params' },
  ];

  const scanSets = [
    { patterns: SQL_INJECTION_PATTERNS, type: 'SQL注入' },
    { patterns: XSS_PATTERNS, type: 'XSS攻击' },
    { patterns: PATH_TRAVERSAL_PATTERNS, type: '路径遍历' },
    { patterns: LFI_PATTERNS, type: '本地文件包含' },
    { patterns: RFI_PATTERNS, type: '远程文件包含' },
    { patterns: SHELL_CMD_PATTERNS, type: '命令执行' },
  ];

  for (const target of targets) {
    for (const scanSet of scanSets) {
      const result = typeof target.data === 'string'
        ? scanString(target.data, scanSet.patterns, scanSet.type)
        : scanObject(target.data, scanSet.patterns, scanSet.type);
      
      if (result) {
        return {
          detected: true,
          type: scanSet.type,
          source: target.name,
          ip: req.ip || req.connection?.remoteAddress || '',
          path: req.path
        };
      }
    }
  }

  return { detected: false };
}

function wafMiddleware(req, res, next) {
  const result = detectAttack(req);
  
  if (result.detected) {
    logger.warn('waf', `检测到${result.type}攻击`, {
      ip: result.ip,
      path: result.path,
      source: result.source,
      method: req.method
    });
    
    onSuspiciousRequest(result.ip, result.type, result.path);
    
    res.status(403).json({
      error: '请求被安全系统拦截',
      code: 'WAF_BLOCKED',
      type: result.type
    });
    return;
  }
  
  next();
}

function enableWaf(app) {
  app.use(wafMiddleware);
}

module.exports = { wafMiddleware, enableWaf, detectAttack };
