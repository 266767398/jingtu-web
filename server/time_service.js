/**
 * 境途同游 — 网络对时服务（应用层时钟校准）
 *
 * 背景：容器与宿主共享内核时钟，容器内默认没有 CAP_SYS_TIME，改不了系统时钟。
 * 因此「时间不对」在容器里只能从两个方向解决：
 *   1) 时区口径对齐（system_time 路由一次性同步进程/DB 时区，已完成）；
 *   2) 时钟走偏（宿主 NTP 未开、休眠唤醒后漂移）——这就是本模块负责的部分：
 *      自动从多个公网时间源取标准 UTC，算出本机漂移量，在应用层以 appNow() 补偿，
 *      并可在面板显示漂移、超阈值告警；仅当容器显式授予 CAP_SYS_TIME 且以 root
 *      运行时才尝试真正改系统时钟（默认关闭，避免误改宿主时钟）。
 *
 * 时间源：
 *   · SNTP（UDP 123）：ntp.aliyun.com / time.cloudflare.com / pool.ntp.org
 *   · HTTP Date 头（走 80/443，NAT 下最稳）：baidu / cloudflare / taobao / github
 *   多源并发采样后取中位数，单源被劫持或缓存不会带偏结果。
 *
 * 对外能力：
 *   measureOnce()           —— 立即采样一次，返回漂移量（毫秒）
 *   runCheck(reason)       —— 采样 + 落状态 + 告警（自动任务与手动按钮共用）
 *   appNow()               —— 补偿后的当前时间（logger 等统一走这里）
 *   startAutoSync/stopAutoSync/init —— 定时器与启动载入
 *   getStatus()            —— 面板展示用状态快照
 */
const dgram = require('dgram');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

// 惰性引用 logger：logger 也会反过来 require 本模块取 appNow()，顶层互引会拿到半成品
let _logger = null;
function log() {
  if (!_logger) { try { _logger = require('./logger'); } catch (e) { _logger = null; } }
  return _logger;
}

const NTP_SOURCES = ['ntp.aliyun.com', 'time.cloudflare.com', 'pool.ntp.org'];
const HTTP_SOURCES = [
  'https://www.baidu.com',
  'https://www.cloudflare.com',
  'https://www.taobao.com',
  'https://api.github.com'
];

const PROBE_TIMEOUT_MS = 5000;
// 单源偏移超过 30 天视为脏数据（时区串位/代理伪造），直接丢弃
const MAX_SANE_OFFSET_MS = 30 * 24 * 3600 * 1000;
// 漂移告警阈值：超过 3 秒就值得提醒（跨天判定、日志排序会受影响）
const DRIFT_WARN_MS = 3000;

const CFG_ENABLED = 'time_auto_sync';
const CFG_INTERVAL = 'time_auto_sync_interval';
const CFG_SET_CLOCK = 'time_auto_sync_set_clock';

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 1440;
const DEFAULT_INTERVAL = 30;

const state = {
  enabled: false,
  intervalMinutes: DEFAULT_INTERVAL,
  allowSystemClockSet: false,
  offsetMs: 0,
  lastCheckAt: null,
  lastResult: null,
  lastError: null,
  checking: false,
  timer: null,
  successCount: 0,
  failCount: 0
};

let poolRef = null;

/** 单源 HTTP Date 头探测：以响应头时间为基准，用 RTT/2 补偿单程网络延迟 */
function httpProbe(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const t0 = Date.now();
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); };
    try {
      const req = lib.request(url, {
        method: 'HEAD',
        timeout: PROBE_TIMEOUT_MS,
        headers: { 'User-Agent': 'jingtu-time-sync/1.0', 'Cache-Control': 'no-cache' }
      }, (res) => {
        const t1 = Date.now();
        res.resume();
        const dateHeader = res.headers && res.headers.date;
        if (!dateHeader) return done(null);
        const serverMs = Date.parse(dateHeader);
        if (!Number.isFinite(serverMs)) return done(null);
        const rtt = t1 - t0;
        done({
          source: url.replace(/^https?:\/\//, ''),
          offsetMs: serverMs + Math.round(rtt / 2) - t1,
          rttMs: rtt
        });
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      req.end();
    } catch (e) { done(null); }
  });
}

