const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { encryptCookie, decryptCookie } = require('./utils');

let transporter = null;
let isEnabled = false;

const mailQueue = [];
let isProcessing = false;
const MAX_RETRIES = 3;

// P3-73: 队列上限 + 落盘持久化——突发群发不再无限堆内存；进程重启从磁盘恢复未发送邮件
const MAIL_QUEUE_MAX = parseInt(process.env.MAIL_QUEUE_MAX, 10) || 1000;
const QUEUE_INTERVAL_MS_FAST = parseInt(process.env.MAIL_QUEUE_INTERVAL_MS, 10) || 250; 
const QUEUE_INTERVAL_MS_SLOW = 1000; 
const PERSIST_FILE = process.env.MAIL_QUEUE_FILE || path.join(__dirname, '..', 'runtime', 'mail_queue.json');

function _persistQueue() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    fs.mkdirSync(path.dirname(PERSIST_FILE), { recursive: true });
    // AUTH-6：落盘前对邮件正文（含 OTP/重置链接等敏感内容）加密，
    // 本地读取者拿到 mail_queue.json 也无法直接提取重置码/令牌
    const snapshot = mailQueue.slice(0, MAIL_QUEUE_MAX).map(item => ({
      ...item,
      html: _encryptBody(item.html),
      text: _encryptBody(item.text)
    }));
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(snapshot));
  } catch (e) {
    logger.error('mailer', '[mailer] 邮件队列落盘失败:', e.message);
  }
}

// ENCRYPT_KEY 缺失/长度不足时宁可置为占位符，也绝不落盘明文正文
function _encryptBody(content) {
  if (content == null || content === '') return null;
  const enc = encryptCookie(String(content));
  return enc || '[redacted]';
}

function _decryptBody(stored) {
  if (stored == null || stored === '' || stored === '[redacted]') return null;
  // decryptCookie 对无 enc: 前缀的旧版明文会原样返回，天然兼容历史 mail_queue.json
  return decryptCookie(String(stored));
}

function _loadQueue() {
  if (process.env.NODE_ENV === 'test') return;
  try {
    if (!fs.existsSync(PERSIST_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!item || !item.to || mailQueue.length >= MAIL_QUEUE_MAX) break;
      const html = _decryptBody(item.html);
      const text = _decryptBody(item.text);
      // AUTH-6：正文解密失败（密钥变更/已被 redact）→ 丢弃该邮件并告警，
      // 避免重启后把无正文或缺重置链接的残缺邮件发给用户
      if ((item.html != null && item.html !== '') && html == null) {
        logger.error('mailer', '[mailer] 队列恢复失败：邮件正文解密失败，已丢弃:', item.to);
        continue;
      }
      mailQueue.push({
        to: item.to,
        subject: item.subject || '',
        html,
        text,
        retries: item.retries || 0,
        delay: item.delay || 0,
        timestamp: item.timestamp || Date.now()
      });
    }
  } catch (e) {
    logger.error('mailer', '[mailer] 邮件队列恢复失败:', e.message);
  }
}

