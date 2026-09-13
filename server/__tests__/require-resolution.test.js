'use strict';
/**
 * P2-4 复验永久守卫：全站「字面量相对 require」路径可解析性静态校验。
 * 动机缺陷：P2-4 第一批发现 routes/stats.js 冷门分支里 `../../mailer` 相对路径错误
 * （文件迁移后未同步），命中即 MODULE_NOT_FOUND → 该分支实际 500。
 * 此类缺陷纯静态即可判定，但从未做过全站扫描；本守卫覆盖 server 下全部 .js
 * （含 routes/_archive，保证归档代码具备复活条件），防止同类缺陷复发。
 */
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'coverage', '.git', 'data']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (e.name.endsWith('.js')) out.push(f);
  }
  return out;
}

// 逐字符扫描，产出「不在字符串/注释内」的相对 require 字面量（spec=null 表示动态调用点）
function extractRequires(src) {
  const hits = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < n) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    if (src.startsWith('require', i) && /[\w$]/.test(src[i - 1] || ' ')) { i += 7; continue; }
    if (src.startsWith('require', i)) {
      const m = /^require\(\s*(['"])((?:\.\.?\/)[^'"]+)\1\s*\)/.exec(src.slice(i));
      if (m) { hits.push({ spec: m[2], pos: i }); i += m[0].length; continue; }
      const dyn = /^require\([^'")]/.test(src.slice(i));
      if (dyn) hits.push({ spec: null, pos: i });
      i += 7; continue;
    }
    i++;
  }
  return hits;
}

function resolves(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  const cands = [base, base + '.js', base + '.json', base + '.node',
    path.join(base, 'index.js'), path.join(base, 'index.json'), path.join(base, 'index.node')];
  for (const p of cands) {
    try { if (fs.statSync(p).isFile()) return true; } catch (e) { /* noop */ }
  }
  return false;
}

describe('P2-4 复验守卫：全站相对 require 可解析性', () => {
  const files = walk(SERVER_ROOT, []);
  const bad = [];
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const h of extractRequires(src)) {
      if (h.spec === null) continue;
      checked++;
      if (!resolves(path.dirname(f), h.spec)) {
        const rel = path.relative(SERVER_ROOT, f).replace(/\\/g, '/');
        const line = src.slice(0, h.pos).split('\n').length;
        bad.push(`${rel}:${line} → ${h.spec}`);
      }
    }
  }

  test('扫描器生效：覆盖 150+ 源文件与 300+ 字面量相对 require（防守卫自身静默失效）', () => {
    expect(files.length).toBeGreaterThan(150);
    expect(checked).toBeGreaterThan(300);
  });

  test('全部字面量相对 require 可解析（../../mailer 同类缺陷不复现，含 _archive 复活条件）', () => {
    expect(bad).toEqual([]);
  });
});
