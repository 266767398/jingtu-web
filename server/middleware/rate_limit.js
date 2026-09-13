const rateLimit = require('express-rate-limit');
const cache = require('../cache');
const { hybridStore } = require('./rate_limit_store');

// 使用 ipKeyGenerator 辅助函数包装 IP 获取，修复 IPv6 兼容性
function ipKey(req) {
  return rateLimit.ipKeyGenerator(req);
}

const limiterConfig = {
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: '请求过于频繁，请稍后再试',
    retryAfter: 900
  }
};

const loginLimiter = rateLimit({
  ...limiterConfig,
  max: 10,
  store: hybridStore('rate-login'),
  message: {
    error: '登录失败次数过多，请稍后再试',
    retryAfter: 900
  },
  keyGenerator: (req) => req.body?.email || req.body?.username || ipKey(req)
});

const registerLimiter = rateLimit({
  ...limiterConfig,
  max: 5,
  store: hybridStore('rate-register'),
  message: {
    error: '注册请求过于频繁，请稍后再试',
    retryAfter: 900
  },
  keyGenerator: (req) => req.body?.email || ipKey(req)
});

const apiLimiter = rateLimit({
  ...limiterConfig,
  max: 200,
  store: hybridStore('rate-api'),
  message: {
    error: 'API请求过于频繁，请稍后再试',
    retryAfter: 900
  }
});

const uploadLimiter = rateLimit({
  ...limiterConfig,
  max: 30,
  store: hybridStore('rate-upload'),
  message: {
    error: '上传请求过于频繁，请稍后再试',
    retryAfter: 900
  }
});

// 敏感认证端点限流：15 分钟 5 次（密码重置/改密/VRC 绑定验证）
const passwordResetLimiter = rateLimit({
  ...limiterConfig,
  max: 5,
  store: hybridStore('rate-password-reset'),
  message: {
    error: '敏感操作请求过于频繁，请稍后再试',
    retryAfter: 900
  }
});

const bruteForceLimiter = {
  async check(req, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
    const key = `bruteforce:${ipKey(req)}:${req.path}`;
    const attempts = await cache.get(key) || 0;
    
    if (attempts >= maxAttempts) {
      return { blocked: true, attempts };
    }
    
    await cache.set(key, attempts + 1, Math.ceil(windowMs / 1000));
    return { blocked: false, attempts };
  },
  
  async reset(req) {
    const key = `bruteforce:${ipKey(req)}:${req.path}`;
    await cache.del(key);
  }
};

const createCustomLimiter = ({ name, ...options }) => {
  return rateLimit({
    ...limiterConfig,
    store: hybridStore(`rate-custom-${name || 'anonymous'}`),
    ...options
  });
};

module.exports = {
  loginLimiter,
  registerLimiter,
  apiLimiter,
  uploadLimiter,
  passwordResetLimiter,
  bruteForceLimiter,
  createCustomLimiter
};
