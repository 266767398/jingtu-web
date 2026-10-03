/**
 * 运维面板反向代理 + 生命周期管理
 * 站点管理后台「运维面板」入口经此访问：主站 /ops/* → 127.0.0.1:3457/*（剥离前缀）。
 * 必须置于安全响应头（CSP/X-Frame-Options）之前，否则面板内联脚本会被主站 CSP 拦截；
 * 面板自身的 Bearer Token 鉴权保持不变。
 *
 * 生命周期策略（面板「按需启动 + 空闲自动关闭」，释放服务器资源）：
 *  - 管理后台「运维面板」按钮点击 → POST /api/ops/start 确保面板进程就绪 → 再打开 /ops/；
 *  - 每次 /ops 代理访问都会刷新 lastOpsActivity（面板页面开着也会定期心跳保活）；
 *  - 空闲超过 PANEL_IDLE_MINUTES（默认 20）分钟且无任何访问 → 自动关闭面板进程；
 *    下次点击入口会自动重新拉起，实现循环。
 */
const http = require('http');
const path = require('path');
const fs = require('fs');

const PANEL_UPSTREAM = { host: '127.0.0.1', port: Number(process.env.PANEL_PORT || 3457) };
// 生命周期参数均可通过环境变量调节（便于部署调参与测试）：
//  PANEL_IDLE_MINUTES       空闲多少分钟后自动关闭面板（默认 20）
//  PANEL_IDLE_CHECK_SECONDS 空闲检查周期，秒（默认 60）
//  PANEL_START_POLL_MS      等待面板健康时的探测轮询间隔，毫秒（默认 1000）
const IDLE_MS = (Number(process.env.PANEL_IDLE_MINUTES) || 20) * 60 * 1000;
const IDLE_CHECK_INTERVAL = (Number(process.env.PANEL_IDLE_CHECK_SECONDS) || 60) * 1000;
const START_POLL_MS = Number(process.env.PANEL_START_POLL_MS) || 1000;
const START_WAIT_MAX = 10000;          // ensurePanelStarted 等待健康上限

let panelSpawnPending = false;  // trySpawnPanelServer 10s 去重标记
let panelChild = null;          // 本模块拉起的面板进程引用（仅自动拉起的才由空闲策略托管）
let lastOpsActivity = 0;        // 最近一次 /ops 代理访问时间戳（0 = 面板从未被网站访问）
let idleTimer = null;           // 空闲检查定时器

/* ---------- 探测与拉起 ---------- */

/** 探测面板 /api/bootstrap 是否可达（不重复 spawn） */
function probePanel(onResult) {
  const probe = http.request({
    host: PANEL_UPSTREAM.host,
    port: PANEL_UPSTREAM.port,
    path: '/api/bootstrap',
    method: 'GET',
    timeout: 1200
  }, (r) => { r.resume(); onResult(true); });
  probe.on('timeout', () => { probe.destroy(); onResult(false); });
  probe.on('error', () => onResult(false));
  probe.end();
}

function trySpawnPanelServer(rootDir) {
  // 快速探测面板是否在监听；不可达则自动拉起（避免入口打不开），10s 内去重
  if (panelSpawnPending) return;
  panelSpawnPending = true;
  setTimeout(() => { panelSpawnPending = false; }, 10000);
  probePanel((ok) => { if (!ok) doSpawnPanel(rootDir); });
}

function doSpawnPanel(rootDir) {
  try {
    const cp = require('child_process');
    const panelPath = path.join(rootDir, 'panel', 'panel-server.js');
    if (!fs.existsSync(panelPath)) return;
    const child = cp.spawn(process.execPath, [panelPath], {
      cwd: path.join(rootDir, 'panel'),
      detached: true,
      stdio: 'ignore'
    });
    child.on('exit', () => { if (panelChild === child) panelChild = null; });
    child.unref();
    panelChild = child;
    console.log('[ops] 运维面板未运行，已自动拉起 panel-server.js (pid=' + child.pid + ')');
  } catch (e) {
    console.error('[ops] 自动拉起运维面板失败:', e.message);
  }
}

/**
 * 确保面板已启动并等待健康。
 * @param {string} rootDir
 * @param {(err: Error|null, running: boolean) => void} cb
 */
function ensurePanelStarted(rootDir, cb) {
  probePanel((ok) => {
    if (ok) return cb(null, true);
    doSpawnPanel(rootDir);
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      probePanel((ok2) => {
        if (ok2) { clearInterval(t); cb(null, true); }
        else if (tries >= Math.ceil(START_WAIT_MAX / START_POLL_MS)) { clearInterval(t); cb(new Error('运维面板启动超时')); }
      });
    }, START_POLL_MS);
    if (t.unref) t.unref();
  });
}

/* ---------- 活动追踪与空闲关闭 ---------- */

function touchOpsActivity() {
  lastOpsActivity = Date.now();
}

/** 跨平台终止本模块拉起的面板进程（Windows taskkill / POSIX SIGTERM） */
function stopPanelProcess() {
  const child = panelChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) { panelChild = null; return; }
  const pid = child.pid;
  try {
    if (process.platform === 'win32') {
      const { spawnSync } = require('child_process');
      spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { /* 进程已退出则忽略 */ }
    }
    console.log('[ops] 运维面板空闲超时，已自动关闭 (pid=' + pid + ')');
  } catch (e) {
    console.error('[ops] 关闭运维面板失败:', e.message);
  }
  panelChild = null;
}

