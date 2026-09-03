function apiVersionMiddleware(req, res, next) {
  const pathParts = req.path.split('/');
  let version = 'v1';
  
  if (pathParts[2] === 'v1' || pathParts[2] === 'v2') {
    version = pathParts[2];
    req.path = '/' + pathParts.slice(3).join('/');
    req.version = version;
  } else {
    req.version = 'v1';
  }
  
  res.setHeader('X-API-Version', req.version);
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
