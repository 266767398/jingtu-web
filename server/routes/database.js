/**
 * 境途同游 — 数据库管理路由
 * 
 * @swagger
 * tags:
 *   name: Database
 *   description: 数据库管理相关接口
 */
const express = require('express');
const mysql = require('mysql2');
const { getPool, safeError, logOper, handleError, sendError, fail, ErrorCodes, paginate } = require('../utils');
const { requireAdminCompat } = require('../auth');
const { DB_NAME } = require('../db');
const logger = require('../logger');

const router = express.Router();

// §46：合法表名白名单缓存，避免 SQL 标识符注入
let tableWhitelistCache = null;
async function getTableWhitelist() {
  if (tableWhitelistCache) return tableWhitelistCache;
  const [rows] = await getPool().query('SHOW TABLES');
  tableWhitelistCache = new Set(rows.map(r => Object.values(r)[0]));
  return tableWhitelistCache;
}

router.get('/admin/db/status', requireAdminCompat, async (req, res) => {
  try {
    const [pingRes] = await getPool().query('SELECT 1 AS ping');
    const [versionRes] = await getPool().query('SELECT VERSION() AS version');
    const [uptimeRes] = await getPool().query('SHOW STATUS LIKE "Uptime"');
    const [connectionsRes] = await getPool().query('SHOW STATUS LIKE "Threads_connected"');
    const [activeRes] = await getPool().query('SHOW STATUS LIKE "Threads_running"');
    const [qpsRes] = await getPool().query('SHOW STATUS LIKE "Queries"');

    const pool = require('../db').holder.pool;
    const poolStats = pool ? {
      connectionLimit: pool.connectionLimit,
      queueLimit: pool.queueLimit || 50,
      activeConnections: pool._allConnections?.length || 0,
      idleConnections: pool._idleConnections?.length || 0,
      waitingCount: pool._waitingCount || 0
    } : {};

    res.json({
      success: true,
      connected: pingRes.length > 0,
      database: DB_NAME,
      version: versionRes[0]?.version || 'Unknown',
      uptime: parseInt(uptimeRes[0]?.Value) || 0,
      connections: parseInt(connectionsRes[0]?.Value) || 0,
      activeConnections: parseInt(activeRes[0]?.Value) || 0,
      queries: parseInt(qpsRes[0]?.Value) || 0,
      poolStats
    });
  } catch (e) {
    logger.error('database', e);
    fail(res, 200, safeError(e.message));
  }
});

router.get('/admin/db/tables', requireAdminCompat, async (req, res) => {
  try {
    const [tablesRes] = await getPool().query(`SHOW TABLES`);
    const tableNames = tablesRes.map(t => Object.values(t)[0]);

    const tables = [];
    for (const tableName of tableNames) {
      const [infoRes] = await getPool().query(`SHOW TABLE STATUS LIKE ?`, [tableName]);
      const info = infoRes[0];

      const [colsRes] = await getPool().query(`DESCRIBE ${mysql.escapeId(tableName)}`);
      const columns = colsRes.map(c => ({
        name: c.Field,
        type: c.Type,
        nullable: c.Null === 'YES',
        key: c.Key || '',
        default: c.Default,
        extra: c.Extra || ''
      }));

      tables.push({
        name: tableName,
        engine: info.Engine || '',
        rows: parseInt(info.Rows) || 0,
        dataSize: info.Data_length || 0,
        indexSize: info.Index_length || 0,
        totalSize: (info.Data_length || 0) + (info.Index_length || 0),
        collation: info.Collation || '',
        createTime: info.Create_time,
        updateTime: info.Update_time,
        columns
      });
    }

    const totalSize = tables.reduce((sum, t) => sum + t.totalSize, 0);

    res.json({
      success: true,
      tables,
      totalTables: tables.length,
      totalRows: tables.reduce((sum, t) => sum + t.rows, 0),
      totalSize
    });
  } catch (e) { handleError(res, e, '[db/tables]'); }
});

