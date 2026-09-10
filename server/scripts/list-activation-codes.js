#!/usr/bin/env node
/**
 * 境途同游 — 离线激活码清单工具（完全离线：只读本地激活码文件，不连数据库、不需要网站运行、不联网）
 *
 * 用法：
 *   node server/scripts/list-activation-codes.js [--status all|unused|used|revoked|expired] [--json] [--out 文件.txt] [--file <路径>]
 *
 * 示例：
 *   node server/scripts/list-activation-codes.js
 *   node server/scripts/list-activation-codes.js --status unused --out unused.txt
 *   node server/scripts/list-activation-codes.js --status expired
 *   node server/scripts/list-activation-codes.js --json
 *
 * 退出码：
 *   0 = 读取成功（无论清单是否为空）
 *   1 = 读取失败（文件损坏 / 锁超时）
 */
const fs = require('fs');
const path = require('path');
const { listCodes, getCodeFilePath, setFilePath, isEntryExpired } = require('../activation_code_service');

function parseArgs(argv) {
  const opts = { status: 'all', json: false, out: '', file: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status' || a === '-s') opts.status = (argv[++i] || 'all').toLowerCase();
    else if (a === '--json') opts.json = true;
    else if (a === '--out' || a === '-o') opts.out = argv[++i] || '';
    else if (a === '--file') opts.file = argv[++i] || '';
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function matchStatus(c, status) {
  if (status === 'unused') return !c.used && !c.revoked;
  if (status === 'used') return !!c.used;
  if (status === 'revoked') return !!c.revoked;
  if (status === 'expired') return !c.used && !c.revoked && isEntryExpired(c);
  return true;
}

function statusLabel(c) {
  if (c.used) return `已使用 ← ${c.used_by || '未知'} @ ${c.used_at || '?'}`;
  if (c.revoked) return `已作废 ← ${c.revoked_by || '未知'} @ ${c.revoked_at || '?'}${c.revoked_reason ? '（' + c.revoked_reason + '）' : ''}`;
  if (isEntryExpired(c)) return `已过期（原有效期至 ${String(c.expires_at).replace('T', ' ').slice(0, 19)}）`;
  if (c.expires_at) return `未使用（有效期至 ${String(c.expires_at).replace('T', ' ').slice(0, 19)}）`;
  return '未使用（永久有效）';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.file) setFilePath(opts.file);
  if (opts.help || !['all', 'unused', 'used', 'revoked', 'expired'].includes(opts.status)) {
    console.log('用法: node server/scripts/list-activation-codes.js [--status all|unused|used|revoked|expired] [--json] [--out 文件.txt] [--file <路径>]');
    console.log('  --status expired   只列出已过期（未使用、未作废）的激活码');
    process.exit(0);
  }
  const data = await listCodes();
  const filtered = data.codes.filter(c => matchStatus(c, opts.status));
  if (opts.json) {
    console.log(JSON.stringify({
      file: getCodeFilePath(),
      summary: {
        total: data.total,
        used: data.used,
        unused: data.unused,
        revoked: data.codes.filter(c => c.revoked).length,
        expired: data.expired || 0,
        shown: filtered.length
      },
      codes: filtered
    }, null, 2));
  } else {
    console.log(`存储文件: ${getCodeFilePath()}`);
    console.log(`统计: 总计 ${data.total} | 未使用 ${data.unused} | 已使用 ${data.used} | 已作废 ${data.codes.filter(c => c.revoked).length} | 已过期 ${data.expired || 0}`);
    console.log(`筛选: ${opts.status}（${filtered.length} 条）`);
    console.log('-'.repeat(72));
    if (filtered.length === 0) {
      console.log('（无匹配记录）');
    } else {
      filtered.forEach((c, i) => {
        console.log(`${String(i + 1).padStart(3)}) ${c.code}  ${statusLabel(c)}${c.note ? '  # ' + c.note : ''}`);
      });
    }
  }
  if (opts.out) {
    const outPath = path.resolve(opts.out);
    fs.writeFileSync(outPath, filtered.map(c => c.code).join('\r\n') + (filtered.length ? '\r\n' : ''), 'utf8');
    if (!opts.json) console.log('-'.repeat(72));
    console.log(`已导出 ${filtered.length} 个激活码至: ${outPath}`);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('读取失败:', e.message);
  process.exit(1);
});
