/**
 * 时间同步路由（超管专属）
 *
 * 场景：容器（飞牛 NAS / Docker）默认 UTC，入口脚本按出口 IP 判定时区失败时会回退
 * UTC，导致「日志时间戳差 8 小时」「签到/生日跨天判定错一天」「定时任务不按点跑」。
 * 本路由提供：
 *   GET  /api/admin/time-status —— 读取应用进程时区、服务器时间、数据库时区与时钟偏差
 *   POST /api/admin/time-sync   —— 一键把进程时区 + MySQL 会话时区统一到指定时区
 *
 * 生效范围：
 *   · process.env.TZ（Node 16+ 运行时赋值即时生效，日志/日期计算/定时任务立刻换口径）
 *   · MySQL 连接池解析时区（db.setDbTimezone → 重建池，新连接立即按新偏移）
 *   · MySQL 当前会话 SET time_zone（GLOBAL 需 SUPER 权限，普通应用账号不强行改）
 *   · 持久化写入项目根 .env 的 TZ（容器入口脚本会优先读取，重启后仍生效）
 *
 * 安全边界：仅超级管理员；参数必须是合法 IANA 时区名；不改系统时钟（容器内无权限，
 * 也不应改宿主时钟），只对齐「时区口径」。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ok, sendError, ErrorCodes, logOper } = require('../utils');
const { requireSuperAdmin } = require('../auth');
const { getPool, setDbTimezone, applyTimeDrift } = require('../db');
const timeService = require('../time_service');
const logger = require('../logger');

const router = express.Router();

const DEFAULT_TZ = 'Asia/Shanghai';
// 常用候选时区（前端下拉直接渲染，也接受用户手动传其它合法 IANA 名）
const CANDIDATE_TZ = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles'
];

const SQLITE_MODE = process.env.JINGTU_DB_ENGINE === 'sqlite';

/** 校验 IANA 时区名（Intl 构造失败即非法，顺带拦掉注入型脏值） */
function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch (e) {
    return false;
  }
}

/** 指定时区在某一时刻相对 UTC 的偏移分钟数（考虑夏令时） */
function tzOffsetMinutes(tz, at = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** 分钟偏移 → MySQL 可用的 '+08:00' 形式 */
function offsetToString(minutes) {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
}

/** 按时区格式化可读时间（不受进程 TZ 影响） */
function formatInTz(tz, at = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(at);
}

/** 当前应用进程时区（环境变量优先，其次运行时解析结果） */
function currentTz() {
  if (process.env.TZ) return process.env.TZ;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}

/** 采集一次完整状态（状态查询与同步前后对比共用） */
async function collectStatus() {
  const now = new Date();
  const tz = currentTz();
  const appOffset = tzOffsetMinutes(tz, now);

  const status = {
    app: {
      tz,
      tzSource: process.env.TZ ? 'env' : 'system',
      nowUtc: now.toISOString(),
      nowLocal: formatInTz(tz, now),
      offset: offsetToString(appOffset),
      offsetMinutes: appOffset
    },
    db: null,
    driftSeconds: null,
    defaultTz: DEFAULT_TZ,
    candidates: CANDIDATE_TZ,
    sqlite: SQLITE_MODE,
    autoSync: timeService.getStatus()
  };

  try {
    if (SQLITE_MODE) {
      // SQLite 无会话时区概念：以应用本地时间作为 DB 时间口径
      status.db = {
        now: formatInTz(tz, now),
        utc: now.toISOString().replace('T', ' ').slice(0, 19),
        sessionTz: 'SQLite(local)',
        globalTz: 'SQLite(local)',
        systemTz: 'SQLite(local)',
        offsetMinutes: appOffset
      };
      status.driftSeconds = 0;
    } else {
      const pool = getPool();
      const [[row]] = await pool.query(
        `SELECT UNIX_TIMESTAMP() AS epoch, NOW() AS dbNow, UTC_TIMESTAMP() AS dbUtc,
                @@session.time_zone AS sessionTz, @@global.time_zone AS globalTz,
                @@system_time_zone AS systemTz,
                TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS offsetMinutes`
      );
      const dbEpoch = Number(row.epoch) || 0;
      const appEpoch = Math.floor(now.getTime() / 1000);
      status.db = {
        now: row.dbNow,
        utc: row.dbUtc,
        sessionTz: row.sessionTz,
        globalTz: row.globalTz,
        systemTz: row.systemTz,
        offsetMinutes: Number(row.offsetMinutes)
      };
      status.driftSeconds = dbEpoch ? dbEpoch - appEpoch : null;
    }
  } catch (e) {
    status.db = { error: e.message || '数据库不可达' };
  }
  return status;
}

/** 把 TZ 写回项目根 .env（容器内 /app/.env 已 chown 给 node，可写） */
function persistEnvTz(tz) {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    let txt = '';
    if (fs.existsSync(envPath)) txt = fs.readFileSync(envPath, 'utf8');
    const line = 'TZ=' + tz;
    if (/^\s*TZ\s*=.*$/m.test(txt)) {
      txt = txt.replace(/^\s*TZ\s*=.*$/m, line);
    } else {
      txt = txt.replace(/\s*$/, '') + (txt.trim() ? '\n' : '') + line + '\n';
    }
    fs.writeFileSync(envPath, txt, 'utf8');
    return true;
  } catch (e) {
    logger.warn('[admin/time-sync]', '写入 .env 的 TZ 失败（容器内只读时属预期）：' + (e.message || e));
    return false;
  }
}

// ==================== 时间状态查询 ====================
router.get('/admin/time-status', requireSuperAdmin, async (req, res) => {
  try {
    const status = await collectStatus();
    ok(res, status);
  } catch (e) {
    logger.error('[admin/time-status]', e.message);
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, '读取时间状态失败：' + (e.message || '未知错误'));
  }
});

