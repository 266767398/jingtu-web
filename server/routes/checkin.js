/**
 * 境途同游 — 用户签到系统路由
 * 
 * @swagger
 * tags:
 *   name: Checkin
 *   description: 用户签到相关接口
 */
const express = require('express');
const router = express.Router();
const { getPool, handleError, paginate } = require('../utils');
const { requireAuth } = require('../auth');
const { checkAndUnlock } = require('./achievements');

// 本地日期字符串（YYYY-MM-DD）：避免 toISOString() 的 UTC 偏移导致按本地时区误判"今天"与连续签到天数
function ymd(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
// 两个 YYYY-MM-DD 之间的天数差（b - a），用 Date.UTC 构造消除时区干扰
function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// P2-79：原 ensureCheckinUniqueIndex() 一次性裸 ALTER 迁移已从请求路径移除，
// 改由 db_init.js 启动初始化统一补建（新库建表自带 uk_user_date，老库兼容 ALTER）。
// 此处签到写入依赖该唯一索引 + 显式 INSERT（冲突即已签到），并发安全不受影响。

router.post('/me/checkin', requireAuth, async (req, res) => {
  const conn = await getPool().getConnection();
  try {
    const userId = req.session.userId;
    const today = ymd(new Date());

    await conn.beginTransaction();

    // 行级检查（用于返回友好的 alreadyCheckedIn 提示）
    const [existing] = await conn.query(
      'SELECT id FROM user_checkin WHERE user_id = ? AND checkin_date = ?',
      [userId, today]
    );

    if (existing.length > 0) {
      await conn.rollback();
      return res.json({
        success: false,
        message: '今天已经签到过了',
        alreadyCheckedIn: true
      });
    }

    const [lastCheckin] = await conn.query(
      'SELECT checkin_date, streak FROM user_checkin WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 1',
      [userId]
    );

    let streak = 1;
    let points = 10;

    if (lastCheckin.length > 0) {
      const diffDays = dayDiff(ymd(lastCheckin[0].checkin_date), today);

      if (diffDays === 1) {
        streak = lastCheckin[0].streak + 1;
      } else if (diffDays > 1) {
        streak = 1;
      }
    }

    const [reward] = await conn.query(
      'SELECT points, badge FROM checkin_rewards WHERE streak <= ? ORDER BY streak DESC LIMIT 1',
      [streak]
    );

    if (reward.length > 0) {
      points = reward[0].points;
    }

    // 依赖 UNIQUE(user_id, checkin_date) 防止并发重复签到
    try {
      await conn.query(
        'INSERT INTO user_checkin (user_id, checkin_date, checkin_time, streak, points) VALUES (?, ?, NOW(), ?, ?)',
        [userId, today, streak, points]
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        await conn.rollback();
        return res.json({
          success: false,
          message: '今天已经签到过了',
          alreadyCheckedIn: true
        });
      }
      throw e;
    }

    // §P3-170: 原子自增 + 行锁，避免 read-then-write 竞态（FOR UPDATE 在 SQLite 模式由 transformSQL 剥离并告警，已依赖 BEGIN IMMEDIATE）
    const [userRes] = await conn.query(
      'SELECT total_checkins, current_streak, max_streak, checkin_points FROM users WHERE id = ? FOR UPDATE',
      [userId]
    );

    const currentUser = userRes[0] || { total_checkins: 0, current_streak: 0, max_streak: 0, checkin_points: 0 };
    const newMaxStreak = Math.max(currentUser.max_streak, streak);

    // current_streak 用 GREATEST 幂等兜底：并发下即使读快照略旧，也不回退已提交的更高连续天数
    await conn.query(
      'UPDATE users SET total_checkins = total_checkins + 1, current_streak = GREATEST(current_streak, ?), max_streak = GREATEST(max_streak, ?), checkin_points = checkin_points + ?, last_checkin_date = ? WHERE id = ?',
      [streak, streak, points, today, userId]
    );

    await conn.commit();

    const newTotalCheckins = currentUser.total_checkins + 1;
    const newPoints = currentUser.checkin_points + points;
    const newCurrentStreak = streak;

    res.json({
      success: true,
      message: `签到成功！获得 ${points} 积分`,
      streak,
      points,
      totalCheckins: newTotalCheckins,
      currentStreak: newCurrentStreak,
      maxStreak: Math.max(newMaxStreak, streak),
      checkinPoints: newPoints,
      todayCheckedIn: true
    });

    await checkAndUnlock(userId, 'checkin', { total: newTotalCheckins, streak: newCurrentStreak });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    handleError(res, e, '[checkin/checkin]');
  } finally {
    conn.release();
  }
});

router.get('/me/status', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const today = ymd(new Date());
    
    const [checkinToday] = await getPool().query(
      'SELECT * FROM user_checkin WHERE user_id = ? AND checkin_date = ?',
      [userId, today]
    );
    
    const [userRes] = await getPool().query(
      'SELECT total_checkins, current_streak, max_streak, checkin_points, last_checkin_date FROM users WHERE id = ?',
      [userId]
    );
    
    const user = userRes[0] || { total_checkins: 0, current_streak: 0, max_streak: 0, checkin_points: 0, last_checkin_date: null };
    
    const [rewards] = await getPool().query('SELECT * FROM checkin_rewards ORDER BY streak ASC');
    
    const [recent] = await getPool().query(
      'SELECT checkin_date, streak, points FROM user_checkin WHERE user_id = ? ORDER BY checkin_date DESC LIMIT 7',
      [userId]
    );
    
    res.json({
      todayCheckedIn: checkinToday.length > 0,
      totalCheckins: user.total_checkins,
      currentStreak: user.current_streak,
      maxStreak: user.max_streak,
      checkinPoints: user.checkin_points,
      lastCheckinDate: user.last_checkin_date,
      rewards: rewards.map(r => ({
        streak: r.streak,
        points: r.points,
        badge: r.badge,
        description: r.description,
        achieved: user.max_streak >= r.streak
      })),
      recentCheckins: recent.map(r => ({
        date: r.checkin_date,
        streak: r.streak,
        points: r.points
      }))
    });
  } catch (e) {
    handleError(res, e, '[checkin/status]');
  }
});

