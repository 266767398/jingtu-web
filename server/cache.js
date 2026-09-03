let redisClient = null;
let isEnabled = false;

async function initCache() {
  try {
    const redisHost = process.env.REDIS_HOST || '127.0.0.1';
    const redisPort = parseInt(process.env.REDIS_PORT) || 6379;
    const redisPassword = process.env.REDIS_PASSWORD || '';
    const redisDb = parseInt(process.env.REDIS_DB) || 0;

    if (!process.env.REDIS_HOST) {
      console.log('[cache] Redis未配置，跳过初始化');
      return;
    }

    const redis = require('redis');
    redisClient = redis.createClient({
      url: `redis://${redisPassword ? ':' + encodeURIComponent(redisPassword) + '@' : ''}${redisHost}:${redisPort}/${redisDb}`
    });

    await redisClient.connect();
    console.log('[cache] Redis连接成功');
    isEnabled = true;

    redisClient.on('error', (err) => {
      console.error('[cache] Redis错误:', err);
      isEnabled = false;
    });

    redisClient.on('disconnect', () => {
      console.warn('[cache] Redis断开连接');
      isEnabled = false;
    });

    redisClient.on('reconnecting', () => {
      console.log('[cache] Redis重连中...');
    });

    redisClient.on('ready', () => {
      console.log('[cache] Redis重新连接成功');
      isEnabled = true;
    });
  } catch (e) {
    console.error('[cache] Redis初始化失败:', e.message);
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
    console.error('[cache] get error:', e);
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
    console.error('[cache] set error:', e);
  }
}

async function del(key) {
  if (!isEnabled || !redisClient) return;
  try {
    await redisClient.del(key);
  } catch (e) {
    console.error('[cache] del error:', e);
  }
}

async function exists(key) {
  if (!isEnabled || !redisClient) return false;
  try {
    const result = await redisClient.exists(key);
    return result === 1;
  } catch (e) {
    console.error('[cache] exists error:', e);
    return false;
  }
}

async function keys(pattern) {
  if (!isEnabled || !redisClient) return [];
  try {
    return await redisClient.keys(pattern);
  } catch (e) {
    console.error('[cache] keys error:', e);
    return [];
  }
}

async function flushAll() {
  if (!isEnabled || !redisClient) return;
  try {
    await redisClient.flushAll();
  } catch (e) {
    console.error('[cache] flushAll error:', e);
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
    
    const cacheKey = `cache:${req.method}:${req.path}:${JSON.stringify(req.query)}`;
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
  keys,
  flushAll,
  getStats,
  cacheMiddleware,
  isEnabled: () => isEnabled
};
