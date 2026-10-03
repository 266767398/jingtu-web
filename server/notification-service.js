/**
 * 境途同游 V6.14 — 通知服务模块
 * 支持：WebSocket 推送、数据库存储、邮件通知（统一走 mailer 队列）
 * 修复：使用 target_type/target_id/post_id 替代单一 related_id，解决语义歧义
 * 新增：检查用户通知设置（browser/email/sound）
 */
const { getPool, safeError } = require('./utils');
const mailer = require('./mailer');
const wsService = require('./ws_service');

class NotificationService {
  static SETTINGS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
  static SETTINGS_CACHE_MAX = 5000;

  constructor() {
    this._settingsCache = new Map();
  }

  setWSReferences() {
  }

  // P3-49: 设置缓存带 TTL（1 小时）与容量上限，防止永不读到的用户条目无限增长
  async getUserSettings(userId) {
    const cached = this._settingsCache.get(userId);
    if (cached && Date.now() - cached.at < NotificationService.SETTINGS_CACHE_TTL_MS) {
      return cached.settings;
    }
    if (cached) this._settingsCache.delete(userId);
    try {
      const [rows] = await getPool().query(`SELECT notification_settings FROM users WHERE id = ?`, [userId]);
      if (rows.length === 0) {
        return { browser: true, email: false, sound: true };
      }
      const settings = rows[0].notification_settings ? JSON.parse(rows[0].notification_settings) : {};
      const result = {
        browser: settings.browser !== false,
        email: settings.email || false,
        sound: settings.sound !== false
      };
      // 容量兜底：超过上限整体清空（缓存只是每用户省 1 次查询的优化，重建代价低）
      if (this._settingsCache.size >= NotificationService.SETTINGS_CACHE_MAX) {
        this._settingsCache.clear();
      }
      this._settingsCache.set(userId, { at: Date.now(), settings: result });
      return result;
    } catch (e) {
      console.warn('⚠️ 获取用户通知设置失败:', e.message);
      return { browser: true, email: false, sound: true };
    }
  }

  invalidateSettingsCache(userId) {
    this._settingsCache.delete(userId);
  }

  async createNotification(userId, type, title, message, target = {}) {
    try {
      const { relatedId = null, targetType = null, targetId = null, postId = null } = target;
      await getPool().query(
        `INSERT INTO notifications (user_id, type, title, message, related_id, target_type, target_id, post_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, type, title, message, relatedId, targetType, targetId, postId]
      );
    } catch (e) {
      console.warn('⚠️ 创建通知失败:', e.message);
    }
  }

  async notifyAllMembers(type, title, message, target = {}) {
    try {
      const [users] = await getPool().query(`SELECT id FROM users WHERE deleted_at IS NULL AND banned = 0`);
      await this._bulkFanOut(users.map(u => u.id), type, title, message, target);
    } catch (e) {
      console.warn('⚠️ 群发通知失败:', e.message);
    }
  }

  // 通知所有管理员（super_admin/admin），用于安全告警等场景
  async notifyAllAdmins(type, title, message, target = {}) {
    try {
      const [admins] = await getPool().query(
        `SELECT id FROM users WHERE deleted_at IS NULL AND banned = 0 AND role IN ('super_admin','admin')`
      );
      await this._bulkFanOut(admins.map(a => a.id), type, title, message, target);
    } catch (e) {
      console.warn('⚠️ 管理员群发通知失败:', e.message);
    }
  }

  // P2-82 批量扇出：原先每人一次 notifyUser（INSERT + 设置 SELECT 串行往返），
  // 万人群为分钟级阻塞。改为按 500 人分块：多行 INSERT 一次落库、设置一次查回；
  // WS 推送仍逐用户（尊重个人 browser 设置、走 broadcastToUser），邮件仍 fire-and-forget 进队列。
  // 失败语义与原逐人路径一致：INSERT 分块失败仅告警不阻断推送；设置查询失败回落默认设置（不写缓存）。
  async _bulkFanOut(userIds, type, title, message, target = {}) {
    if (!userIds || userIds.length === 0) return;
    const { relatedId = null, targetType = null, targetId = null, postId = null } = target;
    const CHUNK = 500;
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const slice = userIds.slice(i, i + CHUNK);
      try {
        const values = [];
        for (const id of slice) values.push(id, type, title, message, relatedId, targetType, targetId, postId);
        await getPool().query(
          `INSERT INTO notifications (user_id, type, title, message, related_id, target_type, target_id, post_id)
           VALUES ${slice.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          values
        );
      } catch (e) {
        console.warn('⚠️ 批量创建通知失败:', e.message);
      }
      let rows = null;
      try {
        [rows] = await getPool().query(`SELECT id, notification_settings FROM users WHERE id IN (?)`, [slice]);
      } catch (e) {
        console.warn('⚠️ 批量查询通知设置失败:', e.message);
      }
      if (rows) {
        for (const row of rows) {
          let settings = null;
          try {
            const parsed = row.notification_settings ? JSON.parse(row.notification_settings) : {};
            settings = {
              browser: parsed.browser !== false,
              email: parsed.email || false,
              sound: parsed.sound !== false
            };
          } catch (e) {
            settings = null;
          }
          if (settings) this._settingsCache.set(row.id, settings);
          else settings = { browser: true, email: false, sound: true };
          this._deliver(settings, row.id, type, title, message, target);
        }
      } else {
        for (const id of slice) {
          this._deliver({ browser: true, email: false, sound: true }, id, type, title, message, target);
        }
      }
    }
  }

