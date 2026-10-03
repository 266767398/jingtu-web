/**
 * 境途同游 V5.2 — 我的资料路由（P2-66：自 users.js 按域拆出，行为逐字保留）
 * 覆盖：/me/profile 读写、头像上传/VRChat 头像/删除/显示偏好、位置上报。
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { requireAuth, getAvatarUrl, encryptAES, decryptAES } = require('../auth');
const {
  ok, getPool, validateFields, handleError, sendError, ErrorCodes, createFileFilter, secureUpload
} = require('../utils');
const { VRC_API, VRC_API_KEY } = require('../vrc');
const logger = require('../logger');

const ROOT_DIR = path.join(__dirname, '..', '..');
const AVATAR_DIR = path.join(ROOT_DIR, 'uploads', 'avatars');

// 确保头像目录存在
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// 清理某用户的旧头像文件（best-effort，忽略锁定/不存在错误）
// keep1/keep2 为本次新生成的文件名，必须保留
function cleanupOldAvatars(userId, keep1, keep2) {
  try {
    const files = fs.readdirSync(AVATAR_DIR);
    const id = String(userId);
    for (const f of files) {
      const full = path.join(AVATAR_DIR, f);
      if (f === keep1 || f === keep2) continue;
      // 匹配旧命名：{id}.jpg / {id}_256.jpg / {id}_64.jpg / {id}_{ts}.jpg / {id}_{ts}_64.jpg / .tmp_*
      const isOld = f === `${id}.jpg` || f === `${id}_256.jpg` || f === `${id}_64.jpg`
        || (f.startsWith(`${id}_`) && (f.endsWith('.jpg') || f.endsWith('.png')))
        || f.startsWith('.tmp_');
      if (isOld) { try { fs.unlinkSync(full); } catch {} }
    }
  } catch {}
}

// 头像上传配置
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    cb(null, `avatar_${req.session.userId}_${Date.now()}${path.extname(file.originalname)}`);
  }
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: createFileFilter(['IMAGE'])
});

// ==================== 我的资料 ====================
router.get('/me/profile', requireAuth, async (req, res) => {
  try {
    let rows;
    try {
      [rows] = await getPool().query(
        `SELECT id, login_id, display_name, vrchat_id, vrchat_name, vrchat_verified, role, banned, avatar_type,
                custom_avatar_path, vrchat_avatar_url, avatar_visible, qq_number_enc, birthday, email, last_login,
                location, lat, lng, location_visible, preferences, created_at, updated_at
         FROM users WHERE id = ? AND deleted_at IS NULL`,
        [req.session.userId]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [rows] = await getPool().query(
          `SELECT id, login_id, display_name, vrchat_id, vrchat_name, vrchat_verified, role, banned, avatar_type,
                  custom_avatar_path, vrchat_avatar_url, avatar_visible, qq_number_enc, birthday,
                  location, lat, lng, location_visible, preferences, created_at, updated_at
           FROM users WHERE id = ?`,
          [req.session.userId]
        );
      } else {
        throw e;
      }
    }
    if (rows.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    const u = rows[0];
    res.json({
      id: u.id,
      loginId: u.login_id,
      displayName: u.display_name,
      vrchatId: u.vrchat_id,
      vrchatName: u.vrchat_name,
      vrchatAvatarUrl: u.vrchat_avatar_url || null,
      vrchatVerified: !!u.vrchat_verified,
      role: u.role,
      banned: !!u.banned,
      avatarType: u.avatar_type,
      avatarVisible: u.avatar_visible === 0 ? false : true,
      customAvatarPath: u.custom_avatar_path || null,
      avatarUrl: getAvatarUrl(u),
      qq: decryptAES(u.qq_number_enc),
      birthday: u.birthday,
      location: u.location,
      lat: u.lat,
      lng: u.lng,
      locationVisible: !!u.location_visible,
      preferences: u.preferences,
      bio: u.preferences?.bio || '',
      motto: u.preferences?.motto || '',
      website: u.preferences?.website || '',
      coverImage: u.preferences?.coverImage || '',
      socialLinks: u.preferences?.social_links || null,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      email: u.email || null,
      lastLoginTime: u.last_login || null,
      createTime: u.created_at
    });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 更新我的资料 ====================
router.put('/me/profile', requireAuth, async (req, res) => {
  try {
    if (req.session.userId === 0) {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '游客不能修改资料');
    }
    const { displayName, qq, birthday, location, preferences, bio, motto, website, socialLinks, coverImage } = req.body;
    const updates = {};

    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || displayName.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名不能超过50字');
      updates.display_name = displayName;
    }
    if (qq !== undefined) {
      if (typeof qq !== 'string' || qq.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'QQ号过长');
      updates.qq_number_enc = qq ? encryptAES(qq) : null;
    }
    if (birthday !== undefined) {
      if (birthday !== null && (typeof birthday !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthday))) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '生日格式不正确');
      updates.birthday = birthday || null;
    }
    if (location !== undefined) {
      if (typeof location !== 'string' || location.length > 200) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '所在地过长');
      updates.location = location || null;
    }

    // V6.10: socialLinks — 存入 preferences.social_links
    // bio 和 motto 存到 preferences JSON 字段 — 始终合并已有字段
    let prefsObj = {};
    try {
      const [current] = await getPool().query(`SELECT preferences FROM users WHERE id = ?`, [req.session.userId]);
      if (current.length > 0 && current[0].preferences) {
        prefsObj = typeof current[0].preferences === 'string' ? JSON.parse(current[0].preferences) : current[0].preferences;
      }
    } catch { prefsObj = {}; }
    if (!prefsObj || typeof prefsObj !== 'object' || Array.isArray(prefsObj)) prefsObj = {};

    // 输入校验（对齐前端 maxlength：motto=100、bio=2000；URL 字段限 http(s) 或站内相对路径，
    // 拒绝 javascript:/data: 等伪协议，防止存库后在渲染端形成 XSS 载体）
    const isSafeUrl = (v) => typeof v === 'string' && v.length <= 500 && (
      v === '' || /^https?:\/\/\S+$/i.test(v) || /^\/[A-Za-z0-9._\-~/]*$/.test(v)
    );
    if (bio !== undefined) {
      if (typeof bio !== 'string' || bio.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '个人简介不能超过2000字');
      prefsObj.bio = bio;
    }
    if (motto !== undefined) {
      if (typeof motto !== 'string' || motto.length > 100) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '个性签名不能超过100字');
      prefsObj.motto = motto;
    }
    // V6.10: website 存到 preferences.website
    if (website !== undefined) {
      if (!isSafeUrl(website)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '个人网站格式不正确');
      prefsObj.website = website;
    }
    // coverImage 存到 preferences.coverImage（封面图 URL，公开主页读取端已兼容该键）
    if (coverImage !== undefined) {
      if (!isSafeUrl(coverImage)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '封面图地址格式不正确');
      prefsObj.coverImage = coverImage;
    }
    // V6.10: socialLinks 存到 preferences.social_links（平面对象 string→string，防深层结构滥用）
    if (socialLinks !== undefined) {
      let sl = socialLinks;
      if (typeof sl === 'string') {
        try { sl = JSON.parse(sl); } catch { return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'socialLinks 不是合法的 JSON'); }
      }
      if (!sl || typeof sl !== 'object' || Array.isArray(sl)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'socialLinks 格式不正确');
      for (const [k, v] of Object.entries(sl)) {
        if (!/^[A-Za-z0-9_]{1,30}$/.test(k) || (v !== null && (typeof v !== 'string' || v.length > 300))) {
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'socialLinks 内容不合规');
        }
      }
      prefsObj.social_links = sl;
    }
    // preferences 参数覆盖（如果前端传了完整的 preferences 对象）——
    // 只接受 plain object，键名限白名单字符，整体序列化后限 64KB，防止撑爆 JSON 列
    if (preferences !== undefined) {
      let incoming = preferences;
      if (typeof incoming === 'string') {
        try { incoming = JSON.parse(incoming); } catch { return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'preferences 不是合法的 JSON'); }
      }
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'preferences 格式不正确');
      if (JSON.stringify(incoming).length > 65536) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '偏好设置过大');
      for (const k of Object.keys(incoming)) {
        if (!/^[A-Za-z0-9_]{1,30}$/.test(k)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'preferences 含不支持的键名');
        if (typeof incoming[k] === 'object' && incoming[k] !== null && k !== 'social_links') return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'preferences 值类型不正确');
      }
      Object.assign(prefsObj, incoming);
    }
    updates.preferences = JSON.stringify(prefsObj);

    validateFields(updates, ['display_name', 'qq_number_enc', 'birthday', 'location', 'preferences']);

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有需要更新的字段');
    }

    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(req.session.userId);

    await getPool().query(
      `UPDATE users SET ${fields}, updated_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
      values
    );

    // 更新 session displayName
    if (displayName !== undefined) {
      req.session.displayName = displayName;
      await req.session.save();
    }

    // 操作日志
    const changedFields = Object.keys(updates).join(', ');
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '更新个人资料', ?)`,
      [req.session.userId, `更新字段: ${changedFields}`]);

    ok(res, { message: '资料更新成功' });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 上传自定义头像 ====================
router.post('/me/avatar', requireAuth, secureUpload(avatarUpload.single('avatar')), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择头像图片');
  }
  try {
    // 每次上传使用时间戳唯一文件名，避免 Windows 下覆盖正在被读取的旧文件导致
    // sharp.toFile 报 "Permission denied / Invalid argument"（原地覆盖写锁冲突）。
    const ts = Date.now();
    const finalName = `${req.session.userId}_${ts}.jpg`;
    const thumbName = `${req.session.userId}_${ts}_64.jpg`;
    const finalPath = path.join(AVATAR_DIR, finalName);
    const thumbPath64 = path.join(AVATAR_DIR, thumbName);

    // 用 sharp 处理成 256x256 jpg（始终写入新文件，不存在覆盖锁冲突）
    await sharp(req.file.path)
      .resize(256, 256, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toFile(finalPath);

    // 生成缩略图
    await sharp(finalPath).resize(64, 64, { fit: 'cover' }).jpeg({ quality: 75 }).toFile(thumbPath64);

    // 删除上传临时文件
    try { fs.unlinkSync(req.file.path); } catch {}

    // 清理该用户旧头像文件（best-effort，忽略锁定/不存在）
    cleanupOldAvatars(req.session.userId, finalName, thumbName);

    const url = `/uploads/avatars/${finalName}`;
    const thumbUrl = `/uploads/avatars/${thumbName}`;

    await getPool().query(
      `UPDATE users SET avatar_type = 'custom', custom_avatar_path = ?, avatar_visible = 1, updated_at = NOW() WHERE id = ?`,
      [url, req.session.userId]
    );

    // 更新 session
    req.session.avatarType = 'custom';
    req.session.avatarUrl = url;
    await req.session.save();

    ok(res, { avatarUrl: url, thumbUrl, message: '头像上传成功' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '上传头像', ?)`,
      [req.session.userId, `上传自定义头像: ${req.file.originalname}`]);
  } catch (e) { handleError(res, e, '[users/avatar]'); }
});

// ==================== 切换到 VRChat 头像 ====================
router.post('/me/avatar-vrchat', requireAuth, async (req, res) => {
  try {
    const [users] = await getPool().query(
      `SELECT vrchat_id, vrchat_avatar_url FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.session.userId]
    );
    if (users.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    if (!users[0].vrchat_id) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '未绑定VRChat账号');
    }

    // 尝试刷新 VRChat 头像
    let avatarUrl = users[0].vrchat_avatar_url;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      try {
        const profileRes = await fetch(
          `${VRC_API}/users/${users[0].vrchat_id}?apiKey=${VRC_API_KEY}`,
          { headers: { 'User-Agent': 'JingTuWeb/5.2' }, signal: ac.signal }
        );
        if (profileRes.ok) {
          const profile = await profileRes.json();
          avatarUrl = profile.currentAvatarThumbnailImageUrl || profile.userIcon || avatarUrl;
        }
      } finally { clearTimeout(t); }
    } catch (e) { logger.warn('users', '⚠️ 刷新 VRChat 头像失败:', e.message); }

    await getPool().query(
      `UPDATE users SET avatar_type = 'vrchat', vrchat_avatar_url = ?, avatar_visible = 1, updated_at = NOW() WHERE id = ?`,
      [avatarUrl, req.session.userId]
    );

    req.session.avatarType = 'vrchat';
    req.session.avatarUrl = avatarUrl;
    await req.session.save();

    ok(res, { avatarUrl, message: '已切换为VRChat头像' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '切换头像', ?)`,
      [req.session.userId, '切换为VRChat头像']);
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 移除自定义头像 ====================
router.delete('/me/avatar', requireAuth, async (req, res) => {
  try {
    // 先查出当前存储的头像路径，确保唯一文件名也能被清理
    let currentPath = null;
    try {
      const [rows] = await getPool().query(`SELECT custom_avatar_path FROM users WHERE id = ?`, [req.session.userId]);
      if (rows && rows[0] && rows[0].custom_avatar_path) currentPath = rows[0].custom_avatar_path;
    } catch {}

    cleanupOldAvatars(req.session.userId, null, null);
    // 若 DB 中存的是唯一文件名（如 /uploads/avatars/4_123.jpg），额外精准删除
    if (currentPath) {
      const base = path.basename(currentPath);
      const full = path.join(AVATAR_DIR, base);
      try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch {}
      const thumbFull = path.join(AVATAR_DIR, base.replace(/\.jpg$/, '_64.jpg'));
      try { if (fs.existsSync(thumbFull)) fs.unlinkSync(thumbFull); } catch {}
    }

    await getPool().query(
      `UPDATE users SET avatar_type = 'none', custom_avatar_path = NULL, vrchat_avatar_url = NULL, updated_at = NOW() WHERE id = ?`,
      [req.session.userId]
    );

    req.session.avatarType = 'none';
    req.session.avatarUrl = null;
    await req.session.save();

    ok(res, { message: '头像已移除' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '移除头像', ?)`,
      [req.session.userId, '移除自定义头像']);
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 头像显示偏好（是否显示 + 显示哪种） §11.8.8 ====================
// 与原头像上传/切换接口解耦：本接口只改「显示开关」和「选用哪种头像」，
// 不动 custom_avatar_path / vrchat_avatar_url 本身。
router.post('/me/avatar-pref', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { avatarVisible, avatarType } = req.body || {};
    const updates = [];
    const values = [];

    if (avatarVisible !== undefined) {
      if (avatarVisible !== 0 && avatarVisible !== 1 && avatarVisible !== false && avatarVisible !== true) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'avatarVisible 必须是 0/1');
      }
      updates.push('avatar_visible = ?');
      values.push(avatarVisible ? 1 : 0);
    }

    if (avatarType !== undefined) {
      if (!['custom', 'vrchat'].includes(avatarType)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'avatarType 必须是 custom 或 vrchat');
      }
      // 校验所选头像确实存在，避免选了一个不存在的头像类型导致全站显示空白
      const [rows] = await getPool().query(
        `SELECT avatar_type, custom_avatar_path, vrchat_avatar_url FROM users WHERE id = ?`,
        [uid]
      );
      if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      const u = rows[0];
      if (avatarType === 'custom' && !u.custom_avatar_path) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '尚未设置本地头像，无法选用');
      }
      if (avatarType === 'vrchat' && !u.vrchat_avatar_url) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '尚未绑定 VRChat 头像，无法选用');
      }
      updates.push('avatar_type = ?');
      values.push(avatarType);
    }

    if (updates.length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有任何要更新的字段');
    }

    values.push(uid);
    await getPool().query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );

    // 同步 session（头像显示/选用变化后，依赖 session.avatarUrl 的即时渲染保持一致）
    if (avatarVisible !== undefined) req.session.avatarVisible = avatarVisible ? 1 : 0;
    if (avatarType !== undefined) req.session.avatarType = avatarType;
    const [su] = await getPool().query(`SELECT avatar_type, custom_avatar_path, vrchat_avatar_url, avatar_visible FROM users WHERE id = ?`, [uid]);
    if (su.length) {
      const s = su[0];
      req.session.avatarUrl = s.avatar_visible === 0 ? null : getAvatarUrl(s);
    }
    await req.session.save();

    const [rows] = await getPool().query(`SELECT avatar_type, avatar_visible FROM users WHERE id = ?`, [uid]);
    const u = rows[0];
    ok(res, {
      avatarType: u.avatar_type,
      avatarVisible: u.avatar_visible === 0 ? false : true,
      avatarUrl: getAvatarUrl(u),
      message: '头像显示设置已更新'
    });
  } catch (e) {
    handleError(res, e, '[users/avatar-pref]');
  }
});

// ==================== 更新个人位置（静态手动更新） V6.13 ====================
// 用户手动点"更新位置"时保存 GPS 到服务器
router.put('/me/location', requireAuth, async (req, res) => {
  try {
    const { lat, lng, location, visible } = req.body;
    const updates = {};
    if (lat !== undefined) {
      const v = parseFloat(lat);
      // 坐标必须合法，否则会写入 NaN/越界值并污染地图标记
      if (!Number.isFinite(v) || v < -90 || v > 90) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '纬度无效');
      }
      updates.lat = v;
    }
    if (lng !== undefined) {
      const v = parseFloat(lng);
      if (!Number.isFinite(v) || v < -180 || v > 180) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '经度无效');
      }
      updates.lng = v;
    }
    // P3-123：与 PUT /me/profile 口径一致——location 必须为 string 且 ≤200 字
    if (location !== undefined) {
      if (typeof location !== 'string') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '位置格式不正确');
      const loc = location.trim();
      if (loc.length > 200) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '位置不能超过200字');
      updates.location = loc;
    }
    if (visible !== undefined) updates.location_visible = visible ? 1 : 0;
    // 记录位置时间戳，否则地图气泡的"更新时间"永远为空
    if (updates.lat !== undefined || updates.lng !== undefined) {
      updates.location_updated_at = new Date();
    }
    // V6.13: 如果关掉位置可见，删除服务器上的 lat/lng
    if (visible !== undefined && !visible) {
      updates.lat = null;
      updates.lng = null;
      updates.location_updated_at = null;
    }
    validateFields(updates, ['lat', 'lng', 'location', 'location_visible', 'location_updated_at']);
    if (Object.keys(updates).length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无更新字段');
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(updates);
    vals.push(req.session.userId);
    await getPool().query(`UPDATE users SET ${fields}, updated_at = NOW() WHERE id = ?`, vals);
    ok(res, { message: '位置更新成功' });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

module.exports = router;
