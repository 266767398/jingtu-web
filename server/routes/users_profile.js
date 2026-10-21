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
  ok, getPool, validateFields, handleError, sendError, ErrorCodes, createFileFilter, secureUpload, normalizeSelfTags, normalizeTheme, formatDateOnly, decryptCookie
} = require('../utils');
const { VRC_API, VRC_API_KEY, vrchatGetUser, resolveTrustLevelFromTags } = require('../vrc');
const wsService = require('../ws_service');
const logger = require('../logger');

const ROOT_DIR = path.join(__dirname, '..', '..');
const AVATAR_DIR = path.join(ROOT_DIR, 'uploads', 'avatars');

// 确保头像目录存在
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// 清理某用户的旧头像文件（best-effort，忽略锁定/不存在错误）
// keep1/keep2 为本次新生成的文件名，必须保留
// notBeforeTs：本次请求开始时间戳（ms）。只删除在该时间之前已存在的文件——
// 并发上传时另一请求刚写入的新文件 mtime 必 > notBeforeTs，绝不会被误删（历史 BUG：
// 同一用户秒级内重复上传，两请求的 cleanup 互相把对方刚生成的主图当旧文件删掉，
// 磁盘最后只剩缩略图、主图丢失，DB 引用悬空 → 前端 404）。
function cleanupOldAvatars(userId, keep1, keep2, notBeforeTs) {
  try {
    const files = fs.readdirSync(AVATAR_DIR);
    const id = String(userId);
    const threshold = typeof notBeforeTs === 'number' ? notBeforeTs : Number.MAX_SAFE_INTEGER;
    for (const f of files) {
      const full = path.join(AVATAR_DIR, f);
      if (f === keep1 || f === keep2) continue;
      // 匹配旧命名：{id}.jpg / {id}_256.jpg / {id}_64.jpg / {id}_{ts}.jpg / {id}_{ts}_64.jpg / .tmp_*
      // 及 multer 临时文件 avatar_{id}_*（上传中断/校验失败残留，正常流程已删除）
      const isOld = f === `${id}.jpg` || f === `${id}_256.jpg` || f === `${id}_64.jpg`
        || (f.startsWith(`${id}_`) && (f.endsWith('.jpg') || f.endsWith('.png')))
        || f.startsWith(`avatar_${id}_`)
        || f.startsWith('.tmp_');
      if (!isOld) continue;
      // 并发保护：本次请求开始后才写入的文件（其他上传请求刚生成）一律保留
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < threshold) fs.unlinkSync(full);
      } catch {}
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

// ==================== 封面上传配置 ====================
const COVER_DIR = path.join(ROOT_DIR, 'uploads', 'covers');
if (!fs.existsSync(COVER_DIR)) fs.mkdirSync(COVER_DIR, { recursive: true });

// 清理某用户的旧封面文件（best-effort）：每次上传用时间戳唯一文件名，
// 只删除本次请求开始之前已存在的 cover_{id}_* 文件，防止并发互删（语义同 cleanupOldAvatars）
function cleanupOldCovers(userId, keepName, notBeforeTs) {
  try {
    const files = fs.readdirSync(COVER_DIR);
    const id = String(userId);
    const threshold = typeof notBeforeTs === 'number' ? notBeforeTs : Number.MAX_SAFE_INTEGER;
    for (const f of files) {
      if (f === keepName) continue;
      if (!f.startsWith(`cover_${id}_`)) continue;
      try {
        const st = fs.statSync(path.join(COVER_DIR, f));
        if (st.mtimeMs < threshold) fs.unlinkSync(path.join(COVER_DIR, f));
      } catch {}
    }
  } catch {}
}

const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, COVER_DIR),
  filename: (req, file, cb) => {
    cb(null, `cover_${req.session.userId}_${Date.now()}${path.extname(file.originalname)}`);
  }
});
const coverUpload = multer({
  storage: coverStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: createFileFilter(['IMAGE'])
});