/** SNTP 客户端（RFC 4330 简化版）：精度优于 HTTP Date 头，但依赖 UDP 出网 */
function sntpProbe(host) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const t0 = Date.now();
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { if (socket) socket.close(); } catch (e) {}
      resolve(v);
    };
    try {
      socket = dgram.createSocket('udp4');
    } catch (e) { return done(null); }

    socket.on('message', (msg) => {
      const t3 = Date.now();
      if (!msg || msg.length < 48) return done(null);
      const secs = msg.readUInt32BE(40);
      const frac = msg.readUInt32BE(44);
      if (!secs) return done(null);
      // NTP 纪元起点 1900-01-01，转 Unix 纪元
      const epochMs = (secs - 2208988800) * 1000 + Math.round((frac / 4294967296) * 1000);
      const rtt = t3 - t0;
      done({
        source: 'ntp:' + host,
        offsetMs: epochMs + Math.round(rtt / 2) - t3,
        rttMs: rtt
      });
    });
    socket.on('error', () => done(null));

    const buf = Buffer.alloc(48);
    buf[0] = 0x1b; // LI=0, VN=3, Mode=3(client)
    try {
      socket.send(buf, 0, 48, 123, host, (err) => { if (err) done(null); });
    } catch (e) { return done(null); }

    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  });
}

/**
 * 多源并发采样并取中位数。
 * 中位数而非均值：单个源被劫持/返回缓存时间时会成为离群值，中位数天然免疫。
 */
async function measureOnce() {
  const probes = [
    ...NTP_SOURCES.map((h) => sntpProbe(h)),
    ...HTTP_SOURCES.map((u) => httpProbe(u))
  ];
  const raw = await Promise.all(probes);
  const results = raw.filter(Boolean).filter((r) => Number.isFinite(r.offsetMs) && Math.abs(r.offsetMs) < MAX_SANE_OFFSET_MS);

  if (!results.length) {
    return { ok: false, error: '所有时间源均不可达（网络受限或全部超时）' };
  }

  const offsets = results.map((r) => r.offsetMs).sort((a, b) => a - b);
  const median = offsets.length % 2
    ? offsets[(offsets.length - 1) / 2]
    : Math.round((offsets[offsets.length / 2 - 1] + offsets[offsets.length / 2]) / 2);

  // 取最接近中位数的样本作为「代表源」，用于面板展示
  results.sort((a, b) => Math.abs(a.offsetMs - median) - Math.abs(b.offsetMs - median));
  const best = results[0];

  return {
    ok: true,
    offsetMs: median,
    source: best.source,
    rttMs: best.rttMs,
    samples: results.length
  };
}

/** 是否具备改系统时钟的条件（root + 通常还有 CAP_SYS_TIME） */
function canSetSystemClock() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** 真正把系统时钟校正到网络时间（默认关闭，仅在显式开启且 root 时执行） */
function setSystemClock(targetMs) {
  return new Promise((resolve) => {
    const iso = new Date(targetMs).toISOString();
    execFile('date', ['-u', '-s', iso], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').trim() || 'date 命令执行失败' });
      resolve({ ok: true, output: String(stdout || '').trim() });
    });
  });
}

/**
 * 执行一次完整对时：采样 → 落状态 → 告警 →（可选）校系统时钟。
 * 并发保护：上一次还没跑完就直接返回，避免定时器与手动按钮叠加打满网络。
 */
async function runCheck(reason = 'manual') {
  if (state.checking) return { ok: false, busy: true, error: '上一次对时尚未完成' };
  state.checking = true;
  const startedAt = Date.now();
  try {
    const r = await measureOnce();

    if (!r.ok) {
      state.failCount += 1;
      state.lastCheckAt = new Date();
      state.lastError = r.error;
      const lg = log();
      if (lg) lg.warn('time-sync', `[${reason}] 联网对时失败：${r.error}`);
      return { ok: false, error: r.error, reason };
    }

    state.offsetMs = r.offsetMs;
    state.lastCheckAt = new Date();
    state.lastError = null;
    state.successCount += 1;

    let clockFix = null;
    if (state.allowSystemClockSet && canSetSystemClock() && Math.abs(r.offsetMs) > DRIFT_WARN_MS) {
      clockFix = await setSystemClock(Date.now() + r.offsetMs);
      if (!clockFix.ok) {
        const lg = log();
        if (lg) lg.warn('time-sync', `[${reason}] 系统时钟校正失败（容器通常无 CAP_SYS_TIME）：${clockFix.error}`);
      }
    }

    state.lastResult = {
      reason,
      offsetMs: r.offsetMs,
      source: r.source,
      rttMs: r.rttMs,
      samples: r.samples,
      elapsedMs: Date.now() - startedAt,
      clockFix,
      at: new Date().toISOString()
    };

    const lg = log();
    if (lg) {
      if (Math.abs(r.offsetMs) > DRIFT_WARN_MS) {
        lg.warn('time-sync', `[${reason}] 检测到时钟漂移 ${r.offsetMs}ms（来源 ${r.source}/${r.samples} 源，RTT ${r.rttMs}ms），应用层已补偿`);
      } else {
        lg.info('time-sync', `[${reason}] 对时完成，漂移 ${r.offsetMs}ms（来源 ${r.source}/${r.samples} 源）`);
      }
    }
    return { ok: true, ...state.lastResult };
  } catch (e) {
    state.failCount += 1;
    state.lastError = e.message || String(e);
    const lg = log();
    if (lg) lg.error('time-sync', `[${reason}] 对时异常：${state.lastError}`);
    return { ok: false, error: state.lastError, reason };
  } finally {
    state.checking = false;
  }
}

