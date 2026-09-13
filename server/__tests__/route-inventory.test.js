/**
 * P2-66 路由守恒守卫：god-route 拆分（groups.js / users.js 等）前后，
 * 全应用路由清单（method + path + 注册顺序）必须与基线快照完全一致。
 *
 * 基线 fixtures/route-inventory.json 由 route_guard.collectRoutes 在
 * 拆分前（HEAD 463 条路由）生成。任何新增/删除/改路径/改顺序的路由变更
 * 都必须显式更新该快照并在 PR 中说明。
 */
const fs = require('fs');
const path = require('path');
const app = require('../server');
const { collectRoutes } = require('../route_guard');

describe('路由守恒（P2-66 god-route 拆分守卫）', () => {
  it('全应用路由清单与基线快照逐条一致（含顺序）', () => {
    const golden = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'route-inventory.json'), 'utf8')
    );
    const live = collectRoutes(app).map(r => `${r.method} ${r.path}`);
    expect(live.length).toBe(golden.length);
    const diffs = [];
    for (let i = 0; i < Math.max(live.length, golden.length); i += 1) {
      if (live[i] !== golden[i]) diffs.push(`#${i}: golden=${golden[i]} live=${live[i]}`);
    }
    expect(diffs).toEqual([]);
  });
});
