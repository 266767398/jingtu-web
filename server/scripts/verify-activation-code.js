#!/usr/bin/env node
/**
 * 境途同游 — 离线激活码校验工具（完全离线：只读本地激活码文件，不连数据库、不需要网站运行、不联网）
 *
 * 用法：
 *   node server/scripts/verify-activation-code.js <激活码> [激活码2 ...] [--json] [--file <路径>]
 *
 * 示例：
 *   node server/scripts/verify-activation-code.js JT-AB2D-E3FG-H5JK
 *   node server/scripts/verify-activation-code.js JT-AB2D-E3FG-H5JK JT-ZZ99-ZZ99-ZZ99 --json
 *
 * 退出码：
 *   0 = 全部可用（存在且未使用、未作废）
 *   1 = 存在无效码（格式错误或不存在）
 *   2 = 存在已用码（没有更严重的无效码时）
 *   4 = 存在已作废码（没有更严重的无效码时）
 *
 * --json 输出机器可读结果数组，供 P2P 安装脚本解析。
 */
const { checkCode, getCodeFilePath, setFilePath } = require('../activation_code_service');

function parseArgs(argv) {
  const opts = { codes: [], json: false, help: false, file: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--file') opts.file = argv[++i] || '';
    else opts.codes.push(a);
  }
  return opts;
}

function statusLabel(r) {
  if (r.reason === 'INVALID_FORMAT') return '无效（格式错误）';
  if (r.reason === 'NOT_FOUND') return '无效（不存在）';
  if (r.reason === 'ALREADY_USED') return `已使用（${r.used_by || '未知'}，${r.used_at || '未知时间'}）`;
  if (r.reason === 'REVOKED') return `已作废（${r.revoked_by || '未知'}，${r.revoked_at || '未知时间'}）`;
  return '可用';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.file) setFilePath(opts.file);
  if (opts.help || opts.codes.length === 0) {
    console.log('用法: node server/scripts/verify-activation-code.js <激活码> [激活码2 ...] [--json] [--file <路径>]');
    process.exit(0);
  }
  const results = [];
  for (const raw of opts.codes) {
    const r = await checkCode(raw);
    r.input = raw;
    results.push(r);
  }
  if (opts.json) {
    console.log(JSON.stringify({
      file: getCodeFilePath(),
      results: results.map(r => ({
        input: r.input, code: r.code, valid: !!r.valid,
        reason: r.reason || null, used: !!r.used,
        used_by: r.used_by || null, used_at: r.used_at || null,
        revoked: !!r.revoked,
        revoked_by: r.revoked_by || null, revoked_at: r.revoked_at || null
      })),
      all_valid: results.every(r => r.valid)
    }, null, 2));
  } else {
    console.log(`存储文件: ${getCodeFilePath()}`);
    console.log('-'.repeat(36));
    results.forEach(r => console.log(`${r.code || r.input}  =>  ${statusLabel(r)}`));
    console.log('-'.repeat(36));
    if (results.every(r => r.valid)) console.log('结论: 全部可用');
    else if (results.some(r => r.reason === 'INVALID_FORMAT' || r.reason === 'NOT_FOUND')) console.log('结论: 存在无效激活码');
    else if (results.some(r => r.reason === 'REVOKED')) console.log('结论: 存在已作废的激活码');
    else console.log('结论: 存在已使用的激活码');
  }
  const hasInvalid = results.some(r => r.reason === 'INVALID_FORMAT' || r.reason === 'NOT_FOUND');
  const hasUsed = results.some(r => r.reason === 'ALREADY_USED');
  const hasRevoked = results.some(r => r.reason === 'REVOKED');
  process.exit(hasInvalid ? 1 : hasUsed ? 2 : hasRevoked ? 4 : 0);
}

main().catch(e => {
  console.error('校验失败:', e.message);
  process.exit(1);
});
