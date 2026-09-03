const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

async function compressImage(filePath, maxWidth = 1920, maxHeight = 1080, quality = 80) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      return { success: true, message: '不支持的格式，跳过压缩' };
    }

    const info = await sharp(filePath).metadata();
    if (!info.width || !info.height) {
      return { success: true, message: '无法读取图片信息，跳过压缩' };
    }

    // 防解压炸弹：限制像素总数（5000万像素上限）
    if (info.width * info.height > 50000000) {
      return { success: false, message: '图片尺寸过大（超过 5000 万像素），拒绝压缩以防止 OOM' };
    }

    let width = info.width;
    let height = info.height;

    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    const originalSize = fs.statSync(filePath).size;

    let outputBuffer;
    if (ext === '.webp') {
      // webp 单独走 .webp()，避免静默转 jpeg 导致透明度丢失
      outputBuffer = await sharp(filePath)
        .resize(width, height, { fit: 'inside' })
        .webp({ quality })
        .toBuffer();
    } else if (ext === '.png') {
      // PNG quality 期望 0-100，原代码 quality/100 传成 0.8 为错误用法
      outputBuffer = await sharp(filePath)
        .resize(width, height, { fit: 'inside' })
        .png({ quality })
        .toBuffer();
    } else {
      outputBuffer = await sharp(filePath)
        .resize(width, height, { fit: 'inside' })
        .jpeg({ quality })
        .toBuffer();
    }

    fs.writeFileSync(filePath, outputBuffer);
    const newSize = fs.statSync(filePath).size;
    const savedPercent = ((1 - newSize / originalSize) * 100).toFixed(1);

    return {
      success: true,
      message: `压缩完成: ${(originalSize / 1024).toFixed(1)}KB → ${(newSize / 1024).toFixed(1)}KB (节省${savedPercent}%)`,
      savedPercent: parseFloat(savedPercent),
      originalSize,
      newSize
    };
  } catch (e) {
    return { success: false, message: `压缩失败: ${e.message}` };
  }
}

function createCompressMiddleware(options = {}) {
  const { maxWidth = 1920, maxHeight = 1080, quality = 80 } = options;

  return async function(req, res, next) {
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        if (file.path) {
          const result = await compressImage(file.path, maxWidth, maxHeight, quality);
          if (!result.success) {
            console.error('[image-compress]', result.message);
          }
        }
      }
    }
    next();
  };
}

module.exports = { compressImage, createCompressMiddleware };