// ==================== 一键同步时间 ====================
router.post('/admin/time-sync', requireSuperAdmin, async (req, res) => {
  const tz = String((req.body && req.body.tz) || DEFAULT_TZ).trim();
  if (!isValidTimeZone(tz)) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的时区名（请使用 IANA 时区，如 Asia/Shanghai）');
  }
  try {
    const before = await collectStatus();

    // 1) 应用进程时区：Node 16+ 运行时改 process.env.TZ 即时生效
    process.env.TZ = tz;
    const offset = offsetToString(tzOffsetMinutes(tz, new Date()));

    // 2) 数据库：会话时区（SET time_zone）+ 连接池解析时区（重建池后新连接生效）
    let dbSessionApplied = false;
    let dbPoolApplied = false;
    let dbError = null;
    if (!SQLITE_MODE) {
      try {
        await getPool().query('SET time_zone = ?', [offset]);
        dbSessionApplied = true;
      } catch (e) {
        dbError = e.message || String(e);
      }
      try {
        dbPoolApplied = setDbTimezone(offset);
      } catch (e) {
        dbError = dbError || (e.message || String(e));
      }
      // 切换时区会重置会话时区，这里把已测得的时钟漂移重新折算回去，
      // 否则「联网校时」的 DB 时间平移会被时区同步覆盖掉。
      try {
        const drift = timeService.getStatus().offsetMs;
        if (drift) applyTimeDrift(drift, offset);
      } catch (e) { dbError = dbError || (e.message || String(e)); }
    }

    // 3) 持久化：写 .env 的 TZ，重启后仍按该时区
    const persisted = persistEnvTz(tz);

    // 4) 操作日志
    try {
      logOper(req.session.userId, 'time_sync',
        `时间同步：${before.app.tz}(${before.app.offset}) → ${tz}(${offset})；DB 会话 ${dbSessionApplied ? '已设' : '未设'}、连接池 ${dbPoolApplied ? '已重建' : '未重建'}、.env ${persisted ? '已写入' : '未写入'}`);
    } catch (e) { logger.warn('[admin/time-sync]', '写操作日志失败：' + (e.message || e)); }

    const after = await collectStatus();
    logger.info('[admin/time-sync]', `已同步时区 ${before.app.tz} → ${tz}（偏移 ${offset}），drift=${after.driftSeconds}s`);

    ok(res, {
      message: '时间已同步',
      tz,
      offset,
      persisted,
      db: { sessionApplied: dbSessionApplied, poolApplied: dbPoolApplied, error: dbError },
      before,
      after,
      note: SQLITE_MODE
        ? 'SQLite 模式无数据库会话时区，已仅同步应用进程时区与 .env。'
        : '应用进程与新建数据库连接已按新时区工作；MySQL 服务端全局时区建议在 compose 的 --default-time-zone 固定。'
    });
  } catch (e) {
    logger.error('[admin/time-sync]', e.message);
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, '时间同步失败：' + (e.message || '未知错误'));
  }
});

// ==================== 自动联网对时：配置开关 ====================
router.post('/admin/time-auto-sync', requireSuperAdmin, async (req, res) => {
  const body = req.body || {};
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
  const allowSystemClockSet = typeof body.allowSystemClockSet === 'boolean' ? body.allowSystemClockSet : undefined;
  let intervalMinutes;
  if (body.intervalMinutes !== undefined) {
    intervalMinutes = Math.floor(Number(body.intervalMinutes));
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < timeService.MIN_INTERVAL || intervalMinutes > timeService.MAX_INTERVAL) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST,
        `对时间隔需在 ${timeService.MIN_INTERVAL}~${timeService.MAX_INTERVAL} 分钟之间`);
    }
  }
  try {
    const status = await timeService.saveConfig({ enabled, intervalMinutes, allowSystemClockSet });
    try {
      logOper(req.session.userId, 'time_auto_sync',
        `自动联网对时：${enabled === undefined ? '未改开关' : (enabled ? '开启' : '关闭')}；间隔 ${status.intervalMinutes} 分钟；系统时钟校正 ${status.allowSystemClockSet ? '允许' : '禁止'}`);
    } catch (e) { logger.warn('[admin/time-auto-sync]', '写操作日志失败：' + (e.message || e)); }

    ok(res, {
      message: status.enabled ? '自动联网对时已开启' : '自动联网对时已关闭',
      autoSync: status
    });
  } catch (e) {
    logger.error('[admin/time-auto-sync]', e.message);
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, '保存自动对时配置失败：' + (e.message || '未知错误'));
  }
});

// ==================== 自动联网对时：立即执行一次 ====================
router.post('/admin/time-sync-now', requireSuperAdmin, async (req, res) => {
  try {
    const result = await timeService.runCheck('manual');
    if (!result.ok) {
      return sendError(res, 502, ErrorCodes.INTERNAL_ERROR, '联网对时失败：' + (result.error || '未知错误'));
    }
    try {
      logOper(req.session.userId, 'time_sync_now',
        `立即联网对时：漂移 ${result.offsetMs}ms（来源 ${result.source}，${result.samples} 个时间源）`);
    } catch (e) { logger.warn('[admin/time-sync-now]', '写操作日志失败：' + (e.message || e)); }

    ok(res, {
      message: '联网对时完成',
      result,
      autoSync: timeService.getStatus()
    });
  } catch (e) {
    logger.error('[admin/time-sync-now]', e.message);
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, '联网对时失败：' + (e.message || '未知错误'));
  }
});

module.exports = router;
