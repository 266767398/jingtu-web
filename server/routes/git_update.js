/**
 * 在线更新路由（超管专属，GIT 拉取 + 自动重启）
 *
 * 功能：在后台「系统设置」中一键拉取 GitHub 远程最新代码并自动更新。
 * - 安全边界：仅超级管理员可调用（requireSuperAdmin + adminLimiter 限流 + CSRF）；
 *   所有 git 调用走 execFile 数组参数直传，杜绝 shell 注入。
 * - 数据保护：git fetch + merge --ff-only 只改动受版本控制的跟踪文件，
 *   永不执行 git clean；.env / uploads/ /assets/ /server/data/*.sqlite /
 *   MySQL 数据库均被 .gitignore 排除或存放于外部，不会受更新影响。
 * - 重启策略：Windows 下用独立 PowerShell 进程「先杀掉旧进程、再 Start-Process
 *   拉起新的 node server.js」，端口释放后再启动，避免 EADDRINUSE。
 */
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const { ok, sendError, ErrorCodes, logOper } = require('../utils');
const { requireSuperAdmin } = require('../auth');
const logger = require('../logger');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT, 'server');

const router = express.Router();
module.exports = router;

/**
 * 执行 git 命令（数组参数直传，不过 shell）
 * @returns {Promise<string>} stdout
 */
function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: ROOT,
      timeout: opts.timeout || 20000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || '').trim();
        const gitErr = new Error(detail || err.message);
        gitErr.gitError = err;
        reject(gitErr);
      } else {
        resolve(String(stdout || '').trim());
      }
    });
  });
}

function gitOk(args) {
  return runGit(args).catch(() => null);
}

async function installServerDeps() {
  return new Promise((resolve) => {
    execFile('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: SERVER_DIR,
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }, (err) => {
      if (err) logger.warn('[git-update]', 'server 依赖安装失败:', (err.stderr || err.message || '').toString().slice(0, 500));
      resolve(!err);
    });
  });
}

/**
 * 排程自动重启（Windows）：独立 PowerShell 进程先杀旧进程，等端口释放后再拉起新服务。
 * 调用方必须在 HTTP 响应已发出后再执行；return 后立即 detach，主进程不受影响。
 *
 * 注意（2026-10-03 实测修复）：不得用裸命令名 'powershell.exe' / 'node'，服务进程的
 * env PATH 与交互终端不同，detached 子进程会 spawn 失败或 Start-Process 解析不到可执行
 * 文件而抛 statement-terminating error 把整段 -Command 中止，导致“已排程”日志正常但
 * 服务不重启。改用绝对路径：PowerShell 用 SystemRoot 定位，node 用 process.execPath
 * （重启后与当前运行的服务是同一份 node 二进制）。
 */
function scheduleRestart() {
  try {
    const psExe = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const nodeExe = process.execPath || 'node';
    const ps = [
      `$ErrorActionPreference='SilentlyContinue'`,
      `Start-Sleep -Milliseconds 1500`,
      `Stop-Process -Id ${process.pid} -Force`,
      `Start-Sleep -Seconds 2`,
      `Start-Process -FilePath '${nodeExe}' -ArgumentList 'server.js' -WorkingDirectory '${SERVER_DIR.replace(/\\/g, '/')}' -WindowStyle Hidden`
    ].join('\n');
    const child = execFile(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', (e) => logger.error('[git-update]', '重启排程子进程启动失败:', e.message));
    child.unref();
    logger.info('[git-update]', '已排程自动重启服务（进程 pid=' + process.pid + '）');
  } catch (e) {
    logger.error('[git-update]', '排程自动重启失败:', e.message);
  }
}

// ==================== 更新状态查询 ====================
router.get('/admin/git-status', requireSuperAdmin, async (req, res) => {
  try {
    const branch = await gitOk(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') {
      return ok(res, { isGitRepo: false, message: '未检测到 Git 仓库（或当前为检出状态），在线更新不可用' });
    }
    const commit = await gitOk(['rev-parse', '--short=7', 'HEAD']);
    const fullCommit = await gitOk(['rev-parse', 'HEAD']);
    const subject = await gitOk(['log', '-1', '--pretty=%s']);
    const remote = await gitOk(['remote', 'get-url', 'origin']);
    const dirty = await gitOk(['status', '--porcelain']);
    const localChanges = dirty ? dirty.split('\n').filter(Boolean).length : 0;

    // 有限时 fetch 以得知 ahead/behind；失败不阻塞状态展示
    let fetchOk = true;
    let behind = null;
    let ahead = null;
    try {
      await runGit(['fetch', 'origin', branch], { timeout: 15000 });
      const b = await gitOk(['rev-list', '--count', 'HEAD..origin/' + branch]);
      const a = await gitOk(['rev-list', '--count', 'origin/' + branch + '..HEAD']);
      behind = b === null ? null : parseInt(b, 10);
      ahead = a === null ? null : parseInt(a, 10);
    } catch (e) {
      fetchOk = false;
    }
    ok(res, {
      isGitRepo: true,
      branch,
      remote: remote || null,
      commit: commit || null,
      fullCommit: fullCommit || null,
      subject: subject || null,
      localChanges,
      behind,
      ahead,
      fetchOk
    });
  } catch (e) {
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, '查询更新状态失败：' + (e.message || '未知错误'));
    logger.error('[admin/git-status]', e.message);
  }
});

