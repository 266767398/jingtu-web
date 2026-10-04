const logger = require('./logger');

let redisClient = null;
let isEnabled = false;

async function initCache() {
  try {
    const redisHost = process.env.REDIS_HOST || '127.0.0.1';
    const redisPort = parseInt(process.env.REDIS_PORT) || 6379;
    const redisPassword = process.env.REDIS_PASSWORD || '';
    const redisDb = parseInt(process.env.REDIS_DB) || 0;

    if (!process.env.REDIS_HOST) {
      logger.info('cache', '[cache] Redis未配置，跳过初始化');
      return;
    }

    const redis = require('redis');
    redisClient = redis.createClient({
      url: `redis://${redisPassword ? ':' + encodeURIComponent(redisPassword) + '@' : ''}${redisHost}:${redisPort}/${redisDb}`
    });

    await redisClient.connect();
    logger.info('cache', '[cache] Redis连接成功');
    isEnabled = true;

    redisClient.on('error', (err) => {
      logger.error('cache', '[cache] Redis错误:', err);
      isEnabled = false;
    });

    redisClient.on('disconnect', () => {
      logger.warn('cache', '[cache] Redis断开连接');
      isEnabled = false;
    });

    redisClient.on('reconnecting', () => {
      logger.info('cache', '[cache] Redis重连中...');
    });

    redisClient.on('ready', () => {
      logger.info('cache', '[cache] Redis重新连接成功');
      isEnabled = true;
    });
  } catch (e) {
    logger.error('cache', '[cache] Redis初始化失败:', e.message);
    isEnabled = false;
  }
}

async function get(key) {
  if (!isEnabled || !redisClient) return null;
  try {
    const value = await redisClient.get(key);
    if (value) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return null;
  } catch (e) {
    logger.error('cache', '[cache] get error:', e);
    return null;
  }
}

async function set(key, value, ttlSeconds = 3600) {
  if (!isEnabled || !redisClient) return;
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds > 0) {
      await redisClient.setEx(key, ttlSeconds, serialized);
    } else {
      await redisClient.set(key, serialized);
    }
  } catch (e) {
    logger.error('cache', '[cache] set error:', e);
  }
}

async function del(key) {
  if (!isEnabled || !redisClient) return;
  try {
    await redisClient.del(key);
  } catch (e) {
    logger.error('cache', '[cache] del error:', e);
  }
}

async function exists(key) {
  if (!isEnabled || !redisClient) return false;
  try {
    const result = await redisClient.exists(key);
    return result === 1;
  } catch (e) {
    logger.error('cache', '[cache] exists error:', e);
    return false;
  }
}

/**
 * 原子计数：首次写入即带 TTL，避免 incr-then-expire 竞态产生永生键。
 * 返回 { total, ttl }；Redis 不可用或异常时返回 null，调用方需回退本地实现。
 */
async function incr(key, ttlSeconds) {
  if (!isEnabled || !redisClient) return null;
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.ceil(ttlSeconds) : 0;
  try {
    const created = ttl > 0
      ? await redisClient.set(key, '1', { NX: true, EX: ttl })
      : await redisClient.set(key, '1', { NX: true });
    if (created) return { total: 1, ttl };

    const total = await redisClient.incr(key);
    const remaining = ttl > 0 ? await redisClient.ttl(key) : -1;
    if (ttl > 0 && remaining < 0) {
      await redisClient.expire(key, ttl);
      return { total, ttl };
    }
    return { total, ttl: ttl > 0 ? remaining : ttl };
  } catch (e) {
    logger.error('cache', '[cache] incr error:', e);
    isEnabled = false;
    return null;
  }
}

/**
 * 原子减计数（P3-138）：单条 Lua 内完成读取/减一/保留 TTL，消除 get-then-set
 * 竞态（并发成功登录互相覆盖丢更新）。键不存在返回 -1（调用方视为无需减），
 * 计数值降到 0 时保留键位并续 TTL，与 MemoryStore 的 decrement 语义一致；
 * Redis 不可用或异常返回 null，调用方需回退本地实现。
 */
