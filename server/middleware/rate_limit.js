const rateLimit = require('express-rate-limit');
const { hybridStore } = require('./rate_limit_store');

// 使用 ipKeyGenerator 辅助函数包装 IP 获取，修复 IPv6 兼容性
// P2-168（连带修复）：express-rate-limit v8 起 ipKeyGenerator 签名由 (req)=>req.ip
// 改为 (ip:string)=>ip——此前传整个 req 对象会被原样返回，作为限流 key 时每次请求
// 都是新对象、计数永不累积，registerLimiter 的无标识回退路径形同虚设。
function ipKey(req) {
  return rateLimit.ipKeyGenerator(req.ip);
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

// P3-139：loginLimiter/bruteForceLimiter 全库无调用方（登录实际走 security.js 的
// loginBruteForceLimiter），且 bruteForceLimiter.check 的 key 拼入用户可控的 req.path，
// 一旦未来接上可把每个路径拆成独立桶绕过次数限制——一并删除，避免死代码误复用。

// P2-168：注册限流 key 归一化——email 原文由请求方任意控制，直接拼入 key 时
// 攻击者靠大小写变换/前后空格即可分裂出无限 key，绕过 15 分钟 5 次注册上限。
// 归一化口径与 security.js loginBruteForceLimiter 对齐：trim + lowercase，并钳制
// 长度上限防止超长字符串滥用；无 email（当前注册表单为 username+激活码）时
// 回退纯 IP 维度（换用户名无法绕过 IP 计数）。
const normalizeRegisterKey = (req) => {
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254);
  return email ? `email:${email}` : ipKey(req);
};

const registerLimiter = rateLimit({
  ...limiterConfig,
  max: 5,
  store: hybridStore('rate-register'),
  message: {
    error: '注册请求过于频繁，请稍后再试',
    retryAfter: 900
  },
  keyGenerator: normalizeRegisterKey
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

// P3-140：/uploads 静态媒体按 IP 限流——此前该路径不在任何限流之下，攻击者
// 用有效分享码拼不同路径反复请求可放大 DB 查询量（配合 uploads_auth 短 TTL 缓存
// 双管齐下）。上限取宽（1000/15min ≈ 67/min）以容纳相册首屏批量拉图，仍足以
// 阻断无标识刷量与爬取。
const uploadsStaticLimiter = rateLimit({
  ...limiterConfig,
  max: 1000,
  store: hybridStore('rate-uploads-static'),
  message: {
    error: '请求过于频繁，请稍后再试',
    retryAfter: 900
  }
});

const createCustomLimiter = ({ name, ...options }) => {
  return rateLimit({
    ...limiterConfig,
    store: hybridStore(`rate-custom-${name || 'anonymous'}`),
    ...options
  });
};

module.exports = {
  registerLimiter,
  apiLimiter,
  uploadLimiter,
  passwordResetLimiter,
  uploadsStaticLimiter,
  createCustomLimiter
};
