/**
 * 境途同游 V5.2 — 密码找回业务层
 * 密码重置三路由（forgot-password / verify-reset-code / reset-password）业务，
 * registerResetRoutes(router) 由 routes/auth.js 原位委托注册，保持挂载顺序不变。
 */
const crypto = require('crypto');
const { fail, ok, getPool, handleError, sendError, ErrorCodes } = require('./utils');
const { passwordResetLimiter } = require('./middleware/rate_limit');
const { hashPassword, validatePasswordStrength } = require('./auth');
const logger = require('./logger');
const mailer = require('./mailer');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ==================== 密码找回（忘记密码） ====================
const resetTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, state] of resetTokens) {
    if (state.expireAt < now) resetTokens.delete(token);
  }
}, 60000).unref();

// §30：校验验证码并记录失败次数，超过 5 次删除 token
function consumeResetCode(token, code) {
  const state = resetTokens.get(token);
  if (!state || state.expireAt < Date.now()) {
    if (state) resetTokens.delete(token);
    return { expired: true };
  }
  if (state.code !== code.trim()) {
    state.attempts = (state.attempts || 0) + 1;
    if (state.attempts > 5) {
      resetTokens.delete(token);
      return { expired: true };
    }
    return { mismatch: true, attempts: state.attempts };
  }
  return { ok: true, state };
}

function registerResetRoutes(router) {
  router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入邮箱地址');

    const [users] = await getPool().query(
      `SELECT id, display_name, login_id FROM users WHERE email = ? AND deleted_at IS NULL AND banned = 0`,
      [email]
    );
    // AUTH-3/4: 无论账号是否存在都返回真实随机 token（不存在时该 token 无对应验证码，
    // verify/reset 必失败），响应结构完全对称，杜绝「token:null vs 64hex」的存在性枚举 oracle。
    const token = crypto.randomBytes(32).toString('hex');
    if (users.length === 0) {
      return ok(res, { message: '如果该邮箱已注册，验证码已发送到您的邮箱', token });
    }

    const user = users[0];
    // AUTH-3: OTP 熵提升至 8 位数字（~26.6 bit，原 6 位仅 ~20 bit），配合 5 次尝试上限
    const code = crypto.randomInt(10000000, 100000000).toString();
    const expireAt = Date.now() + 15 * 60 * 1000;

    resetTokens.set(token, { userId: user.id, code, expireAt, attempts: 0 });

    try {
      const resetHtml = `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:20px;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;font-size:20px;">境途同游</h1>
          </div>
          <div style="border:1px solid #eee;border-top:none;padding:20px;">
            <h2 style="color:#333;margin:0 0 15px;">密码重置</h2>
            <p style="color:#666;line-height:1.6;">您好 ${escapeHtml(user.display_name)}，</p>
            <p style="color:#666;line-height:1.6;">您的密码重置验证码是：</p>
            <div style="background:#f8f9fa;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
              <span style="font-size:36px;font-weight:bold;color:#667eea;letter-spacing:8px;">${code}</span>
            </div>
            <p style="color:#666;line-height:1.6;">此验证码15分钟内有效，请尽快使用。</p>
            <p style="color:#666;line-height:1.6;">如果不是您本人操作，请忽略此邮件。</p>
          </div>
          <div style="text-align:center;color:#999;font-size:12px;padding:15px;border-top:1px solid #eee;">
            <p>这是一封自动发送的通知邮件，请勿回复。</p>
          </div>
        </div>`;
      const result = mailer.sendEmail(email, '【境途同游】密码重置验证码', resetHtml);
      if (!result.success) {
        logger.warn('auth', '⚠️ 发送验证码邮件失败:', result.error);
      }
    } catch (e) {
      logger.warn('auth', '⚠️ 发送验证码邮件失败:', e.message);
      handleError(res, e, 'auth');
      return;
    }

    ok(res, { message: '验证码已发送到您的邮箱', token });
  } catch (e) {
    handleError(res, e, '[auth/forgot-password]');
  }
});

  router.post('/verify-reset-code', passwordResetLimiter, async (req, res) => {
  try {
    const { token, code } = req.body;
    if (!token || !code) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');

    const result = consumeResetCode(token, code);
    if (result.expired) {
      return fail(res, 400, '验证码已过期，请重新获取', { expired: true });
    }
    if (result.mismatch) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '验证码错误');
    }

    ok(res, { message: '验证通过' });
  } catch (e) {
    handleError(res, e, '[auth/verify-reset-code]');
  }
});

  router.post('/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const { token, code, newPassword } = req.body;
    if (!token || !newPassword) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');

    const result = consumeResetCode(token, code);
    if (result.expired) {
      return fail(res, 400, '链接已过期，请重新获取', { expired: true });
    }
    if (result.mismatch) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '验证码错误');
    }
    const state = result.state;
    // AUTH-2: 校验通过后立即原子注销 token（先于任何异步 DB 操作），
    // 两个并发 reset-password 同参请求只有一个能通过，杜绝双消耗/后写覆盖。
    resetTokens.delete(token);

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return fail(res, 400, '密码强度不足', { details: strength.errors });
    }

    const pwdHash = await hashPassword(newPassword);
    await getPool().query(`UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [pwdHash, state.userId]);
    // §44：重置密码后删除该用户所有 session 记录，强制其他会话失效
    try {
      await getPool().query(`DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId')) = ?`, [String(state.userId)]);
    } catch (e) { logger.warn('auth', '[reset-password] 清理用户会话失败:', e.message); }

    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '重置密码', ?)`,
      [state.userId, '通过邮箱验证重置密码']);

    ok(res, { message: '密码重置成功，请使用新密码登录' });
  } catch (e) {
    handleError(res, e, '[auth/reset-password]');
  }
});
}

module.exports = { registerResetRoutes };