// ==================== 网站背景上传配置 ====================
// 用户单独的站点背景图（与封面 cover 相互独立）：封面用于个人主页横幅，
// 背景用于登录后整站页面背景。同样落 preferences.backgroundImage（JSON，无需改表）。
const BACKGROUND_DIR = path.join(ROOT_DIR, 'uploads', 'backgrounds');
if (!fs.existsSync(BACKGROUND_DIR)) fs.mkdirSync(BACKGROUND_DIR, { recursive: true });

function cleanupOldBackgrounds(userId, keepName, notBeforeTs) {
  try {
    const files = fs.readdirSync(BACKGROUND_DIR);
    const id = String(userId);
    const threshold = typeof notBeforeTs === 'number' ? notBeforeTs : Number.MAX_SAFE_INTEGER;
    for (const f of files) {
      if (f === keepName) continue;
      if (!f.startsWith(`bg_${id}_`)) continue;
      try {
        const st = fs.statSync(path.join(BACKGROUND_DIR, f));
        if (st.mtimeMs < threshold) fs.unlinkSync(path.join(BACKGROUND_DIR, f));
      } catch {}
    }
  } catch {}
}

const backgroundStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BACKGROUND_DIR),
  filename: (req, file, cb) => {
    cb(null, `bg_${req.session.userId}_${Date.now()}${path.extname(file.originalname)}`);
  }
});
const backgroundUpload = multer({
  storage: backgroundStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: createFileFilter(['IMAGE'])
});

// ==================== 我的资料 ====================
// ==================== 自身 VRChat 信任等级回填（V6.17） ====================
// 「我的信息」头像光环按信任等级着色，数据源优先 group_roster（群名册）。
// 已绑定 VRChat 但名册暂无记录的用户（未入群/名册未同步），trustLevel 恒为空 → 光环永远默认金色。
// 这里用用户自己持久化的 VRChat cookie（users.vrchat_token_enc）后台回填真实等级
//（/users/{id} 是含 system_trust_* tags 的唯一数据源，与 schedule.js 信任补充同口径）。
// 后台执行不阻塞 /me/profile 响应；trust_checked_at 6h 去重避免反复查同一人。
const USER_TRUST_REFRESH_MS = 6 * 60 * 60 * 1000;
const USER_TRUST_CN = { negative: '恶劣玩家', visitor: '游客', new: '新用户', user: '用户', known: '常驻玩家', trusted: '信任', vetted: '审核', veteran: '资深玩家', legend: '资深玩家' };
const _userTrustInflight = new Set();

async function refreshUserTrustLevel(userId, vrchatId, encToken) {
  if (!vrchatId || !encToken || _userTrustInflight.has(userId)) return;
  _userTrustInflight.add(userId);
  try {
    const cookie = decryptCookie(encToken);
    if (!cookie) return;
    const resp = await vrchatGetUser(vrchatId, cookie);
    const userData = resp && resp.status >= 200 && resp.status < 300 ? resp.data : null;
    if (userData && Array.isArray(userData.tags)) {
      const tl = resolveTrustLevelFromTags(userData.tags) || '';
      const tlCn = USER_TRUST_CN[tl] || tl;
      await getPool().query(
        `UPDATE users SET trust_level = ?, trust_checked_at = NOW() WHERE id = ?`,
        [tl, userId]
      );
      logger.info('[me-profile]', `✅ 已回填用户 #${userId} 的 VRChat 信任等级: ${tl || '(空)'}（${tlCn}）`);
    } else {
      // 未拿到 tags（隐私墙/接口异常）：仅标记已尝试，避免每轮重复查询
      await getPool().query(`UPDATE users SET trust_checked_at = NOW() WHERE id = ?`, [userId]);
    }
  } catch (e) {
    logger.warn('[me-profile]', `⚠️ 用户 #${userId} 信任等级回填失败: ${e.message}`);
    try { await getPool().query(`UPDATE users SET trust_checked_at = NOW() WHERE id = ?`, [userId]); } catch (e2) { /* 忽略 */ }
  } finally {
    _userTrustInflight.delete(userId);
  }
}