/** 空闲超过阈值且面板为本模块拉起时自动关闭（由定时器周期调用） */
function stopPanelIfIdle() {
  if (!panelChild || lastOpsActivity <= 0) return;
  if (Date.now() - lastOpsActivity >= IDLE_MS) {
    stopPanelProcess();
  }
}

function startIdleMonitor() {
  if (idleTimer) return;
  idleTimer = setInterval(stopPanelIfIdle, IDLE_CHECK_INTERVAL);
  if (idleTimer.unref) idleTimer.unref();
}

function stopIdleMonitor() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

/**
 * 运维面板生命周期 API（管理后台「运维面板」按钮与空闲自动关闭配套）：
 *   POST /api/ops/start  确保面板已启动（等待健康），返回 { ok, running, pid? }
 *   GET  /api/ops/status 查询运行状态与空闲信息，返回 { ok, running, idleMinutes, lastActivityAgoSec }
 * @param {import('express').Express} app
 * @param {{ ROOT_DIR: string, requireSuperAdmin: Function }} deps
 */
function setupPanelLifecycle(app, deps) {
  const { ROOT_DIR, requireSuperAdmin } = deps;
  startIdleMonitor();
  app.post('/api/ops/start', requireSuperAdmin, (req, res) => {
    ensurePanelStarted(ROOT_DIR, (err, running) => {
      if (err) return res.status(502).json({ ok: false, message: err.message });
      touchOpsActivity();
      res.json({ ok: true, running, pid: panelChild ? panelChild.pid : null });
    });
  });
  app.get('/api/ops/status', requireSuperAdmin, (req, res) => {
    probePanel((ok) => {
      const idleMinutes = Math.round(IDLE_MS / 60000);
      res.json({
        ok: true,
        running: ok,
        idleMinutes,
        lastActivityAgoSec: lastOpsActivity > 0 ? Math.round((Date.now() - lastOpsActivity) / 1000) : -1
      });
    });
  });
}

/* ---------- 反向代理 ---------- */

function proxyToPanel(req, res, isRetry) {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const upstreamPath = parsed.pathname.replace(/^\/ops(?=\/|$)/, '') || '/';
  const q = parsed.search || '';
  // P3-97/P3-108：代理链路注入可信标记——面板端仅当直连来源为回环（本机可信入口）时
  // 才信任 x-real-ip（登录失败锁定按真实来源 IP 分桶，不再退化为全局共享桶）；
  // x-ops-proxy 供面板做 POST 源校验放行（主站侧已先行 CSRF + 超管鉴权）。
  const forwardHeaders = Object.assign({}, req.headers, {
    host: '127.0.0.1:' + PANEL_UPSTREAM.port,
    'x-real-ip': String(req.ip || (req.socket && req.socket.remoteAddress) || ''),
    'x-ops-proxy': '1'
  });
  const proxyReq = http.request({
    host: PANEL_UPSTREAM.host,
    port: PANEL_UPSTREAM.port,
    path: upstreamPath + q,
    method: req.method,
    headers: forwardHeaders,
    timeout: 8000
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('timeout', () => proxyReq.destroy());
  proxyReq.on('error', (e) => {
    if (!isRetry && (req.method === 'GET' || req.method === 'HEAD')) {
      // 首次失败：面板可能刚被杀/尚未启动，自动拉起后 3 秒重试一次（GET/HEAD 可安全重放）
      setTimeout(() => proxyToPanel(req, res, true), 3000);
    } else if (!res.headersSent) {
      res.status(502).json({ ok: false, message: '运维面板不可达，请确认 panel-server.js 已启动（' + e.message + '）' });
    } else {
      res.end();
    }
  });
  if (req.method === 'GET' || req.method === 'HEAD') proxyReq.end();
  else req.pipe(proxyReq);
}

/**
 * 挂载 /ops/ 反向代理入口（须在安全响应头中间件之前调用）
 * @param {import('express').Express} app
 * @param {{ ROOT_DIR: string, requireSuperAdmin: Function }} deps
 *
 * P2-154：入口鉴权从 requireAdminCompat 提升为 requireSuperAdmin——面板可执行
 * 重置超管密码/清空用户数据/停杀服务/导出含全部 PII 站点包等机器级操作，
 * 仅凭一枚共享面板密码即可完成，因此普通管理员（admin）不得经公网入口触及。
 */
function setupPanelProxy(app, deps) {
  // 运维面板反向代理：先过主站超管鉴权，避免把仅监听 localhost 的管理面板
  // 经公网入口暴露给匿名用户或数据面管理员
  // P3-42: 挂载边界 `/ops/`——Express 只把 `/ops` 或 `/ops/*` 路由进代理，`/opsfoo` 这类畸形前缀不再进入
  app.use('/ops/', deps.requireSuperAdmin, (req, res) => {
    touchOpsActivity();
    trySpawnPanelServer(deps.ROOT_DIR);
    proxyToPanel(req, res, false);
  });
}

module.exports = { setupPanelProxy, setupPanelLifecycle, stopIdleMonitor };