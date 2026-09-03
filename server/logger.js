const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] : null;

let currentLevel = LOG_LEVEL !== null ? LOG_LEVEL : (NODE_ENV === 'production' ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG);

const LOG_DIR = path.join(__dirname, '..', 'logs');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;

const logBuffer = [];
const FLUSH_INTERVAL = 1000;
const BUFFER_THRESHOLD = 100;
let flushTimer = null;
let isFlushing = false;

const ensureLogDir = async () => {
  try {
    await fsPromises.access(LOG_DIR);
  } catch {
    await fsPromises.mkdir(LOG_DIR, { recursive: true });
  }
};

ensureLogDir();

const timestamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
};

const getBaseLogFile = () => {
  const d = new Date();
  const envSuffix = NODE_ENV === 'production' ? '' : '-dev';
  return path.join(LOG_DIR, `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}${envSuffix}.log`);
};

const getRotatedFiles = async () => {
  const baseFile = getBaseLogFile();
  const dir = path.dirname(baseFile);
  const ext = path.extname(baseFile);
  const prefix = path.basename(baseFile, ext);
  
  try {
    const files = await fsPromises.readdir(dir);
    return files
      .filter(f => f.startsWith(prefix + '.') && f.endsWith(ext))
      .map(f => path.join(dir, f))
      .sort();
  } catch {
    return [];
  }
};

const rotateLog = async () => {
  const baseFile = getBaseLogFile();
  
  try {
    const stats = await fsPromises.stat(baseFile);
    if (stats.size < MAX_FILE_SIZE) return;
  } catch {
    return;
  }
  
  const rotatedFiles = await getRotatedFiles();
  const nextNum = rotatedFiles.length + 1;
  
  if (nextNum > MAX_ROTATED_FILES) {
    for (let i = nextNum - MAX_ROTATED_FILES; i < rotatedFiles.length; i++) {
      await fsPromises.unlink(rotatedFiles[i]).catch(() => {});
    }
  }
  
  const rotatedName = `${baseFile}.${nextNum}`;
  await fsPromises.rename(baseFile, rotatedName).catch(() => {});
};

const safeStringify = (obj, maxDepth = 3, currentDepth = 0) => {
  if (currentDepth >= maxDepth) {
    return '[Object truncated]';
  }
  
  if (typeof obj === 'string') {
    return obj.length > 2000 ? obj.substring(0, 2000) + '...[truncated]' : obj;
  }
  
  if (typeof obj !== 'object' || obj === null) {
    return String(obj);
  }
  
  if (obj instanceof Error) {
    return `${obj.message}\n${obj.stack || ''}`;
  }
  
  try {
    const serialized = JSON.stringify(obj, (key, value) => {
      if (/password|passwd|token|secret|cookie|authorization|api[-_]?key/i.test(key)) {
        return '[REDACTED]';
      }
      if (typeof value === 'string') {
        return value.length > 500 ? value.substring(0, 500) + '...' : value;
      }
      if (typeof value === 'object' && value !== null && currentDepth >= maxDepth - 1) {
        return `[Object]`;
      }
      return value;
    }, 2);
    return serialized.length > 4000 ? serialized.substring(0, 4000) + '\n...[truncated]' : serialized;
  } catch {
    try {
      return `[Circular: ${obj.constructor?.name || 'Object'}]`;
    } catch {
      return '[Object]';
    }
  }
};

const formatMessage = (level, tag, message, ...args) => {
  const levelStr = level.toUpperCase().padEnd(5, ' ');
  let msg = `${timestamp()} [${levelStr}] ${tag || '-'}: ${message}`;
  if (args.length > 0) {
    try {
      msg += ' ' + args.map(a => typeof a === 'object' ? safeStringify(a) : safeStringify(a)).join(' ');
    } catch {
      msg += ' ' + args.map(a => {
        try { return String(a); } catch { return '[unknown]'; }
      }).join(' ');
    }
  }
  return msg.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
};

const flushBuffer = async () => {
  if (isFlushing || logBuffer.length === 0) return;
  
  isFlushing = true;
  const lines = [...logBuffer];
  logBuffer.length = 0;
  
  try {
    await rotateLog();
    const content = lines.join('\n') + '\n';
    await fsPromises.appendFile(getBaseLogFile(), content, 'utf8');
  } catch (e) {
    console.error('[logger] Failed to flush logs:', e.message);
  } finally {
    isFlushing = false;
  }
};

const scheduleFlush = () => {
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBuffer();
    }, FLUSH_INTERVAL);
  }
};

const writeToFile = (msg) => {
  logBuffer.push(msg);
  if (logBuffer.length >= BUFFER_THRESHOLD) {
    flushBuffer();
  } else {
    scheduleFlush();
  }
};

const shouldLog = (level) => LOG_LEVELS[level.toUpperCase()] >= currentLevel;

const colors = {
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m'
};

const log = (level, tag, message, ...args) => {
  if (!shouldLog(level)) return;
  
  const msg = formatMessage(level, tag, message, ...args);
  
  if (level === 'error') {
    console.error(colors.error + msg + colors.reset);
  } else if (level === 'warn') {
    console.warn(colors.warn + msg + colors.reset);
  } else if (level === 'info') {
    console.log(colors.info + msg + colors.reset);
  } else {
    console.log(colors.debug + msg + colors.reset);
  }
  
  writeToFile(msg);
};

process.on('SIGTERM', async () => {
  await flushBuffer();
});

process.on('SIGINT', async () => {
  await flushBuffer();
});

