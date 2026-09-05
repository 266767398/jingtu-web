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
    const route = usersRoute();
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
    const route = usersRoute();
    const locationRoute = route.slice(route.indexOf("router.put('/me/location'"), route.indexOf("router.get('/:userId/photos'"));
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
