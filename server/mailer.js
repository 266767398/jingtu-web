const nodemailer = require('nodemailer');

let transporter = null;
let isEnabled = false;

const mailQueue = [];
let isProcessing = false;
const MAX_RETRIES = 3;

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
      console.log('[mailer] SMTP未配置，跳过初始化');
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
    console.log('[mailer] 邮件服务初始化成功');
  } catch (e) {
    console.error('[mailer] 邮件服务初始化失败:', e.message);
    isEnabled = false;
  }
}

async function sendEmailDirect(to, subject, html, text) {
  if (!isEnabled || !transporter) {
    console.warn('[mailer] 邮件服务未启用');
    return { success: false, error: '邮件服务未配置' };
  }

  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    const info = await transporter.sendMail({
      from: `"境途同游" <${from}>`,
      to: to,
      subject: subject,
      text: text || (html ? html.replace(/<[^>]*>/g, '') : subject),
      html: html
    });
    console.log('[mailer] 邮件发送成功:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (e) {
    console.error('[mailer] 邮件发送失败:', e.message);
    return { success: false, error: e.message };
  }
}

async function processQueue() {
  if (isProcessing || mailQueue.length === 0) return;
  isProcessing = true;

  while (mailQueue.length > 0) {
    const item = mailQueue.shift();
    try {
      const result = await sendEmailDirect(item.to, item.subject, item.html, item.text);
      if (!result.success) {
        if (item.retries < MAX_RETRIES) {
          item.retries++;
          item.delay = Math.pow(2, item.retries) * 1000;
          setTimeout(() => {
            mailQueue.push(item);
            processQueue();
          }, item.delay);
        } else {
          console.error(`[mailer] 邮件发送失败，已达最大重试次数: ${item.to}`);
        }
      }
    } catch (e) {
      console.error('[mailer] 队列处理异常:', e.message);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  isProcessing = false;
}

function sendEmail(to, subject, html, text) {
  if (!isEnabled) {
    console.warn('[mailer] 邮件服务未启用，跳过发送');
    return { success: false, error: '邮件服务未配置' };
  }

  mailQueue.push({
    to,
    subject,
    html,
    text,
    retries: 0,
    delay: 0,
    timestamp: Date.now()
  });

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
        <p>尊敬的 ${username}，</p>
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
        <p>即将开始的活动：<strong>${event.title}</strong></p>
        <p>${event.description}</p>
        <p><strong>时间：</strong>${new Date(event.start_time).toLocaleString()}</p>
        ${event.location ? `<p><strong>地点：</strong>${event.location}</p>` : ''}
      </div>
      <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">境途同游 - VRChat群组管理平台</p>
    </div>
  `;
  return sendEmail(email, `境途同游 - 活动提醒：${event.title}`, html);
}

async function sendSystemAlert(subject, message) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('[mailer] 未配置ADMIN_EMAIL，跳过系统告警');
    return { success: false, error: '管理员邮箱未配置' };
  }

  const html = `
    <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
      <div style="background: linear-gradient(135deg, #ff416c 0%, #ff4b2b 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0;">
        <h1 style="margin: 0;">🚨 系统告警</h1>
      </div>
      <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
        <h2>${subject}</h2>
        <p>${message}</p>
        <p><strong>时间：</strong>${new Date().toLocaleString()}</p>
      </div>
      <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">境途同游 - 系统监控</p>
    </div>
  `;
  return sendEmail(adminEmail, `[告警] ${subject}`, html);
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
    console.log('[mailer] 测试邮件发送成功:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (e) {
    console.error('[mailer] 测试邮件发送失败:', e.message);
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
