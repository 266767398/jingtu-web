/**
 * 境途同游 V7.11 — 每日运势签 & 签到彩蛋（纯逻辑模块）
 *
 * 设计要点：
 * - 运势按 hash(userId + 日期) 确定性抽取：同一用户同一天无论何时查询结果一致，
 *   因此无需随机种子持久化，刷新页面后 /me/status 仍可复算/读取。
 * - 彩蛋在签到瞬间判定（连签、生日、当日第一签、时段），结果以 "key:points" 串持久化到
 *   user_checkin.eggs，供刷新后展示。
 * - 本模块只做纯计算与常量定义，不依赖数据库 / Express，便于单测。
 */

// 运势档位：权重合计 = 100（百分比）
const FORTUNE_TIERS = [
  { key: 'daji',    icon: '🌟', mult: 3,   weight: 5 },
  { key: 'ji',      icon: '🍀', mult: 2,   weight: 15 },
  { key: 'zhongji', icon: '🌤️', mult: 1.5, weight: 30 },
  { key: 'xiaoji',  icon: '☁️', mult: 1,   weight: 35 },
  { key: 'moji',    icon: '⛈️', mult: 0.5, weight: 15 }
];

const FORTUNE_BY_KEY = Object.fromEntries(FORTUNE_TIERS.map(t => [t.key, t]));

// FNV-1a 32-bit：足够均匀且跨进程/重启稳定（不依赖 Math.random）
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 抽取当日运势档位（确定性）。
 * @param {number|string} userId
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {{key:string, icon:string, mult:number}}
 */
function rollFortune(userId, dateStr) {
  const seed = fnv1a(`jingtu-fortune:${userId}:${dateStr}`);
  // 取 0..99.99，按权重累计命中
  const r = (seed % 10000) / 100;
  let acc = 0;
  for (const tier of FORTUNE_TIERS) {
    acc += tier.weight;
    if (r < acc) return { key: tier.key, icon: tier.icon, mult: tier.mult };
  }
  return { key: 'xiaoji', icon: '☁️', mult: 1 };
}

/**
 * 计算签到彩蛋。
 * @param {{streak:number, hour:number, isBirthday:boolean, isFirstOfDay:boolean}} ctx
 * @returns {{key:string, points:number}[]}
 */
function computeEggs(ctx) {
  const eggs = [];
  const streak = Number(ctx.streak) || 0;
  // 连签彩蛋：精确命中档位（第7天触发七连击，第30天触发月签达人）
  if (streak === 7) eggs.push({ key: 'streak_7', points: 30 });
  else if (streak === 30) eggs.push({ key: 'streak_30', points: 150 });

  if (ctx.isBirthday) eggs.push({ key: 'birthday', points: 50 });
  if (ctx.isFirstOfDay) eggs.push({ key: 'first_of_day', points: 10 });

  const hour = Number(ctx.hour);
  if (!Number.isNaN(hour)) {
    // 早起鸟 05:00-07:59 / 夜猫子 23:00-03:59，两者互斥（else if）
    if (hour >= 5 && hour < 8) eggs.push({ key: 'early_bird', points: 5 });
    else if (hour >= 23 || hour < 4) eggs.push({ key: 'night_owl', points: 5 });
  }

  return eggs;
}

/** 彩蛋总数 */
function eggTotal(eggs) {
  return eggs.reduce((s, e) => s + (Number(e.points) || 0), 0);
}

module.exports = { FORTUNE_TIERS, FORTUNE_BY_KEY, fnv1a, rollFortune, computeEggs, eggTotal };
