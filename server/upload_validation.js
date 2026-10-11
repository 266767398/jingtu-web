/**
 * 境途同游 — 上传文件校验（M7：自 middleware/security.js 下沉，解除 utils↔security 延迟 require 环）。
 * 本模块刻意零依赖（仅内置 fs）：utils.js 顶层直接 require 也不会产生任何模块加载期循环。
 * middleware/security.js 从这里 re-export 三个符号，保持对外接口不变。
 */
const fs = require('fs');

const FILE_SIGNATURES = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png': [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'video/mp4': [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  'video/quicktime': [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  'audio/mp4': [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  'video/webm': [0x1A, 0x45, 0xDF, 0xA3],
  'video/x-matroska': [0x1A, 0x45, 0xDF, 0xA3],
  'video/ogg': [0x4F, 0x67, 0x67, 0x53],
  'audio/wav': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x41, 0x56, 0x45],
  'video/x-msvideo': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x41, 0x56, 0x49, 0x20]
};

const DANGEROUS_EXTENSIONS = ['exe', 'bat', 'sh', 'cmd', 'com', 'scr', 'pif', 'msi', 'dll', 'sys', 'ps1', 'jar', 'php', 'py', 'pl', 'rb', 'asp', 'aspx', 'jsp', 'jspx', 'html', 'htm', 'js', 'vbs', 'hta', 'wsf', 'cpl', 'lnk', 'url', 'hta'];

const SAFE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'ogg', 'mp3', 'wav', 'm4a', 'pdf', 'zip', 'rar', '7z', 'txt', 'json'];

function verifyFileSignature(filePath, mimeType) {
  const expected = FILE_SIGNATURES[mimeType];
  if (!expected) return true;

  // 按签名长度读取头部字节（最长 RIFF 子格式需 12 字节），避免整文件读入内存。
  const len = expected.length;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, 0);
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  for (let i = 0; i < len; i++) {
    if (expected[i] === null) continue;
    if (buf[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

function isSafeFile(filename) {
  if (!filename) return false;
  const ext = filename.split('.').pop().toLowerCase();
  return SAFE_EXTENSIONS.includes(ext) && !DANGEROUS_EXTENSIONS.includes(ext);
}

async function validateUploadFile(file, maxSize = 200 * 1024 * 1024) {
  const errors = [];

  if (!file) {
    errors.push('未选择文件');
    return { valid: false, errors };
  }

  if (file.size > maxSize) {
    errors.push(`文件大小超过限制（最大 ${maxSize / 1024 / 1024}MB）`);
    return { valid: false, errors };
  }

  if (!isSafeFile(file.originalname)) {
    errors.push('不支持的文件类型');
    return { valid: false, errors };
  }

  const ext = file.originalname.split('.').pop().toLowerCase();
  let expectedMimeType = '';

  if (['jpg', 'jpeg'].includes(ext)) expectedMimeType = 'image/jpeg';
  else if (ext === 'png') expectedMimeType = 'image/png';
  else if (ext === 'gif') expectedMimeType = 'image/gif';
  else if (ext === 'webp') expectedMimeType = 'image/webp';
  else if (ext === 'mp4') expectedMimeType = 'video/mp4';
  else if (ext === 'mov') expectedMimeType = 'video/quicktime';
  else if (ext === 'm4a') expectedMimeType = 'audio/mp4';
  else if (ext === 'webm') expectedMimeType = 'video/webm';
  else if (ext === 'mkv') expectedMimeType = 'video/x-matroska';
  else if (ext === 'avi') expectedMimeType = 'video/x-msvideo';
  else if (ext === 'ogg') expectedMimeType = 'video/ogg';
  else if (ext === 'wav') expectedMimeType = 'audio/wav';
  // mp3 不设魔数闸：文件可能以 ID3 标签或裸帧同步字（0xFF Ex/Fx）开头，单一签名会误杀合法音频

  if (expectedMimeType && !verifyFileSignature(file.path, expectedMimeType)) {
    errors.push('文件内容与扩展名不匹配');
    return { valid: false, errors };
  }

  return { valid: true, errors };
}

module.exports = {
  validateUploadFile,
  verifyFileSignature,
  isSafeFile,
  FILE_SIGNATURES,
  DANGEROUS_EXTENSIONS,
  SAFE_EXTENSIONS
};
