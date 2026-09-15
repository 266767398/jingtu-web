/**
 * 境途同游 网页版运维后台 —— 独立面板服务（默认端口 3457）
 * 仅监听本机 127.0.0.1；所有 API 需 Bearer Token 鉴权。
 * 运行：node panel/panel-server.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PANEL_DIR = __dirname;
const PS_API = path.join(PANEL_DIR, 'panel-api.ps1');
const PUBLIC_DIR = path.join(PANEL_DIR, 'public');
const AUTH_FILE = path.join(PANEL_DIR, 'panel-auth.json');
const SETTINGS_FILE = path.join(PANEL_DIR, 'panel-settings.json');
const BACKUP_DIR = path.join(ROOT, 'backup');
const LOGS_DIR = path.join(ROOT, 'logs');

/* ---------- 设置 ---------- */
const DEFAULT_SETTINGS = { port: 3457, lan: false, tokenHours: 12 };
function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); }
  catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}
let settings = loadSettings();
let LAN_MODE = !!settings.lan;

/* ---------- PS5.1 中文脚本必须 UTF-8 BOM ---------- */
function ensureBom(file) {
  try {
    const buf = fs.readFileSync(file);
    if (!(buf.length > 2 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)) {
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]));
      console.log('[panel] 已为 panel-api.ps1 补充 UTF-8 BOM（PS5.1 中文兼容）');
    }
  } catch (e) { console.error('[panel] ensureBom 失败:', e.message); }
}
ensureBom(PS_API);

/* ---------- 鉴权（PBKDF2） ---------- */
function authLoaded() { return fs.existsSync(AUTH_FILE); }
function authRead() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch (e) { return null; }
}
function authWrite(o) { fs.writeFileSync(AUTH_FILE, JSON.stringify(o, null, 2), 'utf8'); }
function hashPassword(pwd, salt) {
  return crypto.pbkdf2Sync(pwd, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex');
}
function verifyPassword(pwd, auth) {
  const h = hashPassword(pwd, auth.salt);
  const a = Buffer.from(h, 'hex'), b = Buffer.from(auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function createAuth(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const auth = { version: 1, salt, hash: hashPassword(pwd, salt), iterations: 100000, createdAt: new Date().toISOString() };
  authWrite(auth);
  return auth;
}

/* ---------- 会话（内存） ---------- */
const sessions = new Map(); // token -> expireAt(ms)
const loginFails = { count: 0, lockUntil: 0 };
function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + settings.tokenHours * 3600 * 1000);
  return token;
}
function checkToken(token) {
  if (!token || !sessions.has(token)) return false;
  const exp = sessions.get(token);
  if (Date.now() > exp) { sessions.delete(token); return false; }
  sessions.set(token, Date.now() + settings.tokenHours * 3600 * 1000); // 滑动续期
  return true;
}
function doLogout(token) { sessions.delete(token); }

/* ---------- 初始化向导：环境探测（只读） ---------- */
function envProbe() {
  const checks = [];
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel-config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { cfg = null; }
  const services = (cfg && Array.isArray(cfg.services)) ? cfg.services : [];
  for (const s of services) {
    const exe = (s.start && s.start.exe) || '';
    let ok = false;
    if (exe === 'node') {
      try { ok = spawnSync('node', ['--version'], { timeout: 8000 }).status === 0; } catch (e) { ok = false; }
    } else if (exe) {
      ok = fs.existsSync(exe);
    }
    checks.push({ name: s.name, port: s.port, exe: exe || '', ok });
  }
  const keys = [
    ['server/server.js', 'Node 服务入口'],
    ['.env', '环境配置'],
    ['panel-config.json', '面板配置']
  ];
  for (const [f, label] of keys) {
    checks.push({ name: label, path: f, ok: fs.existsSync(path.join(ROOT, f)) });
  }
  return checks;
}

/* ---------- 后台任务 ---------- */
const tasks = new Map(); // id -> task
function createTask(name, runner) {
  const id = crypto.randomBytes(8).toString('hex');
  const t = { id, name, status: 'running', output: [], startedAt: Date.now(), endedAt: null, result: null, error: null };
  tasks.set(id, t);
  Promise.resolve().then(() => runner(t)).then(
    (r) => { t.status = 'done'; t.result = r; t.endedAt = Date.now(); },
    (e) => { t.status = 'error'; t.error = (e && e.message) || String(e); t.endedAt = Date.now(); }
  );
  return id;
}
function appendOutput(t, text) {
  const lines = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (const ln of lines) {
    if (ln.trim().startsWith('{')) continue; // 跳过 JSON 行
    t.output.push(ln);
    if (t.output.length > 500) t.output.splice(0, t.output.length - 500);
  }
}

/* ---------- 调用 panel-api.ps1 ---------- */
function runPs(action, arg, onChunk) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_API, '-Action', action];
    if (arg !== undefined && arg !== null && arg !== '') args.push('-Arg', String(arg));
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn('powershell.exe', args, { windowsHide: true });
    } catch (e) { return reject(new Error('无法启动 powershell：' + e.message)); }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; if (onChunk) onChunk(d); });
    child.stderr.on('data', d => { stderr += d; if (onChunk) onChunk(d); });
    child.on('error', err => reject(new Error('powershell 启动失败：' + err.message)));
    child.on('close', code => {
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith('{')) { try { parsed = JSON.parse(t); } catch (e) { parsed = null; } if (parsed) break; }
      }
      if (parsed && parsed.ok) return resolve(parsed);
      // P2-95：响应只保留 PS 侧结构化 message（PS 端已收敛为单行安全原因）。
      // 原始 stderr/stdout 不再拼进 Error.message 回显到 HTTP 响应，改为只写
      // 本地面板审计日志，避免异常堆栈/绝对路径/账号名等内部上下文外泄。
      if (!parsed) {
        auditPanel(action + ' PS 未返回结构化结果（退出码 ' + code + '）：' + (stderr.trim() || stdout.trim()).slice(0, 500));
      }
      const msg = (parsed && parsed.message) || ('执行失败（退出码 ' + code + '），详情见面板审计日志');
      reject(new Error(msg));
    });
  });
}

