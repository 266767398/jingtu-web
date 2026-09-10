const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');
const compact = (source) => source.replace(/\s+/g, ' ');

const files = {
  server: read('server', 'server.js'),
  csrfMiddleware: read('server', 'middleware', 'csrf.js'),
  uploadsAuth: read('server', 'middleware', 'uploads_auth.js'),
  authRoute: read('server', 'routes', 'auth.js'),
  localService: read('server', 'auth_local_service.js'),
  vrcService: read('server', 'auth_vrc_service.js'),
  authMiddleware: read('server', 'auth.js'),
  securityMiddleware: read('server', 'middleware', 'security.js'),
  migrationRoute: read('server', 'routes', 'migration.js'),
  vrcSystemRoute: read('server', 'routes', 'vrc_system.js'),
  liveRoute: read('server', 'routes', 'live.js'),
  postsRoute: read('server', 'routes', 'posts.js'),
  shareRoute: read('server', 'routes', 'share.js'),
  backupsRoute: read('server', 'routes', 'backups.js'),
  dbInit: read('server', 'db_init.js'),
  metrics: read('server', 'middleware', 'metrics.js'),
  analyticsRoute: read('server', 'routes', 'analytics.js'),
  usersRoute: read('server', 'routes', 'users.js'),
  profileRoute: read('server', 'routes', 'profile.js'),
  membersJs: read('public', 'js', 'members.js'),
  migrationPage: read('public', 'migration.html'),
  mainJs: read('public', 'js', 'main.js'),
  initJs: read('public', 'js', 'init.js'),
  authJs: read('public', 'js', 'auth.js'),
  liveJs: read('public', 'js', 'live.js'),
  postsJs: read('public', 'js', 'posts.js'),
  indexHtml: read('public', 'index.html'),
  uiEnhanceCss: read('public', 'css', 'ui-enhance.css'),
  uiComponentsCss: read('public', 'css', 'ui-components.css')
};

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectBefore(source, earlier, later) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  expect(earlierIndex).toBeGreaterThanOrEqual(0);
  expect(laterIndex).toBeGreaterThanOrEqual(0);
  expect(earlierIndex).toBeLessThan(laterIndex);
}

/**
 * 本文件通过静态源码断言守护安全回归：只读取现有源码，不启动 Express、
 * 不连接 MariaDB，避免把认证、CSRF、私有资源和初始化流程的历史漏洞带回来。
 */
