/**
 * 境途同游 V7.11 — 运势/彩蛋模块单元测试（node --check + node scripts/test_fortune.js）
 * 运行：cd server && node scripts/test_fortune.js
 */
const assert = require('assert');
const { FORTUNE_TIERS, rollFortune, computeEggs, eggTotal } = require('../fortune');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1; }
}

console.log('fortune.js 单元测试\n');

t('运势档位权重合计为 100', () => {
  const sum = FORTUNE_TIERS.reduce((s, x) => s + x.weight, 0);
  assert.strictEqual(sum, 100);
});

t('rollFortune 确定性：同参数多次调用结果一致', () => {
  const a = rollFortune(42, '2026-08-20');
  for (let i = 0; i < 50; i++) {
    assert.deepStrictEqual(rollFortune(42, '2026-08-20'), a);
  }
});

t('rollFortune 返回合法档位', () => {
  const keys = new Set(FORTUNE_TIERS.map(x => x.key));
  for (let uid = 1; uid <= 300; uid++) {
    const f = rollFortune(uid, '2026-08-20');
    assert.ok(keys.has(f.key), `未知档位 ${f.key}`);
    assert.strictEqual(typeof f.mult, 'number');
  }
});

// 分布测试单独实现（避免模板陷阱）
t('rollFortune 分布检查', () => {
  const counts = {};
  for (let uid = 1; uid <= 10000; uid++) {
    const k = rollFortune(uid, '2026-08-20').key;
    counts[k] = (counts[k] || 0) + 1;
  }
  for (const tier of FORTUNE_TIERS) {
    const pct = ((counts[tier.key] || 0) / 100);
    assert.ok(pct > tier.weight * 0.4 && pct < tier.weight * 1.6, `${tier.key} 占比 ${pct}% 偏离权重 ${tier.weight}%`);
  }
});

t('不同日期运势可以不同（300 个用户里至少出现两种档位）', () => {
  const keys = new Set();
  for (let uid = 1; uid <= 300; uid++) keys.add(rollFortune(uid, '2026-08-20').key);
  assert.ok(keys.size >= 2);
});

t('彩蛋：连签7天触发 streak_7 +30', () => {
  const eggs = computeEggs({ streak: 7, hour: 12 });
  assert.deepStrictEqual(eggs, [{ key: 'streak_7', points: 30 }]);
});

t('彩蛋：连签30天触发 streak_30 +150（不再触发7天档）', () => {
  const eggs = computeEggs({ streak: 30, hour: 12 });
  assert.deepStrictEqual(eggs, [{ key: 'streak_30', points: 150 }]);
});

t('彩蛋：生日当天 +50', () => {
  const eggs = computeEggs({ streak: 1, hour: 12, isBirthday: true });
  assert.ok(eggs.some(e => e.key === 'birthday' && e.points === 50));
});

t('彩蛋：当日第一签 +10', () => {
  const eggs = computeEggs({ streak: 1, hour: 12, isFirstOfDay: true });
  assert.ok(eggs.some(e => e.key === 'first_of_day' && e.points === 10));
});

t('彩蛋：早起鸟 05:00-07:59 +5', () => {
  for (const h of [5, 6, 7]) {
    const eggs = computeEggs({ streak: 1, hour: h });
    assert.ok(eggs.some(e => e.key === 'early_bird'), `hour=${h} 应触发 early_bird`);
  }
});

t('彩蛋：夜猫子 23:00-03:59 +5', () => {
  for (const h of [23, 0, 1, 3]) {
    const eggs = computeEggs({ streak: 1, hour: h });
    assert.ok(eggs.some(e => e.key === 'night_owl'), `hour=${h} 应触发 night_owl`);
  }
});

t('彩蛋：8点/22点不触发时段彩蛋', () => {
  for (const h of [4, 8, 12, 22]) {
    const eggs = computeEggs({ streak: 1, hour: h });
    assert.ok(!eggs.some(e => e.key === 'early_bird' || e.key === 'night_owl'), `hour=${h} 不应触发时段彩蛋`);
  }
});

t('彩蛋：多重叠加（生日+第一签+早起）', () => {
  const eggs = computeEggs({ streak: 7, hour: 6, isBirthday: true, isFirstOfDay: true });
  assert.strictEqual(eggTotal(eggs), 30 + 50 + 10 + 5);
});

t('彩蛋：streak=0/undefined 不报错', () => {
  assert.deepStrictEqual(computeEggs({ streak: 0, hour: NaN }), []);
  assert.deepStrictEqual(computeEggs({}), []);
});

console.log(`\n完成：${passed} 项通过${process.exitCode ? '（存在失败）' : ''}`);
