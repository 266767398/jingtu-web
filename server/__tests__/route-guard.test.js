// 启动期路由冲突自检（P2-15 / B-3）：用合成 Express 应用验证
// exact（同方法+同路径完全重复 → 后者死代码）与 shadow（参数路由先注册截胡后注册字面路由）两类检测，
// 以及挂载前缀还原 / 参数归一化 / 形状重叠判定等基础函数。
const express = require('express');
const {
  auditRouteConflicts,
  collectRoutes,
  prefixFromSource,
  normalizeRoutePath,
  shapesOverlap,
  isParamRoute
} = require('../route_guard');

describe('route_guard 基础函数', () => {
  test('prefixFromSource：字面挂载前缀还原', () => {
    // app.use('/api', r) 的 layer.regexp.source 形态
    expect(prefixFromSource('^\\/api\\/?(?=\\/|$)')).toBe('/api');
    // app.use('/api/share', r)
    expect(prefixFromSource('^\\/api\\/share\\/?(?=\\/|$)')).toBe('/api/share');
    // app.use(fn) 无路径挂载（Express 默认 '/'）
    expect(prefixFromSource('^\\/?(?=\\/|$)')).toBe('');
    // 复杂正则挂载无法静态还原 → null（调用方跳过该子树）
    expect(prefixFromSource('^\\/api\\/(v\\d+)')).toBeNull();
    expect(prefixFromSource('^\\/:id([0-9]+)')).toBeNull();
  });

  test('normalizeRoutePath：参数名归一化', () => {
    expect(normalizeRoutePath('/vrc/world/:worldId')).toBe('/vrc/world/:param');
    expect(normalizeRoutePath('/vrc/world/:wid')).toBe('/vrc/world/:param');
    expect(normalizeRoutePath('/users/:id/posts/:postId')).toBe('/users/:param/posts/:param');
    expect(normalizeRoutePath('/plain')).toBe('/plain');
  });

  test('isParamRoute：含参数段为 true', () => {
    expect(isParamRoute('/vrc/world/:worldId')).toBe(true);
    expect(isParamRoute('/vrc/worlds')).toBe(false);
    expect(isParamRoute('/:id')).toBe(true);
  });

  test('shapesOverlap：段数相同且逐段相等或为参数段', () => {
    expect(shapesOverlap('/vrc/world/:worldId', '/vrc/world/featured')).toBe(true);
    expect(shapesOverlap('/vrc/world/:wid', '/vrc/world/:other')).toBe(true);
    expect(shapesOverlap('/vrc/world/:worldId', '/vrc/world/featured/sub')).toBe(false);
    expect(shapesOverlap('/vrc/world', '/vrc/world/featured')).toBe(false);
    expect(shapesOverlap('/admin/users', '/admin/users')).toBe(true);
    expect(shapesOverlap('/admin/:id', '/admin/users')).toBe(true);
  });
});

describe('route_guard.collectRoutes：挂载前缀还原与路由收集', () => {
  test('从挂载的子 router 收集带前缀的路由（含多方法）', () => {
    const app = express();
    const r1 = express.Router();
    r1.get('/vrc/worlds', (req, res) => res.json({}));
    r1.get('/vrc/world/:worldId', (req, res) => res.json({}));
    r1.post('/vrc/avatar/set', (req, res) => res.json({}));
    app.use('/api', r1);

    const routes = collectRoutes(app);
    expect(routes).toHaveLength(3);
    expect(routes.map(r => r.method + ' ' + r.path).sort()).toEqual([
      'GET /api/vrc/world/:worldId',
      'GET /api/vrc/worlds',
      'POST /api/vrc/avatar/set'
    ]);
    // seq 按注册顺序递增
    expect(routes[0].seq).toBe(0);
  });

  test('app.get 直接路由 + 空挂载子 router 均可收集', () => {
    const app = express();
    app.get('/api/health', (req, res) => res.json({}));
    const r = express.Router();
    r.get('/ping', (req, res) => res.json({}));
    app.use(r); // 无路径挂载
    const routes = collectRoutes(app);
    const keys = routes.map(r => r.method + ' ' + r.path).sort();
    expect(keys).toEqual(['GET /api/health', 'GET /ping']);
  });
});

describe('route_guard.auditRouteConflicts：冲突检测', () => {
  test('无冲突应用：exact=0, shadow=0', () => {
    const app = express();
    const r1 = express.Router();
    r1.get('/admin/users', (req, res) => res.json({}));
    const r2 = express.Router();
    r2.get('/admin/logs', (req, res) => res.json({}));
    app.use('/api', r1);
    app.use('/api', r2);
    const report = auditRouteConflicts(app);
    expect(report.total).toBe(2);
    expect(report.exact).toHaveLength(0);
    expect(report.shadow).toHaveLength(0);
  });

  test('exact：后挂载 router 的同方法同路径重复路由被报告（死代码）', () => {
    const app = express();
    const r1 = express.Router();
    r1.get('/status/check', (req, res) => res.json({}));
    const r2 = express.Router();
    r2.get('/status/check', (req, res) => res.json({}));
    app.use('/api', r1);
    app.use('/api', r2);
    const report = auditRouteConflicts(app);
    expect(report.exact).toHaveLength(1);
    expect(report.exact[0].key).toBe('GET /api/status/check');
    expect(report.exact[0].dup.seq).toBeGreaterThan(report.exact[0].first.seq);
  });

  test('exact 不跨方法误报：GET 与 POST 同路径不算重复', () => {
    const app = express();
    const r1 = express.Router();
    r1.get('/thing', (req, res) => res.json({}));
    const r2 = express.Router();
    r2.post('/thing', (req, res) => res.json({}));
    app.use('/api', r1);
    app.use('/api', r2);
    const report = auditRouteConflicts(app);
    expect(report.exact).toHaveLength(0);
    expect(report.shadow).toHaveLength(0);
  });

  test('shadow：参数路由先注册、字面路由后注册 → 字面路由被截胡', () => {
    const app = express();
    // 模拟 groups.js 现状：/vrc/world/:worldId 先注册
    const groups = express.Router();
    groups.get('/vrc/world/:worldId', (req, res) => res.json({}));
    // 模拟未来某文件新增 /vrc/world/featured
    const other = express.Router();
    other.get('/vrc/world/featured', (req, res) => res.json({}));
    app.use('/api', groups);
    app.use('/api', other);
    const report = auditRouteConflicts(app);
    expect(report.shadow).toHaveLength(1);
    expect(report.shadow[0].key).toBe('GET /api/vrc/world/featured');
    expect(report.shadow[0].by).toBe('GET /api/vrc/world/:worldId');
  });

  test('shadow 不误报：字面路由先注册、参数路由后注册是合法顺序', () => {
    const app = express();
    const r1 = express.Router();
    r1.get('/vrc/world/featured', (req, res) => res.json({}));
    const r2 = express.Router();
    r2.get('/vrc/world/:worldId', (req, res) => res.json({}));
    app.use('/api', r1);
    app.use('/api', r2);
    const report = auditRouteConflicts(app);
    expect(report.shadow).toHaveLength(0);
  });

  test('shadow 不误报：形状不兼容（段数不同/字面段不同）', () => {
    const app = express();
    const r1 = express.Router();
    r1.get('/users/:id', (req, res) => res.json({}));
    const r2 = express.Router();
    r2.get('/users/list/all', (req, res) => res.json({})); // 段数不同
    r2.get('/posts/:id', (req, res) => res.json({})); // 首段不同
    app.use('/api', r1);
    app.use('/api', r2);
    const report = auditRouteConflicts(app);
    expect(report.shadow).toHaveLength(0);
  });
});
