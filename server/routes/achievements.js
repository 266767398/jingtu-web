/**
 * 境途同游 — 成就勋章系统路由
 * 
 * @swagger
 * tags:
 *   name: Achievements
 *   description: 成就勋章相关接口
 */
const express = require('express');
const router = express.Router();
const { getPool, handleError } = require('../utils');
const { requireAuth } = require('../auth');
const logger = require('../logger');

async function checkAndUnlock(userId, type, data) {
  try {
    const pool = getPool();
    const [achievements] = await pool.query(
      'SELECT * FROM achievements WHERE type = ? AND is_active = 1',
      [type]
    );
    
    let unlockedCount = 0;
    const unlockedAchievements = [];
    
    for (const achievement of achievements) {
      const [userAchievement] = await pool.query(
        'SELECT * FROM user_achievements WHERE user_id = ? AND achievement_id = ?',
        [userId, achievement.id]
      );
      
      let progress = data.value !== undefined ? data.value : data;
      if (achievement.condition_type === 'streak') {
        progress = data.streak !== undefined ? data.streak : (data.value !== undefined ? data.value : data);
      } else if (achievement.condition_type === 'total') {
        progress = data.total !== undefined ? data.total : (data.value !== undefined ? data.value : data);
      } else {
        progress = data.value !== undefined ? data.value : data;
      }
      
      if (progress >= achievement.condition_value) {
        if (userAchievement.length === 0) {
          await pool.query(
            'INSERT INTO user_achievements (user_id, achievement_id, progress, is_unlocked, unlocked_at) VALUES (?, ?, ?, 1, NOW())',
            [userId, achievement.id, progress]
          );
          await pool.query(
            'UPDATE users SET achievement_points = achievement_points + ? WHERE id = ?',
            [achievement.points, userId]
          );
          unlockedCount++;
          unlockedAchievements.push(achievement);
        } else if (!userAchievement[0].is_unlocked) {
          await pool.query(
            'UPDATE user_achievements SET progress = ?, is_unlocked = 1, unlocked_at = NOW() WHERE user_id = ? AND achievement_id = ?',
            [progress, userId, achievement.id]
          );
          await pool.query(
            'UPDATE users SET achievement_points = achievement_points + ? WHERE id = ?',
            [achievement.points, userId]
          );
          unlockedCount++;
          unlockedAchievements.push(achievement);
        } else if (progress > userAchievement[0].progress) {
          await pool.query(
            'UPDATE user_achievements SET progress = ? WHERE user_id = ? AND achievement_id = ?',
            [progress, userId, achievement.id]
          );
        }
      } else {
        if (userAchievement.length === 0) {
          await pool.query(
            'INSERT INTO user_achievements (user_id, achievement_id, progress) VALUES (?, ?, ?)',
            [userId, achievement.id, progress]
          );
        } else {
          await pool.query(
            'UPDATE user_achievements SET progress = ? WHERE user_id = ? AND achievement_id = ?',
            [progress, userId, achievement.id]
          );
        }
      }
    }
    
    return { unlockedCount, unlockedAchievements };
  } catch (e) {
    logger.error('achievements', 'checkAndUnlock:', e);
    return { unlockedCount: 0, unlockedAchievements: [] };
  }
}

router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [userAchievements] = await getPool().query(`
      SELECT
        a.id AS achievement_id, a.key_name, a.name, a.description, a.icon, a.type,
        a.condition_type, a.condition_value, a.points, a.rarity,
        COALESCE(ua.progress, 0) AS progress,
        COALESCE(ua.is_unlocked, 0) AS is_unlocked,
        ua.unlocked_at
      FROM achievements a
      LEFT JOIN user_achievements ua
        ON ua.achievement_id = a.id AND ua.user_id = ?
      WHERE a.is_active = 1
      ORDER BY a.rarity DESC, ua.unlocked_at DESC, a.id ASC
    `, [userId]);
    const [userRes] = await getPool().query(
      'SELECT achievement_points FROM users WHERE id = ?',
      [userId]
    );
    const [totalAchievements] = await getPool().query(
      'SELECT COUNT(*) as total FROM achievements WHERE is_active = 1'
    );
    const unlockedCount = userAchievements.filter(ua => ua.is_unlocked).length;
    
    res.json({
      achievements: userAchievements.map(ua => ({
        id: ua.achievement_id,
        keyName: ua.key_name,
        name: ua.name,
        description: ua.description,
        icon: ua.icon,
        type: ua.type,
        conditionType: ua.condition_type,
        conditionValue: ua.condition_value,
        progress: ua.progress,
        isUnlocked: !!ua.is_unlocked,
        unlockedAt: ua.unlocked_at,
        points: ua.points,
        rarity: ua.rarity,
        // condition_value 为 0/NULL 时会算出 Infinity 或 NaN，前端拿去写 width 会直接崩样式
        percentage: ua.condition_value > 0
          ? Math.min(100, Math.round((ua.progress / ua.condition_value) * 100))
          : 0
      })),
      totalAchievements: totalAchievements[0].total,
      unlockedCount,
      lockedCount: totalAchievements[0].total - unlockedCount,
      achievementPoints: userRes[0]?.achievement_points || 0
    });
  } catch (e) { handleError(res, e, '[achievements/me]'); }
});

