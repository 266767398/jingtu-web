/**
 * 境途同游 V5.2 — 用户管理与资料路由
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const {
  hashPassword, validatePasswordStrength,
  encryptAES, decryptAES, requireAuth, requireRole,
  getAvatarUrl
} = require('../auth');
const { getPool, safeError } = require('../utils');
const { VRC_API, VRC_API_KEY } = require('../vrc');
const ROOT_DIR = path.join(__dirname, '..', '..');
const AVATAR_DIR = path.join(ROOT_DIR, 'uploads', 'avatars');

// 确保头像目录存在
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

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
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// 脱敏用户记录（去除敏感字段）
function sanitizeUser(u) {
  return {
    id: u.id,
    loginId: u.login_id,
    displayName: u.display_name,
    vrchatId: u.vrchat_id,
    vrchatName: u.vrchat_name,
    vrchatAvatarUrl: u.vrchat_avatar_url || null,
    role: u.role,
    avatarType: u.avatar_type,
    avatarUrl: getAvatarUrl(u),
    birthday: u.birthday,
    location: u.location_visible ? u.location : null,
    lat: u.location_visible ? u.lat : null,
    lng: u.location_visible ? u.lng : null,
    preferences: u.preferences,
    createdAt: u.created_at,
    updatedAt: u.updated_at
  };
}

// ==================== 用户列表（admin+） ====================
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const offset = (page - 1) * pageSize;

    const [count] = await getPool().query(
      `SELECT COUNT(*) as total FROM users WHERE deleted_at IS NULL`
    );
    const [rows] = await getPool().query(
      `SELECT id, login_id, display_name, vrchat_id, vrchat_name, role, avatar_type,
              custom_avatar_path, vrchat_avatar_url, location_visible, created_at, updated_at
       FROM users WHERE deleted_at IS NULL
       ORDER BY FIELD(role, 'super_admin', 'admin', 'member'), id ASC
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );

    const users = rows.map(u => ({
      id: u.id,
      loginId: u.login_id,
      displayName: u.display_name,
      vrchatId: u.vrchat_id,
      vrchatName: u.vrchat_name,
      role: u.role,
      avatarType: u.avatar_type,
      avatarUrl: getAvatarUrl(u),
      locationVisible: !!u.location_visible,
      createdAt: u.created_at,
      updatedAt: u.updated_at
    }));

    res.json({ users, total: count[0].total, page, pageSize });
  } catch (e) { console.error('[users/list]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// ==================== 创建用户（super_admin 专用） ====================
router.post('/', requireRole('super_admin'), async (req, res) => {
  try {
    const { loginId, password, displayName, role } = req.body;
    if (!loginId || !password) {
      return res.status(400).json({ error: '登录ID和密码不能为空' });
    }
    if (!displayName) {
      return res.status(400).json({ error: '显示名不能为空' });
    }

    // 密码强度
    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return res.status(400).json({ error: '密码强度不足', details: strength.errors });
    }

    // 角色校验
    const validRoles = ['super_admin', 'admin', 'member'];
    const userRole = validRoles.includes(role) ? role : 'member';
    if (userRole === 'super_admin') {
      return res.status(400).json({ error: '只能存在一个超级管理员' });
    }

    // 检查 login_id
    const [dup] = await getPool().query(`SELECT id FROM users WHERE login_id = ?`, [loginId]);
    if (dup.length > 0) {
      return res.status(400).json({ error: '该登录ID已被使用' });
    }

    const pwdHash = await hashPassword(password);
    const [result] = await getPool().query(
      `INSERT INTO users (login_id, display_name, password_hash, role, avatar_type) VALUES (?, ?, ?, ?, 'none')`,
      [loginId, displayName, pwdHash, userRole]
    );

    // 操作日志
    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '创建用户', ?)`,
      [req.session.loginId, `创建用户 ${displayName} (${loginId}) 角色: ${userRole}`]
    );

    res.json({ success: true, id: result.insertId, message: '用户创建成功' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: '该登录ID已被使用' });
    }
    console.error('[users-create]', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 生日列表（需要放在 /:id 通配路由之前） ====================
router.get('/birthdays', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    const [rows] = await getPool().query(
      `SELECT id, display_name AS displayName, birthday,
              COALESCE(custom_avatar_path, vrchat_avatar_url) AS avatarUrl
       FROM users
       WHERE birthday IS NOT NULL AND deleted_at IS NULL
       ORDER BY MONTH(birthday), DAY(birthday)`
    );

    const todayBirthdays = rows.filter(r => {
      if (!r.birthday) return false;
      const b = new Date(r.birthday);
      return b.getMonth() + 1 === month && b.getDate() === day;
    });

    res.json({ birthdays: rows, todayCount: todayBirthdays.length, todayBirthdays });
  } catch (e) { console.error('[users]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// ==================== 全员位置（需要放在 /:id 通配路由之前） ====================
router.get('/all/locations', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, display_name, avatar_type, custom_avatar_path, vrchat_avatar_url,
              location, lat, lng
       FROM users
       WHERE location_visible = 1 AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL`
    );

    const markers = rows.map(u => ({
      id: u.id,
      name: u.display_name,
      avatarUrl: getAvatarUrl(u),
      location: u.location,
      lat: parseFloat(u.lat),
      lng: parseFloat(u.lng)
    }));

    res.json({ markers, count: markers.length });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 获取单个用户 ====================
router.get('/:id', requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    res.json(sanitizeUser(rows[0]));
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 更新用户（admin+） ====================
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { displayName, role } = req.body;
    const updates = {};
    if (displayName) updates.display_name = displayName;
    if (role) {
      const validRoles = ['super_admin', 'admin', 'member'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: '无效的角色' });
      }
      // 不能给自己降级
      if (parseInt(req.params.id) === req.session.userId && role !== req.session.role) {
        return res.status(400).json({ error: '不能修改自己的角色' });
      }
      // 普通 admin 不能提 super_admin
      if (role === 'super_admin' && req.session.role !== 'super_admin') {
        return res.status(403).json({ error: '只有超级管理员可以提拔超级管理员' });
      }
      updates.role = role;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '没有需要更新的字段' });
    }

    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(req.params.id);

    const [result] = await getPool().query(
      `UPDATE users SET ${fields}, updated_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '更新用户', ?)`,
      [req.session.loginId, `更新用户 ID:${req.params.id}`]
    );

    res.json({ success: true, message: '更新成功' });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 软删除用户（admin+） ====================
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) {
      return res.status(400).json({ error: '不能删除自己' });
    }

    // 超管不能被删除
    const [target] = await getPool().query(
      `SELECT role FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (target.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (target[0].role === 'super_admin') {
      return res.status(400).json({ error: '不能删除超级管理员' });
    }

    const [result] = await getPool().query(
      `UPDATE users SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '删除用户', ?)`,
      [req.session.loginId, `软删除用户 ID:${req.params.id}`]
    );

    res.json({ success: true, message: '用户已删除' });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 重置密码（admin+） ====================
router.post('/:id/reset-password', requireRole('admin'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ error: '请输入新密码' });
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ error: '密码强度不足', details: strength.errors });
    }

    const [target] = await getPool().query(
      `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (target.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const pwdHash = await hashPassword(newPassword);
    await getPool().query(`UPDATE users SET password_hash = ? WHERE id = ?`, [pwdHash, req.params.id]);

    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '重置密码', ?)`,
      [req.session.loginId, `重置用户 ${req.params.id} 密码`]
    );

    res.json({ success: true, message: '密码已重置' });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 我的资料 ====================
router.get('/me/profile', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, login_id, display_name, vrchat_id, vrchat_name, vrchat_verified, role, avatar_type,
              custom_avatar_path, vrchat_avatar_url, qq_number_enc, birthday,
              location, lat, lng, location_visible, preferences, created_at, updated_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.session.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
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
      avatarType: u.avatar_type,
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
      socialLinks: u.preferences?.social_links || null,
      createdAt: u.created_at,
      updatedAt: u.updated_at
    });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 更新我的资料 ====================
router.put('/me/profile', requireAuth, async (req, res) => {
  try {
    if (req.session.userId === 0) {
      return res.status(403).json({ error: '游客不能修改资料' });
    }
    const { displayName, qq, birthday, location, preferences, bio, motto, website, socialLinks } = req.body;
    const updates = {};

    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || displayName.length > 50) return res.status(400).json({ error: '显示名不能超过50字' });
      updates.display_name = displayName;
    }
    if (qq !== undefined) {
      if (typeof qq !== 'string' || qq.length > 50) return res.status(400).json({ error: 'QQ号过长' });
      updates.qq_number_enc = qq ? encryptAES(qq) : null;
    }
    if (birthday !== undefined) updates.birthday = birthday || null;
    if (location !== undefined) {
      if (typeof location !== 'string' || location.length > 200) return res.status(400).json({ error: '所在地过长' });
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

    // preferences 参数覆盖（如果前端传了完整的 preferences 对象）
    if (preferences !== undefined) {
      const incoming = typeof preferences === 'string' ? JSON.parse(preferences) : preferences;
      Object.assign(prefsObj, incoming);
    }
    if (bio !== undefined) prefsObj.bio = bio;
    if (motto !== undefined) prefsObj.motto = motto;
    // V6.10: website 存到 preferences.website
    if (website !== undefined) prefsObj.website = website;
    // V6.10: socialLinks 存到 preferences.social_links
    if (socialLinks !== undefined) {
      if (typeof socialLinks === 'string') prefsObj.social_links = JSON.parse(socialLinks);
      else prefsObj.social_links = socialLinks;
    }
    updates.preferences = JSON.stringify(prefsObj);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '没有需要更新的字段' });
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

    res.json({ success: true, message: '资料更新成功' });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 上传自定义头像 ====================
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择头像图片' });
  }
  try {
    // 用 sharp 处理成 256x256 jpg
    const finalPath = path.join(AVATAR_DIR, `${req.session.userId}.jpg`);
    const thumbPath256 = path.join(AVATAR_DIR, `${req.session.userId}_256.jpg`);
    const thumbPath64 = path.join(AVATAR_DIR, `${req.session.userId}_64.jpg`);

    await sharp(req.file.path)
      .resize(256, 256, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toFile(finalPath);

    // 生成缩略图
    await sharp(finalPath).resize(64, 64, { fit: 'cover' }).jpeg({ quality: 75 }).toFile(thumbPath64);

    // 删除临时文件
    if (req.file.path !== finalPath) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    const url = `/uploads/avatars/${req.session.userId}.jpg`;
    const thumbUrl = `/uploads/avatars/${req.session.userId}_64.jpg`;

    await getPool().query(
      `UPDATE users SET avatar_type = 'custom', custom_avatar_path = ?, updated_at = NOW() WHERE id = ?`,
      [url, req.session.userId]
    );

    // 更新 session
    req.session.avatarType = 'custom';
    req.session.avatarUrl = url;
    await req.session.save();

    res.json({ success: true, avatarUrl: url, thumbUrl, message: '头像上传成功' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '上传头像', ?)`,
      [req.session.userId, `上传自定义头像: ${req.file.originalname}`]);
  } catch (e) { console.error('[users-avatar]', e); res.status(500).json({ error: safeError('头像处理失败: ' + e.message) }); }
});

// ==================== 切换到 VRChat 头像 ====================
router.post('/me/avatar-vrchat', requireAuth, async (req, res) => {
  try {
    const [users] = await getPool().query(
      `SELECT vrchat_id, vrchat_avatar_url FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.session.userId]
    );
    if (users.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    if (!users[0].vrchat_id) {
      return res.status(400).json({ error: '未绑定VRChat账号' });
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
    } catch (e) { console.warn('⚠️ 刷新 VRChat 头像失败:', e.message); }

    await getPool().query(
      `UPDATE users SET avatar_type = 'vrchat', vrchat_avatar_url = ?, updated_at = NOW() WHERE id = ?`,
      [avatarUrl, req.session.userId]
    );

    req.session.avatarType = 'vrchat';
    req.session.avatarUrl = avatarUrl;
    await req.session.save();

    res.json({ success: true, avatarUrl, message: '已切换为VRChat头像' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '切换头像', ?)`,
      [req.session.userId, '切换为VRChat头像']);
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 移除自定义头像 ====================
router.delete('/me/avatar', requireAuth, async (req, res) => {
  try {
    // 删除头像文件
    const paths = [
      path.join(AVATAR_DIR, `${req.session.userId}.jpg`),
      path.join(AVATAR_DIR, `${req.session.userId}_256.jpg`),
      path.join(AVATAR_DIR, `${req.session.userId}_64.jpg`)
    ];
    for (const p of paths) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    }

    await getPool().query(
      `UPDATE users SET avatar_type = 'none', custom_avatar_path = NULL, vrchat_avatar_url = NULL, updated_at = NOW() WHERE id = ?`,
      [req.session.userId]
    );

    req.session.avatarType = 'none';
    req.session.avatarUrl = null;
    await req.session.save();

    res.json({ success: true, message: '头像已移除' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '移除头像', ?)`,
      [req.session.userId, '移除自定义头像']);
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 更新个人位置（静态手动更新） V6.13 ====================
// 用户手动点"更新位置"时保存 GPS 到服务器
router.put('/me/location', requireAuth, async (req, res) => {
  try {
    const { lat, lng, location, visible } = req.body;
    const updates = {};
    if (lat !== undefined) updates.lat = lat;
    if (lng !== undefined) updates.lng = lng;
    if (location !== undefined) updates.location = location;
    if (visible !== undefined) updates.location_visible = visible ? 1 : 0;
    // V6.13: 如果关掉位置可见，删除服务器上的 lat/lng
    if (visible !== undefined && !visible) {
      updates.lat = null;
      updates.lng = null;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: '无更新字段' });
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(updates);
    vals.push(req.session.userId);
    await getPool().query(`UPDATE users SET ${fields}, updated_at = NOW() WHERE id = ?`, vals);
    res.json({ success: true, message: '位置更新成功' });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 用户公开名片（按ID） ====================
router.get('/:id/card', requireAuth, async (req, res, next) => {
  // 跳过 /me/* 路由，避免和 /me/events 等冲突
  if (req.params.id === 'me') return next('route');
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: '参数错误' });

    const [rows] = await getPool().query(
      `SELECT u.id, u.login_id, u.display_name, u.vrchat_id, u.vrchat_name,
              u.role, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
              u.birthday, u.location, u.location_visible, u.preferences,
              u.created_at
       FROM users u
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });

    const u = rows[0];
    const prefs = typeof u.preferences === 'string' ? JSON.parse(u.preferences) : (u.preferences || {});
    // 获取该用户报名的活动数和照片数
    const [[{ evtCount }]] = await getPool().query(
      `SELECT COUNT(*) AS evtCount FROM event_sign WHERE user_vrcid = ?`, [u.id]
    );
    const [[{ photoCount }]] = await getPool().query(
      `SELECT COUNT(*) AS photoCount FROM user_photos WHERE user_id = ?`, [u.id]
    );
    res.json({
      id: u.id,
      loginId: u.login_id,
      displayName: u.display_name,
      vrchatName: u.vrchat_name,
      role: u.role,
      roleLabel: u.role === 'super_admin' ? '超级管理员' : u.role === 'admin' ? '管理员' : u.role === 'member' ? '成员' : '访客',
      avatarUrl: getAvatarUrl(u),
      birthday: u.birthday,
      location: u.location,
      locationVisible: !!u.location_visible,
      motto: prefs.motto || '',
      bio: prefs.bio || '',
      joinedAt: u.created_at,
      evtCount,
      photoCount
    });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

// 获取当前用户报名过的活动
router.get('/me/events', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT e.id, e.title, e.event_time AS eventTime, e.ends_at AS endsAt, e.place,
              e.description, e.event_type AS eventType, e.visibility,
              e.world_name AS worldName, e.world_image_url AS worldImageUrl,
              es.sign_time AS signTime, es.is_sign AS isSign
       FROM event_sign es
       JOIN event e ON es.event_id = e.id
       WHERE es.user_vrcid = ?
       ORDER BY e.event_time DESC`,
      [req.session.userId]
    );
    res.json({ events: rows });
  } catch (e) { console.error('[users]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// 获取指定用户报名过的活动
router.get('/:userId/events', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: '参数错误' });
    const [rows] = await getPool().query(
      `SELECT e.id, e.title, e.event_time AS eventTime, e.ends_at AS endsAt, e.place,
              e.description, e.event_type AS eventType, e.visibility,
              e.world_name AS worldName, e.world_image_url AS worldImageUrl,
              es.sign_time AS signTime
       FROM event_sign es
       JOIN event e ON es.event_id = e.id
       WHERE es.user_vrcid = ?
       ORDER BY e.event_time DESC`,
      [userId]
    );
    res.json({ events: rows });
  } catch (e) { console.error('[users]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// 获取指定用户上传的照片
router.get('/:userId/photos', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!userId) return res.status(400).json({ error: '参数错误' });
    const [rows] = await getPool().query(
      `SELECT ap.id, ap.photo_path AS url, ap.thumb_path AS thumbnail,
              ap.photo_desc AS caption, ap.create_time AS createdAt,
              ap.like_count AS likeCount
       FROM album_photo ap
       WHERE ap.upload_vrcid = ? AND ap.is_recycle = 0
       ORDER BY ap.create_time DESC`,
      [String(userId)]
    );
    res.json({ photos: rows });
  } catch (e) { console.error('[users]', e); res.status(500).json({ error: safeError(e.message) }); }
});

module.exports = router;
