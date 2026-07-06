/**
 * 境途同游 — 视频工具模块
 * 提供视频缩略图提取和时长获取功能
 * 使用 fluent-ffmpeg 调用 ffmpeg 处理视频
 */
const path = require('path');
const fs = require('fs');

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
      console.log('[video] 使用 @ffmpeg-installer/ffmpeg:', ffmpegPath);
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
      console.log('[video] 使用系统 ffmpeg:', ffmpegPath);
      return { ffmpegPath, ffprobePath };
    }
  } catch (e) { /* not in PATH */ }

  console.warn('[video] ffmpeg 未找到，视频缩略图提取功能不可用');
  return { ffmpegPath: null, ffprobePath: null };
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
    console.warn('[video] 视频文件不存在:', videoInputPath);
    return '';
  }

  const dir = outputDir || path.dirname(videoInputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const parsed = path.parse(videoInputPath);
  // 限制文件名长度（含 _thumb）
  const baseName = parsed.name.length > 80 ? parsed.name.substring(0, 80) : parsed.name;
  const thumbName = `thumb_${baseName}.jpg`;
  const thumbPath = path.join(dir, thumbName);

  // 如果缩略图已存在，直接返回
  if (fs.existsSync(thumbPath)) {
    return thumbName;
  }

  return new Promise((resolve) => {
    // 使用 child_process 直接调用 ffmpeg（避免 fluent-ffmpeg 异步依赖）
    const { spawn } = require('child_process');
    const args = [
      '-y',                        // 覆盖已存在
      '-i', videoInputPath,        // 输入
      '-vframes', '1',             // 仅提取一帧
      '-f', 'image2',              // 输出格式
      '-q:v', '2',                 // 质量（2=高质量）
      '-s', '400x225',             // 16:9 缩放到 400px 宽
      thumbPath
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      console.warn('[video] ffmpeg 超时:', videoInputPath);
      resolve('');
    }, 12000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 100) {
        resolve(thumbName);
      } else {
        if (code !== 0) console.warn('[video] ffmpeg 退出码', code, stderr.slice(-200));
        resolve('');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.warn('[video] ffmpeg 执行错误:', err.message);
      resolve('');
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
