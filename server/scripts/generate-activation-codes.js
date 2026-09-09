#!/usr/bin/env node
/**
 * 境途同游 — 离线激活码生成工具（完全离线：不连数据库、不需要网站运行、不联网）
 *
 * 用法：
 *   node server/scripts/generate-activation-codes.js [数量] [--note "备注"] [--out 文件.txt] [--file <路径>]
 *
 * 示例：
 *   node server/scripts/generate-activation-codes.js 10
 *   node server/scripts/generate-activation-codes.js 5 --note "内测批次" --out codes.txt
 *
 * 产出写入 server/data/activation-codes.json（与网站后台共用同一文件与文件锁），
 * 把该文件随 P2P 软件分发或放到网站 server/data/ 目录即可供注册消耗。
 * 用 --file 可指定生成到任意路径的激活码文件。
 */
const fs = require('fs');
const path = require('path');
const { generateCodes, getCodeFilePath, setFilePath } = require('../activation_code_service');

function parseArgs(argv) {
  const opts = { count: 1, note: '', out: '', file: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--note' || a === '-n') {
      opts.note = argv[++i] || '';
    } else if (a === '--out' || a === '-o') {
      opts.out = argv[++i] || '';
    } else if (a === '--file') {
      opts.file = argv[++i] || '';
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      const n = parseInt(a, 10);
      if (!isNaN(n) && n > 0) opts.count = n;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.file) setFilePath(opts.file);
  if (opts.help || opts.count < 1) {
    console.log('用法: node server/scripts/generate-activation-codes.js [数量] [--note "备注"] [--out 文件.txt] [--file <路径>]');
    process.exit(0);
  }
  if (opts.count > 200) {
    console.error('单次最多生成 200 个激活码');
    process.exit(1);
  }
  const created = await generateCodes(opts.count, 'offline-cli', opts.note);
  console.log(`已生成 ${created.length} 个激活码`);
  console.log(`存储文件: ${getCodeFilePath()}`);
  console.log('-'.repeat(36));
  created.forEach((c, i) => {
    console.log(`${String(i + 1).padStart(3)}) ${c.code}${c.note ? '   # ' + c.note : ''}`);
  });
  if (opts.out) {
    const outPath = path.resolve(opts.out);
    fs.writeFileSync(outPath, created.map(c => c.code).join('\r\n') + '\r\n', 'utf8');
    console.log('-'.repeat(36));
    console.log(`激活码已另存至: ${outPath}`);
  }
  console.log('提示: 未使用的激活码可随时用于注册；已使用的激活码永久作废。');
}

main().catch(e => {
  console.error('生成失败:', e.message);
  process.exit(1);
});
