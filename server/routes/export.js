/**
 * 境途同游 — 数据导出路由
 *
 * @swagger
 * tags:
 *   name: Export
 *   description: 数据导出相关接口
 */
// 说明（P0-3 修复）：导出接口原先一次性 `SELECT * LIMIT 50000` 把整表读入内存数组，
// 再 redact + 生成完整 CSV/JSON 字符串，峰值内存约 3~4× 数据量；大表（users/messages 等）
// 易触发 OOM。现改为「mysql2 流式查询 + 逐行 redact + 流式写出(res.write)」，
// 内存占用与单行大小成常数级，不再随表行数线性增长。
// （此段须留在 @swagger 块外：散文行混入块内会让 swagger-jsdoc 抛
//  YAMLSemanticError，且该库只打日志不抛异常，整块文档会被静默丢弃。）
const express = require('express');
const { fail, getPool, handleError , sendError, ErrorCodes } = require('../utils');
const { requireAdminCompat } = require('../auth');
const { Parser } = require('json2csv');
const logger = require('../logger');

const router = express.Router();

// 单次导出最大行数，避免全表 SELECT * 把内存/响应打爆（流式下仍作安全护栏）
const EXPORT_ROW_CAP = 50000;

// 流式读取时的每批行数（控制背压节奏）
const STREAM_HIGH_WATER = 200;

// 导出时对可能含密钥/凭据的字段做脱敏（大小写不敏感）
const REDACT_KEYS = new Set([
  'password', 'password_hash', 'vrcookie', 'secret', 'signing_secret', 'webhook_secret', 'token',
  'access_token', 'refresh_token', 'api_key', 'apikey', 'private_key',
  'client_secret', 'signing_key', 'encryption_key', 'auth_token'
]);

function redactRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const k of Object.keys(row)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '***REDACTED***' : row[k];
  }
  return out;
}

const EXPORT_TABLES = [
  { name: 'users', label: '用户数据' },
  { name: 'posts', label: '动态数据' },
  { name: 'event', label: '活动数据' },
  { name: 'album_photo', label: '照片数据' },
  { name: 'post_comment', label: '动态评论数据' },
  { name: 'album_comment', label: '相册评论数据' },
  { name: 'announcement', label: '公告数据' },
  { name: 'permissions', label: '权限数据' },
  { name: 'group_roster', label: '成员数据' },
  { name: 'messages', label: '私信数据' },
  { name: 'chat_group_messages', label: '群聊消息数据' },
  { name: 'notifications', label: '通知数据' },
  { name: 'user_profile', label: '用户资料数据' },
  { name: 'user_albums', label: '用户相册数据' },
  { name: 'user_photos', label: '用户照片数据' },
  { name: 'event_sign', label: '活动报名数据' },
  { name: 'event_checkin', label: '活动签到数据' },
  { name: 'post_like', label: '动态点赞数据' },
  { name: 'album_like', label: '照片点赞数据' },
  { name: 'permission_groups', label: '权限组数据' },
  { name: 'user_group_membership', label: '用户权限组归属数据' },
  { name: 'system_config', label: '系统配置数据' },
  { name: 'webhooks', label: 'Webhook数据' },
  { name: 'group_member_changes', label: '群成员变更记录' },
  { name: 'group_sync_log', label: '群组同步日志' }
];

router.get('/admin/export/tables', requireAdminCompat, (req, res) => {
  res.json({ tables: EXPORT_TABLES });
});

router.get('/admin/export/sample', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();

    const [users] = await pool.query('SELECT id, login_id, display_name, vrchat_name, created_at FROM users LIMIT 10');
    const [posts] = await pool.query('SELECT id, user_id, content, type, created_at FROM posts LIMIT 10');
    const [events] = await pool.query('SELECT id, title, description, event_time, create_time FROM event LIMIT 10');
    const [photos] = await pool.query('SELECT id, cate_id, photo_path, upload_name, create_time FROM album_photo LIMIT 10');

    res.json({
      sample: { users, posts, events, photos },
      counts: {
        users: users.length,
        posts: posts.length,
        events: events.length,
        photos: photos.length
      }
    });
  } catch (e) {
    handleError(res, e, '[export]');
  }
});

/**
 * 流式导出单表到响应对象。
 * - CSV：AsyncParser 逐行转换并 res.write。
 * - JSON：逐行 res.write 拼成数组（配合背压），避免整表驻留。
 * 返回一个 Promise，结束时释放连接。
 */
