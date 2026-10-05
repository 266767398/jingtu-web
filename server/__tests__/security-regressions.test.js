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
  rateLimitMiddleware: read('server', 'middleware', 'rate_limit.js'),
  rateLimitStore: read('server', 'middleware', 'rate_limit_store.js'),
  cacheLib: read('server', 'cache.js'),
  cacheService: read('server', 'cache_service.js'),
  chatRoute: read('server', 'routes', 'chat.js'),
  migrationRoute: read('server', 'routes', 'migration.js'),
  vrcSystemRoute: read('server', 'routes', 'vrc_system.js'),
  liveRoute: read('server', 'routes', '_archive', 'live.js'),
  postsRoute: read('server', 'routes', 'posts.js'),
  shareRoute: read('server', 'routes', 'share.js'),
  backupsRoute: read('server', 'routes', 'backups.js'),
  dbInit: read('server', 'db_init.js'),
  metrics: read('server', 'middleware', 'metrics.js'),
  analyticsRoute: read('server', 'routes', 'analytics.js'),
  videoUtils: read('server', 'video_utils.js'),
  apiVersion: read('server', 'middleware', 'api_version.js'),
  // P2-66 god-route 拆分：/me/profile、/me/avatar 等资料域路由已按域拆至 users_profile.js，守卫随实现迁移
  usersProfileRoute: read('server', 'routes', 'users_profile.js'),
  // P3-110~124 第六批后端：系统配置脱敏 / .env 掩码 / 分析收敛 / 匿名校验 / 聊天三处 / 管理分页与改名 / 头像限速 / 点赞与审核/ 字段钳制 / setup 防护
  adminRoute: read('server', 'routes', 'admin.js'),
  envConfigRoute: read('server', 'routes', 'config.js'),
  adminUsersRoute: read('server', 'routes', 'admin_users.js'),
  adminNameChangeRoute: read('server', 'routes', 'admin_name_change.js'),
  usersRoute: read('server', 'routes', 'users.js'),
  moderationsRoute: read('server', 'routes', 'moderations.js'),
  setupRoute: read('server', 'routes', 'setup.js'),
  avatarRoute: read('server', 'routes', 'avatar.js'),
  collectionsRoute: read('server', 'routes', 'collections.js'),
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
  uiComponentsCss: read('public', 'css', 'ui-components.css'),
  groupJs: read('public', 'js', 'group.js'),
  mapJs: read('public', 'js', 'map.js'),
  freezeJs: read('public', 'js', 'freeze.js'),
  themeJs: read('public', 'js', 'theme.js'),
  homeJs: read('public', 'js', 'home.js'),
  chatJs: read('public', 'js', 'chat.js'),
  zhLang: read('public', 'js', 'languages', 'zh.js')
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
    // P1-12：备份目录定义已收口至 backup-core，路由改为委托导入，守卫随实现迁移
    // P2-151：BACKUP_DIR 支持 env 注入（测试隔离），默认仍为项目根 backups/
    expect(files.backupsRoute).toMatch(/BACKUP_DIR:\s*backupDir,[\s\S]*?\}\s*=\s*require\('\.\.\/backup-core'\)/);
    const backupCoreSrc = read('server', 'backup-core.js');
    expect(backupCoreSrc).toMatch(/const BACKUP_DIR = process\.env\.BACKUP_DIR[\s\S]*?path\.join\(__dirname,\s*'\.\.',\s*'backups'\)/);
    expect(backupCoreSrc).toMatch(/path\.resolve\(process\.env\.BACKUP_DIR\)/);
    expect(files.backupsRoute).toMatch(/router\.get\('\/admin\/backups\/:filename\/download',\s*requireAdminCompat/);
    expect(files.backupsRoute).toMatch(/const filename = path\.basename\(req\.params\.filename\)/);
  });

  // 迁移接口和系统级 VRChat 控制可探测环境或改写全局登录态，必须只有管理员能访问。
  // H-1 加固：迁移面（含 /migrate /replace-config）提升为仅超级管理员（requireSuperAdmin）。
  test('protects migration and system VRChat control routes', () => {
    expect(files.migrationRoute).toMatch(/router\.use\(requireSuperAdmin\)/);
    expect(files.migrationRoute).not.toMatch(/router\.use\(requireAdminCompat\)/);
    expect(files.vrcSystemRoute).toMatch(/router\.post\('\/login',\s*requireAdminCompat/);
    expect(files.vrcSystemRoute).toMatch(/router\.post\('\/2fa',\s*requireAdminCompat/);
    expect(files.vrcSystemRoute).toMatch(/router\.post\('\/logout',\s*requireAdminCompat/);
    expect(files.server).toMatch(/app\.use\('\/api\/migration',\s*adminLimiter\)/);
    expect(files.server).toMatch(/app\.use\('\/api',\s*vrcSystemRouter\)/);
  });

  // 系统 VRChat 登录/2FA 的 401 必须带 VRC_AUTH_FAILED 业务码：否则前端 api() 401 拦截器
  // 在 currentUser 已登录（超管在场）时会把"VRChat 账号密码没通过"误判成"本站会话过期"，
  // toast 登录状态已失效 + 1.5s 后强制登出。用户实测现象：后台登录系统 VRChat 账号 → 被踢回登录页。
  test('system VRChat login/2FA 401 carry VRC_AUTH_FAILED code', () => {
    const loginBlock = sliceBetween(files.vrcSystemRoute, "router.post('/login'", "router.post('/2fa'");
    const twoFaBlock = sliceBetween(files.vrcSystemRoute, "router.post('/2fa'", "router.post('/logout'");
    expect(loginBlock).toMatch(/fail\(res, 401, [\s\S]*code: ErrorCodes\.VRC_AUTH_FAILED/);
    expect(twoFaBlock).toMatch(/fail\(res, 401, [\s\S]*code: ErrorCodes\.VRC_AUTH_FAILED/);
  });

  // 管理、迁移、数据库等特权路由曾可能在 CSRF 中间件外；挂载顺序必须保证先校验 CSRF 再挂路由。
  // （CSRF 实现已抽至 middleware/csrf.js：server.js 只保留挂载点，豁免清单与会话绑定断言锚定到新模块。）
  test('keeps privileged routes inside CSRF protection', () => {
    expectBefore(files.server, 'const { csrfCleanupInterval } = setupCsrf(app);', "app.use('/api/auth', require('./routes/auth'))");
    expectBefore(files.server, 'const { csrfCleanupInterval } = setupCsrf(app);', "app.use('/api/migration', require('./routes/migration'))");
    expectBefore(files.server, 'const { csrfCleanupInterval } = setupCsrf(app);', "app.use('/api', require('./routes/database'))");
    expect(files.csrfMiddleware).toMatch(/app\.use\('\/api',\s*(?:async\s*)?\(req,\s*res,\s*next\) => \{/);
    const csrfBlock = sliceBetween(files.csrfMiddleware, 'const exemptPaths = [', 'const token = req.headers');
    expect(csrfBlock).not.toMatch(/admin|migration|database|backups|files|export|config/);
    expect(files.csrfMiddleware).toMatch(/record\.sid[\s\S]*!== req\.sessionID[\s\S]*CSRF token 与当前会话不匹配/);
    // P2-167：移除 'anon' 兜底记录——会话未初始化时 fail-closed 拒绝签发，
    // 校验分支不再豁免匿名记录（否则任意会话可复用同一 token 击穿整个 CSRF 防线）。
    expect(files.csrfMiddleware).not.toMatch(/'anon'/);
    expect(files.csrfMiddleware).toMatch(/!req\.sessionID[\s\S]*return fail\(res,\s*403,\s*'会话未初始化，无法获取 CSRF token'\)/);
    expect(files.csrfMiddleware).toMatch(/(?:!record\.sid\s*\|\||record\.sid !== req\.sessionID)[\s\S]*CSRF token 与当前会话不匹配/);
  });

  // Swagger 曾仅靠 NODE_ENV!=='production' 决定是否挂载——生产漏配 NODE_ENV 时
  // /api-docs 全量 API 文档（含管理端点与安全注解）无鉴权公开。现在必须显式 ENABLE_SWAGGER=1，
  // 且文档访问自身叠加 requireSuperAdmin（双保险）。
  test('swagger requires explicit enable + super-admin auth (P2-169)', () => {
    expect(files.server).toMatch(/if \(process\.env\.ENABLE_SWAGGER === '1'\)/);
    expect(files.server).not.toMatch(/NODE_ENV !== 'production'/);
    const swaggerSrc = read('server', 'swagger.js');
    expect(swaggerSrc).toMatch(/function setupSwagger\(app,\s*deps\s*=\s*\{\}\)/);
    expect(swaggerSrc).toMatch(/const guard = requireSuperAdmin \|\|/);
    expect(swaggerSrc).toMatch(/app\.use\('\/api-docs',\s*guard,/);
    expect(swaggerSrc).toMatch(/app\.get\('\/api-docs\.json',\s*guard,/);
  });

  // 注册限流 key 曾直接使用请求方可控的 email 原文——攻击者靠大小写/空格变换分裂
  // 无限 key 绕过 15 分钟 5 次注册上限。key 必须归一化（trim+lowercase+长度钳制），
  // 无 email 时回退纯 IP 维度（对齐 security.js 登录限流口径）。
  test('registerLimiter normalizes email key and falls back to IP (P2-168)', () => {
    expect(files.rateLimitMiddleware).toMatch(/keyGenerator:\s*normalizeRegisterKey/);
    expect(files.rateLimitMiddleware).toMatch(/String\(req\.body\?\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\)\.slice\(0,\s*254\)/);
    expect(files.rateLimitMiddleware).toMatch(/email \? `email:\$\{email\}` : ipKey\(req\)/);
  });

  // 运行时可变配置曾只钳下限不设上限：'1e999'→Infinity 写进缓存后 mbToBytes 返回 0，
  // 全部上传/请求 413（功能瘫痪）；大有限值则令请求体安全闸恒假（被静默禁用）。
  // 现在必须双向钳制 + 拒绝非有限数 + 字节阈值预计算。
  test('settings clamps both directions and rejects non-finite values (P2-170)', () => {
    const settingsSrc = read('server', 'settings.js');
    expect(settingsSrc).toMatch(/const CEILINGS = \{/);
    expect(settingsSrc).toMatch(/req_max_upload_mb:\s*1024/);
    expect(settingsSrc).toMatch(/Math\.min\(Math\.max\(value,\s*floor\),\s*ceiling\)/);
    expect(settingsSrc).toMatch(/Number\.isFinite\(raw\)\s*&&\s*raw\s*>\s*0/);
    expect(settingsSrc).toMatch(/let limitsCache = computeLimits\(\)/);
    expect(settingsSrc).toMatch(/function getLimits\(\) \{\s*return limitsCache;/);
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
    const putProfile = sliceBetween(files.usersProfileRoute, "router.put('/me/profile'", "router.post('/me/avatar'");
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
    const getProfile = sliceBetween(files.usersProfileRoute, "router.get('/me/profile'", "router.put('/me/profile'");
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

  // P1-1（条件触发项）：所有 express-rate-limit limiter 必须显式声明共享 store，
  // 否则回到 v8 默认 MemoryStore（进程内计数），多实例部署下限流语义失效。
  test('wires every rate limiter to the shared hybrid store', () => {
    const countLimiters = (source) => (source.match(/rateLimit\(\{/g) || []).length;
    const countStores = (source) => (source.match(/store:\s*hybridStore\(/g) || []).length;
    // P3-13（2026-09-15）为 /api/jtt 新增 jttLimiter，security 中间件 limiter 数 5→6
    expect(countLimiters(files.securityMiddleware)).toBe(6);
    expect(countStores(files.securityMiddleware)).toBe(countLimiters(files.securityMiddleware));
    expect(countLimiters(files.rateLimitMiddleware)).toBe(6);
    expect(countStores(files.rateLimitMiddleware)).toBe(countLimiters(files.rateLimitMiddleware));
    expect(files.chatRoute).toMatch(/joinGroupLimiter = rateLimit\(\{[\s\S]*?store: hybridStore\('chat-join-group'\)/);
    // createCustomLimiter 必须注入默认 store，且放在调用方 options 之前，允许显式覆盖
    expect(files.rateLimitMiddleware).toMatch(/const createCustomLimiter = \(\{ name, \.\.\.options \}\) => \{/);
    expectBefore(files.rateLimitMiddleware, 'store: hybridStore(`rate-custom-', '  ...options');
    expect(files.rateLimitMiddleware).not.toMatch(/new MemoryStore\(\)/);
    expect(files.securityMiddleware).not.toMatch(/new MemoryStore\(\)/);
  });

  // hybrid store 必须在「请求时」而不是构造时判断 Redis 可用性（initCache 是 fire-and-forget），
  // 并且 Redis 关闭/异常时必须回退到本地 MemoryStore，保持限流始终生效。
  test('keeps the hybrid store degradable when Redis is unavailable', () => {
    expect(files.rateLimitStore).toMatch(/const \{ MemoryStore \} = require\('express-rate-limit'\)/);
    expect(files.rateLimitStore).toMatch(/const cache = require\('\.\.\/cache'\)/);
    expect(files.rateLimitStore).toMatch(/this\.localKeys = false/);
    expect(files.rateLimitStore).toMatch(/this\.prefix = `\$\{KEY_PREFIX\}:\$\{this\.name\}:`/);
    expect(files.rateLimitStore).toMatch(/async increment\(key\) \{[\s\S]*?if \(cache\.isEnabled\(\)\)[\s\S]*?return this\.local\.increment\(key\)/);
    expect(files.rateLimitStore).toMatch(/async decrement\(key\) \{[\s\S]*?await this\.local\.decrement\(key\)/);
    expect(files.rateLimitStore).toMatch(/async get\(key\) \{[\s\S]*?return this\.local\.get\(key\)/);
    expect(files.rateLimitStore).toMatch(/async resetKey\(key\) \{[\s\S]*?await this\.local\.resetKey\(key\)/);
    // 可用性判定必须逐方法发生在请求时（P3-137 后共 5 处），否则启动后才连上的 Redis 永远不会被使用
    expect((files.rateLimitStore.match(/if \(cache\.isEnabled\(\)\)/g) || []).length).toBe(5);
    // v8 校验：同一 store 实例不得跨 limiter 复用，工厂必须每次新建实例
    expect(files.rateLimitStore).toMatch(/function hybridStore\(name\) \{[\s\S]*?return new HybridStore\(/);
    expect(files.rateLimitStore).not.toMatch(/registry\.get\(base\)\s*\?\?\s*new HybridStore/);
    // Redis 计数键必须带 TTL，避免窗口结束后键常驻
    expect(files.rateLimitStore).toMatch(/Math\.ceil\(this\.windowMs \/ 1000\)/);
    expect(files.cacheLib).toMatch(/async function incr\(key, ttlSeconds\)/);
    expect(files.cacheLib).toMatch(/NX:\s*true,\s*EX:\s*ttl/);
    expect(files.cacheLib).toMatch(/isEnabled = false/);
    expect(files.cacheLib).toMatch(/async function closeCache\(\)/);
    expect(files.cacheLib).toMatch(/exports = \{[\s\S]*incr,[\s\S]*closeCache,/);
  });

  // P3-137：resetAll 必须同时清理 Redis 分支计数（按 store 前缀批量删），
  // 否则管理侧「一键重置限流」在 Redis 模式下永不生效。
  test('P3-137 resetAll clears Redis-branch counters by prefix', () => {
    expect(files.rateLimitStore).toMatch(/async resetAll\(\) \{[\s\S]*?if \(cache\.isEnabled\(\)\)[\s\S]*?const pattern = `\$\{this\.prefix\}\*`;[\s\S]*?cache\.keys\(pattern\)[\s\S]*?cache\.del\(k\)[\s\S]*?await this\.local\.resetAll\(\)/);
  });

  // P3-138：decrement 必须原子（单条 Lua decrBy），杜绝 get-then-set 竞态少减，
  // 且 Redis 异常仍需回退本地（限流不因缓存故障失效）。
  test('P3-138 decrement is atomic via cache.decrBy', () => {
    expect(files.rateLimitStore).toMatch(/async decrement\(key\) \{[\s\S]*?cache\.decrBy\([\s\S]*?if \(total !== null\) return;[\s\S]*?await this\.local\.decrement\(key\)/);
    expect(files.cacheLib).toMatch(/async function decrBy\(key, ttlSeconds\)/);
    expect(files.cacheLib).toMatch(/redisClient\.eval\(DECRBY_SCRIPT, \{ keys: \[key\], arguments: \[String\(ttl\)\] \}\)/);
    expect(files.cacheLib).toMatch(/exports = \{[\s\S]*\bdecrBy,/);
  });

  // P3-139：loginLimiter/bruteForceLimiter 死代码已删（bruteForce key 拼入用户可控
  // req.path，一旦接上可拆分成独立桶绕过次数限制）；无调用方的 cache 引用同步清除。
  test('P3-139 dead loginLimiter/bruteForceLimiter removed from rate_limit.js', () => {
    expect(files.rateLimitMiddleware).not.toMatch(/const loginLimiter = rateLimit/);
    expect(files.rateLimitMiddleware).not.toMatch(/const bruteForceLimiter = \{/);
    expect(files.rateLimitMiddleware).not.toMatch(/bruteforce:\$\{ipKey/);
    expect(files.rateLimitMiddleware).not.toMatch(/require\('\.\.\/cache'\)/);
  });

  // P3-140：uploads_auth 分享校验短 TTL 缓存（防有效码拼路径放大 DB 查询），
  // /uploads 静态媒体按 IP 限流且挂在鉴权之前（未登录刷量同样受限）。
  test('P3-140 uploads share verification cached and /uploads rate-limited', () => {
    expect(files.uploadsAuth).toMatch(/SHARE_VERIFY_TTL_MS = 15 \* 1000/);
    expect(files.uploadsAuth).toMatch(/const cached = getShareVerifyCached\(cacheKey\);/);
    expect(files.uploadsAuth).toMatch(/setShareVerifyCached\(cacheKey, result\)/);
    expect(files.uploadsAuth).toMatch(/shareVerifyCache\.set\(key, \{ \.\.\.value, at: Date\.now\(\) \}\)/);
    expect(files.rateLimitMiddleware).toMatch(/uploadsStaticLimiter = rateLimit\(\{/);
    expect(files.rateLimitMiddleware).toMatch(/store: hybridStore\('rate-uploads-static'\)/);
    expectBefore(files.server, "app.use('/uploads', uploadsStaticLimiter);", 'setupUploadsAuth(app);');
  });

  // P3-141：image_compress 死代码模块已删除（全库无调用方，接入即覆盖 multer 原文件）
  test('P3-141 image_compress dead module removed', () => {
    expect(fs.existsSync(path.join(repoRoot, 'server', 'middleware', 'image_compress.js'))).toBe(false);
  });

  // P3-142：video_utils 缩略图改「临时文件 + JPEG 魔数校验 + 内容指纹命名」——
  // 超时半成品不落定、损坏图不复用、长名截断不互相覆盖。
  test('P3-142 video thumbnails validated and collision-safe', () => {
    expect(files.videoUtils).toMatch(/function isValidJpeg\(filePath\)/);
    expect(files.videoUtils).toMatch(/head\[0\] === 0xff && head\[1\] === 0xd8 && head\[2\] === 0xff/);
    expect(files.videoUtils).toMatch(/tmpPath = `\$\{thumbPath\}\.tmp`/);
    expect(files.videoUtils).toMatch(/fs\.renameSync\(tmpPath, thumbPath\)/);
    expect(files.videoUtils).toMatch(/function videoContentDigest\(videoInputPath\)/);
    expect(files.videoUtils).toMatch(/const thumbName = `thumb_\$\{baseName\}_\$\{videoContentDigest\(videoInputPath\)\}\.jpg`/);
  });

  // P3-143：未知版本前缀 /api/v\d+ 必须 400 显式失败，不得静默回退 v1；
  // 仅裸 /api（无版本段）路径回退默认版本。
  test('P3-143 unknown API version prefix rejected with 400', () => {
    expect(files.apiVersion).toMatch(/} else \{[\s\S]*?const unknown = req\.path\.match/);
    expect(files.apiVersion).toMatch(/不支持的 API 版本/);
    expect(files.apiVersion).toMatch(/支持版本：v1、v2/);
  });

  // P1-1：CSRF token 必须本地 Map + Redis 双写，Redis 仅为跨实例共享副本，
  // 未配置或异常时行为与迁移前一致（本地 Map 为权威副本）。
  test('dual-writes CSRF tokens to Redis with a local authoritative copy', () => {
    expect(files.csrfMiddleware).toMatch(/const cache = require\('\.\.\/cache'\)/);
    expect(files.csrfMiddleware).toMatch(/async function csrfStoreSet\(token, record\) \{\s*csrfTokens\.set\(token, record\);\s*if \(!cache\.isEnabled\(\)\) return;/);
    expect(files.csrfMiddleware).toMatch(/async function csrfStoreGet\(token\) \{\s*const local = csrfTokens\.get\(token\);\s*if \(local\) return local;/);
    expect(files.csrfMiddleware).toMatch(/csrfTokens\.set\(token, shared\)/);
    expect(files.csrfMiddleware).toMatch(/const record = token \? await csrfStoreGet\(token\) : null/);
    expect(files.csrfMiddleware).toMatch(/await csrfStoreDelete\(token\)/);
    expect(files.csrfMiddleware).toMatch(/await cache\.del\(csrfRedisKey\(token\)\)/);
    expect(files.csrfMiddleware).toMatch(/CSRF_KEY_PREFIX = 'csrf:'/);
    expect(files.csrfMiddleware).toMatch(/TTL[\s\S]*CSRF_EXPIRY_SECONDS|cache\.set\(csrfRedisKey\(token\), record, CSRF_EXPIRY_SECONDS\)/);
    // 清理定时器仍须负责本地 Map，避免只依赖 Redis TTL 造成内存增长
    expect(files.csrfMiddleware).toMatch(/for \(const \[token, record\] of csrfTokens\) \{/);
  });

  // 缓存门面必须透传 del，否则 posts.js 的写后失效会抛 TypeError；优雅关闭须释放 Redis 连接。
  test('exposes cache invalidation passthrough and releases Redis on shutdown', () => {
    expect(files.cacheService).toMatch(/async function del\(key\) \{\s*await cache\.del\(key\);\s*\}/);
    expect(files.cacheService).toMatch(/exports = \{[\s\S]*\bdel,\n[\s\S]*clearAll,/);
    expect(files.postsRoute).toMatch(/await cacheService\.del\(/);
    expect(files.server).toMatch(/await cache\.closeCache\(\)/);
    expectBefore(files.server, 'startSchedule.gracefulShutdown()', 'await cache.closeCache()');
  });

  // ==================== P3-110~124 第六批后端 ====================
  test('P3-110/111 masks system_config & .env URL-embedded credentials on read', () => {
    expect(files.adminRoute).toMatch(/CONFIG_MASK = '__MASKED__'/);
    expect(files.adminRoute).toMatch(/config\[row\.configKey\] = maskConfigValue\(row\.configKey, row\.configValue\)/);
    expect(files.adminRoute).toMatch(/if \(val === CONFIG_MASK\) continue/);
    expect(files.envConfigRoute).toMatch(/config\[envKey\] = maskEnvValue\(envKey, value\)/);
    expect(files.envConfigRoute).toMatch(/userinfo/);
  });

  test('P3-112/113 clamps analytics days, hides internal network, drops e.message on anon search', () => {
    expect(files.analyticsRoute).toMatch(/Math\.min\(365, Math\.max\(1, parseInt\(req\.query\.days, 10\) \|\| 7\)\)/);
    expect(files.analyticsRoute).toMatch(/egress: egressAddresses\(os\.networkInterfaces\(\)\)/);
    expect(files.collectionsRoute).toMatch(/模型搜索失败，请稍后重试/);
    expect(files.collectionsRoute).toMatch(/世界搜索失败，请稍后重试/);
    expect(files.collectionsRoute).toMatch(/世界排行失败，请稍后重试/);
    expect(files.collectionsRoute).toMatch(/logger\.error\('\[collections\/search-models\]', e\)/);
  });

  test('P3-114~116 chat filters deleted DM + excludes own/pre-join unread + protects owner from kick', () => {
    expect(files.chatRoute).toMatch(/AND deleted_at IS NULL GROUP BY other_id/);
    expect(files.chatRoute).toMatch(/WHERE m\.deleted_at IS NULL/);
    expect(files.chatRoute).toMatch(/m\.sender_id <> \? AND m\.created_at >= gm\.joined_at/);
    expect(files.chatRoute).toMatch(/不能踢出群主/);
  });

  test('P3-117~118 admin users pagination cap + name-change race hardening', () => {
    expect(files.adminUsersRoute).toMatch(/defaultSize: 20, maxSize: 100/);
    expect(files.adminUsersRoute).toMatch(/显示名不能超过50字/);
    expect(files.adminUsersRoute).toMatch(/邮箱格式不正确/);
    expect(files.adminNameChangeRoute).toMatch(/status='pending' FOR UPDATE/);
    expect(files.adminNameChangeRoute).toMatch(/目标显示名已被他人占用，已拒绝/);
    expect(files.adminNameChangeRoute).toMatch(/WHERE id=\? AND status='pending'/);
  });

  test('P3-119~124 avatar XFF trust, posts like txn, moderation atomic flip, field clamps, setup relay guard', () => {
    expect(files.avatarRoute).toMatch(/isLoopbackPeer[\s\S]*?x-forwarded-for/);
    expect(files.postsRoute).toMatch(/INSERT INTO post_like[\s\S]*ON DUPLICATE KEY UPDATE/);
    expect(files.postsRoute).toMatch(/ins\.affectedRows === 1/);
    expect(files.moderationsRoute).toMatch(/WHERE id = \? AND status = \?/);
    expect(files.moderationsRoute).toMatch(/upd\.affectedRows === 0/);
    expect(files.usersRoute).toMatch(/显示名不能超过50字/);
    expect(files.usersProfileRoute).toMatch(/location\.length > 200/);
    expect(files.setupRoute).toMatch(/testEmailLimited\(srcIp\)/);
    expect(files.setupRoute).toMatch(/收发件邮箱格式不正确/);
    expect(files.setupRoute).toMatch(/邮件发送失败，请检查 SMTP 配置后在日志定位问题/);
    expect(files.setupRoute).not.toMatch(/邮件发送失败：' \+ \(result\.error/);
  });

  // ==== VRChat 头像链路修复（2026-10-05） ====
  // 实测：api.vrchat.com/api/1/users/{id}/image 已是死链（307 后 api.vrchat.cloud 返回 404）；
  // assets.amlcdn.com 在国内多数网络 TLS 层即被阻断（回源约 19s 超时）→ 群成员头像大面积不显示。
  // 修复：后端新增 /api/avatar/user 按 ID 解析真实头像（系统账号 cookie + 缓存 + 限速 + 并发去重），
  // 前端死链兜底改走该接口，amlcdn 历史缩略图 URL 不再直连。
  describe('VRChat 头像可显示链路回归', () => {
    test('avatar.js 提供 /api/avatar/user：校验 usr_ ID、302 到 /proxy 复用缓存链路', () => {
      expect(files.avatarRoute).toMatch(/router\.get\('\/user'/);
      expect(files.avatarRoute).toMatch(/VRC_UID_PATTERN = \/\^usr_\[0-9a-fA-F-\]\+\$\/;/);
      expect(files.avatarRoute).toMatch(/res\.redirect\(302, '\/api\/avatar\/proxy\?u=' \+ encodeURIComponent/);
      expect(files.avatarRoute).toMatch(/authStateRef\.cookie/);
      expect(files.avatarRoute).toMatch(/USER_AVATAR_RATE_MIN/);
      expect(files.avatarRoute).toMatch(/userAvatarRateLimited\(clientIp\)/);
      expect(files.avatarRoute).toMatch(/vrchatGetUser/);
    });

    test('avatar 路由不再允许直连 api.vrchat.com/users/{id}/image 死链', () => {
      expect(files.groupJs).not.toMatch(/api\.vrchat\.com\/api\/1\/users\//);
    });

    test('group.js 无头像兜底走 /api/avatar/user，amlcdn 历史缩略图跳过直连', () => {
      expect(files.groupJs).toMatch(/vrcFallback = `\/api\/avatar\/user\?u=/);
      expect(files.groupJs).toMatch(/assets\\\.amlcdn\\\.com/);
      expect(files.groupJs).toMatch(/VRCX 风格：DB 无头像/);
    });

    test('map.js mapAvatarSrc 支持按 ID 兜底解析、amlcdn URL 改道', () => {
      expect(files.mapJs).toMatch(/function mapAvatarSrc\(url, uid\)/);
      expect(files.mapJs).toMatch(/assets\\\.amlcdn\\\.com/);
      expect(files.mapJs).toMatch(/\/api\/avatar\/user\?u=/);
    });

    test('server.js 挂载 avatar 路由时传入 authState（供 /api/avatar/user 使用系统会话）', () => {
      expect(files.server).toMatch(/require\('\.\/routes\/avatar'\)\(authState\)/);
    });
  });

  // ==== 页面空闲冻结/解冻（2026-10-05） ====
  // 需求：网站 2 分钟无操作进入「冻结」态，暂停后台轮询/WebSocket 心跳以节约带宽与内存；
  // 用户任意交互立即解冻并恢复轮询与实时连接。freeze.js 为唯一空闲检测来源，
  // 各业务模块（main/group/map/theme/home/chat/auth）注册回调统一被冻结/解冻。
  describe('页面空闲冻结/交互解冻回归', () => {
    test('freeze.js 暴露 window.__freeze（isFrozen/register）并采用捕获阶段监听', () => {
      expect(files.freezeJs).toMatch(/window\.__freeze = \{/);
      expect(files.freezeJs).toMatch(/isFrozen: function/);
      expect(files.freezeJs).toMatch(/register: function \(entry\)/);
      expect(files.freezeJs).toMatch(/capture: true, passive: true/);
      expect(files.freezeJs).toMatch(/IDLE_MS = 2 \* 60 \* 1000/);
      expect(files.freezeJs).toMatch(/site-frozen/);
      expect(files.freezeJs).toMatch(/page:freeze/);
      expect(files.freezeJs).toMatch(/page:unfreeze/);
    });

    test('index.html 中 freeze.js 先于 theme/auth/main 加载（注册回调时 __freeze 已就绪）', () => {
      expectBefore(files.indexHtml, 'js/freeze.js?v=20261005a', 'js/theme.js?v=20261005a');
      expectBefore(files.indexHtml, 'js/freeze.js?v=20261005a', 'js/auth.js?v=20261005b');
      expectBefore(files.indexHtml, 'js/freeze.js?v=20261005a', 'js/main.js?v=20261005b');
      expect(files.indexHtml).toMatch(/loader\.js\?v=20261005e/);
    });

    test('main.js 冻结时暂停刷新轮询与断开 WebSocket，解冻恢复；轮询带冻结守卫', () => {
      expect(files.mainJs).toMatch(/let refreshTimer = null;/);
      expect(files.mainJs).toMatch(/let _initialRefreshTimer = null;/);
      expect(files.mainJs).toMatch(/window\.__freeze\.isFrozen\(\)\) return; \/\/ 空闲冻结期间不发起轮询/);
      expect(files.mainJs).toMatch(/onFreeze: function \(\) \{[\s\S]*?disconnectWebSocket\(\);[\s\S]*?wsEverOpened = true;/);
      expect(files.mainJs).toMatch(/onUnfreeze: function \(\) \{[\s\S]*?scheduleRefresh\(\);[\s\S]*?connectWebSocket\(\);/);
    });

    test('group.js 冻结停轮询，解冻仅在 vrc Tab 恢复', () => {
      expect(files.groupJs).toMatch(/onFreeze: function \(\) \{ stopGroupPolling\(\); \}/);
      expect(files.groupJs).toMatch(/activeTab === 'vrc' && typeof loadGroupStats === 'function'\) startGroupPolling\(\);/);
    });

    test('map.js 封装位置上报循环并注册冻结回调（清扫 + GPS 上报）', () => {
      expect(files.mapJs).toMatch(/function startLocationReportLoop\(\)/);
      expect(files.mapJs).toMatch(/function stopLocationReportLoop\(\)/);
      expect(files.mapJs).toMatch(/onFreeze: function \(\) \{[\s\S]*?stopLocationReportLoop\(\);/);
      expect(files.mapJs).toMatch(/onUnfreeze: function \(\) \{[\s\S]*?startLocationReportLoop\(\);/);
    });

    test('theme/home/chat/auth 均注册冻结回调（低频定时器与粒子 rAF 可暂停恢复）', () => {
      expect(files.themeJs).toMatch(/window\.__freeze\.register\(\{[\s\S]*?_themeScheduleTimer[\s\S]*?config\.mode === 'auto'/);
      expect(files.homeJs).toMatch(/let _greetingTimer = null;/);
      expect(files.homeJs).toMatch(/window\.__freeze\.register\(\{[\s\S]*?_greetingTimer[\s\S]*?updateGreeting\(\);/);
      expect(files.chatJs).toMatch(/window\.__freeze\.register\(\{[\s\S]*?stopGroupLocSweep\(\);[\s\S]*?startGroupLocSweep\(\);/);
      expect(files.authJs).toMatch(/window\._resumeLoginParticles = function/);
      expect(files.authJs).toMatch(/window\.__freeze\.register\(\{[\s\S]*?_particleAnimId[\s\S]*?_resumeLoginParticles/);
    });
  });

  // ==== 屏幕共享防回音（2026-10-05） ====
  // 回音环路：对端外放桌面音频 → 本机麦克风再采集 → 回传环形。修复分两层：
  // 麦克风采集统一开启 AEC；屏幕共享的桌面音频轨由信令标记识别、接收端默认静音，
  // 提供"共享声音"开关按需开启。
  describe('屏幕共享防回音回归', () => {
    test('麦克风采集统一启用回音消除（RTC_AUDIO 常量，4 处 getUserMedia 全量替换）', () => {
      expect(files.chatJs).toMatch(/const RTC_AUDIO = \{ echoCancellation: true, noiseSuppression: true, autoGainControl: true \};/);
      const uses = files.chatJs.match(/getUserMedia\(\{ audio: RTC_AUDIO/g) || [];
      expect(uses.length).toBeGreaterThanOrEqual(4);
      expect(files.chatJs).not.toMatch(/getUserMedia\(\{ audio: true/);
    });

    test('屏幕共享发送端在 offer 信令携带 screenStreamId（私聊 + 群语音房）', () => {
      expect(files.chatJs).toMatch(/screenShare: !!\(aTrack\), screenStreamId: aTrack \? screenStream\.id : null/);
      expect(files.chatJs).toMatch(/screenShare: false, screenStreamId: null/);
    });

    test('接收端 onTrack 识别桌面音频轨并默认静音（track.enabled = false）/防回音核心', () => {
      expect(files.chatJs).toMatch(/inv\.screenStreamId && stream\.id === inv\.screenStreamId/);
      expect(files.chatJs).toMatch(/e\.track\.enabled = !!(inv\.screenAudioEnabled)/);
      expect(files.chatJs).toMatch(/room\.screenStreamIds\[uid\] && stream\.id === room\.screenStreamIds\[uid\]/);
      expect(files.chatJs).toMatch(/e\.track\.enabled = !!room\.screenAudioEnabled/);
    });

    test('提供"共享声音"开关（私聊 + 群）与未共享时的提示', () => {
      expect(files.chatJs).toMatch(/rtcScreenAudioBtn/);
      expect(files.chatJs).toMatch(/rtcGroupScreenAudioBtn/);
      expect(files.chatJs).toMatch(/rtc\.share_screen_first/);
      expect(files.chatJs).toMatch(/rtc\.screen_audio_tip/);
    });

    test('中文语言包补齐 4 个防回音文案 key', () => {
      expect(files.zhLang).toMatch(/"rtc\.screen_audio"/);
      expect(files.zhLang).toMatch(/"rtc\.screen_audio_on"/);
      expect(files.zhLang).toMatch(/"rtc\.share_screen_first"/);
      expect(files.zhLang).toMatch(/"rtc\.screen_audio_tip"/);
    });

    test('桌面音频轨挂载输出 sink（无私聊/群路由则开关无声）：routeScreenAudioTrack/routeGroupScreenAudioTrack', () => {
      expect(files.chatJs).toMatch(/function routeScreenAudioTrack\(elId, track\)/);
      expect(files.chatJs).toMatch(/routeScreenAudioTrack\('rtcScreenAudioOut', e\.track\)/);
      expect(files.chatJs).toMatch(/<audio id="rtcScreenAudioOut" autoplay playsinline class="rtc-hidden"><\/audio>/);
      expect(files.chatJs).toMatch(/function routeGroupScreenAudioTrack\(uid, track\)/);
      expect(files.chatJs).toMatch(/rtcGroupScreenAudioOut_' \+ uid/);
      expect(files.chatJs).toMatch(/bar\.appendChild\(el\)/);
    });

    test('对端停止共享时私聊按钮立即复位；群成员离开清理屏幕共享残留', () => {
      // 私聊复位分支（!inv.screenShareActive）必须同步更新按钮，否则按钮残留"共享中"
      expect(files.chatJs).toMatch(/inv\.screenAudioEnabled = false;\s*inv\.screenAudioTracks = \[\];\s*updateScreenAudioBtn\(\);/);
      // 群成员离开：删除 screenStreamIds/screenShareBy/screenAudioTracksByUid 并移除输出元素
      expect(files.chatJs).toMatch(/delete room\.screenStreamIds\[uid\];/);
      expect(files.chatJs).toMatch(/delete room\.screenShareBy\[uid\];/);
      expect(files.chatJs).toMatch(/delete room\.screenAudioTracksByUid\[uid\];/);
      expect(files.chatJs).toMatch(/rtcGroupScreenAudioOut_' \+ uid/);
    });
  });
});
