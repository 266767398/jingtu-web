/**
 * user-data-helper.js — 用户级数据导出/导入共享逻辑
 *
 * 供以下两处复用：
 *   1. 个人资料页自助导出/导入（users.js 的 /me/export、/me/import）
 *   2. 管理面板按用户/批量导出导入备份还原（admin.js）
 *
 * 依赖：utils.getPool
 */
const { getPool } = require('../utils');

// VRCX ExportFriendsListDialog 风格：CSV 字段转义（含逗号/引号/控制字符时加引号并转义内部引号）
function csvField(v) {
  const s = v == null ? '' : String(v);
  // CSV 转义必须识别控制字符，no-control-regex 在此为误报
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f,"]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function safeParseJson(v) {
  if (v == null || v === '') return v;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

// 通过 VRChat ID 反查本站 user_id（导入关注用）
async function resolveUserIdByVrcId(vrcId) {
  if (!vrcId) return 0;
  const [rows] = await getPool().query('SELECT id FROM users WHERE vrchat_id = ? AND deleted_at IS NULL LIMIT 1', [vrcId]);
  return rows.length ? rows[0].id : 0;
}

// 拉取指定用户全部可导出数据；用户不存在时返回 null
async function collectUserData(userId) {
  const pool = getPool();
  const [userRows] = await pool.query(
    'SELECT id, login_id, display_name, vrchat_id, vrchat_name, email, avatar_type, custom_avatar_path, vrchat_avatar_url, birthday, location, lat, lng, location_visible, vrchat_status, vrchat_verified, vrchat_connected_at FROM users WHERE id = ? AND deleted_at IS NULL',
    [userId]
  );
  if (!userRows.length) return null;
  const u = userRows[0];
  const vrcId = u.vrchat_id || '';

  const [tags] = await pool.query('SELECT tag_name, color, create_time FROM user_tags WHERE user_id = ? ORDER BY id ASC', [userId]);
  const notes = vrcId
    ? (await pool.query('SELECT target_vrcid, note_text, note_color, note_tags, update_time FROM member_note WHERE owner_vrcid = ? ORDER BY id ASC', [vrcId]))[0]
    : [];
  const [friends] = await pool.query(
    `SELECT uf.friend_id, uf.status, uf.requested_by, uf.created_at, us.vrchat_id AS friend_vrchat_id, us.vrchat_name AS friend_vrchat_name, us.display_name AS friend_display_name
     FROM user_friends uf LEFT JOIN users us ON us.id = uf.friend_id
     WHERE uf.user_id = ? ORDER BY uf.id ASC`,
    [userId]
  );
  const [follows] = await pool.query(
    `SELECT f.following_id, f.created_at, us.vrchat_id AS following_vrchat_id, us.vrchat_name AS following_vrchat_name, us.display_name AS following_display_name
     FROM user_follows f LEFT JOIN users us ON us.id = f.following_id
     WHERE f.follower_id = ? ORDER BY f.id ASC`,
    [userId]
  );
  const [worldFavs] = await pool.query('SELECT world_id, world_name, image_url, is_recommended, recommended_by, created_at FROM world_favorites WHERE user_id = ? ORDER BY id ASC', [userId]);
  const [avatarFavs] = await pool.query('SELECT avatar_id, avatar_name, image_url, is_recommended, recommended_by, created_at FROM avatar_favorites WHERE user_id = ? ORDER BY id ASC', [userId]);
  const [folders] = await pool.query('SELECT name, sort_order, created_at FROM collection_folders WHERE user_id = ? ORDER BY sort_order ASC, id ASC', [userId]);
  const [collections] = await pool.query(
    `SELECT kind, target_id, name, author, author_id, thumbnail, description, world_type, platform, load_type, size_bytes, size_category, category, content_rating, tags, status, invalid_reason, last_checked_at, invalid_at, unity_version, asset_url, unity_package_url, booth_url, favorite_count, collector_count, rating_avg, rating_count, heat, visibility, show_author, is_recommended, recommended_by, folder_id, notes, created_at_vrc, created_at, updated_at
     FROM collections WHERE user_id = ? ORDER BY id ASC`,
    [userId]
  );
  const [profile] = await pool.query('SELECT motto, bio, cover_image, location, website, social_links, privacy_settings FROM user_profile WHERE user_id = ?', [userId]);

  return {
    meta: {
      exported_at: new Date().toISOString(),
      version: 1,
      user: {
        id: u.id,
        login_id: u.login_id,
        display_name: u.display_name,
        vrchat_id: u.vrchat_id,
        vrchat_name: u.vrchat_name,
        email: u.email,
        birthday: u.birthday,
        location: u.location,
        lat: u.lat,
        lng: u.lng
      }
    },
    tags: tags.map(t => ({ name: t.tag_name, color: t.color, createdAt: t.create_time })),
    notes: notes.map(n => ({ targetVrcId: n.target_vrcid, text: n.note_text, color: n.note_color, tags: n.note_tags, updatedAt: n.update_time })),
    friends: friends.map(f => ({
      userId: f.friend_id,
      vrchatId: f.friend_vrchat_id,
      vrchatName: f.friend_vrchat_name,
      displayName: f.friend_display_name,
      status: f.status,
      requestedBy: f.requested_by,
      createdAt: f.created_at
    })),
    follows: follows.map(f => ({
      userId: f.following_id,
      vrchatId: f.following_vrchat_id,
      vrchatName: f.following_vrchat_name,
      displayName: f.following_display_name,
      createdAt: f.created_at
    })),
    worldFavorites: worldFavs,
    avatarFavorites: avatarFavs,
    folders: folders,
    collections: collections.map(c => ({ ...c, tags: safeParseJson(c.tags) })),
    profile: profile.length ? { ...profile[0], socialLinks: safeParseJson(profile[0].social_links), privacySettings: safeParseJson(profile[0].privacy_settings) } : null
  };
}

// 将导入 JSON 数据写入指定用户；返回 { imported } 统计对象
async function importUserData(userId, body) {
  const pool = getPool();
  const [userRows] = await pool.query('SELECT vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  if (!userRows.length) {
    const err = new Error('用户不存在');
    err.statusCode = 404;
    throw err;
  }
  const vrcId = userRows[0].vrchat_id || '';

  let imported = { tags: 0, notes: 0, follows: 0, worldFavorites: 0, avatarFavorites: 0, folders: 0, collections: 0 };

  // 标签
  if (Array.isArray(body.tags)) {
    for (const t of body.tags) {
      const name = String(t.name || '').trim().slice(0, 50);
      const color = String(t.color || '').slice(0, 20);
      if (!name) continue;
      await pool.query('INSERT INTO user_tags (user_id, tag_name, color) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE color = VALUES(color)', [userId, name, color]);
      imported.tags++;
    }
  }

  // 备注（以 VRChat ID 为键）
  if (Array.isArray(body.notes) && vrcId) {
    for (const n of body.notes) {
      const target = String(n.targetVrcId || '').trim().slice(0, 100);
      const text = n.text == null ? null : String(n.text).slice(0, 200);
      const color = n.color == null ? null : String(n.color).slice(0, 16);
      const tags = n.tags == null ? null : String(n.tags).slice(0, 255);
      if (!target) continue;
      await pool.query(
        'INSERT INTO member_note (owner_vrcid, target_vrcid, note_text, note_color, note_tags) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE note_text = VALUES(note_text), note_color = VALUES(note_color), note_tags = VALUES(note_tags)',
        [vrcId, target, text, color, tags]
      );
      imported.notes++;
    }
  }

  // 关注（跟随，单向）
  if (Array.isArray(body.follows)) {
    for (const f of body.follows) {
      const followingId = parseInt(f.userId) || (f.vrchatId ? await resolveUserIdByVrcId(f.vrchatId) : 0);
      if (!followingId || followingId === userId) continue;
      await pool.query('INSERT IGNORE INTO user_follows (follower_id, following_id) VALUES (?, ?)', [userId, followingId]);
      imported.follows++;
    }
  }

  // 世界收藏（旧表）
  if (Array.isArray(body.worldFavorites)) {
    for (const w of body.worldFavorites) {
      const wid = String(w.world_id || '').trim().slice(0, 100);
      if (!wid) continue;
      await pool.query(
        'INSERT INTO world_favorites (user_id, world_id, world_name, image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE world_name = VALUES(world_name), image_url = VALUES(image_url)',
        [userId, wid, String(w.world_name || '').slice(0, 255), String(w.image_url || '').slice(0, 500)]
      );
      imported.worldFavorites++;
    }
  }

  // 头像收藏（旧表）
  if (Array.isArray(body.avatarFavorites)) {
    for (const a of body.avatarFavorites) {
      const aid = String(a.avatar_id || '').trim().slice(0, 100);
      if (!aid) continue;
      await pool.query(
        'INSERT INTO avatar_favorites (user_id, avatar_id, avatar_name, image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE avatar_name = VALUES(avatar_name), image_url = VALUES(image_url)',
        [userId, aid, String(a.avatar_name || '').slice(0, 255), String(a.image_url || '').slice(0, 500)]
      );
      imported.avatarFavorites++;
    }
  }

  // 分组
  if (Array.isArray(body.folders)) {
    for (const fd of body.folders) {
      const name = String(fd.name || '').trim().slice(0, 100);
      if (!name) continue;
      const order = parseInt(fd.sort_order) || 0;
      await pool.query('INSERT INTO collection_folders (user_id, name, sort_order) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)', [userId, name, order]);
      imported.folders++;
    }
  }

  // 收藏（新表）
  if (Array.isArray(body.collections)) {
    for (const c of body.collections) {
      const kind = ['avatar_model', 'world', 'avatar_favorite'].includes(c.kind) ? c.kind : null;
      const targetId = String(c.target_id || '').trim().slice(0, 100);
      if (!kind || !targetId) continue;
      const tagsJson = JSON.stringify(Array.isArray(c.tags) ? c.tags : []);
      await pool.query(
        `INSERT INTO collections (user_id, kind, target_id, name, author, author_id, thumbnail, description, world_type, platform, load_type, size_bytes, size_category, category, content_rating, tags, status, invalid_reason, unity_version, asset_url, unity_package_url, booth_url, visibility, show_author, folder_id, notes, created_at_vrc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), author = VALUES(author), thumbnail = VALUES(thumbnail), description = VALUES(description), tags = VALUES(tags)`,
        [
          userId, kind, targetId,
          String(c.name || '').slice(0, 255),
          String(c.author || '').slice(0, 255),
          String(c.author_id || '').slice(0, 64),
          String(c.thumbnail || '').slice(0, 1024),
          c.description == null ? null : String(c.description).slice(0, 65535),
          String(c.world_type || '').slice(0, 32),
          String(c.platform || '').slice(0, 32),
          String(c.load_type || '').slice(0, 32),
          parseInt(c.size_bytes) || 0,
          String(c.size_category || '').slice(0, 16),
          c.category === 'functional' ? 'functional' : 'white',
          c.content_rating === '18+' ? '18+' : 'all',
          tagsJson,
          ['unknown', 'valid', 'invalid'].includes(c.status) ? c.status : 'unknown',
          String(c.invalid_reason || '').slice(0, 255),
          String(c.unity_version || '').slice(0, 64),
          String(c.asset_url || '').slice(0, 1024),
          String(c.unity_package_url || '').slice(0, 1024),
          String(c.booth_url || '').slice(0, 1024),
          c.visibility === 'public' ? 'public' : 'private',
          c.show_author ? 1 : 0,
          parseInt(c.folder_id) || null,
          c.notes == null ? null : String(c.notes).slice(0, 65535),
          c.created_at_vrc || null
        ]
      );
      imported.collections++;
    }
  }

  return { imported };
}

module.exports = {
  csvField,
  safeParseJson,
  resolveUserIdByVrcId,
  collectUserData,
  importUserData
};