router.get('/admin/db/processlist', requireAdminCompat, async (req, res) => {
  try {
    const [processes] = await getPool().query('SHOW FULL PROCESSLIST');
    
    const filtered = processes.filter(p => p.Command !== 'Sleep' || p.Time > 60);
    
    res.json({
      success: true,
      processes: filtered.map(p => ({
        id: p.Id,
        user: p.User,
        host: p.Host,
        db: p.db || '-',
        command: p.Command,
        time: p.Time,
        state: p.State || '',
        info: p.Info || '',
        progress: p.Progress || 0
      })),
      total: processes.length
    });
  } catch (e) { handleError(res, e, '[db/processlist]'); }
});

router.get('/admin/db/variables', requireAdminCompat, async (req, res) => {
  try {
    const [variables] = await getPool().query('SHOW VARIABLES');
    
    const keyVars = variables.filter(v => 
      ['innodb_buffer_pool_size', 'max_connections', 'query_cache_size', 
       'tmp_table_size', 'max_heap_table_size', 'wait_timeout', 
       'interactive_timeout', 'innodb_log_file_size', 'innodb_flush_log_at_trx_commit'].includes(v.Variable_name)
    );

    res.json({
      success: true,
      variables: keyVars.map(v => ({
        name: v.Variable_name,
        value: v.Value
      }))
    });
  } catch (e) { handleError(res, e, '[db/variables]'); }
});

router.get('/admin/db/slow-queries', requireAdminCompat, async (req, res) => {
  try {
    const [slowLogRes] = await getPool().query('SHOW GLOBAL VARIABLES LIKE "slow_query_log_file"');
    const slowLogFile = slowLogRes[0]?.Value || '';
    
    const [slowQueriesRes] = await getPool().query('SHOW GLOBAL STATUS LIKE "Slow_queries"');
    const slowQueryCount = parseInt(slowQueriesRes[0]?.Value) || 0;

    const [slowLogEnabledRes] = await getPool().query('SHOW GLOBAL VARIABLES LIKE "slow_query_log"');
    const slowLogEnabled = slowLogEnabledRes[0]?.Value === 'ON';

    res.json({
      success: true,
      slowQueryCount,
      slowLogEnabled,
      slowLogFile
    });
  } catch (e) { handleError(res, e, '[db/slow-queries]'); }
});

router.get('/admin/db/table/:name', requireAdminCompat, async (req, res) => {
  try {
    const tableName = req.params.name;
    // §46：白名单校验
    const whitelist = await getTableWhitelist();
    if (!whitelist.has(tableName)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的表名');
    }

    const [infoRes] = await getPool().query(`SHOW TABLE STATUS LIKE ?`, [tableName]);
    if (!infoRes || infoRes.length === 0) {
      return fail(res, 404, '表不存在');
    }
    const info = infoRes[0];

    const [colsRes] = await getPool().query(`DESCRIBE ${mysql.escapeId(tableName)}`);
    const columns = colsRes.map(c => ({
      name: c.Field,
      type: c.Type,
      nullable: c.Null === 'YES',
      key: c.Key || '',
      default: c.Default,
      extra: c.Extra || ''
    }));

    const [indexRes] = await getPool().query(`SHOW INDEX FROM ${mysql.escapeId(tableName)}`);
    const indexes = [];
    const seenIndexes = new Set();
    for (const idx of indexRes) {
      const idxName = idx.Key_name || '';
      if (!seenIndexes.has(idxName)) {
        seenIndexes.add(idxName);
        indexes.push({
          name: idxName,
          type: idx.Non_unique === 0 ? 'UNIQUE' : 'NORMAL',
          columns: []
        });
      }
      const currentIdx = indexes.find(i => i.name === idxName);
      if (currentIdx) {
        currentIdx.columns.push(idx.Column_name);
      }
    }

    const { page, pageSize, offset } = paginate(req, { defaultSize: 20 });

    const [countRes] = await getPool().query(`SELECT COUNT(*) AS total FROM ${mysql.escapeId(tableName)}`);
    const total = countRes[0].total;

    const [rowsRes] = await getPool().query(`SELECT * FROM ${mysql.escapeId(tableName)} LIMIT ? OFFSET ?`, [pageSize, offset]);

    res.json({
      success: true,
      name: tableName,
      engine: info.Engine || '',
      rows: parseInt(info.Rows) || 0,
      dataSize: info.Data_length || 0,
      indexSize: info.Index_length || 0,
      totalSize: (info.Data_length || 0) + (info.Index_length || 0),
      collation: info.Collation || '',
      createTime: info.Create_time,
      updateTime: info.Update_time,
      columns,
      indexes,
      records: rowsRes,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    });
  } catch (e) { handleError(res, e, '[db/table-detail]'); }
});

