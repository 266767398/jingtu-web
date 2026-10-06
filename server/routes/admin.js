/**
 * 境途同游 V6.14 — 管理 / 搜索 / 改名 / 权限系统路由
 *
 * P2-4 第三批（god-route 拆分）：用户管理、改名系统、直播/内容管理已按域拆出至
 * admin_users.js / admin_name_change.js / admin_content_live.js，
 * 此处在原代码块位置透传挂载，路由路径与注册顺序保持不变。
 *
 * @swagger
 * tags:
 *   name: Admin
 *   description: 管理后台相关接口
 */
const express = require('express');
const { ok, getPool, handleError, logOper, sendError, ErrorCodes, paginate, escapeLike } = require('../utils');
const { requireAdminCompat, requireRole } = require('../auth');
const logger = require('../logger');
const settings = require('../settings');
const mediaProviders = require('../media_providers');
const {
  collectUserData,
  importUserData
} = require('./user-data-helper');

module.exports = function (groupId, vrcCookieCfg) {
  const router = express.Router();

  // V8.2: 读取/设置 VRChat cookie 软性过期时间（天）。0=永不过期。
  const VALID_EXPIRE = [0, 7, 30, 90, 180, 365];
  router.get('/vrc-cookie-expire', requireAdminCompat, async (req, res) => {
    try {
      const days = (vrcCookieCfg && typeof vrcCookieCfg.getExpireDays === 'function')
        ? vrcCookieCfg.getExpireDays()
        : 0;
      res.json({ expireDays: days, options: VALID_EXPIRE });
    } catch (e) { handleError(res, e, '[admin/vrc-cookie-expire:get]'); }
  });
  router.put('/vrc-cookie-expire', requireAdminCompat, async (req, res) => {
    try {
      const days = parseInt(req.body.expireDays, 10);
      if (!VALID_EXPIRE.includes(days)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的过期时间选项');
      }
      const pool = getPool();
      await pool.query(
        `INSERT INTO system_config (config_key, config_value, updated_by) VALUES ('vrc_cookie_expire_days', ?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_by = VALUES(updated_by)`,
        [String(days), req.session?.userId || null]
      );
      if (vrcCookieCfg && typeof vrcCookieCfg.setExpireDays === 'function') {
        vrcCookieCfg.setExpireDays(days);
      }
      ok(res, { expireDays: days });
    } catch (e) { handleError(res, e, '[admin/vrc-cookie-expire:put]'); }
  });

  // ==================== 管理员面板统计数据 ====================
  router.get('/admin/stats', requireAdminCompat, async (req, res) => {
    try {
      const [[{ totalUsers }]] = await getPool().query(`SELECT COUNT(*) AS totalUsers FROM users WHERE deleted_at IS NULL`);
      const [[{ pendingApproval }]] = await getPool().query(`SELECT COUNT(*) AS pendingApproval FROM users WHERE deleted_at IS NULL AND approved=0 AND role='member'`);
      const [[{ totalBanned }]] = await getPool().query(`SELECT COUNT(*) AS totalBanned FROM users WHERE deleted_at IS NULL AND banned=1`);
      const [[{ totalPhotos }]] = await getPool().query(`SELECT COUNT(*) AS totalPhotos FROM album_photo WHERE is_recycle=0`);
      const [[{ totalEvents }]] = await getPool().query(`SELECT COUNT(*) AS totalEvents FROM event WHERE is_archive=0`);
      const [[{ totalOnline }]] = await getPool().query(`SELECT COUNT(*) AS totalOnline FROM group_roster WHERE is_member=1 AND is_online=1`);
      const [[{ totalGroupMembers }]] = await getPool().query(`SELECT COUNT(*) AS totalGroupMembers FROM group_roster WHERE is_member=1`);
      const [[{ totalAnnouncements }]] = await getPool().query(`SELECT COUNT(*) AS totalAnnouncements FROM announcement`);
      res.json({ totalUsers, pendingApproval, totalBanned, totalPhotos, totalEvents, totalOnline, totalGroupMembers, totalAnnouncements });
    } catch (e) { handleError(res, e, '[admin/stats]'); }
  });

  // ==================== 操作日志（sys_oper_log 表） ====================
  // 说明：`/api/admin/logs` 返回的是文件系统里的应用日志（logger.js），
  // 字段结构完全不同。管理面板的"操作日志"面板此前误调那个端点，
  // 拿到的每条记录都没有 adminVrcId/operType/content，于是全部渲染成空白与
  // "unknown"。sys_oper_log 表被 20 处代码写入，却从来没有任何接口读取过。
  router.get('/admin/oper-logs', requireAdminCompat, async (req, res) => {
    try {
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 100 });
      const type = (req.query.type || '').trim();
      const user = (req.query.user || '').trim();

      const where = [];
      const params = [];
      if (type) { where.push('l.oper_type = ?'); params.push(type); }
      if (user) {
        // admin_vrcid 列历史上混存了 login_id、数字用户 ID 和 VRChat ID 三种值，
        // 所以模糊匹配要同时覆盖原始列和 JOIN 出来的显示名。
        where.push('(l.admin_vrcid LIKE ? ESCAPE \'!\' OR u1.display_name LIKE ? ESCAPE \'!\' OR u2.display_name LIKE ? ESCAPE \'!\')');
        const like = `%${escapeLike(user)}%`;
        params.push(like, like, like);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      // 两个 LEFT JOIN 分别按 login_id 和数字主键回查，兼容历史脏数据
      const joinSql = `
        LEFT JOIN users u1 ON u1.login_id = l.admin_vrcid
        LEFT JOIN users u2 ON u2.id = (CASE WHEN l.admin_vrcid REGEXP '^[0-9]+$' THEN CAST(l.admin_vrcid AS UNSIGNED) ELSE NULL END)`;

      const [[{ total }]] = await getPool().query(
        `SELECT COUNT(*) AS total FROM sys_oper_log l ${joinSql} ${whereSql}`, params
      );
      const [rows] = await getPool().query(
        `SELECT l.id, l.admin_vrcid, l.oper_type, l.content, l.create_time,
                COALESCE(u1.display_name, u2.display_name) AS display_name
         FROM sys_oper_log l ${joinSql} ${whereSql}
         ORDER BY l.create_time DESC, l.id DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );

      res.json({
        logs: rows.map(r => ({
          id: r.id,
          // 优先显示可读昵称，回退到原始标识；两者都没有才算未知
          adminVrcId: r.display_name || r.admin_vrcid || '',
          operType: r.oper_type || '',
          content: r.content || '',
          createTime: r.create_time
        })),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      });
    } catch (e) { handleError(res, e, '[admin/oper-logs]'); }
  });

  // 操作类型下拉框的可选值，避免前端硬编码
  router.get('/admin/oper-log-types', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT oper_type, COUNT(*) AS n FROM sys_oper_log GROUP BY oper_type ORDER BY n DESC LIMIT 50`
      );
      res.json({ types: rows.map(r => r.oper_type).filter(Boolean) });
    } catch (e) { handleError(res, e, '[admin/oper-log-types]'); }
  });

  // ==================== 社交链接（公开接口） ====================
  router.get('/social-links', async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT config_key, config_value FROM system_config WHERE config_key IN ('vrcGroupUrl', 'kookUrl', 'oopzUrl', 'hide_forgot_password')`
      );
      const links = {};
      for (const row of rows) {
        links[row.config_key] = row.config_value || '';
      }
      res.json({
        vrcGroupUrl: links.vrcGroupUrl || '',
        kookUrl: links.kookUrl || '',
        oopzUrl: links.oopzUrl || '',
        hideForgotPassword: links.hide_forgot_password || '0'
      });
    } catch (e) { logger.error('admin', '[social-links]', e); res.json({ vrcGroupUrl: '', kookUrl: '', oopzUrl: '', hideForgotPassword: '0' }); }
  });

  // ==================== 系统配置 ====================
  // P3-110：system_config 含 rtc_turn_credential/media_provider_mirrors 等凭据，
  // GET 对敏感键统一脱敏，避免任意 admin 明文读取；PUT 对回传占位符的键跳过写入
  // （占位符仅表示「未修改」，只有填新值才更新），保证前端编辑表单 round-trip 不覆盖真实凭据。
  const CONFIG_MASK = '__MASKED__';
  const SENSITIVE_KEY_RE = /(PASSWORD|SECRET|KEY|TOKEN|CREDENTIAL)/i;
  const SENSITIVE_INLINE_RE = /(password|passwd|secret|token|api_?key|credential|client_secret)=([^\s&]*)/gi;
  function maskConfigValue(key, value) {
    if (!value || typeof value !== 'string') return value;
    if (SENSITIVE_KEY_RE.test(key)) return CONFIG_MASK;
    // URL userinfo 内嵌凭据：scheme://user:pass@host
    if (/^[a-zA-Z][\w+.-]*:\/\/[^/:\s]*:[^@\s]*@/i.test(value)) {
      return value.replace(/^(.*:\/\/[^:/\s]*:)[^@\s]*@/, '$1' + CONFIG_MASK + '@');
    }
    // 内联 "key=secret" 片段
    if (SENSITIVE_INLINE_RE.test(value)) {
      return value.replace(SENSITIVE_INLINE_RE, '$1' + CONFIG_MASK);
    }
    return value;
  }
  router.get('/admin/config', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT config_key AS configKey, config_value AS configValue FROM system_config`);
      const config = { groupId };
      for (const row of rows) config[row.configKey] = maskConfigValue(row.configKey, row.configValue);
      res.json(config);
    } catch (e) { handleError(res, e, '[admin/config]'); }
  });

  router.put('/admin/config', requireRole('super_admin'), async (req, res) => {
    try {
      // 前端 saveSystemConfig 发送的是 { config: {...} }，兼容顶层直传两种形态，
      // 否则历史上会静默变成 no-op（改了不入库）。
      const incoming = (req.body && req.body.config && typeof req.body.config === 'object') ? req.body.config : req.body;
      const allowedKeys = ['site_name', 'hero_title', 'hero_subtitle', 'hero_description', 'hero_bg_url', 'hero_bg_color', 'hero_bg_overlay_opacity', 'hero_accent_color', 'hero_badge_text', 'hero_show_stats', 'hero_show_badge', 'hero_animation', 'posts_per_page', 'post_max_images', 'post_max_videos', 'post_video_max_size_mb', 'vrcGroupUrl', 'kookUrl', 'oopzUrl', 'req_max_upload_mb', 'req_max_body_mb', 'req_max_other_mb', 'hide_forgot_password', 'media_provider_mirrors', 'media_provider_mirror_first', 'media_provider_timeout_ms', 'rtc_turn_urls', 'rtc_turn_username', 'rtc_turn_credential'];
      for (const key of allowedKeys) {
        if (incoming[key] !== undefined) {
          const val = typeof incoming[key] === 'string' ? incoming[key] : String(incoming[key]);
          // P3-110：占位符视为「未修改」，跳过写入以保留数据库原值
          if (val === CONFIG_MASK) continue;
          await getPool().query(`INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?`, [key, val, val]);
        }
      }
      // 立即把请求大小限制同步到内存，无需重启即生效
      settings.applyConfig(incoming);
      // F-5: 媒体代理源池配置同样热更新到内存（镜像清洗校验在 applyConfig 内完成）
      mediaProviders.applyConfig(incoming);
      await logOper(req.session.userId, '更新系统配置', JSON.stringify(Object.keys(incoming)));
      ok(res);
    } catch (e) { handleError(res, e, '[admin/config/put]'); }
  });

  // ==================== 按域拆出的子路由（P2-4 第三批 god-route 拆分） ====================
  // 在原代码块所在位置透传挂载：route_guard 的 collectRoutes 会递归进入子 router，
  // 路由总数（420）与各路径完全不变。
  router.use(require('./admin_users')());
  router.use(require('./admin_name_change')());
  router.use(require('./admin_vrc_blacklist')());

  // ==================== 权限组排序 API ====================
  router.get('/admin/groups', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        'SELECT id, name, description, parent_id AS parentId, is_default AS isDefault, is_system AS isSystem, created_at AS createdAt, updated_at AS updatedAt FROM permission_groups ORDER BY id ASC'
      );
      res.json({ groups: rows });
    } catch (e) { handleError(res, e, '[admin/groups]'); }
  });

  router.put('/admin/groups/sort', requireAdminCompat, async (req, res) => {
    try {
      const { groupIds } = req.body;
      if (!Array.isArray(groupIds)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      for (let i = 0; i < groupIds.length; i++) {
        await getPool().query('UPDATE permission_groups SET sort = ? WHERE id = ?', [i, groupIds[i]]);
      }
      await logOper(req.session.userId, '调整权限组排序', `排序: ${groupIds.join(',')}`);
      ok(res);
    } catch (e) { handleError(res, e, '[admin/groups/sort]'); }
  });

  router.use(require('./admin_content_live')());

  // ==================== VRC 状态监控 ====================
  router.get('/vrc-monitor', requireAdminCompat, async (req, res) => {
    try {
      // 复用 server.js 暴露的全局 VRChat 鉴权状态
      const g = (typeof global !== 'undefined' && typeof global.__getVrcAuthState === 'function') ? global.__getVrcAuthState() : null;
      let online = false, friendCount = null, lastSync = null, health = 'unknown';
      if (g) {
        online = !!g.loggedIn;
        lastSync = g.lastSyncAt ? new Date(g.lastSyncAt).toISOString() : null;
      }
      // 好友数（如系统账号 cookie 可用，调用 VRChat friends 接口）
      try {
        const vrc = require('../vrc');
        if (g && g.cookie && typeof vrc.vrchatGetAllFriends === 'function') {
          const friends = await vrc.vrchatGetAllFriends(g.cookie);
          friendCount = Array.isArray(friends) ? friends.length : null;
          health = 'ok';
        } else {
          health = g && g.loggedIn ? 'no-cookie-api' : 'offline';
        }
      } catch (e) {
        health = 'error: ' + (e && e.message ? e.message : 'unknown');
      }
      res.json({ online, friendCount, lastSync, health, note: online ? '系统账号已登录 VRChat，可正常抓取数据。' : '系统 VRChat 账号未登录，部分在线状态与好友数据不可用。' });
    } catch (e) { handleError(res, e, '[vrc-monitor:get]'); }
  });

  // ==================== 用户数据导出/导入/备份还原（管理员，按用户 + 批量） ====================

  // GET /admin/user-data/export/:id — 导出单个用户数据（JSON 下载）
  router.get('/admin/user-data/export/:id', requireAdminCompat, async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!userId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户 ID');
      const data = await collectUserData(userId);
      if (!data) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      const name = (data.meta.user.display_name || data.meta.user.login_id || 'user').replace(/[\\/:*?"<>|]/g, '_');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="user-${userId}-${encodeURIComponent(name)}.json"`);
      res.json(data);
      await logOper(req.session.userId, '导出用户数据', '用户ID: ' + userId);
    } catch (e) { handleError(res, e, '[admin/user-data/export]'); }
  });

  // POST /admin/user-data/import/:id — 导入 JSON 数据到指定用户
  router.post('/admin/user-data/import/:id', requireAdminCompat, async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!userId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户 ID');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '导入数据格式不正确');
      }
      const { imported } = await importUserData(userId, body);
      await logOper(req.session.userId, '导入用户数据', '用户ID: ' + userId);
      ok(res, { imported });
    } catch (e) {
      if (e && e.statusCode === 404) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      handleError(res, e, '[admin/user-data/import]');
    }
  });

  // POST /admin/user-data/batch-export — 批量导出（body.ids 为用户 ID 数组），返回包含多个用户的 JSON 下载
  router.post('/admin/user-data/batch-export', requireAdminCompat, async (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
      if (!ids.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '未指定要导出的用户');
      const result = { exported_at: new Date().toISOString(), version: 1, users: {} };
      const skipped = [];
      for (const id of ids) {
        const data = await collectUserData(id);
        if (data) result.users[id] = data;
        else skipped.push(id);
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="jingtu-batch-backup.json"');
      res.json({ ...result, skipped });
      await logOper(req.session.userId, '批量导出用户数据', 'IDs: ' + ids.join(','));
    } catch (e) { handleError(res, e, '[admin/user-data/batch-export]'); }
  });

  // POST /admin/user-data/batch-import — 批量导入（body.users 为 { userId: data } 映射）
  router.post('/admin/user-data/batch-import', requireAdminCompat, async (req, res) => {
    try {
      const users = req.body && req.body.users;
      if (!users || typeof users !== 'object' || Array.isArray(users)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '批量导入数据格式不正确');
      }
      const summary = [];
      const failed = {};
      for (const key of Object.keys(users)) {
        const userId = parseInt(key, 10);
        const data = users[key];
        if (!userId || !data || typeof data !== 'object') { failed[key] = '无效的用户 ID 或数据'; continue; }
        try {
          const { imported } = await importUserData(userId, data);
          summary.push({ userId, imported });
        } catch (e) {
          failed[key] = (e && e.message) || '导入失败';
        }
      }
      await logOper(req.session.userId, '批量导入用户数据', '用户数: ' + summary.length);
      ok(res, { imported: summary, failed });
    } catch (e) { handleError(res, e, '[admin/user-data/batch-import]'); }
  });

  return router;
};
