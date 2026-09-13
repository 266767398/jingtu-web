/**
 * 运势/彩蛋模块单元测试（P3-7：原 scripts/test_fortune.js 接入 Jest）。
 *
 * 背景：旧脚本用裸 assert + 自造 t()  runner，永远不在 `npx jest` 里执行，
 * 13+ 项断言形同虚设。本文件将其逐条移植为 Jest test，断言语义与原脚本一致：
 *   - rollFortune：权重合计、确定性、档位合法性、万次分布偏差（0.4×–1.6×）、档位多样性
 *   - computeEggs / eggTotal：连签 7/30 天互斥、生日、当日首签、早起鸟/夜猫子时段、
 *     非触发时段、多重叠加合计、streak=0/NaN/{} 的容错
 *
 * 运行：cd server && npx jest __tests__/fortune.test.js
 */

const { FORTUNE_TIERS, rollFortune, computeEggs, eggTotal } = require('../fortune');

describe('rollFortune 运势档位', () => {
  test('运势档位权重合计为 100', () => {
    const sum = FORTUNE_TIERS.reduce((s, x) => s + x.weight, 0);
    expect(sum).toBe(100);
  });

  test('rollFortune 确定性：同参数多次调用结果一致', () => {
    const a = rollFortune(42, '2026-08-20');
    for (let i = 0; i < 50; i++) {
      expect(rollFortune(42, '2026-08-20')).toEqual(a);
    }
  });

  test('rollFortune 返回合法档位', () => {
    const keys = new Set(FORTUNE_TIERS.map(x => x.key));
    for (let uid = 1; uid <= 300; uid++) {
      const f = rollFortune(uid, '2026-08-20');
      expect(keys.has(f.key)).toBe(true);
      expect(typeof f.mult).toBe('number');
    }
  });

  // 分布测试单独实现（避免模板陷阱），与原脚本一致
  test('rollFortune 分布检查', () => {
    const counts = {};
    for (let uid = 1; uid <= 10000; uid++) {
      const k = rollFortune(uid, '2026-08-20').key;
      counts[k] = (counts[k] || 0) + 1;
    }
    for (const tier of FORTUNE_TIERS) {
      const pct = ((counts[tier.key] || 0) / 100);
      expect(pct).toBeGreaterThan(tier.weight * 0.4);
      expect(pct).toBeLessThan(tier.weight * 1.6);
    }
  });

  test('不同日期运势可以不同（300 个用户里至少出现两种档位）', () => {
    const keys = new Set();
    for (let uid = 1; uid <= 300; uid++) keys.add(rollFortune(uid, '2026-08-20').key);
    expect(keys.size).toBeGreaterThanOrEqual(2);
  });
});

describe('computeEggs / eggTotal 彩蛋', () => {
  test('彩蛋：连签7天触发 streak_7 +30', () => {
    const eggs = computeEggs({ streak: 7, hour: 12 });
    expect(eggs).toEqual([{ key: 'streak_7', points: 30 }]);
  });

  test('彩蛋：连签30天触发 streak_30 +150（不再触发7天档）', () => {
    const eggs = computeEggs({ streak: 30, hour: 12 });
    expect(eggs).toEqual([{ key: 'streak_30', points: 150 }]);
  });

  test('彩蛋：生日当天 +50', () => {
    const eggs = computeEggs({ streak: 1, hour: 12, isBirthday: true });
    expect(eggs.some(e => e.key === 'birthday' && e.points === 50)).toBe(true);
  });

  test('彩蛋：当日第一签 +10', () => {
    const eggs = computeEggs({ streak: 1, hour: 12, isFirstOfDay: true });
    expect(eggs.some(e => e.key === 'first_of_day' && e.points === 10)).toBe(true);
  });

  test('彩蛋：早起鸟 05:00-07:59 +5', () => {
    for (const h of [5, 6, 7]) {
      const eggs = computeEggs({ streak: 1, hour: h });
      expect(eggs.some(e => e.key === 'early_bird')).toBe(true);
    }
  });

  test('彩蛋：夜猫子 23:00-03:59 +5', () => {
    for (const h of [23, 0, 1, 3]) {
      const eggs = computeEggs({ streak: 1, hour: h });
      expect(eggs.some(e => e.key === 'night_owl')).toBe(true);
    }
  });

  test('彩蛋：8点/22点不触发时段彩蛋', () => {
    for (const h of [4, 8, 12, 22]) {
      const eggs = computeEggs({ streak: 1, hour: h });
      expect(eggs.some(e => e.key === 'early_bird' || e.key === 'night_owl')).toBe(false);
    }
  });

  test('彩蛋：多重叠加（生日+第一签+早起）', () => {
    const eggs = computeEggs({ streak: 7, hour: 6, isBirthday: true, isFirstOfDay: true });
    expect(eggTotal(eggs)).toBe(30 + 50 + 10 + 5);
  });

  test('彩蛋：streak=0/undefined 不报错', () => {
    expect(computeEggs({ streak: 0, hour: NaN })).toEqual([]);
    expect(computeEggs({})).toEqual([]);
  });
});