// 模块加载时恢复上次未发送的邮件（P3-73：进程重启不丢队列）
_loadQueue();

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// AUTH-7：SMTP 头注入防护——subject/to 中剥离 CR/LF，防止 \r\n 构造伪造头
function sanitizeMailHeader(value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

// AUTH-7：收件邮箱格式校验（单地址、无空白与 CRLF、符合基本格式）
function isValidEmailAddress(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s || s.length > 254 || /[\s\r\n,]/.test(s)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function initMailer() {
  try {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = parseInt(process.env.SMTP_PORT) || 587;
    const smtpUser = process.env.SMTP_USER;
    // 环境变量统一：安装向导与 notification-service 均使用 SMTP_PASS，
    // 此处 SMTP_PASS 优先，SMTP_PASSWORD 作为历史配置的兼容回退
    const smtpPass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
    const smtpSecure = process.env.SMTP_SECURE === 'true';
    const smtpFrom = process.env.SMTP_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass) {
      logger.info('mailer', '[mailer] SMTP未配置，跳过初始化');
      return;
    }

    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    isEnabled = true;
    logger.info('mailer', '[mailer] 邮件服务初始化成功');
  } catch (e) {
    logger.error('mailer', '[mailer] 邮件服务初始化失败:', e.message);
    isEnabled = false;
  }
}

async function sendEmailDirect(to, subject, html, text) {
  if (!isEnabled || !transporter) {
    logger.warn('mailer', '[mailer] 邮件服务未启用');
    return { success: false, error: '邮件服务未配置' };
  }

  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    const info = await transporter.sendMail({
      from: `"境途同游" <${from}>`,
      to: sanitizeMailHeader(to),
      subject: sanitizeMailHeader(subject),
      text: text || (html ? html.replace(/<[^>]*>/g, '') : subject),
      html: html
    });
    logger.info('mailer', '[mailer] 邮件发送成功:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (e) {
    logger.error('mailer', '[mailer] 邮件发送失败:', e.message);
    return { success: false, error: e.message };
  }
}

async function processQueue() {
  if (isProcessing || mailQueue.length === 0) return;
  isProcessing = true;

  while (mailQueue.length > 0) {
    const item = mailQueue.shift();
    let failed = false;
    try {
      const result = await sendEmailDirect(item.to, item.subject, item.html, item.text);
      if (!result.success) {
        if (item.retries < MAX_RETRIES) {
          item.retries++;
          item.delay = Math.min(60000, Math.pow(2, item.retries) * 1000);
          setTimeout(() => {
            mailQueue.push(item);
            _persistQueue();
            processQueue();
          }, item.delay);
        } else {
          logger.error('mailer', `[mailer] 邮件发送失败，已达最大重试次数: ${item.to}`);
        }
        failed = true;
      }
    } catch (e) {
      logger.error('mailer', '[mailer] 队列处理异常:', e.message);
      failed = true;
    }
    _persistQueue();
    // P3-73: SMTP 恢复期（连续成功）加快处理节奏尽快排空积压；失败后回落到慢节奏避免风控
    await new Promise(resolve => setTimeout(resolve, failed ? QUEUE_INTERVAL_MS_SLOW : QUEUE_INTERVAL_MS_FAST));
  }

  isProcessing = false;
}

function sendEmail(to, subject, html, text) {
  if (!isEnabled) {
    logger.warn('mailer', '[mailer] 邮件服务未启用，跳过发送');
    return { success: false, error: '邮件服务未配置' };
  }
  // AUTH-7：入队前校验收件地址（格式 + 无 CRLF），防头注入与投递到畸形地址
  if (!isValidEmailAddress(to)) {
    logger.error('mailer', '[mailer] 收件地址非法，拒绝入队:', to);
    return { success: false, error: '收件地址非法' };
  }
  // P3-73: 队列有上限——超限直接拒绝入队（宁可失败也不无限堆内存）
  if (mailQueue.length >= MAIL_QUEUE_MAX) {
    logger.error('mailer', '[mailer] 邮件队列已满，拒绝入队:', to);
    return { success: false, error: '邮件队列已满，请稍后重试' };
  }

  mailQueue.push({
    to: sanitizeMailHeader(to),
    subject: sanitizeMailHeader(subject),
    html,
    text,
    retries: 0,
    delay: 0,
    timestamp: Date.now()
  });
  _persistQueue();

  processQueue();
  return { success: true, queued: true, message: '邮件已加入队列' };
}

async function sendPasswordReset(email, token) {
  // P2-72：默认端口由 3000 修正为实际监听端口 3456（APP_URL 未配置时的本地兜底）
  const url = `${process.env.APP_URL || 'http://localhost:3456'}/reset-password?token=${token}`;
  const html = `
    <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0;">
        <h1 style="margin: 0;">境途同游</h1>
        <p style="opacity: 0.9;">密码重置请求</p>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
        <p>您好，</p>
        <p>收到您的密码重置请求。请点击下方链接重置密码：</p>
        <a href="${url}" style="display: inline-block; margin: 20px 0; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px;">重置密码</a>
        <p>如果这不是您本人的操作，请忽略此邮件。</p>
        <p>此链接有效期为24小时。</p>
      </div>
      <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">境途同游 - VRChat群组管理平台</p>
    </div>
  `;
  return sendEmail(email, '境途同游 - 密码重置', html);
}

async function sendWelcomeEmail(email, username) {
  const html = `
    <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
      <div style="background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0;">
        <h1 style="margin: 0;">🎉 欢迎加入境途同游</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
        <p>尊敬的 ${escapeHtml(username)}，</p>
        <p>欢迎加入境途同游！我们很高兴您成为我们社区的一员。</p>
        <p>您现在可以：</p>
        <ul>
          <li>浏览和参与社区活动</li>
          <li>分享动态和照片</li>
          <li>与其他成员聊天交流</li>
          <li>参与VRChat活动</li>
        </ul>
        <p>如有任何问题，请随时联系管理员。</p>
      </div>
      <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">境途同游 - VRChat群组管理平台</p>
    </div>
  `;
  return sendEmail(email, '境途同游 - 欢迎加入', html);
}

async function sendEventNotification(email, event) {
  const html = `
    <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
      <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0;">
        <h1 style="margin: 0;">📅 活动通知</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
        <p>您好，</p>
        <p>即将开始的活动：<strong>${escapeHtml(event.title)}</strong></p>
        <p>${escapeHtml(event.description)}</p>
        <p><strong>时间：</strong>${new Date(event.start_time).toLocaleString()}</p>
        ${event.location ? `<p><strong>地点：</strong>${escapeHtml(event.location)}</p>` : ''}
      </div>
      <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">境途同游 - VRChat群组管理平台</p>
    </div>
  `;
  return sendEmail(email, `境途同游 - 活动提醒：${event.title}`, html);
}

async function sendSystemAlert(subject, message) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    logger.warn('mailer', '[mailer] 未配置ADMIN_EMAIL，跳过系统告警');
    return { success: false, error: '管理员邮箱未配置' };
  }

  const html = `
    <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
      <div style="background: linear-gradient(135deg, #ff416c 0%, #ff4b2b 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0;">
        <h1 style="margin: 0;">🚨 系统告警</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2>${escapeHtml(subject)}</h2>
        <p>${escapeHtml(message)}</p>
        <p><strong>时间：</strong>${new Date().toLocaleString()}</p>
      </div>
      <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">境途同游 - 系统监控</p>
    </div>
  `;
  return sendEmail(adminEmail, `[告警] ${sanitizeMailHeader(subject)}`, html);
}