/**
 * 补偿后的当前时间。
 * 这是 logger 与需要「网络标准时间」的业务逻辑的统一入口；
 * 未校准时 offsetMs=0，行为与 new Date() 完全一致，无副作用。
 */
function appNow() {
  if (!state.offsetMs) return new Date();
  return new Date(Date.now() + state.offsetMs);
}

function clearTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function clampInterval(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_INTERVAL;
  return Math.min(Math.max(v, MIN_INTERVAL), MAX_INTERVAL);
}

/** 启动定时对时：立即跑一次，之后按间隔轮询；timer unref 不阻塞进程退出 */
function startAutoSync(intervalMinutes) {
  const mins = clampInterval(intervalMinutes != null ? intervalMinutes : state.intervalMinutes);
  state.intervalMinutes = mins;
  state.enabled = true;
  clearTimer();
  state.timer = setInterval(() => { runCheck('auto'); }, mins * 60 * 1000);
  if (state.timer.unref) state.timer.unref();
  runCheck('auto-start');
  const lg = log();
  if (lg) lg.info('time-sync', `自动联网对时已开启（每 ${mins} 分钟）`);
}

function stopAutoSync() {
  state.enabled = false;
  clearTimer();
  const lg = log();
  if (lg) lg.info('time-sync', '自动联网对时已关闭');
}

/** 从 system_config 读取配置并落内存（server.js 启动时调用） */
async function loadConfig(pool) {
  poolRef = pool || poolRef;
  if (!poolRef) return state;
  try {
    const [rows] = await poolRef.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN (?, ?, ?)`,
      [CFG_ENABLED, CFG_INTERVAL, CFG_SET_CLOCK]
    );
    const map = {};
    for (const r of rows) map[r.config_key] = r.config_value;
    if (map[CFG_ENABLED] !== undefined) state.enabled = String(map[CFG_ENABLED]) === '1';
    if (map[CFG_INTERVAL] !== undefined) state.intervalMinutes = clampInterval(map[CFG_INTERVAL]);
    if (map[CFG_SET_CLOCK] !== undefined) state.allowSystemClockSet = String(map[CFG_SET_CLOCK]) === '1';
  } catch (e) {
    const lg = log();
    if (lg) lg.warn('time-sync', '载入自动对时配置失败，使用默认值：' + (e.message || e));
  }
  return state;
}

/** 保存配置到 system_config，并按新配置启停定时器 */
async function saveConfig({ enabled, intervalMinutes, allowSystemClockSet } = {}) {
  if (enabled !== undefined) state.enabled = !!enabled;
  if (intervalMinutes !== undefined) state.intervalMinutes = clampInterval(intervalMinutes);
  if (allowSystemClockSet !== undefined) state.allowSystemClockSet = !!allowSystemClockSet;

  if (poolRef) {
    const rows = [
      [CFG_ENABLED, state.enabled ? '1' : '0'],
      [CFG_INTERVAL, String(state.intervalMinutes)],
      [CFG_SET_CLOCK, state.allowSystemClockSet ? '1' : '0']
    ];
    for (const [k, v] of rows) {
      // eslint-disable-next-line no-await-in-loop
      await poolRef.query(
        `INSERT INTO system_config (config_key, config_value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE config_value = ?`,
        [k, v, v]
      );
    }
  }

  if (state.enabled) startAutoSync(state.intervalMinutes);
  else stopAutoSync();

  return getStatus();
}

/** 面板展示用状态快照（时间均按当前进程时区格式化，交由调用方处理） */
function getStatus() {
  return {
    enabled: state.enabled,
    intervalMinutes: state.intervalMinutes,
    allowSystemClockSet: state.allowSystemClockSet,
    systemClockWritable: canSetSystemClock(),
    offsetMs: state.offsetMs,
    lastCheckAt: state.lastCheckAt ? state.lastCheckAt.toISOString() : null,
    lastResult: state.lastResult,
    lastError: state.lastError,
    checking: state.checking,
    successCount: state.successCount,
    failCount: state.failCount,
    sources: { ntp: NTP_SOURCES.slice(), http: HTTP_SOURCES.slice() }
  };
}

/** 进程启动入口：载入配置，开启则启动定时器 */
async function init(pool) {
  await loadConfig(pool);
  if (state.enabled) startAutoSync(state.intervalMinutes);
  return getStatus();
}

module.exports = {
  init,
  measureOnce,
  runCheck,
  appNow,
  startAutoSync,
  stopAutoSync,
  loadConfig,
  saveConfig,
  getStatus,
  canSetSystemClock,
  DRIFT_WARN_MS,
  MIN_INTERVAL,
  MAX_INTERVAL
};