router.get('/me/type/:type', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const type = req.params.type;
    
    const [userAchievements] = await getPool().query(`
      SELECT
        a.id AS achievement_id, a.key_name, a.name, a.description, a.icon, a.type,
        a.condition_type, a.condition_value, a.points, a.rarity,
        COALESCE(ua.progress, 0) AS progress,
        COALESCE(ua.is_unlocked, 0) AS is_unlocked,
        ua.unlocked_at
      FROM achievements a
      LEFT JOIN user_achievements ua
        ON ua.achievement_id = a.id AND ua.user_id = ?
      WHERE a.is_active = 1 AND a.type = ?
      ORDER BY a.rarity DESC, ua.unlocked_at DESC, a.id ASC
    `, [userId, type]);
    
    res.json({
      achievements: userAchievements.map(ua => ({
        id: ua.achievement_id,
        keyName: ua.key_name,
        name: ua.name,
        description: ua.description,
        icon: ua.icon,
        type: ua.type,
        conditionType: ua.condition_type,
        conditionValue: ua.condition_value,
        progress: ua.progress,
        isUnlocked: !!ua.is_unlocked,
        unlockedAt: ua.unlocked_at,
        points: ua.points,
        rarity: ua.rarity,
        percentage: ua.condition_value > 0
          ? Math.min(100, Math.round((ua.progress / ua.condition_value) * 100))
          : 0
      }))
    });
  } catch (e) { handleError(res, e, '[achievements/me/type]'); }
});

router.get('/me/unlocked', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    const [userAchievements] = await getPool().query(`
      SELECT ua.unlocked_at, a.id AS achievement_id, a.key_name, a.name, a.description,
             a.icon, a.type, a.points, a.rarity
      FROM user_achievements ua
      JOIN achievements a ON ua.achievement_id = a.id
      WHERE ua.user_id = ? AND ua.is_unlocked = 1
      ORDER BY ua.unlocked_at DESC
    `, [userId]);
    
    res.json({
      unlocked: userAchievements.map(ua => ({
        id: ua.achievement_id,
        keyName: ua.key_name,
        name: ua.name,
        description: ua.description,
        icon: ua.icon,
        type: ua.type,
        points: ua.points,
        rarity: ua.rarity,
        unlockedAt: ua.unlocked_at
      }))
    });
  } catch (e) { handleError(res, e, '[achievements/me/unlocked]'); }
});

router.get('/me/locked', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    
    const [userAchievements] = await getPool().query(`
      SELECT
        a.id AS achievement_id, a.key_name, a.name, a.description, a.icon, a.type,
        a.condition_type, a.condition_value, a.points, a.rarity,
        COALESCE(ua.progress, 0) AS progress
      FROM achievements a
      LEFT JOIN user_achievements ua
        ON ua.achievement_id = a.id AND ua.user_id = ?
      WHERE a.is_active = 1 AND (ua.is_unlocked = 0 OR ua.is_unlocked IS NULL)
      ORDER BY a.rarity DESC, a.id ASC
    `, [userId]);
    
    res.json({
      locked: userAchievements.map(ua => ({
        id: ua.achievement_id,
        keyName: ua.key_name,
        name: ua.name,
        description: ua.description,
        icon: ua.icon,
        type: ua.type,
        conditionType: ua.condition_type,
        conditionValue: ua.condition_value,
        progress: ua.progress || 0,
        points: ua.points,
        rarity: ua.rarity,
        percentage: ua.condition_value > 0
          ? Math.min(100, Math.round((ua.progress / ua.condition_value) * 100))
          : 0
      }))
    });
  } catch (e) { handleError(res, e, '[achievements/me/locked]'); }
});

router.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(`
      SELECT u.id, u.display_name, u.achievement_points, 
        (SELECT COUNT(*) FROM user_achievements ua WHERE ua.user_id = u.id AND ua.is_unlocked = 1) as unlocked_count
      FROM users u
      WHERE u.deleted_at IS NULL AND u.achievement_points > 0
      ORDER BY u.achievement_points DESC, unlocked_count DESC
      LIMIT 50
    `);
    
    const leaderboard = rows.map((u, index) => ({
      rank: index + 1,
      userId: u.id,
      displayName: u.display_name,
      achievementPoints: u.achievement_points,
      unlockedCount: u.unlocked_count
    }));
    
    res.json({ leaderboard });
  } catch (e) { handleError(res, e, '[achievements/leaderboard]'); }
});

router.get('/types', requireAuth, async (req, res) => {
  try {
    const [types] = await getPool().query(`
      SELECT type, COUNT(*) as count FROM achievements WHERE is_active = 1 GROUP BY type
    `);
    
    res.json({
      types: types.map(t => ({
        type: t.type,
        count: t.count,
        label: {
          checkin: '签到',
          post: '动态',
          like: '点赞',
          comment: '评论',
          event: '活动',
          chat: '聊天',
          album: '相册',
          member: '用户',
          vrc: 'VRChat'
        }[t.type] || t.type
      }))
    });
  } catch (e) { handleError(res, e, '[achievements/types]'); }
});

module.exports = router;
router.checkAndUnlock = checkAndUnlock;