router.post('/admin/db/optimize/:table', requireAdminCompat, async (req, res) => {
  try {
    const tableName = req.params.table;
    // §46：白名单校验
    const whitelist = await getTableWhitelist();
    if (!whitelist.has(tableName)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的表名');
    }

    const startTime = Date.now();
    await getPool().query(`OPTIMIZE TABLE ${mysql.escapeId(tableName)}`);
    const duration = Date.now() - startTime;

    await logOper(req.session.userId, '优化数据表', tableName);

    res.json({
      success: true,
      table: tableName,
      duration: duration,
      message: `表 ${tableName} 优化完成，耗时 ${duration}ms`
    });
  } catch (e) { handleError(res, e, '[db/optimize]'); }
});

router.post('/admin/db/analyze/:table', requireAdminCompat, async (req, res) => {
  try {
    const tableName = req.params.table;
    // §46：白名单校验
    const whitelist = await getTableWhitelist();
    if (!whitelist.has(tableName)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的表名');
    }

    const startTime = Date.now();
    await getPool().query(`ANALYZE TABLE ${mysql.escapeId(tableName)}`);
    const duration = Date.now() - startTime;

    await logOper(req.session.userId, '分析数据表', tableName);

    res.json({
      success: true,
      table: tableName,
      duration: duration,
      message: `表 ${tableName} 分析完成，耗时 ${duration}ms`
    });
  } catch (e) { handleError(res, e, '[db/analyze]'); }
});

router.post('/admin/db/check/:table', requireAdminCompat, async (req, res) => {
  try {
    const tableName = req.params.table;
    // §46：白名单校验
    const whitelist = await getTableWhitelist();
    if (!whitelist.has(tableName)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的表名');
    }

    const [result] = await getPool().query(`CHECK TABLE ${mysql.escapeId(tableName)}`);

    res.json({
      success: true,
      table: tableName,
      result: result.map(r => ({
        Table: r.Table,
        Op: r.Op,
        Msg_type: r.Msg_type,
        Msg_text: r.Msg_text
      }))
    });
  } catch (e) { handleError(res, e, '[db/check]'); }
});

router.post('/admin/db/repair/:table', requireAdminCompat, async (req, res) => {
  try {
    const tableName = req.params.table;
    // §46：白名单校验
    const whitelist = await getTableWhitelist();
    if (!whitelist.has(tableName)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的表名');
    }

    const [result] = await getPool().query(`REPAIR TABLE ${mysql.escapeId(tableName)}`);

    await logOper(req.session.userId, '修复数据表', tableName);

    res.json({
      success: true,
      table: tableName,
      result: result.map(r => ({
        Table: r.Table,
        Op: r.Op,
        Msg_type: r.Msg_type,
        Msg_text: r.Msg_text
      }))
    });
  } catch (e) { handleError(res, e, '[db/repair]'); }
});

router.post('/admin/db/kill/:pid', requireAdminCompat, async (req, res) => {
  try {
    const pid = parseInt(req.params.pid);
    
    await getPool().query(`KILL ${pid}`);
    
    await logOper(req.session.userId, '终止数据库连接', `PID: ${pid}`);

    res.json({
      success: true,
      pid,
      message: `连接 ${pid} 已终止`
    });
  } catch (e) { handleError(res, e, '[db/kill]'); }
});

module.exports = router;
