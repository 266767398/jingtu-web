/**
 * 高德（AMap）瓦片批量下载脚本
 *
 * 用途：为地图的「本地离线底图」提供瓦片数据。下载产物写入固定导入路径
 *   public/map-tiles/{z}/{x}/{y}.png
 * 之后无需改任何代码，手动向该目录追加 / 更新瓦片即可（与 Leaflet 的
 * {z}/{x}/{y} 命名规则一致，map.js 会优先使用本地瓦片）。
 *
 * 用法：
 *   node scripts/download-tiles.js                # 默认 z0~z7，z>=6 仅中国区域
 *   node scripts/download-tiles.js --max-zoom 9   # 提升最高层级（z8~z9 中国区域）
 *   node scripts/download-tiles.js --global-all   # z>=6 也下载全球（瓦片量大，慎用）
 *   node scripts/download-tiles.js --max-zoom 2   # 快速连通性测试
 *   node scripts/download-tiles.js --dry-run      # 只统计不下载
 *
 * 参数：
 *   --max-zoom N      最高缩放层级（默认 7）
 *   --concurrency N   并发数（默认 12）
 *   --dir <path>      输出目录（默认 <项目>/public/map-tiles）
 *   --global-all      所有层级均下载全球范围（默认 z<=5 全球，z>=6 中国区域）
 *   --dry-run         只统计不下载
 *
 * 中国区域经纬度范围（Web Mercator）：lon 73~135，lat 18~54
 * 瓦片服务：webrd0{s}.is.autonavi.com/appmaptile（style=7 标准矢量，与 map.js 一致）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------- 参数解析 ----------
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return (i >= 0 && args[i + 1] !== undefined) ? args[i + 1] : def;
}
const MAX_ZOOM = parseInt(argVal('--max-zoom', '7'), 10) || 7;
const CONCURRENCY = Math.min(32, Math.max(1, parseInt(argVal('--concurrency', '12'), 10) || 12));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(argVal('--dir', path.join(ROOT, 'public', 'map-tiles')));
const GLOBAL_ALL = args.includes('--global-all');
const DRY_RUN = args.includes('--dry-run');

const CHINA = { lonMin: 73, lonMax: 135, latMin: 18, latMax: 54 };
const MIN_ZOOM = 0;
const HOSTS = [
  'webrd01.is.autonavi.com',
  'webrd02.is.autonavi.com',
  'webrd03.is.autonavi.com',
  'webrd04.is.autonavi.com'
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- 坐标换算 ----------
function lonToX(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
function latToY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
}

// ---------- 生成瓦片坐标清单 ----------
const tiles = [];
for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
  const n = Math.pow(2, z);
  if (z <= 5 || GLOBAL_ALL) {
    // z<=5 全球仅 1365 张，全量下载保证任何区域都有底
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) tiles.push({ z: z, x: x, y: y });
    }
  } else {
    // 中国区域（带 1 瓦片边距，避免国境线附近裁切缺块）
    const x0 = Math.max(0, lonToX(CHINA.lonMin, z) - 1);
    const x1 = Math.min(n - 1, lonToX(CHINA.lonMax, z) + 1);
    const y0 = Math.max(0, latToY(CHINA.latMax, z) - 1);
    const y1 = Math.min(n - 1, latToY(CHINA.latMin, z) + 1);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) tiles.push({ z: z, x: x, y: y });
    }
  }
}

// ---------- 下载单个瓦片 ----------
function urlFor(t) {
  const host = HOSTS[(t.x + t.y + t.z) % HOSTS.length];
  return 'https://' + host + '/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x=' + t.x + '&y=' + t.y + '&z=' + t.z;
}

function isPng(buf) {
  return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function download(tile) {
  return new Promise((resolve, reject) => {
    const dir = path.join(OUT_DIR, String(tile.z), String(tile.x));
    const file = path.join(dir, tile.y + '.png');
    // 幂等续传：已存在且非空则跳过
    try {
      if (fs.statSync(file).size > 0) return resolve({ tile: tile, skipped: true });
    } catch (e) { /* 不存在，正常下载 */ }
    const req = https.get(urlFor(tile), {
      headers: {
        'User-Agent': UA,
        Referer: 'https://ditu.amap.com/',
        Accept: 'image/webp,image/*,*/*;q=0.8'
      },
      timeout: 12000
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const buf = Buffer.concat(chunks);
        if (!isPng(buf)) return reject(new Error('NOT-PNG')); // 高德可能返回错误 JSON / 重定向页
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buf);
        resolve({ tile: tile, skipped: false });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('TIMEOUT')); });
    req.on('error', reject);
  });
}

// ---------- 并发调度 ----------
async function run() {
  console.log('[tiles] 高德离线瓦片下载');
  console.log('[tiles] 范围: z' + MIN_ZOOM + '~z' + MAX_ZOOM + (MAX_ZOOM >= 6 && !GLOBAL_ALL ? '（z>=6 仅中国区域）' : '（全球）'));
  console.log('[tiles] 输出: ' + OUT_DIR);
  console.log('[tiles] 瓦片总数: ' + tiles.length + '，并发: ' + CONCURRENCY + (DRY_RUN ? '（DRY-RUN，仅统计）' : ''));
  if (DRY_RUN) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let done = 0, ok = 0, skip = 0, fail = 0;
  const failed = [];
  const queue = tiles.slice();

  async function worker() {
    while (queue.length) {
      const tile = queue.shift();
      if (!tile) break;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await download(tile);
          if (r.skipped) skip++; else ok++;
          break;
        } catch (e) {
          if (attempt === 2) {
            fail++; failed.push(tile);
          } else {
            await new Promise(function (r) { setTimeout(r, 500 * (attempt + 1)); });
          }
        }
      }
      done++;
      if (done % 200 === 0 || done === tiles.length) {
        const pct = (done / tiles.length * 100).toFixed(1);
        console.log('[tiles] ' + done + '/' + tiles.length + ' (' + pct + '%) 成功=' + ok + ' 跳过=' + skip + ' 失败=' + fail);
      }
    }
  }
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  console.log('========================================');
  console.log('[tiles] 完成: 共 ' + tiles.length + '，新下载 ' + ok + '，已存在跳过 ' + skip + '，失败 ' + fail);
  if (fail) {
    console.log('[tiles] 失败样例: ' + failed.slice(0, 10).map(function (t) { return 'z' + t.z + '/' + t.x + '/' + t.y; }).join(', '));
    console.log('[tiles] 重新运行本脚本可自动续传未完成瓦片（幂等）');
  }
}

run().catch(function (e) { console.error('[tiles] 异常: ' + e.message); process.exit(1); });