// ==================== 日志查询/管理 API（供 routes/logs.js 调用）====================

// 仅允许 YYYY-MM-DD[-dev].log 文件名，防止路径穿越
const SAFE_LOG_NAME = /^\d{4}-\d{2}-\d{2}(-dev)?\.log$/;
const MAX_RECENT_LINES = 1000;

/**
 * 读取最新日志文件的最后 N 行
 */
function getRecentLogs(limit = 50) {
  const file = getBaseLogFile();
  const baseName = path.basename(file);
  if (!fs.existsSync(file)) {
    return { logs: [], file: baseName, total: 0 };
  }
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { logs: [], file: baseName, total: 0, error: e.message };
  }
  const lines = content.split('\n').filter(l => l.length > 0);
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 50, MAX_RECENT_LINES));
  const recent = lines.slice(-safeLimit);
  return { logs: recent, total: lines.length, file: baseName };
}

/**
 * 列出 logs 目录下所有 .log 文件元数据
 */
function getLogFiles() {
  if (!fs.existsSync(LOG_DIR)) return { files: [] };
  let entries;
  try {
    entries = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
  } catch (e) {
    return { files: [], error: e.message };
  }
  const files = entries.map(name => {
    const fullPath = path.join(LOG_DIR, name);
    try {
      const stat = fs.statSync(fullPath);
      return {
        name,
        size: stat.size,
        createdAt: stat.birthtime,
        modifiedAt: stat.mtime
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
  files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  return { files };
}

/**
 * 按日期/页码查询日志，可选级别过滤与关键词搜索
 * 兼容两种调用签名：
 *   - getLogs(date, page, pageSize, level?, search?) — 与 routes/logs.js 一致
 *   - getLogs({file, limit, level, search}) — 文档建议的对象签名
 */
function getLogs(date, page, pageSize, level, search) {
  // 兼容对象签名
  if (date && typeof date === 'object') {
    const opts = date;
    date = opts.file || opts.date || '';
    page = 1;
    pageSize = opts.limit || 100;
    level = opts.level || '';
    search = opts.search || '';
  }

  // 根据 date 解析目标文件名
  let targetName;
  if (!date) {
    targetName = path.basename(getBaseLogFile());
  } else {
    // 兼容传入 YYYY-MM-DD 或 YYYY-MM-DD-dev 或完整文件名
    const stripped = String(date).replace(/\.log$/i, '');
    targetName = `${stripped}.log`;
  }
  // 白名单校验，防止路径穿越
  if (!SAFE_LOG_NAME.test(targetName)) {
    return { logs: [], total: 0, file: targetName, error: '非法日志文件名' };
  }

  const fullPath = path.join(LOG_DIR, targetName);
  if (!fs.existsSync(fullPath)) {
    return { logs: [], total: 0, file: targetName };
  }

  let content;
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    return { logs: [], total: 0, file: targetName, error: e.message };
  }

  let lines = content.split('\n').filter(l => l.length > 0);

  // 级别过滤（基于行首 [LEVEL] 标记）
  if (level) {
    const lv = level.toUpperCase();
    lines = lines.filter(l => l.includes(`[${lv.padEnd(5, ' ')}]`) || l.includes(`[${lv}]`));
  }
  // 关键词搜索（大小写不敏感）
  if (search) {
    const lower = String(search).toLowerCase();
    lines = lines.filter(l => l.toLowerCase().includes(lower));
  }

  const total = lines.length;
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeSize = Math.max(1, Math.min(parseInt(pageSize, 10) || 100, MAX_RECENT_LINES));
  const start = (safePage - 1) * safeSize;
  const paged = lines.slice(start, start + safeSize);

  return {
    logs: paged,
    total,
    page: safePage,
    pageSize: safeSize,
    file: targetName
  };
}

/**
 * 删除指定日志文件（白名单校验防路径穿越）
 */
function deleteLogFile(filename) {
  // 仅允许 YYYY-MM-DD[-dev].log
  if (typeof filename !== 'string' || !SAFE_LOG_NAME.test(filename)) {
    return { success: false, error: '非法日志文件名（仅允许 YYYY-MM-DD[-dev].log）' };
  }
  const fullPath = path.join(LOG_DIR, filename);
  // 二次校验：解析后路径必须仍在 LOG_DIR 内
  if (!fullPath.startsWith(LOG_DIR + path.sep) && fullPath !== LOG_DIR) {
    return { success: false, error: '路径越界' };
  }
  if (!fs.existsSync(fullPath)) {
    return { success: false, error: '日志文件不存在' };
  }
  try {
    fs.unlinkSync(fullPath);
    return { success: true, deleted: filename };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const logger = {
  debug: (tag, message, ...args) => log('debug', tag, message, ...args),
  info: (tag, message, ...args) => log('info', tag, message, ...args),
  warn: (tag, message, ...args) => log('warn', tag, message, ...args),
  error: (tag, message, ...args) => log('error', tag, message, ...args),

  setLevel: (level) => {
    if (LOG_LEVELS[level.toUpperCase()] !== undefined) {
      currentLevel = LOG_LEVELS[level.toUpperCase()];
    }
  },

  getLevel: () => {
    return Object.keys(LOG_LEVELS).find(k => LOG_LEVELS[k] === currentLevel);
  },

  isProduction: () => NODE_ENV === 'production',

  flush: () => flushBuffer(),

  getLogFile: () => getBaseLogFile(),

  // 日志查询/管理 API
  getRecentLogs,
  getLogFiles,
  getLogs,
  deleteLogFile
};

module.exports = logger;