router.get('/me/profile', requireAuth, async (req, res) => {
  try {
    let rows;
    try {
      [rows] = await getPool().query(
        `SELECT u.id, u.login_id, u.display_name, u.vrchat_id, u.vrchat_name, u.vrchat_verified, u.role, u.banned, u.avatar_type,
                u.custom_avatar_path, u.vrchat_avatar_url, u.avatar_visible, u.halo_visible, u.qq_number_enc, u.birthday, u.email, gr.last_login,
                u.location, u.lat, u.lng, u.location_visible, u.preferences, u.created_at, u.updated_at,
                u.trust_level AS self_user_trust, u.trust_checked_at AS self_trust_checked_at, u.vrchat_token_enc AS self_vrc_token_enc,
                gr.trust_level AS self_trust_level, gr.trust_level_cn AS self_trust_level_cn
         FROM users u
         LEFT JOIN group_roster gr ON gr.vrchat_id = u.vrchat_id AND gr.vrchat_id IS NOT NULL AND gr.vrchat_id != ''
         WHERE u.id = ? AND u.deleted_at IS NULL`,
        [req.session.userId]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [rows] = await getPool().query(
          `SELECT u.id, u.login_id, u.display_name, u.vrchat_id, u.vrchat_name, u.vrchat_verified, u.role, u.banned, u.avatar_type,
                  u.custom_avatar_path, u.vrchat_avatar_url, u.avatar_visible, u.halo_visible, u.qq_number_enc, u.birthday, u.email,
                  u.location, u.lat, u.lng, u.location_visible, u.preferences, u.created_at, u.updated_at,
                  u.trust_level AS self_user_trust, u.trust_checked_at AS self_trust_checked_at, u.vrchat_token_enc AS self_vrc_token_enc
           FROM users u WHERE u.id = ?`,
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

    // 自身信任等级：优先群名册（group_roster，schedule 定时同步）；名册无该用户记录时
    // 回退 users.trust_level（绑定/个人页后台回填的真实等级）。两者皆无 → null，前端回退金色默认环。
    const selfTrust = u.self_trust_level || u.self_user_trust || null;
    const selfTrustCn = u.self_trust_level_cn || (selfTrust && selfTrust === u.self_user_trust
      ? (USER_TRUST_CN[u.self_user_trust] || u.self_user_trust) : null);

    // 已绑定 VRChat 但名册无记录 → 后台回填真实信任等级（非阻塞，6h 去重），
    // 让「我的信息」头像光环显示信誉颜色而非恒为默认金色（V6.17）。
    if (!u.self_trust_level && u.vrchat_id && u.self_vrc_token_enc) {
      const checkedTs = u.self_trust_checked_at ? new Date(u.self_trust_checked_at).getTime() : 0;
      if (Date.now() - checkedTs >= USER_TRUST_REFRESH_MS) {
        refreshUserTrustLevel(req.session.userId, u.vrchat_id, u.self_vrc_token_enc);
      }
    }

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
      // 信任光环显示开关（1=显示，0=隐藏）：仅控制「自己的光环对别人是否可见」，
      // 别人浏览时按对方自己的 haloVisible 渲染，单个用户关闭不会让全站光环消失。
      haloVisible: u.halo_visible !== 0,
      customAvatarPath: u.custom_avatar_path || null,
      avatarUrl: getAvatarUrl(u),
      qq: decryptAES(u.qq_number_enc),
      // 供「我的信息」头像光环显示；未绑定/无记录 → null，前端回退金色默认环。
      trustLevel: selfTrust,
      trustLevelCn: selfTrustCn,
      birthday: formatDateOnly(u.birthday),
      location: u.location,
      lat: u.lat,
      lng: u.lng,
      locationVisible: !!u.location_visible,
      preferences: u.preferences,
      bio: u.preferences?.bio || '',
      motto: u.preferences?.motto || '',
      website: u.preferences?.website || '',
      coverImage: u.preferences?.coverImage || '',
      // 用户单独的网站背景图（登录后整站背景，个人主页/成员详情同步展示）
      backgroundImage: u.preferences?.backgroundImage || '',
      // 主题配置（模式/明暗/强调色），登录后跨设备恢复
      theme: u.preferences?.theme || null,
      socialLinks: u.preferences?.social_links || null,
      selfTags: Array.isArray(u.preferences?.self_tags) ? u.preferences.self_tags : [],
      tagsVisible: !!u.preferences?.tags_visible,
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
    const { displayName, qq, birthday, location, preferences, bio, motto, website, socialLinks, coverImage, coverPosition, backgroundImage, selfTags, tagsVisible, theme } = req.body;
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
    // coverPosition 存到 preferences.coverPosition（封面显示位置：top/center/bottom）
    if (coverPosition !== undefined) {
      if (typeof coverPosition !== 'string' || !['top', 'center', 'bottom'].includes(coverPosition)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '封面显示位置必须是 top/center/bottom');
      }
      prefsObj.coverPosition = coverPosition;
    }
    // backgroundImage 存到 preferences.backgroundImage（用户单独的整站背景图）
    if (backgroundImage !== undefined) {
      if (!isSafeUrl(backgroundImage)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '背景图地址格式不正确');
      prefsObj.backgroundImage = backgroundImage;
    }
    // 主题配置存到 preferences.theme（模式/明暗/强调色），登录后跨设备恢复
    if (theme !== undefined) {
      const t = normalizeTheme(theme);
      if (t === null) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '主题配置格式不正确');
      prefsObj.theme = t;
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
    // 自定义标签存到 preferences.self_tags，开关存 preferences.tags_visible
    const normalizedTags = normalizeSelfTags(selfTags);
    if (normalizedTags === null) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标签不合规：最多8个，每个不超过20字');
    if (normalizedTags !== undefined) prefsObj.self_tags = normalizedTags;
    if (tagsVisible !== undefined) {
      if (typeof tagsVisible !== 'boolean') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标签显示开关格式不正确');
      prefsObj.tags_visible = tagsVisible;
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
        if (typeof incoming[k] === 'object' && incoming[k] !== null && k !== 'social_links' && k !== 'self_tags' && k !== 'theme') return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'preferences 值类型不正确');
      }
      Object.assign(prefsObj, incoming);
    }
    // preferences 整体覆盖会绕过上面对 selfTags 的归一化，这里对最终值补一道校验，
    // 保证落库的标签始终满足数量/长度/字符约束
    if (prefsObj.self_tags !== undefined) {
      const revalidated = normalizeSelfTags(prefsObj.self_tags);
      if (revalidated === null) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标签不合规：最多8个，每个不超过20字');
      prefsObj.self_tags = revalidated;
    }
    // 同上：preferences 整体覆盖时 theme 也需重新校验，避免绕过白名单写入任意结构
    if (prefsObj.theme !== undefined) {
      const t = normalizeTheme(prefsObj.theme);
      if (t === null) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '主题配置格式不正确');
      prefsObj.theme = t;
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

    // 回显归一化后的标签，前端据此同步本地状态（去重/裁剪后的权威值）
    ok(res, {
      message: '资料更新成功',
      selfTags: prefsObj.self_tags || [],
      tagsVisible: !!prefsObj.tags_visible
    });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 上传自定义头像 ====================
router.post('/me/avatar', requireAuth, secureUpload(avatarUpload.single('avatar')), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择头像图片');
  }
  let tmpPath = req.file ? req.file.path : null;
  try {
    // 本次请求开始时间：清理旧头像时只删在此之前存在的文件（并发上传防护，
    // 见 cleanupOldAvatars 的 notBeforeTs 参数说明）
    const startedAt = Date.now();
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

    // 主图生成校验：文件缺失/为空视为上传失败，绝不写入 DB 指向一个已丢失的文件
    // （历史曾出现 DB 引用主图但文件缺失 → 前端 onerror 静默回退默认头像，用户感知"头像不好使"）
    if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size === 0) {
      throw new Error('头像主图生成失败：目标文件未写入');
    }

    // 生成缩略图
    await sharp(finalPath).resize(64, 64, { fit: 'cover' }).jpeg({ quality: 75 }).toFile(thumbPath64);

    // 清理该用户旧头像文件（best-effort，忽略锁定/不存在；并发上传防护见函数注释）
    cleanupOldAvatars(req.session.userId, finalName, thumbName, startedAt);

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
  finally {
    // 无论成功/失败，删除 multer 临时文件，避免 uploads/avatars 目录堆积 avatar_{id}_* 残留
    if (tmpPath) { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {} }
  }
});

// ==================== 上传自定义封面 ====================
// 封面区域尺寸不固定，上传时只限制尺寸上限，不裁剪；显示位置由前端 coverPosition 控制
router.post('/me/cover', requireAuth, secureUpload(coverUpload.single('cover')), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择封面图片');
  }
  let tmpPath = req.file ? req.file.path : null;
  try {
    const startedAt = Date.now();
    const ts = Date.now();
    const finalName = `cover_${req.session.userId}_${ts}.jpg`;
    const finalPath = path.join(COVER_DIR, finalName);

    // 压缩为长边 ≤1920 的 JPG（不放大、不裁剪），保留原比例；封面尺寸随区域变化
    await sharp(req.file.path)
      .resize(1920, null, { withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(finalPath);

    if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size === 0) {
      throw new Error('封面上传失败：目标文件未写入');
    }

    cleanupOldCovers(req.session.userId, finalName, startedAt);

    const url = `/uploads/covers/${finalName}`;

    // 同步 preferences.coverImage（公开主页读取端以 preferences 为真相源）
    try {
      const [cur] = await getPool().query(`SELECT preferences FROM users WHERE id = ?`, [req.session.userId]);
      let prefs = cur.length && cur[0].preferences
        ? (typeof cur[0].preferences === 'string' ? JSON.parse(cur[0].preferences) : cur[0].preferences)
        : {};
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
      prefs.coverImage = url;
      await getPool().query(`UPDATE users SET preferences = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(prefs), req.session.userId]);
    } catch (e) {
      logger.warn('users', '⚠️ 封面上传后 preferences 同步失败:', e.message);
    }

    ok(res, { coverUrl: url, message: '封面上传成功' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '上传封面', ?)`,
      [req.session.userId, `上传自定义封面: ${req.file.originalname}`]);
  } catch (e) { handleError(res, e, '[users/cover]'); }
  finally {
    if (tmpPath) { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {} }
  }
});

// ==================== 上传用户单独网站背景 ====================
// 与封面独立：登录后整站页面背景（登录页/个人主页/成员详情同步展示）。
// 落 preferences.backgroundImage（JSON），公开读取端与 /me/profile 均下发该字段。
router.post('/me/background', requireAuth, secureUpload(backgroundUpload.single('background')), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择背景图片');
  }
  let tmpPath = req.file ? req.file.path : null;
  try {
    const startedAt = Date.now();
    const ts = Date.now();
    const finalName = `bg_${req.session.userId}_${ts}.jpg`;
    const finalPath = path.join(BACKGROUND_DIR, finalName);

    // 保留原始分辨率，仅统一转码为 JPG（此前缩到长边1920会让高清屏上背景变糊、与实际上传尺寸不一致）
    await sharp(req.file.path)
      .jpeg({ quality: 88 })
      .toFile(finalPath);

    if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size === 0) {
      throw new Error('背景上传失败：目标文件未写入');
    }

    cleanupOldBackgrounds(req.session.userId, finalName, startedAt);

    const url = `/uploads/backgrounds/${finalName}`;

    // 同步 preferences.backgroundImage
    try {
      const [cur] = await getPool().query(`SELECT preferences FROM users WHERE id = ?`, [req.session.userId]);
      let prefs = cur.length && cur[0].preferences
        ? (typeof cur[0].preferences === 'string' ? JSON.parse(cur[0].preferences) : cur[0].preferences)
        : {};
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
      prefs.backgroundImage = url;
      await getPool().query(`UPDATE users SET preferences = ?, updated_at = NOW() WHERE id = ?`,
        [JSON.stringify(prefs), req.session.userId]);
    } catch (e) {
      logger.warn('users', '⚠️ 背景上传后 preferences 同步失败:', e.message);
    }

    ok(res, { backgroundUrl: url, message: '背景上传成功' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '上传背景', ?)`,
      [req.session.userId, `上传自定义背景: ${req.file.originalname}`]);
  } catch (e) { handleError(res, e, '[users/background]'); }
  finally {
    if (tmpPath) { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {} }
  }
});

// 清除用户单独网站背景（恢复默认）
router.delete('/me/background', requireAuth, async (req, res) => {
  try {
    const [cur] = await getPool().query(`SELECT preferences FROM users WHERE id = ?`, [req.session.userId]);
    let prefs = cur.length && cur[0].preferences
      ? (typeof cur[0].preferences === 'string' ? JSON.parse(cur[0].preferences) : cur[0].preferences)
      : {};
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
    prefs.backgroundImage = '';
    await getPool().query(`UPDATE users SET preferences = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(prefs), req.session.userId]);
    ok(res, { message: '背景已恢复默认' });
  } catch (e) { handleError(res, e, '[users/background]'); }
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
          avatarUrl = profile.currentAvatarThumbnailImageUrl || profile.userIcon || profile.iconUrl || avatarUrl;
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
    const { avatarVisible, avatarType, haloVisible } = req.body || {};
    const updates = [];
    const values = [];

    if (avatarVisible !== undefined) {
      if (avatarVisible !== 0 && avatarVisible !== 1 && avatarVisible !== false && avatarVisible !== true) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'avatarVisible 必须是 0/1');
      }
      updates.push('avatar_visible = ?');
      values.push(avatarVisible ? 1 : 0);
    }

    if (haloVisible !== undefined) {
      if (haloVisible !== 0 && haloVisible !== 1 && haloVisible !== false && haloVisible !== true) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'haloVisible 必须是 0/1');
      }
      updates.push('halo_visible = ?');
      values.push(haloVisible ? 1 : 0);
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

    const [rows] = await getPool().query(`SELECT avatar_type, avatar_visible, halo_visible, custom_avatar_path, vrchat_avatar_url FROM users WHERE id = ?`, [uid]);
    const u = rows[0];
    ok(res, {
      avatarType: u.avatar_type,
      avatarVisible: u.avatar_visible === 0 ? false : true,
      haloVisible: u.halo_visible !== 0,
      // avatarUrl 需要 custom_avatar_path / vrchat_avatar_url 才能算出，
      // 只查 avatar_type,avatar_visible 会让 getAvatarUrl 恒为 null → 前端 saveAvatarPref
      // 把 currentUser.avatarUrl 覆写成 null，切显示开关/选来源后头像立即变默认
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
    // P-2: 隐私开关切换立即失效 WS 层的 location_visible TTL 缓存（否则最迟 10s 才生效）
    if (visible !== undefined && wsService && typeof wsService.invalidateLocationVisibleCache === 'function') {
      try { wsService.invalidateLocationVisibleCache(req.session.userId); } catch (e) {}
    }
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
