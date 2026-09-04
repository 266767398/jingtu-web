function apiVersionMiddleware(req, res, next) {
  const match = req.path.match(/^\/api\/(v[12])(?=\/|$)/);
  let version = 'v1';

  if (match) {
    version = match[1];
    // 修复（P2-1 集成测试发现）：此前仅对 req.path 赋值，而 req.path 是基于 req.url 的
    // 只读 getter，路由匹配始终读取原始 req.url，版本前缀请求实际全部 404。
    // 现改为重写 req.url：仅剥离版本段、保留 /api 前缀，使挂载于 /api/* 的限流器
    // （ddosLimiter、loginBruteForceLimiter 等）与路由对版本化请求同样生效。
    req.url = req.url.replace(/^\/api\/v[12](?=\/|$)/, '/api');
  }

  req.version = version;
  res.setHeader('X-API-Version', version);
  next();
}

function requireVersion(versions) {
  return function(req, res, next) {
    if (!versions.includes(req.version)) {
      return res.status(400).json({ 
        error: `此接口不支持当前API版本 ${req.version}，支持版本: ${versions.join(', ')}` 
      });
    }
    next();
  };
}

module.exports = { apiVersionMiddleware, requireVersion };
