/**
 * 运维面板反向代理
 * 站点管理后台「运维面板」入口经此访问：主站 /ops/* → 127.0.0.1:3457/*（剥离前缀）。
 * 必须置于安全响应头（CSP/X-Frame-Options）之前，否则面板内联脚本会被主站 CSP 拦截；
 * 面板自身的 Bearer Token 鉴权保持不变。
 */
const http = require('http');
const path = require('path');
const fs = require('fs');

const PANEL_UPSTREAM = { host: '127.0.0.1', port: Number(process.env.PANEL_PORT || 3457) };
let panelSpawnPending = false;

function trySpawnPanelServer(rootDir) {
  // 快速探测面板是否在监听；不可达则自动拉起（避免入口打不开），10s 内去重
  if (panelSpawnPending) return;
  panelSpawnPending = true;
  setTimeout(() => { panelSpawnPending = false; }, 10000);
  const probe = http.request({ host: PANEL_UPSTREAM.host, port: PANEL_UPSTREAM.port, path: '/api/bootstrap', method: 'GET', timeout: 1200 }, (r) => { r.resume(); });
  probe.on('timeout', () => { probe.destroy(); doSpawnPanel(rootDir); });
  probe.on('error', () => doSpawnPanel(rootDir));
  probe.end();
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
    child.unref();
    console.log('[ops] 运维面板未运行，已自动拉起 panel-server.js (pid=' + child.pid + ')');
  } catch (e) {
    console.error('[ops] 自动拉起运维面板失败:', e.message);
  }
}

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
    trySpawnPanelServer(deps.ROOT_DIR);
    proxyToPanel(req, res, false);
  });
}

module.exports = { setupPanelProxy };