  _deliver(settings, userId, type, title, message, target) {
    if (settings.browser) {
      this.pushToUserWS(userId, type, { title, message, ...target });
    }
    if (settings.email) {
      this.sendEmailNotification(userId, title, message).catch(() => {});
    }
  }

  broadcastWS(type, payload) {
    try {
      wsService.broadcastAllExcept(null, { 
        type: 'notification', 
        payload: { ...payload, notificationType: type } 
      });
    } catch (e) {
      console.warn('⚠️ WebSocket 广播失败:', e.message);
    }
  }

  async notifyUser(userId, type, title, message, target = {}) {
    await this.createNotification(userId, type, title, message, target);
    const settings = await this.getUserSettings(userId);
    this._deliver(settings, userId, type, title, message, target);
  }

  async sendEmailNotification(userId, title, message) {
    if (!mailer.isMailerEnabled()) return;
    try {
      const [rows] = await getPool().query(`SELECT email, display_name FROM users WHERE id = ?`, [userId]);
      if (rows.length === 0 || !rows[0].email) return;
      const user = rows[0];
      // 统一走 mailer 队列（含重试与限速），不再自建 transporter
      const html = `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:20px;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;font-size:20px;">境途同游</h1>
          </div>
          <div style="border:1px solid #eee;border-top:none;padding:20px;">
            <h2 style="color:#333;margin:0 0 15px;">${title}</h2>
            <p style="color:#666;line-height:1.6;">${message.replace(/\n/g, '<br>')}</p>
          </div>
          <div style="text-align:center;color:#999;font-size:12px;padding:15px;border-top:1px solid #eee;">
            <p>这是一封自动发送的通知邮件，请勿回复。</p>
          </div>
        </div>`;
      const result = mailer.sendEmail(user.email, `【境途同游】${title}`, html, `${message}\n\n-- 境途同游团队`);
      if (!result.success) {
        console.warn('⚠️ 发送邮件通知失败:', result.error);
      }
    } catch (e) {
      console.warn('⚠️ 发送邮件通知失败:', e.message);
    }
  }

  pushToUserWS(userId, type, payload) {
    try {
      wsService.broadcastToUser(userId, { 
        type: 'notification', 
        payload: { ...payload, notificationType: type } 
      });
    } catch (e) {
      console.warn('⚠️ WebSocket 推送失败:', e.message);
    }
  }

  async getNotifications(userId, limit = 50) {
    try {
      const [rows] = await getPool().query(
        `SELECT id, type, title, message, related_id AS relatedId, 
                target_type AS targetType, target_id AS targetId, post_id AS postId,
                is_read AS isRead, created_at AS createdAt
         FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [userId, limit]
      );
      return rows;
    } catch (e) {
      console.error('获取通知列表失败:', e.message);
      return [];
    }
  }

  async markAsRead(userId, notificationId = null) {
    try {
      if (notificationId) {
        await getPool().query(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [notificationId, userId]);
      } else {
        await getPool().query(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [userId]);
      }
      return true;
    } catch (e) {
      console.error('标记通知已读失败:', e.message);
      return false;
    }
  }

  async getUnreadCount(userId) {
    try {
      const [[{ count }]] = await getPool().query(`SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0`, [userId]);
      return count || 0;
    } catch (e) {
      console.error('获取未读通知数失败:', e.message);
      return 0;
    }
  }
}

const notificationService = new NotificationService();

module.exports = notificationService;