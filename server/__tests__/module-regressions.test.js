/**
 * 境途同游模块回归静态守卫：只读取源码，不启动服务或连接数据库。
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const serverRoot = path.join(__dirname, '..');

function readRepo(...parts) {
  return fs.readFileSync(path.join(repoRoot, ...parts), 'utf8');
}

function readServer(...parts) {
  return fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');
}

function extractFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  if (!match) throw new Error(`Function ${name} not found`);
  const start = match.index;
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let i = match.index; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Function ${name} was not closed`);
}

function extractDirective(source, directive) {
  const matches = [...source.matchAll(new RegExp(`${directive}\\s+([^;\"]+)`, 'g'))];
  const match = matches.find(m => m[1].includes("'self'")) || matches[0];
  if (!match) throw new Error(`CSP directive ${directive} not found`);
  return match[1].trim().split(/\s+/);
}

describe('map module regressions', () => {
  const mapJs = () => readRepo('public', 'js', 'map.js');
  const usersRoute = () => readServer('routes', 'users.js');
  // P2-66 god-route 拆分：/me/profile、/me/location 等资料域路由已按域拆至 users_profile.js，守卫随实现迁移
  const usersProfileRoute = () => readServer('routes', 'users_profile.js');

  // 防止 Leaflet 再次只依赖公共 CDN，弱网或 CDN 被拦时地图会不可用。
  test('Leaflet is vendored locally so the map does not depend on public CDNs', () => {
    expect(fs.existsSync(path.join(repoRoot, 'public', 'vendor', 'leaflet', 'leaflet.js'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'public', 'vendor', 'leaflet', 'leaflet.css'))).toBe(true);
    const indexHtml = readRepo('public', 'index.html');
    expect(indexHtml).not.toMatch(/https?:\/\/(?:unpkg|cdnjs|cdn\.jsdelivr)\.com\/[^"']*leaflet/i);
    expect(mapJs()).toEqual(expect.stringContaining('/vendor/leaflet/leaflet.js'));
    expect(mapJs()).toEqual(expect.stringContaining('/vendor/leaflet/leaflet.css'));
  });

  // 防止动态加载顺序退回 CDN 优先，本地副本必须先于远程兜底尝试。
  test('map.js loads the local Leaflet copy before any remote fallback', () => {
    const source = mapJs();
    const localJs = source.indexOf("'/vendor/leaflet/leaflet.js'");
    const remoteJs = source.indexOf("'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'");
    const localCss = source.indexOf("'/vendor/leaflet/leaflet.css'");
    const remoteCss = source.indexOf("'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'");
    expect(localJs).toBeGreaterThanOrEqual(0);
    expect(remoteJs).toBeGreaterThan(localJs);
    expect(localCss).toBeGreaterThanOrEqual(0);
    expect(remoteCss).toBeGreaterThan(localCss);
  });

  // 防止 CSP 只放行 Leaflet 样式或脚本之一，导致地图资源加载不完整。
  test('CSP script-src and style-src stay consistent for third-party origins', () => {
    const serverJs = readServer('server.js');
    const scriptOrigins = extractDirective(serverJs, 'script-src').filter(v => v.startsWith('https://'));
    const styleOrigins = extractDirective(serverJs, 'style-src').filter(v => v.startsWith('https://'));
    expect(scriptOrigins).toContain('https://unpkg.com');
    expect(styleOrigins).toContain('https://unpkg.com');
    const nonFontStyleOrigins = styleOrigins.filter(origin => !origin.includes('fonts.googleapis.com'));
    expect(scriptOrigins).toEqual(expect.arrayContaining(nonFontStyleOrigins));
  });

  // 防止 WebSocket 位置更新只广播不落库，刷新后 /all/locations 读不到坐标。
  test('WebSocket location updates are persisted instead of broadcast-only', () => {
    const ws = readServer('ws_service.js');
    const handleUpdate = extractFunction(ws, 'handleLocationUpdate');
    const persistLocation = extractFunction(ws, 'persistLocation');
    expect(handleUpdate).toMatch(/persistLocation\(userId,\s*lat,\s*lng\)/);
    expect(handleUpdate).toMatch(/broadcastAllExcept\(ws,\s*\{\s*type:\s*['"]location:update['"]/s);
    expect(handleUpdate.indexOf('persistLocation(userId, lat, lng)')).toBeLessThan(handleUpdate.indexOf('broadcastAllExcept'));
    expect(persistLocation).toMatch(/UPDATE\s+users\s+SET\s+lat\s*=\s*\?,\s*lng\s*=\s*\?,\s*location_updated_at\s*=\s*NOW\(\)/i);
    expect(persistLocation).toMatch(/WHERE\s+id\s*=\s*\?\s+AND\s+location_visible\s*=\s*1/i);
  });

  // 防止前端把 visible 发给 /me/profile；真正会写 location_visible 的端点是 /me/location。
  test('map uses the location endpoint that actually accepts a visibility flag', () => {
    const source = mapJs();
    expect(source).toMatch(/api\(['"]\/api\/users\/me\/location['"],\s*\{\s*method:\s*['"]PUT['"],\s*body:\s*\{\s*visible:\s*true\s*\}/s);
    expect(source).toMatch(/api\(['"]\/api\/users\/me\/location['"],\s*\{\s*method:\s*['"]PUT['"],\s*body:\s*\{\s*visible:\s*false\s*\}/s);
    expect(source).not.toMatch(/\/api\/users\/me\/profile[^\n]+locationVisible/);
    const route = usersProfileRoute();
    expect(route).toMatch(/router\.put\(['"]\/me\/location['"]/);
    expect(route).toMatch(/const\s+\{\s*lat,\s*lng,\s*location,\s*visible\s*\}\s*=\s*req\.body/);
    expect(route).toMatch(/updates\.location_visible\s*=\s*visible\s*\?\s*1\s*:\s*0/);
  });

  // 防止 /all/locations 返回 snake_case 或缺字段，前端标记读取不到 displayName/avatarUrl 等字段。
  test('/api/users/all/locations returns the field names the map reads', () => {
    const mapSource = mapJs();
    ['id', 'displayName', 'avatarUrl', 'location', 'lat', 'lng', 'locationUpdatedAt', 'timestamp'].forEach(field => {
      expect(mapSource).toMatch(new RegExp(`\\.${field}|\\[['\"]${field}['\"]\\]`));
    });
    const route = usersRoute();
    const locationsRoute = route.slice(route.indexOf("router.get('/all/locations'"), route.indexOf("router.get('/search'"));
    expect(locationsRoute).toMatch(/WHERE\s+location_visible\s*=\s*1\s+AND\s+lat\s+IS\s+NOT\s+NULL\s+AND\s+lng\s+IS\s+NOT\s+NULL/i);
    ['id', 'displayName', 'name', 'avatarUrl', 'location', 'lat', 'lng', 'locationUpdatedAt', 'timestamp'].forEach(field => {
      expect(locationsRoute).toMatch(new RegExp(`${field}\\s*:`));
    });
    expect(locationsRoute).toMatch(/res\.json\(\{\s*markers,\s*count:/);
  });

  // 防止 PUT /me/location 接受 NaN/越界坐标，或更新坐标时不记录更新时间。
  test('PUT /me/location validates coordinates and records a timestamp', () => {
    // P2-66：/me/location 是 users_profile.js 的末条路由，原结束锚点 /:userId/photos 留在壳内，
    // 改为从起始锚点切到文件末尾（断言均为该路由内正向 needle，不依赖边界排除）。
    const route = usersProfileRoute();
    const locationRoute = route.slice(route.indexOf("router.put('/me/location'"));
    expect(locationRoute).toMatch(/parseFloat\(lat\)/);
    expect(locationRoute).toMatch(/!Number\.isFinite\(v\)\s*\|\|\s*v\s*<\s*-90\s*\|\|\s*v\s*>\s*90/);
    expect(locationRoute).toMatch(/parseFloat\(lng\)/);
    expect(locationRoute).toMatch(/!Number\.isFinite\(v\)\s*\|\|\s*v\s*<\s*-180\s*\|\|\s*v\s*>\s*180/);
    expect(locationRoute).toMatch(/updates\.location_updated_at\s*=\s*new\s+Date\(\)/);
    expect(locationRoute).toMatch(/UPDATE\s+users\s+SET\s+\$\{fields\},\s*updated_at\s*=\s*NOW\(\)\s+WHERE\s+id\s*=\s*\?/);
  });

  // 防止清理离线标记时复制硬编码毫秒数，常量调整后清理逻辑不同步。
  test('stale markers are swept using the declared timeout constant', () => {
    const source = mapJs();
    expect(source).toMatch(/const\s+LOCATION_STALE_TIMEOUT\s*=\s*120000\s*;/);
    const sweep = extractFunction(source, 'sweepStaleMarkers');
    expect(sweep).toMatch(/now\s*-\s*markerLastSeen\[uid\]\s*>\s*LOCATION_STALE_TIMEOUT/);
    expect(sweep).not.toMatch(/120000|30\s*\*\s*1000|60000/);
    expect(sweep).toMatch(/removeLocationMarker\(uid\)/);
  });
});

describe('permission module regressions', () => {
  // P2-3 双写下线：旧版 user_permissions 写入路由已整体移除，
  // 防止旧路由或旧 upsert SQL 被无意恢复，与权限组写侧形成新的双写。
  // P2-4 第三批拆分：守卫范围扩展到 admin.js 拆出的三个按域子模块。
  test('legacy user_permissions write routes stay retired from admin router family', () => {
    const files = ['routes/admin.js', 'routes/admin_users.js', 'routes/admin_name_change.js', 'routes/admin_content_live.js'];
    for (const rel of files) {
      const src = readServer(...rel.split('/'));
      expect(src).not.toMatch(/router\.(get|post)\(\s*['"]\/permissions/);
      expect(src).not.toMatch(/INSERT INTO user_permissions/);
    }
  });

  // 遗留表保留为历史快照：db_init 仍建表（含唯一键），权限查看器 legacy 展示仍 SELECT 它。
  // 若未来要 DROP 该表，必须先移除 permissions.js 的 legacy 展示块，两处需联动。
  test('user_permissions table is retained as a read-only snapshot for the viewer', () => {
    const dbInit = readServer('db_init.js');
    const createTable = dbInit.match(/CREATE TABLE IF NOT EXISTS user_permissions \([\s\S]*?\) ENGINE=InnoDB/)[0];
    expect(createTable).toMatch(/UNIQUE\s+KEY\s+uk_user_permission\s*\(user_id,\s*permission\)/i);
    const viewer = readServer('routes', 'permissions.js');
    expect(viewer).toMatch(/SELECT\s+permission,\s*granted\s+FROM\s+user_permissions\s+WHERE\s+user_id\s*=\s*\?/);
  });
});

describe('album module regressions', () => {
  // 防止相册详情页发送 ?album= 后端却只读取 ?cate，导致返回全量照片。
  test('album photo listing honours the album query parameter sent by the client', () => {
    const client = readRepo('public', 'js', 'album.js');
    expect(client).toMatch(/\/api\/album\/photos\?album=\$\{albumId\}&page=\$\{albumPage\}/);
    const route = readServer('routes', 'album.js');
    const listing = route.slice(route.indexOf("router.get('/album/photos'"), route.indexOf('// ==================== 创建照片记录'));
    expect(listing).toMatch(/const\s+albumId\s*=\s*parseInt\(req\.query\.album\)\s*\|\|\s*0/);
    expect(listing).toMatch(/if\s*\(albumId\s*>\s*0\)\s*\{\s*where\s*\+=\s*['"]\s+AND p\.cate_id=\?['"];\s*params\.push\(albumId\);\s*\}/);
    expect(listing).toMatch(/SELECT COUNT\(\*\) as c FROM album_photo p WHERE \$\{where\}/);
  });
});

describe('posts module regressions', () => {
  const postsJs = () => readRepo('public', 'js', 'posts.js');

  // 防止 api() 返回 400/404 时不抛错，点赞乐观 UI 不回滚。
  test('optimistic like updates roll back on non-2xx responses', () => {
    const toggleLike = extractFunction(postsJs(), 'togglePostLike');
    expect(toggleLike).toMatch(/function\s+rollbackLike\s*\(\)\s*\{/);
    expect(toggleLike).toMatch(/api\(['"]\/api\/posts\/['"]\s*\+\s*postId\s*\+\s*['"]\/like['"]/);
    expect(toggleLike).toMatch(/\.then\(function\(res\)\s*\{\s*if\s*\(!res\.ok\)\s*\{[\s\S]*?rollbackLike\(\);[\s\S]*?\}\s*\}\)/);
    expect(toggleLike).toMatch(/\.catch\(function\(err\)\s*\{[\s\S]*?rollbackLike\(\);[\s\S]*?\}\)/);
    expect(toggleLike).toMatch(/likeBtn\.classList\.(?:add|remove)\(['"]active['"]\)/);
    expect(toggleLike).toMatch(/likeCountEl\.setAttribute\(['"]data-like-count['"],\s*newCount\)/);
  });

  // 防止评论回滚引用 try/if 块内 const，失败路径因 ReferenceError 无法移除乐观评论。
  test('optimistic comment updates roll back without a scoping error', () => {
    const submitComment = extractFunction(postsJs(), 'submitPostComment');
    const declaration = submitComment.indexOf('let newComment = null');
    const previewBlock = submitComment.indexOf('if (previewArea)');
    const rollback = submitComment.indexOf('function rollbackComment');
    expect(declaration).toBeGreaterThanOrEqual(0);
    expect(previewBlock).toBeGreaterThan(declaration);
    expect(rollback).toBeGreaterThan(previewBlock);
    expect(submitComment.slice(rollback)).toMatch(/newComment\s*&&\s*newComment\.parentNode\s*===\s*previewArea/);
    expect(submitComment.slice(rollback)).toMatch(/previewArea\.removeChild\(newComment\)/);
    expect(submitComment).toMatch(/\.then\(function\(res\)\s*\{\s*if\s*\(!res\.ok\)\s*\{[\s\S]*?rollbackComment\(\);[\s\S]*?\}\s*\}\)/);
    expect(submitComment).toMatch(/input\.value\s*=\s*content/);
  });
});

describe('P2-70 pagination consolidation guard', () => {
  // 防止路由层重新出现裸 parseInt(req.query.page/pageSize/limit) 钳位写法，
  // 全站分页必须走 utils.paginate()。_archive/ 为下线归档，不纳入收口口径。
  const liveRouteFiles = () => fs
    .readdirSync(path.join(serverRoot, 'routes'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name);

  test('route files never parse page/pageSize/limit by hand again', () => {
    const rawParse = /parseInt\s*\(\s*\w+(?:\.\w+)*\.(?:page|pageSize|limit)\b/;
    const offenders = [];
    for (const name of liveRouteFiles()) {
      const src = readServer('routes', name);
      if (rawParse.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test('paginate() call sites stay pinned at 34 across 21 route files', () => {
    let totalCalls = 0;
    const filesWithCalls = [];
    for (const name of liveRouteFiles()) {
      const count = (readServer('routes', name).match(/= paginate\(/g) || []).length;
      if (count > 0) filesWithCalls.push(name);
      totalCalls += count;
    }
    expect(totalCalls).toBe(34);
    expect(filesWithCalls.length).toBe(21);
  });

  // P2-70 全量回归暴露的教训：路由新增解构 utils 导出（如 paginate）后，
  // 若测试的 jest.mock('../utils') 工厂没同步补名，路由加载期解构到 undefined，
  // 命中该导出的接口一调用即 TypeError、被 handleError 吞成 500（collections/moderations 双套件曾中招）。
  // 守卫对「mock 了 utils 且 require 了路由」的套件自动校验解构名是否被工厂覆盖。
  test('utils mock factories cover every export their routes destructure', () => {
    const extractFactory = (src) => {
      const marker = src.indexOf("jest.mock('../utils'");
      if (marker === -1) return null;
      const braceIdx = src.indexOf('{', marker);
      if (braceIdx === -1) return null;
      let depth = 0;
      for (let i = braceIdx; i < src.length; i++) {
        if (src[i] === '{') depth++;
        if (src[i] === '}') {
          depth--;
          if (depth === 0) return src.slice(braceIdx + 1, i);
        }
      }
      return null;
    };
    const testDir = path.join(serverRoot, '__tests__');
    const offenders = [];
    for (const file of fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js'))) {
      const src = fs.readFileSync(path.join(testDir, file), 'utf8');
      const factory = extractFactory(src);
      // requireActual + spread 型工厂由真实 utils 动态兜底全部导出，静态检查不适用（也读不到键名）。
      if (!factory || factory.includes('requireActual')) continue;
      for (const [, routeName] of src.matchAll(/require\(['"]\.\.\/routes\/([\w.-]+)['"]\)/g)) {
        let routeSrc;
        try {
          routeSrc = readServer('routes', `${routeName}.js`);
        } catch {
          continue;
        }
        const destructure = routeSrc.match(/const \{([^}]+)\} = require\(['"]\.\.\/utils['"]\)/);
        if (!destructure) continue;
        for (const raw of destructure[1].split(',')) {
          const utilName = raw.trim();
          if (utilName && !new RegExp(`(^|[\\s,{])${utilName}\\s*[(:]`).test(factory)) {
            offenders.push(`${file} → routes/${routeName}.js 解构 ${utilName} 未被 mock 工厂覆盖`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('P2-82 notification bulk fan-out guard', () => {
  // 防止群发通知回退为逐用户串行 notifyUser（每人 INSERT+SELECT，万人群分钟级阻塞）。
  test('mass notifications fan out in batches instead of per-user serial round-trips', () => {
    const src = readServer('notification-service.js');
    expect(src).toMatch(/_bulkFanOut\(users\.map\(u => u\.id\)/);
    expect(src).toMatch(/_bulkFanOut\(admins\.map\(a => a\.id\)/);
    expect(src).not.toMatch(/this\.notifyUser\(/);
    expect(src).toMatch(/VALUES \$\{slice\.map\(/);
    expect(src).toMatch(/SELECT id, notification_settings FROM users WHERE id IN \(\?\)/);
  });
});

describe('P2-71/72/73/76 config & deploy hygiene guard', () => {
  // P2-72：防止站点地址变量链回退丢失（compose 透传 APP_URL，sitemap 必须认它），
  // 也防止 localhost 兜底端口倒退回 3000（实际监听 3456）。
  test('site-url fallback chain covers APP_URL and defaults to port 3456', () => {
    const sitemap = readServer('routes', 'sitemap.js');
    const baseUrl = extractFunction(sitemap, 'getBaseUrl');
    expect(baseUrl).toMatch(/SITEMAP_BASE_URL\s*\|\|\s*process\.env\.APP_URL\s*\|\|\s*process\.env\.APP_BASE_URL/);
    expect(baseUrl).toContain('http://localhost:3456');
    const mailer = readServer('mailer.js');
    expect(mailer).toContain("process.env.APP_URL || 'http://localhost:3456'");
    expect(sitemap).not.toContain('localhost:3000');
    expect(mailer).not.toContain('localhost:3000');
  });

  // P2-72：代码读取但模板缺失的环境变量必须回到 .env.example，防止部署时靠翻源码猜配置。
  test('.env.example documents every previously-undocumented consumed env var', () => {
    const example = readRepo('.env.example');
    const documented = [
      'APP_URL', 'SITEMAP_BASE_URL', 'APP_BASE_URL', 'WS_URL',
      'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM', 'ADMIN_EMAIL',
      'FILE_RETENTION_DAYS', 'NOTIFICATION_RETENTION_DAYS', 'BACKUP_RETENTION_DAYS',
      'PANEL_PORT', 'ACTIVATION_CODES_FILE', 'VRC_USER_AGENT', 'VRCX_SEARCH_URL'
    ];
    for (const key of documented) {
      expect(example).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });

  // P2-73①：安装向导写 .env 必须与 db-recover/migration 通道收口：敏感键加引号、
  // 值剔除换行（防注入额外键值行）、临时文件 + rename 原子落盘。
  test('setup wizard writes .env atomically with sanitized quoted secrets', () => {
    const writeEnv = extractFunction(readServer('routes', 'setup.js'), 'writeEnv');
    expect(writeEnv).toMatch(/replace\(\/\[\\r\\n\]\/g, ''\)/);
    expect(writeEnv).toMatch(/\/SECRET\|PASSWORD\|PASS\|KEY\|TOKEN\/i/);
    expect(writeEnv).toMatch(/\$\{envPath\}\.\$\{process\.pid\}-\$\{Date\.now\(\)\}\.tmp/);
    expect(writeEnv).toMatch(/fs\.renameSync\(tmpPath, envPath\)/);
  });

  // P2-73：.env 自动备份/原子写产物全部含旧密钥，面板哈希文件属本地私有，严禁入库。
  test('.gitignore keeps env backups and panel auth out of the repo', () => {
    const gitignore = readRepo('.gitignore');
    for (const pattern of ['^\\.env\\.bak\\.\\*$', '^\\.env\\.broken-\\*$', '^\\.env\\.tmp$', '^\\.env\\.\\*\\.tmp$', '^panel/panel-auth\\.json$']) {
      expect(gitignore).toMatch(new RegExp(pattern, 'm'));
    }
  });

  // P2-76：反代体积上限不得低于相册路由的单文件上限（500MB），否则大视频在 nginx 层 413。
  test('nginx body-size cap matches the 500MB upload route cap', () => {
    const conf = readRepo('deploy', 'nginx', 'jingtu.conf');
    const installer = readRepo('install.sh');
    expect(conf).toMatch(/client_max_body_size 500m;/);
    expect(installer).toMatch(/client_max_body_size 500m;/);
    expect(conf).not.toMatch(/client_max_body_size 200m;/);
    expect(installer).not.toMatch(/client_max_body_size 200m;/);
  });

  // P2-71：MySQL 服务端时区须与连接层（db.js '+08:00'）和 CronJob 时区一致，
  // 否则 NOW()/CURDATE() 按 UTC 计，日报统计在 00:00-08:00（北京时间）统计错日。
  test('scheduled tasks and MySQL server timezone are both Asia/Shanghai', () => {
    const compose = readRepo('docker-compose.yml');
    expect(compose).toMatch(/--default-time-zone=\+08:00/);
    const tasks = extractFunction(readServer('tasks.js'), 'startTasks');
    const cronJobs = (tasks.match(/new CronJob\(/g) || []).length;
    const tzPinned = (tasks.match(/null, true, 'Asia\/Shanghai'\)/g) || []).length;
    expect(cronJobs).toBe(6);
    expect(tzPinned).toBe(cronJobs);
  });
});

describe('P2-83/84/85 frontend lock, guard & stamp hygiene', () => {
  // P2-83：弹窗滚动锁统一收口到 ui.js 的引用计数锁。core.js 私有计数器
  // (_modalScrollLocks) 在 closeAllModals 中漏递减、且裸写 overflow 会覆盖
  // 菜单/灯箱/无障碍观察器的锁；严禁回退，overflow 只允许经锁机制操作。
  test('core.js modal scroll lock is unified with ui.js reference-counted lock', () => {
    const core = readRepo('public', 'js', 'core.js');
    expect(core).not.toContain('_modalScrollLocks');
    const closeModal = extractFunction(core, 'closeModal');
    expect(closeModal).toContain("unlockBodyScroll('modal:' + id)");
    expect(closeModal).not.toMatch(/body\.style\.overflow/);
    const showModal = extractFunction(core, 'showModal');
    expect(showModal).toContain("lockBodyScroll('modal:' + id)");
    expect(showModal).not.toMatch(/body\.style\.overflow/);
    const closeAll = extractFunction(core, 'closeAllModals');
    expect(closeAll).toContain("unlockBodyScroll('modal:' + modal.id)");
    // canonical 锁本体仍在 ui.js（若被删除，core.js 的调用会静默失效）
    const ui = readRepo('public', 'js', 'ui.js');
    expect(ui).toMatch(/function\s+lockBodyScroll\s*\(/);
    expect(ui).toMatch(/function\s+unlockBodyScroll\s*\(/);
  });

  // P2-84：showEventDetail（events.js）与 openMapLocation（map.js）均为懒加载模块，
  // 内联 onclick 直接引用会在模块未加载时抛 ReferenceError；须带 window 属性守卫。
  test('cross-module inline onclick handlers guard lazily-loaded globals', () => {
    const adminUi = readRepo('public', 'js', 'admin-ui.js');
    expect(adminUi).toContain('onclick="window.showEventDetail&&showEventDetail(');
    expect(adminUi).not.toMatch(/onclick="showEventDetail/);
    const profile = readRepo('public', 'js', 'profile.js');
    expect(profile).toContain('onclick="window.showEventDetail&&showEventDetail(');
    expect(profile).not.toMatch(/onclick="showEventDetail/);
    const chat = readRepo('public', 'js', 'chat.js');
    expect(chat).toContain('onclick="window.openMapLocation&&openMapLocation(');
    expect(chat).not.toMatch(/onclick="openMapLocation/);
  });

  // P2-85：懒加载模块版本戳唯一来源是 index.html 的 loader.js?v=（loader.js 运行时自取）。
  // loader.js 内除「标签无戳」注释外不允许出现 ?v=20xxxxxxa 字面量，防止戳再度分叉。
  test('loader.js derives asset stamp from its own script tag instead of hardcoding', () => {
    const loader = readRepo('public', 'js', 'loader.js');
    expect(loader).toMatch(/document\.currentScript/);
    expect(loader).toMatch(/script\[src\*="\/js\/loader\.js"\]/);
    expect(loader).toContain("s.src = '/js/' + src + _assetVer;");
    const withoutExplain = loader.replace(/\/\/[^\n]*\n/g, '');
    expect(withoutExplain).not.toMatch(/\?v=20\d{6}[a-z]/);
    const index = readRepo('public', 'index.html');
    expect(index).toMatch(/<script defer src="\/js\/loader\.js\?v=\d{8}[a-z]?"><\/script>/);
  });
});

describe('P2-68 eslint gate and lint-discovered fixes', () => {
  // P2-68 首轮 ESLint 抓出 routes/*.js 里「调用 logOper( 但从未导入」的文件
  // （users.js 改密端点、users_tags_notes.js 四个写端点——P2-66 拆分时漏导入）。
  // 症状：数据写入成功后抛 ReferenceError，被 handleError 转成 500（成功却报失败）。
  // 静态扫描全 routes 目录，防止今后再拆文件时复发。
  test('every route file calling logOper imports it via destructuring', () => {
    const routesDir = path.join(serverRoot, 'routes');
    const offenders = [];
    for (const name of fs.readdirSync(routesDir)) {
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(routesDir, name), 'utf8');
      const code = src.replace(/\/\/[^\n]*\n/g, '\n');
      if (!/\blogOper\s*\(/.test(code)) continue;
      if (!/const\s*\{[^}]*\blogOper\b[^}]*\}\s*=\s*require\(/.test(code)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  // P2-68：ws_service.js 旧代码 `typeof securityAlert === 'function'` 永假
  // （模块内从未定义 securityAlert），未认证风暴告警从未触发。
  // 已按 P1-16（db-recover.js）先例改为显式引入 onSecurityBreach，严禁回退。
  test('ws_service security-storm alert uses real onSecurityBreach import', () => {
    const ws = readServer('ws_service.js');
    // 修复说明注释里原文引用了旧代码，断言须先剥行注释只看可执行代码
    const wsCode = ws.replace(/\/\/[^\n]*\n/g, '\n');
    expect(wsCode).not.toMatch(/typeof securityAlert === 'function'/);
    expect(wsCode).toContain("require('./security_alert')");
    expect(wsCode).toContain('onSecurityBreach');
    expect(ws).toContain('WebSocket 未认证连接风暴');
  });

  // P2-68：vrc.js 两处对象字面量重复键 statusDescription（no-dupe-keys），
  // 各保留一份；重复定义会静默覆盖，禁止再加回。
  test('vrc.js defines statusDescription exactly once per object literal', () => {
    const vrc = readServer('vrc.js');
    expect((vrc.match(/statusDescription: f\.statusDescription/g) || []).length).toBe(1);
    expect((vrc.match(/statusDescription: userData\.statusDescription/g) || []).length).toBe(1);
  });

  // P2-68：字符类里的 `\/` 属于 no-useless-escape 噪音，正则语义不变但须保持净化后写法。
  test('regex noise cleaned in waf and route_guard', () => {
    const waf = readServer('middleware', 'waf.js');
    expect(waf).not.toContain('[^\\/');
    expect(waf).toContain('[^/]');
    const guard = readServer('route_guard.js');
    expect(guard).not.toContain('\\[\\]');
  });

  // P2-68：两处控制字符正则是有意的黑名单（显示名校验 / CSV 转义），
  // 以行内 disable 记账；若注释丢失，ESLint error 会立刻把问题顶回 CI。
  test('intentional control-regex sites carry documented eslint-disable', () => {
    expect(readServer('routes', 'admin_name_change.js')).toContain('eslint-disable-next-line no-control-regex');
    expect(readServer('routes', 'user-data-helper.js')).toContain('eslint-disable-next-line no-control-regex');
  });

  // 门禁本体：flat config、npm 脚本、CI 双新 job（lint / node:test）缺一不可。
  test('lint tooling and CI wiring are present', () => {
    expect(fs.existsSync(path.join(serverRoot, 'eslint.config.js'))).toBe(true);
    const pkg = JSON.parse(readServer('package.json'));
    expect(pkg.scripts.lint).toContain('eslint');
    expect(pkg.scripts['test:node']).toContain('node --test');
    const ci = readRepo('.github', 'workflows', 'ci.yml');
    expect(ci).toContain('npm run lint');
    expect(ci).toContain('npm run test:node');
  });

  // P2-68 复活 node:test 套件时发现：`node --test test/`（目录参数）在部分
  // Node/Windows 组合下不做目录发现，会把目录当模块加载并报 MODULE_NOT_FOUND；
  // 脚本改用通配符形态（CI bash 可展开，Node ≥23 亦支持原生 glob 双保险）。
  // 同批修复：security.test.js 的 express-rate-limit stub 必须带 MemoryStore
  // 命名导出，否则 rate_limit_store.js 模块加载期 `new MemoryStore()` 直接崩溃。
  test('node:test suite is discoverable and stub matches module shape', () => {
    const pkg = JSON.parse(readServer('package.json'));
    expect(pkg.scripts['test:node']).toContain('test/*.test.js');
    const sec = readServer('test', 'security.test.js');
    expect(sec).toContain('rateLimitStub.MemoryStore');
  });
});