async function streamTableExport(res, tableName, format, firstTableInBatch, lastTableInBatch) {
  // 流式查询需使用 mysql2 底层连接（其 .query() 返回带 .stream() 的 Query 对象）。
  // getPool() 是 promise 包装池，其 .pool 即底层 mysql2 Pool；
  // 底层 Pool.getConnection 为回调式，这里用 Promise 包装获取底层连接。
  const pool = getPool().pool;
  const conn = await new Promise((resolve, reject) =>
    pool.getConnection((err, connection) => (err ? reject(err) : resolve(connection)))
  );
  try {
    const stream = conn.query(
      'SELECT * FROM ?? LIMIT ?',
      [tableName, EXPORT_ROW_CAP]
    ).stream({ highWaterMark: STREAM_HIGH_WATER });

    if (format === 'json') {
      if (firstTableInBatch) res.write('[');
      let firstRow = true;
      let rowCount = 0;
      await new Promise((resolve, reject) => {
        stream.on('data', (row) => {
          rowCount++;
          const chunk = (firstRow ? '' : ',') + JSON.stringify(redactRow(row));
          firstRow = false;
          if (!res.write(chunk)) {
            stream.pause();
            res.once('drain', () => stream.resume());
          }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      if (lastTableInBatch) res.write(']');
      return rowCount;
    }

    // CSV：逐行转换并写出。首行输出表头，之后 header:false，避免重复列头。
    const parserWithHeader = new Parser({ header: true });
    const parserNoHeader = new Parser({ header: false });
    let headerWritten = false;
    let rowCount = 0;
    await new Promise((resolve, reject) => {
      stream.on('data', (row) => {
        rowCount++;
        const r = redactRow(row);
        const csv = headerWritten
          ? parserNoHeader.parse([r])
          : parserWithHeader.parse([r]);
        headerWritten = true;
        if (!res.write(csv)) {
          stream.pause();
          res.once('drain', () => stream.resume());
        }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return rowCount;
  } finally {
    conn.release();
  }
}

router.post('/admin/export/batch', requireAdminCompat, async (req, res) => {
  try {
    const { tables, format } = req.body;
    const exportFormat = format || 'csv';

    if (!Array.isArray(tables) || tables.length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择要导出的表');
    }

    const validTables = EXPORT_TABLES.map(t => t.name);
    const invalidTables = tables.filter(t => !validTables.includes(t));
    if (invalidTables.length > 0) {
      return fail(res, 400, `不支持的表: ${invalidTables.join(', ')}`);
    }

    logger.warn('[export]', `管理员 ${req.session?.userId || 'unknown'} 批量导出表: ${tables.join(', ')}`);

    const isCsv = exportFormat !== 'json';
    if (isCsv) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="export_all_${Date.now()}.csv"`);
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="export_all_${Date.now()}.json"`);
    }

    for (let i = 0; i < tables.length; i++) {
      const tableName = tables[i];
      if (isCsv) res.write(`=== ${tableName} ===\n`);
      await streamTableExport(res, tableName, exportFormat, i === 0, i === tables.length - 1);
      if (isCsv) res.write('\n\n');
    }
    res.end();
  } catch (e) {
    handleError(res, e, '[export]');
  }
});

router.get('/admin/export/:table', requireAdminCompat, async (req, res) => {
  try {
    const tableName = req.params.table;
    const format = req.query.format || 'csv';

    const validTables = EXPORT_TABLES.map(t => t.name);
    if (!validTables.includes(tableName)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不支持的导出表');
    }

    logger.warn('[export]', `管理员 ${req.session?.userId || 'unknown'} 导出单表: ${tableName}`);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${tableName}_${Date.now()}.json"`);
    } else {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${tableName}_${Date.now()}.csv"`);
    }

    try {
      await streamTableExport(res, tableName, format, true, true);
      res.end();
    } catch (streamErr) {
      // 已部分写出时无法改状态码，记录日志；响应已关闭则忽略
      if (!res.headersSent) {
        return handleError(res, streamErr, '[export]');
      }
      logger.error('[export]', `单表流式导出失败: ${tableName}`, streamErr);
      try { res.end(); } catch (_) {}
    }
  } catch (e) {
    handleError(res, e, '[export]');
  }
});

module.exports = router;
