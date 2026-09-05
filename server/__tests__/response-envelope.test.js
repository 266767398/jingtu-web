/**
 * P2-6 统一响应包络测试守卫（成功侧 ok() + 错误侧 fail()）。
 * 背景：错误侧核心早由 sendError/handleError 统一为 { success:false, error:{code,message} } 嵌套形态，
 * 成功侧全站主流形状为 { success: true, ...字段平铺 }（success 首键、无 data 包装）。
 * 第一步引入 utils.ok(res, fields)：输出与既有平铺形状逐字节一致，并返回 res.json
 * 结果以兼容 `return ok(...)` / `resolve(ok(...))` 表达式位；14 个低风险小路由
 * 共 60 处已完成迁移。
 * 第二批（09-05）：12 个大路由（admin/announcements/auth/collections/events/friends/
 * groups/migration/posts/profile/setup/users）155 处 + server.js 1 处全部迁移完成，
 * 全站成功包络统一收口。
 * 第三批（09-05，错误侧）：引入 utils.fail(res, status, message, extra)，输出
 * { success:false, error: message, ...extra 顶层平铺 }，与既有扁平错误形态逐字节一致；
 * 22 个文件共 119 处迁移完成。嵌套/特殊形态豁免：sendError 与 handleError（嵌套读者）、
 * sendVrcError（顶层 code + detail 契约）、刻意扁平的 waf.js、collections.js 嵌套站点、
 * 测试 mock。
 * 静态源码守卫：锁住已迁移文件不再直接写 res.json({ success: true ... }) 与扁平
 * error 响应，防回退。created()/201 全站暂无用例，留待后续批次。
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const utils = require('../utils');

const MIGRATED_ROUTES = [
  'admin', 'album', 'announcements', 'auth', 'backups', 'collections',
  'config', 'db-recover', 'events', 'files', 'follows', 'friends', 'groups',
  'logs', 'migration', 'moderations', 'notifications', 'permission_groups',
  'posts', 'profile', 'security', 'setup', 'share', 'users', 'vrc_system',
  'webhooks'
];

describe('P2-6 ok() 成功包络', () => {
  test('ok(res) 输出 { success: true }', () => {
    const res = { json: jest.fn() };
    utils.ok(res);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  test('ok(res, fields) 平铺字段：success 首键 + 无 data 包装 + 返回 res.json 结果', () => {
    const jsonResult = { chained: true };
    const res = { json: jest.fn(() => jsonResult) };
    const ret = utils.ok(res, { id: 7, message: 'x' });
    const arg = res.json.mock.calls[0][0];
    expect(arg).toEqual({ success: true, id: 7, message: 'x' });
    expect(Object.keys(arg)[0]).toBe('success');
    expect(Object.keys(arg)).not.toContain('data');
    expect(ret).toBe(jsonResult);
  });
});

describe('P2-6 已迁移路由静态守卫', () => {
  test.each(MIGRATED_ROUTES)('%s.js：引入 ok 且不再直接写 success:true 平铺', (name) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', name + '.js'), 'utf8');
    expect(src).toMatch(/const\s*\{[^}]*\bok\b[^}]*\}\s*=\s*require\('\.\.\/utils'\)/);
    expect(src).not.toMatch(/res\.json\(\s*\{\s*success:\s*true/);
  });

  test('server.js：引入 ok 且不再直接写 success:true 平铺', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toMatch(/const\s*\{[^}]*\bok\b[^}]*\}\s*=\s*require\('\.\/utils'\)/);
    expect(src).not.toMatch(/res\.json\(\s*\{\s*success:\s*true/);
  });
});

describe('P2-6 fail() 错误包络', () => {
  test('fail(res, status, message) 输出 { success:false, error } 且 success 首键', () => {
    const res = { status: jest.fn(() => res), json: jest.fn() };
    utils.fail(res, 404, '请求的资源不存在');
    expect(res.status).toHaveBeenCalledWith(404);
    const arg = res.json.mock.calls[0][0];
    expect(arg).toEqual({ success: false, error: '请求的资源不存在' });
    expect(Object.keys(arg)[0]).toBe('success');
  });

  test('fail(res, status, message, extra) 额外字段顶层平铺 + 返回 res.json 结果', () => {
    const jsonResult = { chained: true };
    const res = { status: jest.fn(() => res), json: jest.fn(() => jsonResult) };
    const ret = utils.fail(res, 429, '请求过快', { code: 'VRC_RATE_LIMITED', retryAfter: 30 });
    const arg = res.json.mock.calls[0][0];
    expect(arg).toEqual({ success: false, error: '请求过快', code: 'VRC_RATE_LIMITED', retryAfter: 30 });
    expect(Object.keys(arg)).not.toContain('data');
    expect(ret).toBe(jsonResult);
  });
});

describe('P2-6 错误侧已迁移文件静态守卫', () => {
  // 19 个错误侧迁移文件：16 个 routes + 2 个 middleware + server/auth.js。
  // 「扁平形态」= error 值为字符串/模板字面量；嵌套 { error: { ... } }（collections.js、
  // sendError/handleError）与刻意扁平的 waf.js、sendVrcError 内部不在守卫范围，不受影响。
  const ERROR_MIGRATED_FILES = [
    'routes/admin.js', 'routes/auth.js', 'routes/avatar.js', 'routes/database.js',
    'routes/db-recover.js', 'routes/events.js', 'routes/export.js', 'routes/groups.js',
    'routes/logs.js', 'routes/migration.js', 'routes/permission_groups.js',
    'routes/permissions.js', 'routes/posts.js', 'routes/setup.js', 'routes/users.js',
    'routes/vrc_system.js', 'middleware/api_version.js', 'middleware/security.js',
    'auth.js'
  ];
  const FLAT_ERROR_SHAPE = /res\.json\(\s*\{\s*(success:\s*false,\s*)?error:\s*['"`]/;
  const failRequireRegex = (rel) => new RegExp(
    "const\\s*\\{[^}]*\\bfail\\b[^}]*\\}\\s*=\\s*require\\('" +
    (rel === 'auth.js' ? './utils' : '../utils') + "'\\)"
  );

  test.each(ERROR_MIGRATED_FILES)('%s：引入 fail 且不再直接写扁平 error 响应', (rel) => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    expect(src).toMatch(failRequireRegex(rel));
    expect(src).not.toMatch(FLAT_ERROR_SHAPE);
  });

  test('server.js：引入 fail 且不再直接写扁平 error 响应', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toMatch(/const\s*\{[^}]*\bfail\b[^}]*\}\s*=\s*require\('\.\/utils'\)/);
    expect(src).not.toMatch(FLAT_ERROR_SHAPE);
  });

  test('utils.js：fail() 定义存在并导出，handleError 尾部保持嵌套形态', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils.js'), 'utf8');
    expect(src).toMatch(/function fail\(/);
    expect(src).toMatch(/module\.exports\s*=\s*\{[^}]*\bfail\b/);
    expect(src).toMatch(/error:\s*\{\s*code,\s*message\s*\}/);
  });
});