// ==================== 执行在线更新 ====================
router.post('/admin/git-update', requireSuperAdmin, async (req, res) => {
  const restart = !!(req.body && req.body.restart);
  try {
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 10000 });
    if (!branch || branch === 'HEAD') {
      return sendError(res, 409, ErrorCodes.GIT_NOT_ON_BRANCH, '当前不在分支上（检出状态），无法自动更新');
    }

    // 1) 拉取远端（GIT_TERMINAL_PROMPT=0，私有仓库缺凭据时快速失败而非挂起等待输入）
    await runGit(['fetch', 'origin', branch], { timeout: 90000 });

    // 2) 比较 ahead/behind
    const behind = parseInt(await runGit(['rev-list', '--count', 'HEAD..origin/' + branch], { timeout: 10000 }), 10) || 0;
    const ahead = parseInt(await runGit(['rev-list', '--count', 'origin/' + branch + '..HEAD'], { timeout: 10000 }), 10) || 0;

    if (behind === 0 && ahead === 0) {
      return ok(res, { updated: false, message: '已是最新版本，无需更新', branch, behind: 0, ahead: 0, restarting: false });
    }
    if (ahead > 0) {
      return sendError(res, 409, ErrorCodes.GIT_LOCAL_AHEAD,
        `本地领先远端 ${ahead} 个提交，自动更新会破坏本地历史。请先在远端合并或放弃本地提交后再试。`);
    }

    // 3) 快进合并（ff-only：严格保持提交线形，绝不产生合并提交）
    const oldCommit = await runGit(['rev-parse', 'HEAD'], { timeout: 10000 });
    await runGit(['merge', '--ff-only', 'origin/' + branch], { timeout: 90000 });
    const newCommit = await runGit(['rev-parse', 'HEAD'], { timeout: 10000 });

    // 4) 变更文件清单
    let filesChanged = [];
    try {
      const names = await runGit(['diff', '--name-only', oldCommit, newCommit], { timeout: 10000 });
      filesChanged = names ? names.split('\n').filter(Boolean) : [];
    } catch (e) { logger.warn('[git-update]', '读取变更文件清单失败:', e.message); }

    // 5) 若 server/package.json 有变更则补装依赖（失败只告警，不阻断更新）
    let depsInstalled = false;
    if (filesChanged.some(f => path.normalize(f).replace(/\\/g, '/') === 'server/package.json')) {
      depsInstalled = await installServerDeps();
    }

    // 6) 操作日志
    try { logOper(req.session.userId, 'git_update', `在线更新 ${branch}: ${oldCommit.slice(0, 7)} → ${newCommit.slice(0, 7)}（${filesChanged.length} 个文件变更，依赖安装 ${depsInstalled ? '完成' : '未触发/失败'}）`); } catch (e) { logger.warn('[git-update]', '写操作日志失败:', e.message); }

    if (restart) {
      scheduleRestart();
      return ok(res, {
        updated: true,
        message: '更新成功，服务正在自动重启（约 3 秒中断），请稍后刷新页面',
        branch, oldCommit, newCommit,
        filesChanged, filesChangedCount: filesChanged.length,
        depsInstalled, restarting: true
      });
    }
    return ok(res, {
      updated: true,
      message: '更新成功，代码已生效（未重启）。如变更涉及服务端依赖或需重载配置，请点击「仅重启服务」',
      branch, oldCommit, newCommit,
      filesChanged, filesChangedCount: filesChanged.length,
      depsInstalled, restarting: false
    });
  } catch (e) {
    // 区分「git 缺失」与「合并冲突/本地改动阻碍」
    const raw = String(e.message || '');
    let msg;
    let code;
    if (e.gitError && e.gitError.code === 'ENOENT') {
      code = ErrorCodes.GIT_NOT_FOUND;
      msg = '未找到 git 命令，请先在服务器安装 Git 并加入 PATH 后重试';
    } else if (/local changes|would be overwritten|Your local changes|Non-fast-forward/i.test(raw)) {
      code = ErrorCodes.GIT_LOCAL_CHANGES;
      msg = '本地有未提交改动与更新冲突。请先提交或备份本地改动（用户数据不受影响），再重试更新';
    } else if (/Authentication|could not read Username|terminal prompt disabled/i.test(raw)) {
      code = ErrorCodes.GIT_NEED_CREDENTIALS;
      msg = '远端仓库需要凭据。请在本机配置 git 凭据（或改用 HTTPS Token）后重试';
    } else if (/not a git repository/i.test(raw)) {
      code = ErrorCodes.GIT_NO_REPO;
      msg = '当前目录不是 Git 仓库，在线更新不可用';
    } else {
      code = ErrorCodes.GIT_UPDATE_FAILED;
      msg = '更新失败：' + raw.slice(0, 300);
    }
    logger.error('[admin/git-update]', '更新失败:', e.message);
    sendError(res, 500, code, msg);
  }
});

// ==================== 仅重启服务（应用已拉取但未重启的场景） ====================
router.post('/admin/git-restart', requireSuperAdmin, async (req, res) => {
  scheduleRestart();
  ok(res, { restarting: true, message: '服务正在自动重启（约 3 秒中断），请稍后刷新页面' });
});
