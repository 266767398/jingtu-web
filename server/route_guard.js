// ==================== 启动期路由冲突自检（P2-15 / B-3 防护，只读） ====================
// 背景：本服务有 16 个 router 直接挂 /api 根，Express 按挂载序匹配——
// 「同方法+同路径」时后挂载者的路由是死代码；「参数路由先注册」会截胡后注册的字面路由
//（如 groups.js 的 /vrc/world/:worldId 会吞掉别处后加的 /vrc/world/featured）。
// 本模块在启动时只读扫描已注册路由并在日志中显式报告，不改变任何路由行为。

'use strict';

// 从 Express layer.regexp.source 还原挂载前缀：
//   app.use('/api', r) → '^\\/api\\/?(?=\\/|$)' → '/api'
//   app.use(fn)        → 空前缀
// 含正则特征（捕获组/字符类等）的复杂挂载无法静态还原，返回 null 由调用方跳过该子树。
function prefixFromSource(src) {
  let p = String(src || '');
  if (p.charAt(0) !== '^') return null;
  p = p.slice(1);
  // 去掉尾部可选斜杠 + 长度前瞻（兼容 (?=\/|$) 与 (?=/|$) 两种转义形态）：
  //   '^\/api\/?(?=\/|$)' → '\/api' → '/api'
  p = p.replace(/\\?\/\?\(\?=\\?\/\|\$\)$/, '');
  // 还原被转义的斜杠
  p = p.replace(/\\\//g, '/');
  // 仍含正则特征 → 复杂挂载（正则/参数前缀），放弃静态还原
  if (/[()[\]|+*?\\]/.test(p)) return null;
  return p;
}

// 参数名归一化：/vrc/world/:worldId 与 /vrc/world/:wid 语义相同
function normalizeRoutePath(p) {
  return String(p).replace(/\/:[A-Za-z0-9_]+/g, '/:param');
}

function isParamRoute(p) {
  return /\/:[A-Za-z0-9_]+/.test(String(p));
}

function segmentsOf(p) {
  return normalizeRoutePath(p).split('/').filter(function (s) { return s !== ''; });
}

// 两条同方法路由是否「形状兼容」（可能命中同一请求）：
// 段数相同且逐段相等（字面=字面 或 任一侧为参数段）
function shapesOverlap(a, b) {
  const sa = segmentsOf(a);
  const sb = segmentsOf(b);
  if (sa.length !== sb.length) return false;
  return sa.every(function (s, i) { return s === sb[i] || s === ':param' || sb[i] === ':param'; });
}

// 递归收集 app 上全部已注册路由（只读），返回 [{method, path, seq}]
function collectRoutes(app) {
  const out = [];
  let seq = 0;
  const root = app._router || app.router;
  if (!root || !Array.isArray(root.stack)) return out;
  const walk = function (stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        // 直接 route（app.get/router.get 等），route.path 为定义时的字符串
        const rp = layer.route.path;
        if (typeof rp !== 'string') continue;
        const methods = layer.route.methods || {};
        for (const m of Object.keys(methods)) {
          if (!methods[m]) continue;
          out.push({ method: m.toUpperCase(), path: prefix + rp, seq: seq++ });
        }
      } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
        // 挂载的子 router：前缀从 regexp.source 还原
        const mp = prefixFromSource(layer.regexp && layer.regexp.source);
        if (mp !== null) walk(layer.handle.stack, prefix + mp);
      }
    }
  };
  walk(root.stack, '');
  return out;
}

// 主审计：返回 { total, exact, shadow }
//   exact  — 同方法+同归一化路径完全重复（后注册者死代码）
//   shadow — 字面路由后注册、且被先注册的同方法参数路由形状兼容截胡
function auditRouteConflicts(app) {
  const routes = collectRoutes(app);
  const exact = [];
  const shadow = [];
  const seen = new Map();
  for (const r of routes) {
    const key = r.method + ' ' + normalizeRoutePath(r.path);
    if (seen.has(key)) exact.push({ key: key, first: seen.get(key), dup: r });
    else seen.set(key, r);
  }
  const paramRoutes = routes.filter(function (r) { return isParamRoute(r.path); });
  for (const r of routes) {
    if (isParamRoute(r.path)) continue;
    const key = r.method + ' ' + normalizeRoutePath(r.path);
    if (seen.get(key) !== r) continue; // 已属完全重复，交给 exact 报告
    for (const p of paramRoutes) {
      if (p.method !== r.method || p.seq >= r.seq) continue; // 只报「参数路由先注册」
      if (shapesOverlap(p.path, r.path)) {
        shadow.push({ key: r.method + ' ' + r.path, by: p.method + ' ' + p.path, seqFirst: p.seq, seqSelf: r.seq });
        break;
      }
    }
  }
  return { total: routes.length, exact: exact, shadow: shadow };
}

module.exports = {
  auditRouteConflicts: auditRouteConflicts,
  collectRoutes: collectRoutes,
  prefixFromSource: prefixFromSource,
  normalizeRoutePath: normalizeRoutePath,
  shapesOverlap: shapesOverlap,
  isParamRoute: isParamRoute
};
