<?php
/**
 * 境途同游 — 服务自动启动脚本（仅限开发环境）
 * ⚠️ 此文件包含硬编码的系统路径，不应在生产环境中暴露
 * 生产环境应使用系统服务管理器（如 pm2 / systemd）管理进程
 */

// 仅在本地开发环境运行
$allowedIPs = ['127.0.0.1', '::1', '192.168.'];
$remoteIP = $_SERVER['REMOTE_ADDR'] ?? '';
$isLocal = false;
foreach ($allowedIPs as $prefix) {
    if (strpos($remoteIP, $prefix) === 0) { $isLocal = true; break; }
}
if (!$isLocal) {
    http_response_code(403);
    die('Forbidden: 此脚本仅限本地开发环境使用');
}

$nodePort  = 3456;
$mysqlPort = 3306;
$nodeDir   = 'D:/phpstudy_pro/WWW/jingtu-web/server';
$logFile   = 'D:/phpstudy_pro/WWW/jingtu-web/node.log';
$mysqlExe  = 'D:/phpstudy_pro/Extensions/MySQL5.7.26/bin/mysqld.exe';
$mysqlConf = 'D:/phpstudy_pro/Extensions/MySQL5.7.26/my.ini';
$maxWait   = 20;

// ---- 辅助：检查端口是否在监听 ----
function portOpen($port) {
    $fp = @fsockopen('127.0.0.1', $port, $errno, $errstr, 1);
    if ($fp) { fclose($fp); return true; }
    return false;
}

// ---- 1. 先确保 MySQL 已启动 ----
if (!portOpen($mysqlPort)) {
    $cmd = sprintf('start /B "%s" --defaults-file="%s"', $mysqlExe, $mysqlConf);
    pclose(popen($cmd, 'r'));
    // 等待 MySQL 就绪（最多 8 秒）
    for ($i = 0; $i < 8; $i++) {
        sleep(1);
        if (portOpen($mysqlPort)) break;
    }
}

// ---- 2. 检查 Node.js 是否已运行 ----
if (portOpen($nodePort)) {
    header('Location: /');
    exit;
}

// ---- 3. 启动 Node.js（Windows 后台进程）----
$cmd = sprintf(
    'start /B cmd /c "cd /d %s && node server.js > %s 2>&1"',
    escapeshellarg($nodeDir),
    escapeshellarg($logFile)
);
pclose(popen($cmd, 'r'));

// ---- 4. 等待 Node 启动完成 ----
for ($i = 0; $i < $maxWait; $i++) {
    sleep(1);
    if (portOpen($nodePort)) {
        header('Location: /');
        exit;
    }
}

// ---- 5. 超时——返回友好错误页 ----
$logContent = file_exists($logFile) ? file_get_contents($logFile) : '（日志文件不存在）';
header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>服务启动失败 - 境途同游</title>
<style>
  body{font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;
       height:100vh;margin:0;background:#0a0a0f;color:#e4e4f0}
  .box{text-align:center;max-width:500px;padding:36px;background:#141420;border-radius:16px;
       border:1px solid #2a2a3e;box-shadow:0 4px 32px rgba(0,0,0,.5)}
  h2{color:#f87171;margin-bottom:16px;font-size:22px}
  ol{text-align:left;line-height:2;color:#9898b0;padding-left:20px}
  a{color:#7c5cfc;text-decoration:none;border-bottom:1px solid}
  pre{font-size:11px;text-align:left;background:#0a0a15;padding:12px;border-radius:8px;
      overflow:auto;max-height:200px;color:#a78bfa;border:1px solid #2a2a3e}
  .btn{display:inline-block;margin-top:20px;padding:10px 28px;background:#7c5cfc;color:#fff;
       border-radius:8px;text-decoration:none;font-weight:600;border:none;cursor:pointer}
</style>
</head>
<body>
<div class="box">
  <h2>⚠️ 服务启动超时</h2>
  <p style="color:#9898b0;margin-bottom:16px">Node.js 未能在 <?= $maxWait ?> 秒内就绪，请检查：</p>
  <ol>
    <li>phpStudy 已启动 <b>MySQL 5.7</b></li>
    <li>已运行 <code>npm install</code> 安装依赖</li>
    <li>端口 <b>3456</b> 未被其他程序占用</li>
    <li>.env 文件中 MySQL 密码正确</li>
  </ol>
  <p><strong>启动日志：</strong></p>
  <pre><?= htmlspecialchars($logContent) ?></pre>
  <a class="btn" href="/start-node.php">🔄 重新尝试启动</a>
</div>
</body>
</html>
