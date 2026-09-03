/**
 * 境途同游 V6.14 — 通知服务模块
 * 支持：WebSocket 推送、数据库存储、邮件通知
 * 修复：使用 target_type/target_id/post_id 替代单一 related_id，解决语义歧义
 * 新增：检查用户通知设置（browser/email/sound）
 */
const { getPool, safeError } = require('./utils');
const nodemailer = require('nodemailer');
const wsService = require('./ws_service');

class NotificationService {
  constructor() {
    this._settingsCache = new Map();
    this._emailTransporter = null;
    this._initEmail();
  }

  _initEmail() {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpSecure = process.env.SMTP_SECURE === 'true';
    if (smtpHost && smtpUser && smtpPass) {
      this._emailTransporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort) || 587,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });
      console.log('📧 邮件通知服务已初始化');
    }
  }

  setWSReferences() {
  }

  async getUserSettings(userId) {
    if (this._settingsCache.has(userId)) {
      return this._settingsCache.get(userId);
    }
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
      this._settingsCache.set(userId, result);
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
      for (const u of users) {
        await this.notifyUser(u.id, type, title, message, target);
      }
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
      for (const a of admins) {
        await this.notifyUser(a.id, type, title, message, target);
      }
    } catch (e) {
      console.warn('⚠️ 管理员群发通知失败:', e.message);
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
    if (settings.browser) {
      this.pushToUserWS(userId, type, { title, message, ...target });
    }
    if (settings.email) {
      this.sendEmailNotification(userId, title, message).catch(() => {});
    }
  }

  async sendEmailNotification(userId, title, message) {
    if (!this._emailTransporter) return;
    try {
      const [rows] = await getPool().query(`SELECT email, display_name FROM users WHERE id = ?`, [userId]);
      if (rows.length === 0 || !rows[0].email) return;
      const user = rows[0];
      await this._emailTransporter.sendMail({
        from: process.env.SMTP_FROM || 'JingTu <noreply@jingtu.com>',
        to: user.email,
        subject: `【境途同游】${title}`,
        text: `${message}\n\n-- 境途同游团队`,
        html: `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
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
        </div>`
      });
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