describe('security regressions', () => {
  // 备份 SQL 曾有被静态目录直接暴露的风险；这里只允许公开 uploads/assets/public，并要求备份下载走管理员路由。
  test('does not expose database backups as static files', () => {
    // /uploads 鉴权已抽至 middleware/uploads_auth.js；server.js 必须保留「先鉴权、后静态」的挂载顺序。
    // 静态挂载允许带 options（如 Cache-Control setHeaders），但目标目录必须是 uploads 本身。
    expect(files.server).toMatch(/setupUploadsAuth\(app\);[\s\S]*?app\.use\('\/uploads',\s*express\.static\(path\.join\(ROOT_DIR,\s*'uploads'\)/);
    expect(files.uploadsAuth).toMatch(/share_links WHERE share_code = \? AND expires_at > NOW\(\)/);
    expect(files.server).toMatch(/app\.use\('\/uploads',\s*express\.static\(path\.join\(ROOT_DIR,\s*'uploads'\)/);
    expect(files.server).toMatch(/app\.use\('\/assets',\s*express\.static\(ASSETS_DIR,\s*\{/);
    expect(files.server).toMatch(/express\.static\(path\.join\(ROOT_DIR,\s*'public'\),\s*\{\s*maxAge:\s*0,\s*etag:\s*true,/);
    expect(files.server).not.toMatch(/express\.static\([^)]*(?:backups|backupDir)[^)]*\)/i);
    expect(files.backupsRoute).toMatch(/const backupDir = path\.join\(__dirname,\s*'\.\.',\s*'\.\.',\s*'backups'\)/);
    expect(files.backupsRoute).toMatch(/router\.get\('\/admin\/backups\/:filename\/download',\s*requireAdminCompat/);
    expect(files.backupsRoute).toMatch(/const filename = path\.basename\(req\.params\.filename\)/);
  });

  // 迁移接口和系统级 VRChat 控制可探测环境或改写全局登录态，必须只有管理员能访问。
  test('protects migration and system VRChat control routes', () => {
    expect(files.migrationRoute).toMatch(/router\.use\(requireAdminCompat\)/);
    expect(files.vrcSystemRoute).toMatch(/router\.post\('\/login',\s*requireAdminCompat/);
    expect(files.vrcSystemRoute).toMatch(/router\.post\('\/2fa',\s*requireAdminCompat/);
    expect(files.vrcSystemRoute).toMatch(/router\.post\('\/logout',\s*requireAdminCompat/);
    expect(files.server).toMatch(/app\.use\('\/api\/migration',\s*adminLimiter\)/);
    expect(files.server).toMatch(/app\.use\('\/api',\s*vrcSystemRouter\)/);
  });

  // 管理、迁移、数据库等特权路由曾可能在 CSRF 中间件外；挂载顺序必须保证先校验 CSRF 再挂路由。
  // （CSRF 实现已抽至 middleware/csrf.js：server.js 只保留挂载点，豁免清单与会话绑定断言锚定到新模块。）
  test('keeps privileged routes inside CSRF protection', () => {
    expectBefore(files.server, 'const { csrfCleanupInterval } = setupCsrf(app);', "app.use('/api/auth', require('./routes/auth'))");
    expectBefore(files.server, 'const { csrfCleanupInterval } = setupCsrf(app);', "app.use('/api/migration', require('./routes/migration'))");
    expectBefore(files.server, 'const { csrfCleanupInterval } = setupCsrf(app);', "app.use('/api', require('./routes/database'))");
    expect(files.csrfMiddleware).toMatch(/app\.use\('\/api',\s*\(req,\s*res,\s*next\) => \{/);
    const csrfBlock = sliceBetween(files.csrfMiddleware, 'const exemptPaths = [', 'const token = req.headers');
    expect(csrfBlock).not.toMatch(/admin|migration|database|backups|files|export|config/);
    expect(files.csrfMiddleware).toMatch(/record\.sid[\s\S]*!== req\.sessionID[\s\S]*CSRF token 与当前会话不匹配/);
  });

  // VRChat 两步登录曾可能在验证码错误时先创建本地会话；必须先 verifyVrc2fa 成功后才 regenerate/buildSession。
  test('rejects an invalid VRChat 2FA code before creating a session', () => {
    const inline2fa = sliceBetween(files.vrcService, 'if (loginToken && code) {', '// ══════════ 模式 A');
    expect(inline2fa).toMatch(/const vResult = await verifyVrc2fa\(code,\s*method,\s*cookie\)/);
    expect(inline2fa).toMatch(/if \(!vResult\.success\)[\s\S]*return (?:fail\(res,\s*401|res\.status\(401\)\.json)/);
    expectBefore(inline2fa, 'const vResult = await verifyVrc2fa', 'req.session.regenerate');
    expectBefore(inline2fa, 'if (!vResult.success)', 'req.session.regenerate');
    const standalone2fa = sliceBetween(files.vrcService, "router.post('/vrchat-2fa'", '// ==================== VRChat 绑定');
    expect(standalone2fa).toMatch(/const vResult = await verifyVrc2fa\(code,\s*method,\s*cookie\)/);
    expectBefore(standalone2fa, 'const vResult = await verifyVrc2fa', 'req.session.regenerate');
  });

  // 迁移页面提交数据库凭据时曾遗漏 cookie/CSRF；统一封装必须随请求携带凭据并为写请求加 token。
  test('migration page sends credentials and CSRF tokens', () => {
    const fetchWrapper = sliceBetween(files.migrationPage, 'async function migrationFetch', 'async function loadPanelConfigs');
    expect(fetchWrapper).toMatch(/fetch\('\/api\/csrf-token',\s*\{\s*credentials:\s*'include'\s*\}\)/);
    expect(fetchWrapper).toMatch(/headers\.set\('X-CSRF-Token',\s*csrfToken\)/);
    expect(fetchWrapper).toMatch(/return fetch\(url,\s*\{\s*\.\.\.options,\s*headers,\s*credentials:\s*'include'\s*\}\)/);
    expect(files.migrationPage).toMatch(/migrationFetch\('\/api\/migration\/test-connection',\s*\{\s*method:\s*'POST'/);
    expect(files.migrationPage).toMatch(/migrationFetch\('\/api\/migration\/migrate',\s*\{\s*method:\s*'POST'/);
  });

  // 私密直播曾可能被列表、详情或推荐通知泄露；列表/详情需过滤，通知只能发公开直播。
  test('keeps recommendation and private live controls restricted', () => {
    expect(files.liveRoute).toMatch(/function getAccessibleStream\(req,\s*streamId\)[\s\S]*stream\.is_public \|\| canViewPrivate \? stream : null/);
    expect(files.liveRoute).toMatch(/if \(!s\.is_public && !canViewPrivate\)[\s\S]*直播不存在/);
    expect(files.liveRoute).toMatch(/conditions\.push\('\(s\.is_public = 1 OR s\.user_id = \?\)'\)/);
    const startBlock = sliceBetween(files.liveRoute, "router.post('/:streamId/start'", '// 结束直播');
    expect(startBlock).toMatch(/if \(notificationService && stream\[0\]\.is_public\)/);
    expect(startBlock).toMatch(/notifyAllMembers\('live'/);
  });

  // 前后端上传字段名曾不一致导致绕过/失败；直播缩略图和动态媒体字段必须和 multer 配置对齐。
  test('keeps live and post frontend upload contracts aligned', () => {
    expect(files.liveRoute).toMatch(/liveUpload\.single\('thumbnail'\)/);
    expect(files.liveJs).toMatch(/formData\.append\('thumbnail',\s*thumbnail\)/);
    expect(files.liveJs).toMatch(/apiForm\('\/api\/live',\s*formData\)/);
    expect(files.postsRoute).toMatch(/postUpload\.array\('media',\s*12\)/);
    expect(files.postsJs).toMatch(/formData\.append\('media',\s*files\[i\]\)/);
    expect(files.postsJs).toMatch(/apiForm\('\/api\/posts',\s*formData\)/);
  });

  // 分享链接路由曾缺失挂载或表结构；必须加载 router，并在初始化脚本创建 share_links 表。
  test('mounts a usable share router and initializes its table', () => {
    expect(files.server).toMatch(/app\.use\('\/api\/share',\s*require\('\.\/routes\/share'\)\(\)\)/);
    expect(files.shareRoute).toMatch(/module\.exports = function \(\) \{[\s\S]*const router = express\.Router\(\)/);
    expect(files.shareRoute).toMatch(/router\.post\('\/',\s*requireAuth/);
    expect(files.shareRoute).toMatch(/crypto\.randomBytes\(6\)\.toString\('base64url'\)/);
    expect(files.shareRoute).not.toMatch(/Math\.random\s*\(/);
    expect(files.dbInit).toMatch(/CREATE TABLE IF NOT EXISTS share_links/);
    expect(files.dbInit).toMatch(/UNIQUE KEY uk_share_code\(share_code\)/);
  });

  // 私密直播的观众、弹幕、点赞等子资源不能只保护详情页；每个子资源都要复用可访问性检查。
  test('protects every private live subresource', () => {
    const routes = [
      "router.post('/:streamId/enter'",
      "router.post('/:streamId/leave'",
      "router.get('/:streamId/viewers'",
      "router.post('/:streamId/comments'",
      "router.get('/:streamId/comments'",
      "router.post('/:streamId/like'",
      "router.get('/:streamId/likes'"
    ];
    for (let i = 0; i < routes.length; i += 1) {
      const next = i + 1 < routes.length ? routes[i + 1] : '// ==================== 主播管理';
      const block = sliceBetween(files.liveRoute, routes[i], next);
      expect(block).toMatch(/getAccessibleStream\(req,\s*streamId\)/);
      if (!routes[i].includes("get('/:streamId/likes'")) {
        expect(block).toMatch(/requireAuth/);
      }
    }
  });

  // 动态详情包含当前用户点赞状态，不能用跨用户缓存；详情查询也必须显式选择现有用户字段。
  test('does not cache user-specific post details or query a missing column', () => {
    const detailRoute = sliceBetween(files.postsRoute, "router.get('/:id'", '/**\n * POST /api/posts');
    expect(detailRoute).toMatch(/const post = await getPostDetail\(postId,\s*req\.session\?\.userId\)/);
    expect(detailRoute).not.toMatch(/cacheService\.(?:get|set)|cacheKeys\.post/);
    const detailQuery = sliceBetween(files.postsRoute, 'async function getPostDetail', '// ==================== 路由');
    expect(detailQuery).toMatch(/u\.vrchat_name/);
    expect(detailQuery).not.toMatch(/\bendedAt\b|s\.endedAt/);
    expect(detailQuery).toMatch(/liked = lk\.length > 0/);
  });

  // 动态详情弹窗曾假设 DOM 预先存在；首次点击必须能创建 overlay/modal 并挂到 body。
  test('creates the post detail modal on first use', () => {
    // overlay 创建逻辑已抽到 openPostDetailModal 辅助函数里（showPostDetail 只负责调用它）。
    const detailFn = sliceBetween(files.postsJs, 'function openPostDetailModal(postId)', 'function paintPostDetail');
    expect(detailFn).toMatch(/var overlay = document\.getElementById\('postDetailModalOverlay'\)/);
    expect(detailFn).toMatch(/if \(!overlay\) \{[\s\S]*document\.createElement\('div'\)/);
    expect(detailFn).toMatch(/overlay\.id = 'postDetailModalOverlay'/);
    expect(detailFn).toMatch(/document\.body\.appendChild\(overlay\)/);
    expect(detailFn).toMatch(/id="postDetailModal"/);
    expect(detailFn).toMatch(/return overlay/);
  });

  // 首次初始化界面展示后曾停留在空状态；检测到 needInit 后必须立即启动环境检查向导。
  test('starts the environment check when first-time initialization is shown', () => {
    const initBranch = sliceBetween(files.mainJs, 'if (!hasUser) {', 'document.getElementById(\'loginModeInit\')?.classList.add');
    expect(initBranch).toMatch(/switchLoginMode\('init'\)/);
    expect(initBranch).toMatch(/startInitWizard\(\)/);
    expect(files.initJs).toMatch(/function startInitWizard\(\) \{[\s\S]*setInitStep\(0\)[\s\S]*setTimeout\(runEnvCheck,\s*300\)/);
    expect(files.initJs).toMatch(/async function runEnvCheck\(\)/);
  });

  // 初始化面板切换曾只改 display 而保留 d-none；活动面板必须移除隐藏类并清掉内联 display。
  test('removes the hidden utility class from the active initialization panel', () => {
    const setStep = sliceBetween(files.initJs, 'function setInitStep(step)', 'async function runEnvCheck');
    expect(setStep).toMatch(/panel\.classList\.toggle\('d-none',\s*i !== step\)/);
    expect(setStep).toMatch(/panel\.style\.removeProperty\('display'\)/);
    expect(files.indexHtml).toMatch(/id="initStepAdmin" class="init-step-panel d-none"/);
    expect(files.indexHtml).toMatch(/id="initStepDone" class="init-step-panel d-none"/);
  });

  // 首个超级管理员曾创建后仍待审核；初始化插入必须同时写入 super_admin 和 approved=1。
  test('creates the first super administrator as approved', () => {
    const initRoute = sliceBetween(files.localService, "router.post('/init'", '/**\n * @swagger');
    expect(initRoute).toMatch(/role,\s*avatar_type,\s*approved/);
    expect(initRoute).toMatch(/VALUES \(\?, \?, \?, 'super_admin', 'none', 1\)/);
    expect(initRoute).toMatch(/const user = \{[\s\S]*role:\s*'super_admin'/);
    expect(initRoute).toMatch(/buildSession\(req,\s*user\)/);
  });

  // 初始化成功后曾再次走登录流程；后端已建立 session，前端应复用返回的用户并直接进入应用。
  test('uses the session created during initialization instead of logging in twice', () => {
    const initRoute = sliceBetween(files.localService, "router.post('/init'", '/**\n * @swagger');
    expect(initRoute).toMatch(/req\.session\.regenerate/);
    expect(initRoute).toMatch(/await buildSession\(req,\s*user\)/);
    expect(initRoute).toMatch(/ok\(res,\s*\{\s*user:\s*sessionUser\(req\.session\)/);
    const doInit = sliceBetween(files.initJs, 'async function doInit()', 'function startInitWizard');
    expect(doInit).toMatch(/currentUser = data\.user \|\|/);
    expect(doInit).toMatch(/await ensureCsrf\(\);[\s\S]*showApp\(\)/);
    expect(doInit).not.toMatch(/doPasswordLogin|\/api\/auth\/login/);
  });

  // 密码可见性按钮曾没有可访问名称并使用默认样式；按钮需要 aria 状态和主题化图标样式。
  test('uses accessible themed password visibility controls', () => {
    expect(files.indexHtml).toMatch(/<button(?=[^>]*id="pwdToggle")(?=[^>]*class="pwd-toggle")(?=[^>]*aria-label="显示密码")(?=[^>]*aria-pressed="false")[^>]*>/);
    expect(files.indexHtml).toMatch(/<button(?=[^>]*id="pwdToggleVrc")(?=[^>]*class="pwd-toggle")(?=[^>]*aria-label="显示密码")(?=[^>]*aria-pressed="false")[^>]*>/);
    expect(files.indexHtml).toMatch(/<button(?=[^>]*id="pwdToggleInit")(?=[^>]*class="pwd-toggle")(?=[^>]*aria-label="显示密码")(?=[^>]*aria-pressed="false")[^>]*>/);
    expect(files.authJs).toMatch(/btn\.setAttribute\('aria-pressed',\s*String\(visible\)\)/);
    expect(files.authJs).toMatch(/btn\.setAttribute\('aria-label',\s*visible \? __\('auth\.hide_password'\) : __\('auth\.show_password'\)\)/);
    expect(files.uiComponentsCss).toMatch(/\.pwd-wrap \.pwd-toggle \{[\s\S]*color:\s*var\(--text2\)/);
    expect(files.uiComponentsCss).toMatch(/\.pwd-wrap \.pwd-toggle::before[\s\S]*mask:/);
    expect(files.uiComponentsCss).toMatch(/\.pwd-wrap \.pwd-toggle:hover,[\s\S]*background:\s*var\(--accent-light\)/);
  });

  // 登录限流曾只按 IP 聚合，导致不同账号互相影响；key 必须同时包含客户端 IP 和登录标识。
  test('isolates login rate limits by client and login identity', () => {
    const limiter = sliceBetween(files.securityMiddleware, 'const loginBruteForceLimiter = rateLimit', 'const uploadLimiter = rateLimit');
    expect(limiter).toMatch(/keyGenerator:\s*\(req\) =>/);
    expect(limiter).toMatch(/req\.body\?\.loginId \|\| req\.body\?\.username \|\| 'unknown'/);
    expect(limiter).toMatch(/trim\(\)\.toLowerCase\(\)/);
    expect(limiter).toMatch(/rateLimit\.ipKeyGenerator\(req\.ip\)/);
    expect(limiter).toMatch(/return `\$\{rateLimit\.ipKeyGenerator\(req\.ip\)\}:\$\{identity\}`/);
  });

  // 非字符串登录字段曾进入 bcrypt 校验造成异常/绕过；类型验证必须在查库和密码比对之前返回。
  test('rejects non-string login credentials before password verification', () => {
    const loginRoute = sliceBetween(files.localService, "router.post('/login'", '// (游客登录已移除');
    expect(loginRoute).toMatch(/typeof loginId !== 'string' \|\| typeof password !== 'string'/);
    expect(loginRoute).toMatch(/return sendError\(res,\s*400,\s*ErrorCodes\.BAD_REQUEST/);
    expectBefore(loginRoute, "typeof loginId !== 'string'", 'const normalizedLoginId = loginId.trim()');
    expectBefore(loginRoute, "typeof loginId !== 'string'", 'getPool().query');
    expectBefore(loginRoute, "typeof loginId !== 'string'", 'verifyPassword(password, user.password_hash)');
  });

  // 响应统计曾重复计数且分析字段不一致；metrics 只能在 finish 记录一次，analytics 要暴露同名统计。
  test('tracks each response once and exposes matching analytics fields', () => {
    expect((files.metrics.match(/trackResponse\(res\.statusCode\)/g) || []).length).toBe(1);
    expect(files.metrics).toMatch(/res\.on\('finish',\s*\(\) => \{[\s\S]*trackResponse\(res\.statusCode\)/);
    expect(files.metrics).not.toMatch(/res\.on\('close'|res\.on\('error'/);
    expect(files.metrics).toMatch(/requests:\s*\{[\s\S]*total:\s*requestStats\.total[\s\S]*success:\s*requestStats\.success[\s\S]*error:\s*requestStats\.error[\s\S]*slow:\s*requestStats\.slow/);
    expect(files.analyticsRoute).toMatch(/router\.get\('\/admin\/analytics\/requests',\s*requireAdminCompat/);
    expect(files.analyticsRoute).toMatch(/total:\s*metrics\.requests\.total/);
    expect(files.analyticsRoute).toMatch(/success:\s*metrics\.requests\.success/);
    expect(files.analyticsRoute).toMatch(/errors:\s*metrics\.requests\.error/);
    expect(files.analyticsRoute).toMatch(/endpoints:\s*metrics\.endpoints/);
    expect(files.analyticsRoute).toMatch(/statusCodes:\s*metrics\.statusCodes/);
    expect(files.analyticsRoute).toMatch(/slowRequests:\s*metrics\.requests\.slow/);
  });

  // 资料写入曾零校验直落库，且 coverImage 被静默丢弃；PUT /me/profile 必须全字段校验并接收 coverImage。
  test('validates profile updates and keeps the coverImage field', () => {
    const putProfile = sliceBetween(files.usersRoute, "router.put('/me/profile'", "router.post('/me/avatar'");
    expect(putProfile).toMatch(/const \{ displayName, qq, birthday, location, preferences, bio, motto, website, socialLinks, coverImage \} = req\.body/);
    expect(putProfile).toMatch(/!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(birthday\)/);
    expect(putProfile).toMatch(/const isSafeUrl = \(v\) => typeof v === 'string' && v\.length <= 500 && \(/);
    expect(putProfile).toMatch(/\^https\?:\\\/\\\/\\S\+\$\/i\.test\(v\) \|\| \/\^\\\/\[A-Za-z0-9\._\\\-~\/\]\*\$\/\.test\(v\)/);
    expect(putProfile).toMatch(/bio\.length > 2000\)[\s\S]*?return sendError\(res,\s*400,\s*ErrorCodes\.BAD_REQUEST,\s*'个人简介不能超过2000字'\)/);
    expect(putProfile).toMatch(/motto\.length > 100\)[\s\S]*?return sendError\(res,\s*400,\s*ErrorCodes\.BAD_REQUEST,\s*'个性签名不能超过100字'\)/);
    expect(putProfile).toMatch(/prefsObj\.coverImage = coverImage/);
    expect(putProfile).toMatch(/!\/\^\[A-Za-z0-9_\]\{1,30\}\$\/\.test\(k\) \|\| \(v !== null && \(typeof v !== 'string' \|\| v\.length > 300\)\)/);
    expect(putProfile).toMatch(/JSON\.stringify\(incoming\)\.length > 65536/);
    expect(putProfile).toMatch(/k !== 'social_links'\) return sendError\(res,\s*400,\s*ErrorCodes\.BAD_REQUEST,\s*'preferences 值类型不正确'\)/);
  });

  // 前端保存封面后 GET /me/profile 曾永远读回空值；响应必须回显 preferences.coverImage。
  test('returns coverImage from GET /me/profile', () => {
    const getProfile = sliceBetween(files.usersRoute, "router.get('/me/profile'", "router.put('/me/profile'");
    expect(getProfile).toMatch(/coverImage:\s*u\.preferences\?\.coverImage \|\| ''/);
  });

  // 公开主页曾按不存在的 vrchat_id 关联 user_profile 表导致 500，且 motto/bio 双数据源割裂；
  // 必须按 user_id 兜底读取（失败静默降级）并以 preferences 为真相源合并。
  test('merges the public profile from preferences with a user_id fallback', () => {
    const publicProfile = sliceBetween(files.profileRoute, "router.get('/:userId'", "router.post('/update'");
    expect(publicProfile).toMatch(/birthday, location, bio, preferences/);
    expect(publicProfile).toMatch(/FROM user_profile WHERE user_id = \?/);
    expect(publicProfile).not.toMatch(/user_profile WHERE vrchat_id/);
    expect(publicProfile).toMatch(/logger\.warn\('\[profile\] user_profile 表读取失败，仅使用 preferences 数据:'/);
    expect(publicProfile).toMatch(/motto: prefs\.motto \?\? \(profileRow \? profileRow\.motto : ''\) \?\? ''/);
    expect(publicProfile).toMatch(/coverImage: prefs\.coverImage \?\? \(profileRow \? profileRow\.coverImage : ''\) \?\? ''/);
  });

  // 遗留 /update 端点曾零校验且只写 user_profile 不写 preferences；必须同标准校验并同步真相源。
  test('validates and syncs the legacy profile update endpoint', () => {
    const legacyUpdate = sliceBetween(files.profileRoute, "router.post('/update'", "router.get('/:userId/albums'");
    expect(legacyUpdate).toMatch(/motto\.length > 100\)[\s\S]*?return sendError\(res,\s*400,\s*ErrorCodes\.BAD_REQUEST,\s*'个性签名不能超过100字'\)/);
    expect(legacyUpdate).toMatch(/bio\.length > 2000\)[\s\S]*?return sendError\(res,\s*400,\s*ErrorCodes\.BAD_REQUEST,\s*'个人简介不能超过2000字'\)/);
    expect(legacyUpdate).toMatch(/coverImage !== undefined && !isSafeUrl\(coverImage\)\) return sendError\(res,\s*400,\s*ErrorCodes\.BAD_REQUEST,\s*'封面图地址格式不正确'\)/);
    expect(legacyUpdate).toMatch(/ON DUPLICATE KEY UPDATE/);
    expect(legacyUpdate).toMatch(/prefs\.coverImage = coverImage/);
    expect(legacyUpdate).toMatch(/prefs\.social_links = JSON\.parse\(socialLinksStr\)/);
    expectBefore(legacyUpdate, 'if (motto !== undefined && (typeof motto !== \'string\'', 'INSERT INTO user_profile');
    expectBefore(legacyUpdate, 'logger.warn(\'[profile/update] preferences 同步失败', "ok(res, { message: '资料更新成功' })");
  });

  // 会员弹窗标签是 innerHTML 注入点，用户名必须经 esc 转义（escJsStr 只转义引号，不转义 <>&）。
  test('escapes user names inside members modal labels', () => {
    const notesModal = sliceBetween(files.membersJs, 'async function openMemberNotes', 'async function saveMemberNote');
    const reportModal = sliceBetween(files.membersJs, 'async function reportUser', 'async function submitUserReport');
    expect(notesModal).toMatch(/\$\{esc\(userName\)\}/);
    expect(reportModal).toMatch(/\$\{esc\(userName\)\}/);
    expect(files.membersJs).not.toMatch(/\$\{userName\}/);
  });
});
