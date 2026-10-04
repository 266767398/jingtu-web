/**
 * 境途同游 — 视频工具模块
 * 提供视频缩略图提取和时长获取功能
 * 使用 fluent-ffmpeg 调用 ffmpeg 处理视频
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('./logger');

let ffmpegPath = null;
let ffprobePath = null;

// 延迟加载 ffmpeg 路径（避免安装失败导致 server 崩溃）
function getFfmpegPaths() {
  if (ffmpegPath) return { ffmpegPath, ffprobePath };

  // 1. 优先使用 @ffmpeg-installer/ffmpeg
  try {
    const ffinstaller = require('@ffmpeg-installer/ffmpeg');
    ffmpegPath = ffinstaller.path.replace(/\\/g, '/');
    // ffprobe 不在该包中，稍后尝试从其他来源获取
    if (fs.existsSync(ffmpegPath)) {
      logger.info('video', '[video] 使用 @ffmpeg-installer/ffmpeg:', ffmpegPath);
      // 尝试同一目录下找 ffprobe
      ffprobePath = ffmpegPath.replace('ffmpeg.exe', 'ffprobe.exe');
      if (!fs.existsSync(ffprobePath)) ffprobePath = null;
      return { ffmpegPath, ffprobePath };
    }
  } catch (e) {}

  // 2. 尝试系统 PATH 中的 ffmpeg
  const { execSync } = require('child_process');
  try {
    const result = execSync('where ffmpeg 2>nul', { encoding: 'utf8', timeout: 3000 });
    ffmpegPath = result.split('\n')[0].trim();
    const probeResult = execSync('where ffprobe 2>nul', { encoding: 'utf8', timeout: 3000 });
    ffprobePath = probeResult.split('\n')[0].trim();
    if (fs.existsSync(ffmpegPath)) {
      logger.info('video', '[video] 使用系统 ffmpeg:', ffmpegPath);
      return { ffmpegPath, ffprobePath };
    }
  } catch (e) { /* not in PATH */ }

  logger.warn('video', '[video] ffmpeg 未找到，视频缩略图提取功能不可用');
  return { ffmpegPath: null, ffprobePath: null };
}

// P3-142：JPEG 魔数校验（FF D8 FF）替代仅 >100B 的大小判断——ffmpeg 超时被 kill
// 的半成品只要超过 100B 就足以骗过旧校验，永久复用损坏缩略图。
function isValidJpeg(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(4);
    let n = 0;
    try { n = fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    return n >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  } catch (e) {
    return false;
  }
}

// P3-142：取视频前 64KB + 文件大小做内容指纹（固定成本，不整读大文件），
// 两个不同视频即使基础名截断相同也不会互相覆盖复用缩略图。
function videoContentDigest(videoInputPath) {
  try {
    const stat = fs.statSync(videoInputPath);
    const fd = fs.openSync(videoInputPath, 'r');
    const buf = Buffer.alloc(65536);
    let n = 0;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    const h = crypto.createHash('sha1');
    h.update(buf.subarray(0, n));
    h.update(String(stat.size));
    return h.digest('hex').slice(0, 8);
  } catch (e) {
    return Date.now().toString(36);
  }
}

/**
 * 提取视频第一帧作为 JPEG 缩略图
 * @param {string} videoInputPath - 视频文件绝对路径
 * @param {string} [outputDir] - 输出目录，默认与视频同目录
 * @returns {Promise<string>} - 缩略图相对路径（相对于 outputDir），空字符串表示失败
 */
async function extractVideoThumbnail(videoInputPath, outputDir) {
  const { ffmpegPath } = getFfmpegPaths();
  if (!ffmpegPath) return '';

  // 确保输入文件存在
  if (!fs.existsSync(videoInputPath)) {
    logger.warn('video', '[video] 视频文件不存在:', videoInputPath);
    return '';
  }

  const dir = outputDir || path.dirname(videoInputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const parsed = path.parse(videoInputPath);
  // 限制文件名长度（含 _thumb）并追加内容指纹，杜绝超长名截断后复用旧缩略图
  const baseName = parsed.name.length > 80 ? parsed.name.substring(0, 80) : parsed.name;
  const thumbName = `thumb_${baseName}_${videoContentDigest(videoInputPath)}.jpg`;
  const thumbPath = path.join(dir, thumbName);
  // 先写临时文件，校验通过后再改名落定——被 kill 的半成品永远不会成为正式缩略图
  const tmpPath = `${thumbPath}.tmp`;

  // 如果正式缩略图已存在且是完整 JPEG，直接返回
  if (fs.existsSync(thumbPath) && isValidJpeg(thumbPath)) {
    return thumbName;
  }

  return new Promise((resolve) => {
    // 使用 child_process 直接调用 ffmpeg（避免 fluent-ffmpeg 异步依赖）
    const { spawn } = require('child_process');
    const args = [
      '-y',                        
      '-i', videoInputPath,        
      '-vframes', '1',             
      '-f', 'image2',              
      '-q:v', '2',                 
      '-s', '400x225',             
      tmpPath
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      logger.warn('video', '[video] ffmpeg 超时:', videoInputPath);
    }, 12000);

    // P3-142：无论成功/失败/超时，统一在进程结束后处理临时文件——
    // 校验通过才改名落定；其余情况删除半成品，避免残留损坏缩略图。
    const cleanupTmp = () => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) { /* 尽力清理 */ }
    };
    const settle = () => {
      if (!timedOut) {
        if (fs.existsSync(tmpPath) && isValidJpeg(tmpPath) && fs.statSync(tmpPath).size > 100) {
          try {
            fs.renameSync(tmpPath, thumbPath);
            resolve(thumbName);
            return;
          } catch (e) {
            logger.warn('video', '[video] 缩略图落定失败:', e.message);
          }
        }
        cleanupTmp();
      } else {
        cleanupTmp();
      }
      resolve('');
    };

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) logger.warn('video', '[video] ffmpeg 退出码', code, stderr.slice(-200));
      settle();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.warn('video', '[video] ffmpeg 执行错误:', err.message);
      settle();
    });
  });
}

/**
 * 获取视频时长（秒）
 * @param {string} videoInputPath - 视频文件绝对路径
 * @returns {Promise<number>} - 时长（秒），失败返回 0
 */
async function getVideoDuration(videoInputPath) {
  const { ffprobePath } = getFfmpegPaths();
  if (!ffprobePath) return 0;

  if (!fs.existsSync(videoInputPath)) return 0;

  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      videoInputPath
    ];

    const proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      resolve(0);
    }, 6000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const dur = parseFloat(stdout.trim());
        resolve(isNaN(dur) ? 0 : Math.round(dur));
      } else {
        resolve(0);
      }
    });

    proc.on('error', () => { clearTimeout(timer); resolve(0); });
  });
}

module.exports = { extractVideoThumbnail, getVideoDuration };