function isMailerEnabled() {
  return isEnabled;
}

// 安装向导专用：使用表单提交的 SMTP 配置直发测试邮件，
// 不依赖 .env（首次安装时 env 尚无 SMTP 配置，initMailer 无法初始化共享 transporter）
async function sendTestEmail(config, to) {
  try {
    const testTransporter = nodemailer.createTransport({
      host: config.host,
      port: parseInt(config.port) || 587,
      secure: config.secure === true || config.secure === 'true',
      auth: { user: config.user, pass: config.pass }
    });
    const info = await testTransporter.sendMail({
      from: `"境途同游" <${config.from || config.user}>`,
      to: to,
      subject: '【境途同游】邮件测试',
      text: '邮件测试成功！'
    });
    logger.info('mailer', '[mailer] 测试邮件发送成功:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (e) {
    logger.error('mailer', '[mailer] 测试邮件发送失败:', e.message);
    return { success: false, error: e.message };
  }
}

function getQueueStats() {
  return {
    queueLength: mailQueue.length,
    isProcessing: isProcessing
  };
}

module.exports = {
  initMailer,
  sendEmail,
  sendPasswordReset,
  sendWelcomeEmail,
  sendEventNotification,
  sendSystemAlert,
  sendTestEmail,
  isMailerEnabled,
  getQueueStats
};