const DECRBY_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v == false then return -1 end
local n = tonumber(v)
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then ttl = tonumber(ARGV[1]) end
if n <= 1 then
  if ttl > 0 then redis.call('SET', KEYS[1], 0, 'EX', ttl) end
  return 0
end
if ttl > 0 then
  redis.call('SET', KEYS[1], n - 1, 'EX', ttl)
else
  redis.call('SET', KEYS[1], n - 1)
end
return n - 1`;

async function decrBy(key, ttlSeconds) {
  if (!isEnabled || !redisClient) return null;
  try {
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.ceil(ttlSeconds) : 3600;
    const result = await redisClient.eval(DECRBY_SCRIPT, { keys: [key], arguments: [String(ttl)] });
    return typeof result === 'number' ? result : Number.parseInt(result, 10);
  } catch (e) {
    logger.error('cache', '[cache] decrBy error:', e);
    isEnabled = false;
    return null;
  }
}

/**
 * 剩余存活秒数：键不存在/已过期返回 -2，未设置过期返回 -1，Redis 不可用返回 -2。
 */
async function ttl(key) {
  if (!isEnabled || !redisClient) return -2;
  try {
    return await redisClient.ttl(key);
  } catch (e) {
    logger.error('cache', '[cache] ttl error:', e);
    isEnabled = false;
    return -2;
  }
}

async function expire(key, seconds) {
  if (!isEnabled || !redisClient) return false;
  try {
    return await redisClient.expire(key, Math.ceil(seconds));
  } catch (e) {
    logger.error('cache', '[cache] expire error:', e);
    isEnabled = false;
    return false;
  }
}

/**
 * 释放 Redis 连接，供进程优雅退出时调用。
 */
async function closeCache() {
  if (!redisClient) return;
  const client = redisClient;
  redisClient = null;
  isEnabled = false;
  try {
    await client.quit();
  } catch (e) {
    try {
      client.disconnect();
    } catch (closeErr) {
      logger.error('cache', '[cache] closeCache error:', closeErr);
    }
  }
}

async function keys(pattern) {
  if (!isEnabled || !redisClient) return [];
  try {
    return await redisClient.keys(pattern);
  } catch (e) {
    logger.error('cache', '[cache] keys error:', e);
    return [];
  }
}

async function flushAll() {
  if (!isEnabled || !redisClient) return;
  try {
    await redisClient.flushAll();
  } catch (e) {
    logger.error('cache', '[cache] flushAll error:', e);
  }
}

async function getStats() {
  if (!isEnabled || !redisClient) {
    return { enabled: false, error: 'Redis未配置或未连接' };
  }
  try {
    const info = await redisClient.info('stats');
    const lines = info.split('\r\n');
    const stats = {};
    for (const line of lines) {
      if (line && !line.startsWith('#') && line.includes(':')) {
        const [key, value] = line.split(':');
        stats[key.trim()] = value.trim();
      }
    }
    return { enabled: true, stats };
  } catch (e) {
    return { enabled: false, error: e.message };
  }
}

function cacheMiddleware(duration = 3600) {
  return async function(req, res, next) {
    if (!isEnabled) return next();
    
    // P3-76: 缓存键并入用户身份维度——即使未来挂到含私有数据的只读 GET，
    // 也绝不会把首个请求者的响应缓存共享给其他用户（当前未挂载任何路由，属纵深防御）。
    const uid = (req.session && (req.session.userId || req.session.id)) || 'anon';
    const cacheKey = `cache:${req.method}:${req.path}:${uid}:${JSON.stringify(req.query)}`;
    const cached = await get(cacheKey);
    
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
    
    res.setHeader('X-Cache', 'MISS');
    const originalJson = res.json;
    
    res.json = function(data) {
      set(cacheKey, data, duration);
      return originalJson.call(this, data);
    };
    
    next();
  };
}

module.exports = {
  initCache,
  get,
  set,
  del,
  exists,
  incr,
  decrBy,
  ttl,
  expire,
  closeCache,
  keys,
  flushAll,
  getStats,
  cacheMiddleware,
  isEnabled: () => isEnabled
};