/* ---------- 小工具 ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendErr(res, code, message) { sendJson(res, code, { ok: false, message }); }
function authRequired(req, res) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m || !checkToken(m[1])) { sendErr(res, 401, '未授权或会话已过期，请重新登录'); return null; }
  return m[1];
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 2 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

function getPathBase(req) {
  const u = new URL(req.url, 'http://localhost');
  return u.pathname;
}
function getQuery(req) {
  const u = new URL(req.url, 'http://localhost');
  return u.searchParams;
}
function isLoopback(req) {
  let addr = String((req.socket && req.socket.remoteAddress) || '');
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.');
}

/* ---------- 桌面打开操作 ---------- */
// P2-95：弃用 `cmd /c start "" …` 字符串拼接——路径/URL 会再过一次 cmd 解析（引号、
// & 等特殊字符即注入面）。改为 spawn 数组参数直传 explorer.exe，任何情况下不过 shell；
// explorer 打开窗口后即退出（退出码不可靠），以「进程能否拉起」（spawn/error 事件）判定成败。
function openDesktop(target, onDone) {
  try {
    const child = spawn('explorer.exe', [target], { cwd: ROOT, windowsHide: true });
    let settled = false;
    child.once('error', () => { if (!settled) { settled = true; onDone(false); } });
    child.once('spawn', () => { if (!settled) { settled = true; onDone(true); } });
  } catch (e) { onDone(false); }
}
function openInBrowser(url) {
  openDesktop(url, () => {});
}

/* ---------- 权限管理：权限键与中文标签（与主站 permission_groups.js 保持一致） ---------- */
const ALL_PERMISSIONS = [
  'can_create_album', 'can_create_photo', 'can_delete_photo',
  'can_create_announcement', 'can_edit_announcement', 'can_delete_announcement',
  'can_create_event', 'can_edit_event', 'can_delete_event',
  'can_sign_event', 'can_comment_event',
  'can_manage_users', 'can_manage_roles',
  'can_review_names', 'can_manage_permissions',
  'can_sync_vrchat', 'can_manage_rosters',
  'can_view_logs', 'can_upload_group_image',
  'can_edit_profile', 'can_change_password',
  'can_view_members', 'can_view_map',
  'can_view_album', 'can_view_events',
  'can_create_album_category',
  'can_create_post', 'can_delete_post', 'can_comment_post', 'can_like_post',
  'can_manage_model_collections'
];
const PERMISSION_LABELS = {
  can_create_album: '创建相册', can_create_photo: '上传照片', can_delete_photo: '删除照片',
  can_create_announcement: '发布公告', can_edit_announcement: '编辑公告', can_delete_announcement: '删除公告',
  can_create_event: '创建活动', can_edit_event: '编辑活动', can_delete_event: '删除活动',
  can_sign_event: '报名活动', can_comment_event: '活动评论',
  can_manage_users: '管理用户', can_manage_roles: '管理角色',
  can_review_names: '审核改名', can_manage_permissions: '管理权限',
  can_sync_vrchat: '同步VRChat', can_manage_rosters: '管理名册',
  can_view_logs: '查看日志', can_upload_group_image: '上传群图',
  can_edit_profile: '编辑资料', can_change_password: '修改密码',
  can_view_members: '查看成员', can_view_map: '查看地图',
  can_view_album: '查看相册', can_view_events: '查看活动',
  can_create_album_category: '创建相册分类',
  can_create_post: '发布动态', can_delete_post: '删除动态', can_comment_post: '动态评论', can_like_post: '动态点赞',
  can_manage_model_collections: '管理模型收藏馆'
};

/* ---------- 网站管理：MySQL 连接（复用主站 server/node_modules 依赖） ---------- */
let _mysql = null;
try { _mysql = require(path.join(ROOT, 'server', 'node_modules', 'mysql2', 'promise')); } catch (e) { _mysql = null; }
let _bcrypt = null;
try { _bcrypt = require(path.join(ROOT, 'server', 'node_modules', 'bcryptjs')); } catch (e) { _bcrypt = null; }
let _actCodes = null;
try { _actCodes = require(path.join(ROOT, 'server', 'activation_code_service')); } catch (e) { _actCodes = null; }

/* 面板操作审计：与 panel-api.ps1 的 Write-Audit 同格式，写入 logs/panel-audit.log */
function auditPanel(msg) {
  try {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const line = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ' | web-panel | ' + msg + '\n';
    fs.appendFile(path.join(ROOT, 'logs', 'panel-audit.log'), line, () => {});
  } catch (e) {}
}

function envValue(key) {
  // P2-95：key 参与 RegExp 拼接，先做标识符白名单，杜绝正则注入面（当前调用方均为常量，属防御）
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key))) return undefined;
  try {
    const p = path.join(ROOT, '.env');
    if (!fs.existsSync(p)) return undefined;
    const txt = fs.readFileSync(p, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$'));
      if (m) {
        let v = m[1].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return v;
      }
    }
  } catch (e) {}
  return undefined;
}