router.get('/me/history', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { page, pageSize, offset } = paginate(req, { defaultSize: 30, maxSize: 100 });
    
    const [count] = await getPool().query(
      'SELECT COUNT(*) as total FROM user_checkin WHERE user_id = ?',
      [userId]
    );
    
    const [rows] = await getPool().query(
      'SELECT checkin_date, checkin_time, streak, points FROM user_checkin WHERE user_id = ? ORDER BY checkin_date DESC LIMIT ? OFFSET ?',
      [userId, pageSize, offset]
    );
    
    res.json({
      history: rows,
      total: count[0].total,
      page,
      pageSize
    });
  } catch (e) {
    handleError(res, e, '[checkin/history]');
  }
});

router.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(`
      SELECT u.id, u.display_name, u.total_checkins, u.current_streak, u.max_streak, u.checkin_points
      FROM users u
      WHERE u.deleted_at IS NULL AND u.total_checkins > 0
      ORDER BY u.total_checkins DESC, u.current_streak DESC
      LIMIT 50
    `);
    
    const leaderboard = rows.map((u, index) => ({
      rank: index + 1,
      userId: u.id,
      displayName: u.display_name,
      totalCheckins: u.total_checkins,
      currentStreak: u.current_streak,
      maxStreak: u.max_streak,
      checkinPoints: u.checkin_points
    }));
    
    res.json({ leaderboard });
  } catch (e) {
    handleError(res, e, '[checkin/leaderboard]');
  }
});

router.get('/rewards', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    const [userRes] = await getPool().query(
      'SELECT max_streak, checkin_points FROM users WHERE id = ?',
      [userId]
    );
    
    const user = userRes[0] || { max_streak: 0, checkin_points: 0 };
    
    const [rewards] = await getPool().query('SELECT * FROM checkin_rewards ORDER BY streak ASC');
    
    res.json({
      rewards: rewards.map(r => ({
        streak: r.streak,
        points: r.points,
        badge: r.badge,
        description: r.description,
        achieved: user.max_streak >= r.streak
      })),
      userMaxStreak: user.max_streak,
      userPoints: user.checkin_points
    });
  } catch (e) {
    handleError(res, e, '[checkin/rewards]');
  }
});

module.exports = router;