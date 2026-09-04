/**
 * P2-6 统一成功响应包络测试守卫。
 * 背景：错误侧已由 sendError/handleError 统一为 { success:false, error:{code,message} }，
 * 成功侧全站主流形状为 { success: true, ...字段平铺 }（success 首键、无 data 包装）。
 * 第一步引入 utils.ok(res, fields)：输出与既有平铺形状逐字节一致，并返回 res.json
 * 结果以兼容 `return ok(...)` / `resolve(ok(...))` 表达式位；14 个低风险小路由
 * 共 60 处已完成迁移。
 * 第二批（09-05）：12 个大路由（admin/announcements/auth/collections/events/friends/
 * groups/migration/posts/profile/setup/users）155 处 + server.js 1 处全部迁移完成，
 * 全站成功包络统一收口。
 * 静态源码守卫：锁住已迁移文件不再直接写 res.json({ success: true ... })，
 * 防回退。created()/201 全站暂无用例，留待后续批次；server.js 因 require 路径
 * 为 './utils' 且不在 routes/ 目录，单独设守卫。
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