let _dbPool = null;
function getDb() {
  if (_dbPool) return _dbPool;
  if (!_mysql) throw new Error('主站 mysql2 依赖不可用');
  const cfg = {
    host: envValue('MYSQL_HOST') || '127.0.0.1',
    port: parseInt(envValue('MYSQL_PORT'), 10) || 3306,
    user: envValue('MYSQL_USER') || 'root',
    database: envValue('MYSQL_DATABASE') || 'jingtu_group'
  };
  const pwd = envValue('MYSQL_PASSWORD');
  if (pwd) cfg.password = pwd;
  _dbPool = _mysql.createPool(Object.assign(cfg, { waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' }));
  return _dbPool;
}
async function dbQuery(sql, params) {
  const pool = getDb();
  const [rows] = await pool.query(sql, params || []);
  return rows;
}
function maskSecret(v) {
  if (!v) return '';
  if (String(v).length <= 4) return '****';
  return String(v).slice(0, 2) + '****' + String(v).slice(-2);
}

/* ---------- 按用户数据导出/导入（复用主站 F-4 数据结构） ---------- */
function safeParseJson(v) {
  if (v == null || v === '') return v;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}
async function resolveUserIdByVrcId(vrcId) {
  if (!vrcId) return 0;
  const rows = await dbQuery('SELECT id FROM users WHERE vrchat_id = ? AND deleted_at IS NULL LIMIT 1', [vrcId]);
  return rows.length ? rows[0].id : 0;
}
async function collectUserDataPanel(userId) {
  const userRows = await dbQuery(
    'SELECT id, login_id, display_name, vrchat_id, vrchat_name, email, avatar_type, custom_avatar_path, vrchat_avatar_url, birthday, location, lat, lng, location_visible, vrchat_status, vrchat_verified, vrchat_connected_at FROM users WHERE id = ? AND deleted_at IS NULL',
    [userId]
  );
  if (!userRows.length) return null;
  const u = userRows[0];
  const vrcId = u.vrchat_id || '';
  const tags = await dbQuery('SELECT tag_name, color, create_time FROM user_tags WHERE user_id = ? ORDER BY id ASC', [userId]);
  const notes = vrcId ? await dbQuery('SELECT target_vrcid, note_text, note_color, note_tags, update_time FROM member_note WHERE owner_vrcid = ? ORDER BY id ASC', [vrcId]) : [];
  const friends = await dbQuery(
    `SELECT uf.friend_id, uf.status, uf.requested_by, uf.created_at, us.vrchat_id AS friend_vrchat_id, us.vrchat_name AS friend_vrchat_name, us.display_name AS friend_display_name
     FROM user_friends uf LEFT JOIN users us ON us.id = uf.friend_id WHERE uf.user_id = ? ORDER BY uf.id ASC`,
    [userId]
  );
  const follows = await dbQuery(
    `SELECT f.following_id, f.created_at, us.vrchat_id AS following_vrchat_id, us.vrchat_name AS following_vrchat_name, us.display_name AS following_display_name
     FROM user_follows f LEFT JOIN users us ON us.id = f.following_id WHERE f.follower_id = ? ORDER BY f.id ASC`,
    [userId]
  );
  const worldFavs = await dbQuery('SELECT world_id, world_name, image_url, is_recommended, recommended_by, created_at FROM world_favorites WHERE user_id = ? ORDER BY id ASC', [userId]);
  const avatarFavs = await dbQuery('SELECT avatar_id, avatar_name, image_url, is_recommended, recommended_by, created_at FROM avatar_favorites WHERE user_id = ? ORDER BY id ASC', [userId]);
  const folders = await dbQuery('SELECT name, sort_order, created_at FROM collection_folders WHERE user_id = ? ORDER BY sort_order ASC, id ASC', [userId]);
  const collections = await dbQuery(
    `SELECT kind, target_id, name, author, author_id, thumbnail, description, world_type, platform, load_type, size_bytes, size_category, category, content_rating, tags, status, invalid_reason, last_checked_at, invalid_at, unity_version, asset_url, unity_package_url, booth_url, favorite_count, collector_count, rating_avg, rating_count, heat, visibility, show_author, is_recommended, recommended_by, folder_id, notes, created_at_vrc, created_at, updated_at
     FROM collections WHERE user_id = ? ORDER BY id ASC`,
    [userId]
  );
  const profile = await dbQuery('SELECT motto, bio, cover_image, location, website, social_links, privacy_settings FROM user_profile WHERE user_id = ?', [userId]);
  return {
    meta: {
      exported_at: new Date().toISOString(),
      version: 1,
      user: { id: u.id, login_id: u.login_id, display_name: u.display_name, vrchat_id: u.vrchat_id, vrchat_name: u.vrchat_name, email: u.email, birthday: u.birthday, location: u.location, lat: u.lat, lng: u.lng }
    },
    tags: tags.map(t => ({ name: t.tag_name, color: t.color, createdAt: t.create_time })),
    notes: notes.map(n => ({ targetVrcId: n.target_vrcid, text: n.note_text, color: n.note_color, tags: n.note_tags, updatedAt: n.update_time })),
    friends: friends.map(f => ({ userId: f.friend_id, vrchatId: f.friend_vrchat_id, vrchatName: f.friend_vrchat_name, displayName: f.friend_display_name, status: f.status, requestedBy: f.requested_by, createdAt: f.created_at })),
    follows: follows.map(f => ({ userId: f.following_id, vrchatId: f.following_vrchat_id, vrchatName: f.following_vrchat_name, displayName: f.following_display_name, createdAt: f.created_at })),
    worldFavorites: worldFavs,
    avatarFavorites: avatarFavs,
    folders: folders,
    collections: collections.map(c => ({ ...c, tags: safeParseJson(c.tags) })),
    profile: profile.length ? { ...profile[0], socialLinks: safeParseJson(profile[0].social_links), privacySettings: safeParseJson(profile[0].privacy_settings) } : null
  };
}
async function importUserDataPanel(userId, body) {
  const userRows = await dbQuery('SELECT vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
  if (!userRows.length) { const e = new Error('用户不存在'); e.statusCode = 404; throw e; }
  const vrcId = userRows[0].vrchat_id || '';
  const imported = { tags: 0, notes: 0, follows: 0, worldFavorites: 0, avatarFavorites: 0, folders: 0, collections: 0 };
  if (Array.isArray(body.tags)) {
    for (const t of body.tags) {
      const name = String(t.name || '').trim().slice(0, 50);
      const color = String(t.color || '').slice(0, 20);
      if (!name) continue;
      await dbQuery('INSERT INTO user_tags (user_id, tag_name, color) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE color = VALUES(color)', [userId, name, color]);
      imported.tags++;
    }
  }
  if (Array.isArray(body.notes) && vrcId) {
    for (const n of body.notes) {
      const target = String(n.targetVrcId || '').trim().slice(0, 100);
      if (!target) continue;
      await dbQuery('INSERT INTO member_note (owner_vrcid, target_vrcid, note_text, note_color, note_tags) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE note_text = VALUES(note_text), note_color = VALUES(note_color), note_tags = VALUES(note_tags)',
        [vrcId, target, n.text == null ? null : String(n.text).slice(0, 200), n.color == null ? null : String(n.color).slice(0, 16), n.tags == null ? null : String(n.tags).slice(0, 255)]);
      imported.notes++;
    }
  }
  if (Array.isArray(body.follows)) {
    for (const f of body.follows) {
      const followingId = parseInt(f.userId) || (f.vrchatId ? await resolveUserIdByVrcId(f.vrchatId) : 0);
      if (!followingId || followingId === userId) continue;
      await dbQuery('INSERT IGNORE INTO user_follows (follower_id, following_id) VALUES (?, ?)', [userId, followingId]);
      imported.follows++;
    }
  }
  if (Array.isArray(body.worldFavorites)) {
    for (const w of body.worldFavorites) {
      const wid = String(w.world_id || '').trim().slice(0, 100);
      if (!wid) continue;
      await dbQuery('INSERT INTO world_favorites (user_id, world_id, world_name, image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE world_name = VALUES(world_name), image_url = VALUES(image_url)',
        [userId, wid, String(w.world_name || '').slice(0, 255), String(w.image_url || '').slice(0, 500)]);
      imported.worldFavorites++;
    }
  }
  if (Array.isArray(body.avatarFavorites)) {
    for (const a of body.avatarFavorites) {
      const aid = String(a.avatar_id || '').trim().slice(0, 100);
      if (!aid) continue;
      await dbQuery('INSERT INTO avatar_favorites (user_id, avatar_id, avatar_name, image_url) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE avatar_name = VALUES(avatar_name), image_url = VALUES(image_url)',
        [userId, aid, String(a.avatar_name || '').slice(0, 255), String(a.image_url || '').slice(0, 500)]);
      imported.avatarFavorites++;
    }
  }
  if (Array.isArray(body.folders)) {
    for (const fd of body.folders) {
      const name = String(fd.name || '').trim().slice(0, 100);
      if (!name) continue;
      await dbQuery('INSERT INTO collection_folders (user_id, name, sort_order) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)', [userId, name, parseInt(fd.sort_order) || 0]);
      imported.folders++;
    }
  }
  if (Array.isArray(body.collections)) {
    for (const c of body.collections) {
      const kind = ['avatar_model', 'world', 'avatar_favorite'].includes(c.kind) ? c.kind : null;
      const targetId = String(c.target_id || '').trim().slice(0, 100);
      if (!kind || !targetId) continue;
      const tagsJson = JSON.stringify(Array.isArray(c.tags) ? c.tags : []);
      await dbQuery(
        `INSERT INTO collections (user_id, kind, target_id, name, author, author_id, thumbnail, description, world_type, platform, load_type, size_bytes, size_category, category, content_rating, tags, status, invalid_reason, unity_version, asset_url, unity_package_url, booth_url, visibility, show_author, folder_id, notes, created_at_vrc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), author = VALUES(author), thumbnail = VALUES(thumbnail), description = VALUES(description), tags = VALUES(tags)`,
        [userId, kind, targetId, String(c.name || '').slice(0, 255), String(c.author || '').slice(0, 255), String(c.author_id || '').slice(0, 64),
          String(c.thumbnail || '').slice(0, 1024), c.description == null ? null : String(c.description).slice(0, 65535), String(c.world_type || '').slice(0, 32),
          String(c.platform || '').slice(0, 32), String(c.load_type || '').slice(0, 32), parseInt(c.size_bytes) || 0, String(c.size_category || '').slice(0, 16),
          c.category === 'functional' ? 'functional' : 'white', c.content_rating === '18+' ? '18+' : 'all', tagsJson,
          ['unknown', 'valid', 'invalid'].includes(c.status) ? c.status : 'unknown', String(c.invalid_reason || '').slice(0, 255),
          String(c.unity_version || '').slice(0, 64), String(c.asset_url || '').slice(0, 1024), String(c.unity_package_url || '').slice(0, 1024),
          String(c.booth_url || '').slice(0, 1024), c.visibility === 'public' ? 'public' : 'private', c.show_author ? 1 : 0, parseInt(c.folder_id) || null,
          c.notes == null ? null : String(c.notes).slice(0, 65535), c.created_at_vrc || null]);
      imported.collections++;
    }
  }
  return imported;
}

/* ---------- 路由 ---------- */
async function handleApi(req, res, token) {
  const pathName = getPathBase(req);
  const body = (req.method === 'POST') ? await readBody(req) : {};

  if (pathName === '/api/bootstrap') {
    if (!token) return sendJson(res, 200, { ok: true, initialized: authLoaded() });
    return sendJson(res, 200, { ok: true, initialized: authLoaded(), lan: LAN_MODE, port: settings.port, env: envProbe() });
  }
  if (pathName === '/api/setup-env') {
    if (authLoaded()) return sendErr(res, 403, '面板已初始化，请直接登录');
    if (!isLoopback(req)) return sendErr(res, 403, '初始化环境检测仅可在本机进行');
    return sendJson(res, 200, { ok: true, env: envProbe() });
  }
  if (pathName === '/api/init') {
    if (authLoaded()) return sendErr(res, 403, '面板已初始化，请直接登录');
    if (!isLoopback(req)) return sendErr(res, 403, '初始化管理面板仅可在本机进行');
    const pwd = String(body.password || '');
    if (pwd.length < 8) return sendErr(res, 400, '面板管理密码至少 8 位');
    createAuth(pwd);
    auditPanel('面板初始化完成，已设置管理密码');
    return sendJson(res, 200, { ok: true, token: issueToken(), message: '初始化完成' });
  }
  if (pathName === '/api/login') {
    if (!authLoaded()) return sendErr(res, 400, '面板尚未初始化');
    if (Date.now() < loginFails.lockUntil) {
      const sec = Math.ceil((loginFails.lockUntil - Date.now()) / 1000);
      return sendErr(res, 429, `尝试次数过多，请 ${sec} 秒后重试`);
    }
    const auth = authRead();
    const pwd = String(body.password || '');
    if (auth && verifyPassword(pwd, auth)) {
      loginFails.count = 0;
      return sendJson(res, 200, { ok: true, token: issueToken() });
    }
    loginFails.count++;
    if (loginFails.count >= 5) {
      loginFails.lockUntil = Date.now() + 15 * 60 * 1000;
      loginFails.count = 0;
      return sendErr(res, 429, '失败次数过多，已锁定 15 分钟');
    }
    return sendErr(res, 401, `密码错误（还可尝试 ${5 - loginFails.count} 次）`);
  }
  if (pathName === '/api/logout') {
    if (token) doLogout(token);
    return sendJson(res, 200, { ok: true });
  }

  // ===== 以下均需登录 =====
  if (!token) return sendErr(res, 401, '未授权');

  /* ---- 状态 ---- */
  if (pathName === '/api/status') {
    const r = await runPs('status');
    return sendJson(res, 200, Object.assign({ ok: true }, r.data, {
      panel: { version: 1, lan: LAN_MODE, port: settings.port, startedAt: global.__startedAt }
    }));
  }

  /* ---- 服务管理 ---- */
  if (/^\/api\/service$/.test(pathName)) {
    const action = String(body.action || '');
    if (!['start', 'stop', 'restart'].includes(action)) return sendErr(res, 400, '无效操作');
    const name = String(body.name || 'all');
    const r = await runPs(action, name);
    return sendJson(res, 200, { ok: true, results: r.data, message: (r.data && r.data.map ? r.data.map(x => x.message).join('\n') : '完成') });
  }

  /* ---- 备份 / 恢复 ---- */
  if (pathName === '/api/backup') {
    const id = createTask('备份用户数据', async (t) => {
      await runPs('backup', '', (chunk) => appendOutput(t, chunk));
      t.output.push('✓ 备份任务完成');
      return true;
    });
    return sendJson(res, 200, { ok: true, taskId: id });
  }
  if (pathName === '/api/backups') {
    const r = await runPs('backups');
    return sendJson(res, 200, Object.assign({ ok: true }, r.data));
  }
  if (pathName === '/api/restore') {
    const name = String(body.name || '');
    if (!name) return sendErr(res, 400, '缺少备份文件名');
    if (String(body.confirm || '') !== 'CONFIRM-RESTORE-FROM-BACKUP') {
      return sendErr(res, 400, '确认短语不正确');
    }
    const id = createTask('从备份恢复', async (t) => {
      const r = await runPs('restore', JSON.stringify({ name }), (chunk) => appendOutput(t, chunk));
      if (r.data && r.data.snapMsg) t.output.push(r.data.snapMsg);
      t.output.push('✓ 恢复完成');
      return true;
    });
    return sendJson(res, 200, { ok: true, taskId: id });
  }
  if (pathName === '/api/clear-data') {
    if (String(body.confirm || '') !== 'CONFIRM-DELETE-ALL-DATA' && String(body.confirm || '') !== 'CONFIRM-DELETE-ALL') {
      return sendErr(res, 400, '确认短语不正确');
    }
    const r = await runPs('clear-data');
    return sendJson(res, 200, { ok: true, message: r.message });
  }
  if (pathName === '/api/backup/download') {
    const name = String(getQuery(req).get('name') || '');
    if (!/^[^\\/]+$/.test(name)) return sendErr(res, 400, '非法文件名');
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendErr(res, 404, '备份不存在');
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '"',
      'Content-Length': stat.size
    });
    fs.createReadStream(file).pipe(res);
    return null;
  }

  /* ---- 日志 ---- */
  if (pathName === '/api/logs/recent') {
    const r = await runPs('recent-log');
    return sendJson(res, 200, Object.assign({ ok: true }, r.data));
  }
  if (pathName === '/api/logs/search') {
    const kw = String(body.keyword || '');
    const r = await runPs('search-log', kw);
    return sendJson(res, 200, Object.assign({ ok: true }, r.data));
  }
  if (pathName === '/api/logs/clear') {
    const r = await runPs('clear-logs');
    return sendJson(res, 200, { ok: true, message: r.message });
  }
  if (pathName === '/api/audit-log') {
    const r = await runPs('audit-log');
    return sendJson(res, 200, Object.assign({ ok: true }, r.data));
  }

  /* ---- 系统工具 ---- */
  if (pathName === '/api/env/check') {
    const r = await runPs('check-env');
    return sendJson(res, 200, Object.assign({ ok: true }, r.data));
  }
  if (pathName === '/api/export-config') {
    const r = await runPs('export-config');
    return sendJson(res, 200, { ok: true, message: r.message, path: r.data && r.data.path });
  }
  if (pathName === '/api/export-panel-config') {
    const r = await runPs('export-panel-config');
    return sendJson(res, 200, { ok: true, message: r.message, path: r.data && r.data.path });
  }
  if (pathName === '/api/ports') {
    const port = String(getQuery(req).get('port') || '');
    const r = await runPs('ports', port);
    return sendJson(res, 200, Object.assign({ ok: true }, r.data));
  }
  if (pathName === '/api/ports/kill') {
    if (String(body.confirm || '') !== 'CONFIRM-DELETE-ALL-DATA' && String(body.confirm || '') !== 'CONFIRM-KILL-PORT') {
      return sendErr(res, 400, '确认短语不正确');
    }
    const r = await runPs('kill-port', String(body.port || ''));
    return sendJson(res, 200, { ok: true, message: r.message });
  }
  if (pathName === '/api/disk') {
    const r = await runPs('disk');
    return sendJson(res, 200, Object.assign({ ok: true }, r.data));
  }
  if (pathName === '/api/lan-ip') {
    const r = await runPs('lan-ip');
    return sendJson(res, 200, Object.assign({ ok: true }, r.data));
  }
  if (pathName === '/api/cache-clean') {
    const r = await runPs('cache-clean');
    return sendJson(res, 200, { ok: true, message: r.message });
  }
  if (pathName === '/api/export-site') {
    const inc = body.includeData ? 'data' : '';
    const id = createTask('导出网站包' + (inc ? '（含用户数据）' : ''), async (t) => {
      const r = await runPs('export-site', inc, (chunk) => appendOutput(t, chunk));
      t.output.push('✓ 导出完成: ' + (r.data && r.data.path));
      return true;
    });
    return sendJson(res, 200, { ok: true, taskId: id });
  }

  /* ---- 安全与配置 ---- */
  if (pathName === '/api/change-password') {
    const auth = authRead();
    if (!auth || !verifyPassword(String(body.old || ''), auth)) return sendErr(res, 400, '原密码错误');
    const npwd = String(body.newPassword || '');
    if (npwd.length < 8) return sendErr(res, 400, '新密码至少 8 位');
    createAuth(npwd);
    // P2-93：改密后必须让所有旧 token 立即失效——否则攻击者持改前签发的
    // 会话可在改密后继续操作面板。sessions 为内存 Map，清空即全局踢出。
    sessions.clear();
    auditPanel('面板管理密码已更新，已注销全部会话');
    return sendJson(res, 200, { ok: true, message: '面板管理密码已更新，请重新登录' });
  }
  if (pathName === '/api/reset-superadmin') {
    if (String(body.confirm || '') !== 'CONFIRM-DELETE-ALL-DATA' && String(body.confirm || '') !== 'CONFIRM-RESET-SUPERADMIN') {
      return sendErr(res, 400, '确认短语不正确');
    }
    const login = String(body.login || 'super_admin');
    const pass = String(body.pass || '');
    if (!pass) return sendErr(res, 400, '请填写临时密码');
    const r = await runPs('reset-superadmin', JSON.stringify({ login, pass }));
    return sendJson(res, 200, { ok: true, message: r.message, data: r.data });
  }
  if (pathName === '/api/settings') {
    if (typeof body.lan === 'boolean') {
      // P2-93：lan=true 会把面板从「仅本机」放开到整个局域网，属安全边界变更，
      // 必须再认证一次当前密码（防止 token 被盗/忘锁屏时被人顺手开洞）。
      if (body.lan) {
        const auth = authRead();
        if (!auth || !verifyPassword(String(body.password || ''), auth)) {
          return sendErr(res, 403, '开启局域网访问需重新输入面板密码');
        }
      }
      settings.lan = body.lan;
      LAN_MODE = body.lan;
      saveSettings(settings);
      auditPanel('面板访问模式变更：' + (body.lan ? '允许局域网访问' : '仅本机访问'));
      return sendJson(res, 200, { ok: true, message: '设置已保存' + (body.lan ? '，重启面板后允许局域网访问生效' : '') });
    }
    return sendErr(res, 400, '无效设置');
  }

  /* ---- 重置初始化（对齐 start-services.ps1 功能 #1） ---- */
  if (pathName === '/api/reset-init') {
    // P2-93：与本文件其它危险操作（:595 kill-port、:633 reset-superadmin）同口径，
    // 重建初始状态前必须携带确认短语。
    if (String(body.confirm || '') !== 'CONFIRM-RESET-INIT') {
      return sendErr(res, 400, '确认短语不正确');
    }
    auditPanel('面板执行重置初始化');
    const r = await runPs('reset');
    return sendJson(res, 200, { ok: true, message: r.message });
  }

  /* ---- 激活码管理（复用主站激活码服务，文件离线存储） ---- */
  if (pathName === '/api/activation-codes' && req.method === 'GET') {
    if (!_actCodes) return sendErr(res, 500, '激活码服务不可用');
    try {
      const list = await _actCodes.listCodes();
      return sendJson(res, 200, { ok: true, data: { total: list.total, used: list.used, unused: list.unused, revoked: list.revoked, expired: list.expired || 0, codes: list.codes } });
    } catch (e) { return sendErr(res, 500, '读取激活码失败：' + e.message); }
  }
  if (pathName === '/api/activation-codes/generate' && req.method === 'POST') {
    if (!_actCodes) return sendErr(res, 500, '激活码服务不可用');
    const count = Math.min(200, Math.max(1, parseInt(body.count, 10) || 1));
    const note = typeof body.note === 'string' ? body.note.slice(0, 100) : '';
    const expiresDays = Math.max(0, Math.min(3650, parseInt(body.expiresDays, 10) || 0));
    try {
      const created = await _actCodes.generateCodes(count, 'panel-admin', note, expiresDays);
      auditPanel('生成激活码 ' + created.length + ' 枚' + (expiresDays ? '（有效期 ' + expiresDays + ' 天）' : '') + (note ? '（备注：' + note + '）' : ''));
      return sendJson(res, 200, { ok: true, data: { count: created.length, codes: created.map(function (c) { return c.code; }), expiresAt: (created[0] && created[0].expires_at) || null } });
    } catch (e) { return sendErr(res, 500, '生成失败：' + e.message); }
  }
  if (pathName === '/api/activation-codes/revoke' && req.method === 'POST') {
    if (!_actCodes) return sendErr(res, 500, '激活码服务不可用');
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : '';
    if (!code) return sendErr(res, 400, '请提供要作废的激活码');
    try {
      const result = await _actCodes.revokeCode(code, 'panel-admin', reason);
      if (!result.ok) {
        const msgs = {
          INVALID_FORMAT: '激活码格式不正确',
          NOT_FOUND: '激活码不存在',
          ALREADY_USED: '该激活码已被使用，无法作废',
          ALREADY_REVOKED: '该激活码已作废，无需重复操作'
        };
        return sendErr(res, 400, msgs[result.reason] || '作废失败');
      }
      auditPanel('作废激活码 ' + result.entry.code + (reason ? '（原因：' + reason + '）' : ''));
      return sendJson(res, 200, { ok: true, message: '已作废 ' + result.entry.code, data: { code: result.entry.code } });
    } catch (e) { return sendErr(res, 500, '作废失败：' + e.message); }
  }

  /* ---- 网站管理 ---- */
  if (pathName === '/api/site/overview') {
    try {
      const version = (() => { try { return require(path.join(ROOT, 'server', 'package.json')).version; } catch (e) { return '-'; } })();
      const stats = await dbQuery(
        `SELECT
          (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS users,
          (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND banned=0) AS activeUsers,
          (SELECT COUNT(*) FROM event WHERE is_archive=0) AS events,
          (SELECT COUNT(*) FROM posts) AS posts,
          (SELECT COUNT(*) FROM group_roster WHERE is_member=1) AS members`
      );
      const row = (stats && stats[0]) || {};
      return sendJson(res, 200, { ok: true, data: { version, users: row.users || 0, activeUsers: row.activeUsers || 0, events: row.events || 0, posts: row.posts || 0, members: row.members || 0 } });
    } catch (e) {
      return sendJson(res, 200, { ok: true, data: { version: '-', users: 0, activeUsers: 0, events: 0, posts: 0, members: 0, dbError: e.message } });
    }
  }
  if (pathName === '/api/site/users') {
    const q = getQuery(req);
    const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(q.get('size'), 10) || 20));
    const kw = String(q.get('kw') || '').trim();
    const offset = (page - 1) * size;
    try {
      const like = '%' + kw + '%';
      const where = kw
        ? 'WHERE deleted_at IS NULL AND (login_id LIKE ? OR display_name LIKE ?)'
        : 'WHERE deleted_at IS NULL';
      const params = kw ? [like, like, size, offset] : [size, offset];
      const rows = await dbQuery(
        `SELECT id, login_id, display_name, role, banned, approved, vrchat_name, created_at
         FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, params);
      const t = kw
        ? await dbQuery(`SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL AND (login_id LIKE ? OR display_name LIKE ?)`, [like, like])
        : await dbQuery(`SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL`);
      return sendJson(res, 200, { ok: true, data: { rows, total: (t[0] && t[0].c) || 0, page, size } });
    } catch (e) {
      return sendErr(res, 500, '查询用户失败：' + e.message);
    }
  }
  if (pathName === '/api/site/user/toggle') {
    const id = parseInt(body.id, 10);
    const banned = body.banned ? 1 : 0;
    if (!id) return sendErr(res, 400, '缺少用户 ID');
    try {
      await dbQuery(`UPDATE users SET banned=? WHERE id=? AND deleted_at IS NULL`, [banned, id]);
      auditPanel((banned ? '禁用用户 #' : '启用用户 #') + id);
      return sendJson(res, 200, { ok: true, message: banned ? '用户已禁用' : '用户已启用' });
    } catch (e) {
      return sendErr(res, 500, '操作失败：' + e.message);
    }
  }
  if (pathName === '/api/site/user/reset-password') {
    const id = parseInt(body.id, 10);
    const pwd = String(body.password || '');
    if (!id) return sendErr(res, 400, '缺少用户 ID');
    if (pwd.length < 8) return sendErr(res, 400, '新密码至少 8 位');
    if (!_bcrypt) return sendErr(res, 500, 'bcryptjs 依赖不可用');
    try {
      const hash = await _bcrypt.hash(pwd, 12);
      await dbQuery(`UPDATE users SET password_hash=? WHERE id=? AND deleted_at IS NULL`, [hash, id]);
      auditPanel('重置站内用户密码 #' + id);
      return sendJson(res, 200, { ok: true, message: '密码已重置' });
    } catch (e) {
      return sendErr(res, 500, '重置失败：' + e.message);
    }
  }
  /* ---- 用户：修改角色（身份）/ 删除 ---- */
  if (pathName === '/api/site/user/role') {
    const id = parseInt(body.id, 10);
    const role = String(body.role || '');
    if (!id) return sendErr(res, 400, '缺少用户 ID');
    if (!['member', 'admin', 'super_admin'].includes(role)) return sendErr(res, 400, '角色值无效');
    try {
      const rows = await dbQuery(`SELECT id, role FROM users WHERE id=? AND deleted_at IS NULL`, [id]);
      if (!rows.length) return sendErr(res, 404, '用户不存在');
      if (rows[0].role === 'super_admin' && role !== 'super_admin') {
        const su = await dbQuery(`SELECT COUNT(*) AS c FROM users WHERE role='super_admin' AND deleted_at IS NULL`);
        if (((su[0] && su[0].c) || 0) <= 1) return sendErr(res, 400, '至少保留一名超级管理员，不能降级唯一超管');
      }
      await dbQuery(`UPDATE users SET role=?, updated_at=NOW() WHERE id=?`, [role, id]);
      // 角色 → 基础权限组同步（1=超管 / 2=管理员 / 3=成员，与主站 syncUserBaseGroup 一致）
      const baseGroupId = role === 'super_admin' ? 1 : role === 'admin' ? 2 : 3;
      await dbQuery(`INSERT IGNORE INTO user_group_membership (user_id, group_id) VALUES (?, ?)`, [id, baseGroupId]);
      await dbQuery(`DELETE FROM user_group_membership WHERE user_id=? AND group_id IN (1,2,3) AND group_id<>?`, [id, baseGroupId]);
      auditPanel('变更站内用户角色 #' + id + ' → ' + role);
      return sendJson(res, 200, { ok: true, message: '已更新为：' + ({ super_admin: '超级管理员', admin: '管理员', member: '成员' }[role] || role) });
    } catch (e) { return sendErr(res, 500, '更新失败：' + e.message); }
  }
  if (pathName === '/api/site/user/delete') {
    const id = parseInt(body.id, 10);
    if (!id) return sendErr(res, 400, '缺少用户 ID');
    try {
      const rows = await dbQuery(`SELECT role FROM users WHERE id=? AND deleted_at IS NULL`, [id]);
      if (!rows.length) return sendErr(res, 404, '用户不存在');
      if (rows[0].role === 'super_admin') return sendErr(res, 400, '不能删除超级管理员（可先降级再删除）');
      await dbQuery(`UPDATE users SET deleted_at=NOW() WHERE id=?`, [id]);
      await dbQuery(`DELETE FROM notifications WHERE user_id=?`, [id]);
      auditPanel('删除站内用户 #' + id + '（软删除）');
      return sendJson(res, 200, { ok: true, message: '用户已删除（软删除）' });
    } catch (e) { return sendErr(res, 500, '删除失败：' + e.message); }
  }

  /* ---- 权限管理：权限组 / 权限项 / 用户入组 ---- */
  if (pathName === '/api/site/perm-groups') {
    try {
      const groups = await dbQuery(`SELECT id, name, description, is_default, is_system FROM permission_groups ORDER BY is_system DESC, id ASC`);
      const entries = await dbQuery(`SELECT group_id, permission_key, permission_value FROM group_permission_entries`);
      const map = {};
      for (const e of entries) {
        if (!map[e.group_id]) map[e.group_id] = {};
        map[e.group_id][e.permission_key] = !!e.permission_value;
      }
      return sendJson(res, 200, { ok: true, data: { groups, entries: map, labels: PERMISSION_LABELS, keys: ALL_PERMISSIONS } });
    } catch (e) { return sendErr(res, 500, '读取权限失败：' + e.message); }
  }
  if (pathName === '/api/site/perm-group/create') {
    const name = String(body.name || '').trim();
    const description = String(body.description || '').trim();
    if (!name) return sendErr(res, 400, '请输入权限组名称');
    try {
      const dup = await dbQuery(`SELECT id FROM permission_groups WHERE name=?`, [name]);
      if (dup.length) return sendErr(res, 400, '权限组名称已存在');
      await dbQuery(`INSERT INTO permission_groups (name, description) VALUES (?, ?)`, [name, description || null]);
      auditPanel('创建权限组：' + name);
      return sendJson(res, 200, { ok: true, message: '权限组已创建' });
    } catch (e) { return sendErr(res, 500, '创建失败：' + e.message); }
  }
  if (pathName === '/api/site/perm-group/save') {
    const groupId = parseInt(body.groupId, 10);
    const perms = (body.perms && typeof body.perms === 'object') ? body.perms : {};
    if (!groupId) return sendErr(res, 400, '缺少权限组 ID');
    try {
      const g = await dbQuery(`SELECT id FROM permission_groups WHERE id=?`, [groupId]);
      if (!g.length) return sendErr(res, 404, '权限组不存在');
      const on = Object.keys(perms).filter(k => ALL_PERMISSIONS.includes(k) && perms[k]);
      await dbQuery(`DELETE FROM group_permission_entries WHERE group_id=?`, [groupId]);
      for (const k of on) {
        await dbQuery(`INSERT INTO group_permission_entries (group_id, permission_key, permission_value) VALUES (?,?,1)`, [groupId, k]);
      }
      auditPanel('保存权限组 #' + groupId + ' 权限（' + on.length + ' 项开启）');
      return sendJson(res, 200, { ok: true, message: '权限已保存（' + on.length + ' 项开启）' });
    } catch (e) { return sendErr(res, 500, '保存失败：' + e.message); }
  }
  if (pathName === '/api/site/user/permgroups') {
    const id = parseInt(req.method === 'GET' ? (getQuery(req).get('id') || '') : body.id, 10);
    if (!id) return sendErr(res, 400, '缺少用户 ID');
    try {
      const u = await dbQuery(`SELECT id, role FROM users WHERE id=? AND deleted_at IS NULL`, [id]);
      if (!u.length) return sendErr(res, 404, '用户不存在');
      const baseId = u[0].role === 'super_admin' ? 1 : u[0].role === 'admin' ? 2 : 3;
      if (req.method === 'GET') {
        const groups = await dbQuery(
          `SELECT g.id, g.name, g.is_default, g.is_system, (ugm.user_id IS NOT NULL) AS joined
           FROM permission_groups g
           LEFT JOIN user_group_membership ugm ON ugm.group_id=g.id AND ugm.user_id=?
           ORDER BY g.is_system DESC, g.id ASC`, [id]);
        return sendJson(res, 200, { ok: true, data: { role: u[0].role, baseGroupId: baseId, groups } });
      }
      const groupIds = Array.isArray(body.groupIds) ? body.groupIds.map(Number).filter(Boolean) : [];
      const custom = Array.from(new Set(groupIds)).filter(gid => ![1, 2, 3].includes(gid));
      await dbQuery(`DELETE FROM user_group_membership WHERE user_id=? AND group_id NOT IN (1,2,3)`, [id]);
      for (const gid of custom) {
        await dbQuery(`INSERT IGNORE INTO user_group_membership (user_id, group_id) VALUES (?,?)`, [id, gid]);
      }
      auditPanel('更新用户 #' + id + ' 权限组（自定义组 ' + custom.join(',') + '）');
      return sendJson(res, 200, { ok: true, message: '用户权限组已更新' });
    } catch (e) { return sendErr(res, 500, '操作失败：' + e.message); }
  }
  /* ---- 用户数据备份 / 还原 ---- */
  if (pathName === '/api/site/user/data/export' && req.method === 'GET') {
    try {
      const id = parseInt(getQuery(req).get('id') || '', 10);
      if (!id) return sendErr(res, 400, '缺少用户 ID');
      const data = await collectUserDataPanel(id);
      if (!data) return sendErr(res, 404, '用户不存在');
      const json = JSON.stringify(data, null, 2);
      const filename = 'user_' + id + '_backup_' + new Date().toISOString().slice(0, 10) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      res.end(json);
      return null;
    } catch (e) { return sendErr(res, e.statusCode || 500, '导出失败：' + e.message); }
  }
  if (pathName === '/api/site/user/data/import' && req.method === 'POST') {
    try {
      const id = parseInt(body.id, 10);
      if (!id) return sendErr(res, 400, '缺少用户 ID');
      const data = body.data;
      if (!data || typeof data !== 'object') return sendErr(res, 400, '缺少备份数据');
      const imported = await importUserDataPanel(id, data);
      auditPanel('导入站内用户数据 #' + id);
      return sendJson(res, 200, { ok: true, success: true, imported });
    } catch (e) { return sendErr(res, e.statusCode || 500, '导入失败：' + e.message); }
  }
  if (pathName === '/api/site/user/data/batch-export' && req.method === 'POST') {
    try {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean);
      if (!ids.length) return sendErr(res, 400, '缺少用户 ID 列表');
      const users = {};
      const skipped = [];
      for (const id of ids) {
        const data = await collectUserDataPanel(id);
        if (data) users[id] = data; else skipped.push(id);
      }
      const payload = { exported_at: new Date().toISOString(), version: 1, users, skipped };
      const json = JSON.stringify(payload, null, 2);
      const filename = 'users_batch_backup_' + new Date().toISOString().slice(0, 10) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      res.end(json);
      return null;
    } catch (e) { return sendErr(res, e.statusCode || 500, '批量导出失败：' + e.message); }
  }
  if (pathName === '/api/site/user/data/batch-import' && req.method === 'POST') {
    try {
      const source = body.users || (body && !Array.isArray(body) && body.meta && body.user ? { [body.user.id]: body } : null);
      if (!source || typeof source !== 'object') return sendErr(res, 400, '缺少备份数据');
      const imported = [];
      const failed = {};
      for (const key of Object.keys(source)) {
        const id = parseInt(key, 10);
        if (!id) continue;
        try {
          const counts = await importUserDataPanel(id, source[key]);
          imported.push({ userId: id, imported: counts });
        } catch (err) { failed[id] = err.message; }
      }
      auditPanel('批量导入站内用户数据：成功 ' + imported.length + ' 人' + (Object.keys(failed).length ? '，失败 ' + Object.keys(failed).join(',') : ''));
      return sendJson(res, 200, { ok: true, success: true, imported, failed });
    } catch (e) { return sendErr(res, e.statusCode || 500, '批量导入失败：' + e.message); }
  }
  if (pathName === '/api/site/config') {
    let panelCfg = null;
    try { panelCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'panel-config.json'), 'utf8')); } catch (e) {}
    return sendJson(res, 200, { ok: true, data: {
      mysql: {
        host: envValue('MYSQL_HOST') || '127.0.0.1',
        port: envValue('MYSQL_PORT') || '3306',
        user: envValue('MYSQL_USER') || 'root',
        database: envValue('MYSQL_DATABASE') || 'jingtu_group',
        password: maskSecret(envValue('MYSQL_PASSWORD'))
      },
      panel: panelCfg
    }});
  }

  /* ---- 桌面打开 ---- */
  if (pathName === '/api/open-dir') { openDesktop(ROOT, ok => sendJson(res, 200, { ok, message: ok ? '已在资源管理器中打开项目根目录' : '打开失败' })); return null; }
  if (pathName === '/api/open-logs') { openDesktop(LOGS_DIR, ok => sendJson(res, 200, { ok, message: ok ? '已在资源管理器中打开日志目录' : '打开失败' })); return null; }
  if (pathName === '/api/open-site') {
    openInBrowser('http://localhost:3456');
    return sendJson(res, 200, { ok: true, message: '已在浏览器打开网站首页' });
  }

  /* ---- 任务查询 ---- */
  const m = /^\/api\/task\/([0-9a-f]{16})$/.exec(pathName);
  if (m) {
    const t = tasks.get(m[1]);
    if (!t) return sendErr(res, 404, '任务不存在');
    return sendJson(res, 200, { ok: true, task: t });
  }

  return sendErr(res, 404, '接口不存在');
}

/* ---------- HTTP 服务 ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const pathName = getPathBase(req);
    if (pathName.startsWith('/api/')) {
      let token = null;
      const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      if (m && checkToken(m[1])) token = m[1];
      const r = await handleApi(req, res, token);
      if (r === null) return; // 已直接流式响应
      return;
    }
    // 静态页面
    let file = pathName === '/' ? 'index.html' : pathName.replace(/^\/+/, '');
    let full = path.resolve(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { sendErr(res, 403, 'Forbidden'); return; }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { sendErr(res, 404, '页面不存在'); return; }
    const ext = path.extname(full).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    try { sendErr(res, 500, e.message || '服务器内部错误'); } catch (_) {}
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[panel] 端口 ${settings.port} 已被占用，面板可能已在运行。`);
  } else {
    console.error('[panel] 服务错误:', e.message);
  }
  process.exit(1);
});

const HOST = LAN_MODE ? '0.0.0.0' : '127.0.0.1';
server.listen(settings.port, HOST, () => {
  global.__startedAt = Date.now();
  console.log('==============================================');
  console.log('  境途同游 网页版运维后台');
  console.log('  地址: http://127.0.0.1:' + settings.port + (LAN_MODE ? '（本机；局域网设备请用本机内网 IP 访问）' : ''));
  console.log('  监听: ' + HOST + (LAN_MODE ? '（局域网模式）' : '（仅本机）'));
  console.log('  关闭: 关闭本窗口即可停止面板');
  console.log('==============================================');
});
