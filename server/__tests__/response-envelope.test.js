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
  'admin', 'album', 'announcements', 'backups', 'collections',
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

  // P2-4 auth 路由按域拆分：原 routes/auth.js 的 ok 包络守卫随实现迁移到三个 service。
  test.each(['auth_local_service.js', 'auth_vrc_service.js', 'auth_reset_service.js'])('%s：引入 ok 且不再直接写 success:true 平铺', (name) => {
    const src = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
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
  // P2-4 第三批 god-route 拆分：admin.js 的用户管理/改名/直播内容已按域拆出，
  // admin.js 留守块不再使用 fail()，改为守卫 admin_users.js 与 admin_content_live.js（引入 fail）。
  // admin.js 与 admin_name_change.js 不引入 fail，由下方「拆分后无扁平 error」反向守卫覆盖。
  const ERROR_MIGRATED_FILES = [
    'routes/admin_users.js', 'routes/admin_content_live.js',
    'routes/avatar.js', 'routes/database.js',
    'routes/db-recover.js', 'routes/events.js', 'routes/export.js', 'routes/groups.js',
    // P2-66 god-route 拆分：groups 子模块中仅这两处引入 fail，守卫随实现迁移
    'routes/groups_members_sync.js', 'routes/groups_content.js',
    'routes/logs.js', 'routes/migration.js', 'routes/permission_groups.js',
    'routes/permissions.js', 'routes/posts.js', 'routes/setup.js', 'routes/users.js',
    'routes/vrc_system.js', 'middleware/api_version.js', 'middleware/security.js',
    'middleware/csrf.js', 'middleware/uploads_auth.js',
    'auth.js', 'auth_local_service.js', 'auth_vrc_service.js', 'auth_reset_service.js'
  ];
  const FLAT_ERROR_SHAPE = /res\.json\(\s*\{\s*(success:\s*false,\s*)?error:\s*['"`]/;
  const failRequireRegex = (rel) => new RegExp(
    "const\\s*\\{[^}]*\\bfail\\b[^}]*\\}\\s*=\\s*require\\('" +
    (rel === 'auth.js' || rel === 'auth_local_service.js' || rel === 'auth_vrc_service.js' || rel === 'auth_reset_service.js' ? './utils' : '../utils') + "'\\)"
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

  test.each(['routes/admin.js', 'routes/admin_name_change.js'])(
    'P2-4 第三批拆分后 %s：不引入 fail 且不再直接写扁平 error 响应',
    (rel) => {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      expect(src).not.toMatch(failRequireRegex(rel));
      expect(src).not.toMatch(FLAT_ERROR_SHAPE);
    }
  );

  test('utils.js：fail() 定义存在并导出，handleError 尾部保持嵌套形态', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils.js'), 'utf8');
    expect(src).toMatch(/function fail\(/);
    expect(src).toMatch(/module\.exports\s*=\s*\{[^}]*\bfail\b/);
    expect(src).toMatch(/error:\s*\{\s*code,\s*message\s*\}/);
  });
});

describe('toSqlDatetime 时间规范化（VRChat ISO8601 → MySQL DATETIME）', () => {
  // VRChat API 的 last_login/scheduledAt 是 UTC ISO8601 字符串（带 Z），
  // 直接写入 DATETIME 列会抛 "Incorrect datetime value"（presence/contribute 500 事故根因）。
  test('VRChat 标准 ISO8601（带毫秒 + Z）截取为 YYYY-MM-DD HH:MM:SS', () => {
    expect(utils.toSqlDatetime('2026-09-03T14:48:42.963Z')).toBe('2026-09-03 14:48:42');
  });

  test('无毫秒 ISO8601 原样转换', () => {
    expect(utils.toSqlDatetime('2026-09-03T14:48:42Z')).toBe('2026-09-03 14:48:42');
  });

  test('空格分隔的 DATETIME 字符串保持不变', () => {
    expect(utils.toSqlDatetime('2026-09-03 14:48:42')).toBe('2026-09-03 14:48:42');
  });

  test('仅到分钟的 ISO 时间补 :00 秒段', () => {
    expect(utils.toSqlDatetime('2026-09-03T14:48Z')).toBe('2026-09-03 14:48:00');
  });

  test('Date 对象原样返回（mysql2 自行序列化）', () => {
    const d = new Date('2026-09-03T14:48:42.963Z');
    expect(utils.toSqlDatetime(d)).toBe(d);
  });

  test('Invalid Date / 空值 / 杂串返回 null（写 NULL 比写坏值安全）', () => {
    expect(utils.toSqlDatetime(null)).toBe(null);
    expect(utils.toSqlDatetime(undefined)).toBe(null);
    expect(utils.toSqlDatetime('')).toBe(null);
    expect(utils.toSqlDatetime('not-a-date')).toBe(null);
    expect(utils.toSqlDatetime(new Date('garbage'))).toBe(null);
  });
});
