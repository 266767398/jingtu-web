#!/usr/bin/env node
/**
 * 境途同游 — 离线激活码作废工具（完全离线：直接读写本地激活码文件，不连数据库、不需要网站运行、不联网）
 *
 * 用法：
 *   node server/scripts/revoke-activation-code.js <激活码> <操作者> [--reason "原因"] [--json] [--file <路径>]
 *
 * 示例：
 *   node server/scripts/revoke-activation-code.js JT-AB2D-E3FG-H5JK admin
 *   node server/scripts/revoke-activation-code.js JT-AB2D-E3FG-H5JK admin --reason "渠道泄露"
 *
 * 语义：标记 revoked=true / revoked_by / revoked_at / revoked_reason 并写回磁盘。
 *       已作废的激活码不能用于注册消耗；已使用的码无法再作废（保留使用记录）。
 *
 * 退出码：
 *   0 = 作废成功
 *   1 = 无效（格式错误或不存在）
 *   2 = 已被使用（无法作废，使用记录保留）
 *   3 = 写入失败 / 锁超时
 *   4 = 已被作废（重复作废）
 */
const { revokeCode, setFilePath } = require('../activation_code_service');

function parseArgs(argv) {
  const opts = { code: '', operator: '', reason: '', json: false, file: '', help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reason' || a === '-r') opts.reason = argv[++i] || '';
    else if (a === '--json') opts.json = true;
    else if (a === '--file') opts.file = argv[++i] || '';
    else if (a === '--help' || a === '-h') opts.help = true;
    else positional.push(a);
  }
  opts.code = positional[0] || '';
  opts.operator = positional[1] || '';
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.file) setFilePath(opts.file);
  if (opts.help || !opts.code || !opts.operator) {
    console.log('用法: node server/scripts/revoke-activation-code.js <激活码> <操作者> [--reason "原因"] [--json] [--file <路径>]');
    process.exit(opts.help ? 0 : 1);
  }
  const result = await revokeCode(opts.code, opts.operator, opts.reason);
  const out = (payload) => console.log(opts.json ? JSON.stringify(payload, null, 2) : payload.message);
  if (result.ok) {
    out({
      ok: true, code: result.entry.code, revoked_by: opts.operator, revoked_at: result.entry.revoked_at,
      message: `作废成功: ${result.entry.code}（操作者 ${opts.operator}${opts.reason ? '，原因: ' + opts.reason : ''}）`
    });
    process.exit(0);
  }
  if (result.reason === 'ALREADY_USED') {
    out({ ok: false, reason: 'ALREADY_USED', code: opts.code, used_by: result.used_by, used_at: result.used_at, message: `该激活码已被使用（${result.used_by || '未知'}，${result.used_at || '未知时间'}），无法作废，使用记录保留` });
    process.exit(2);
  }
  if (result.reason === 'ALREADY_REVOKED') {
    out({ ok: false, reason: 'ALREADY_REVOKED', code: opts.code, revoked_by: result.revoked_by, revoked_at: result.revoked_at, message: `该激活码已被作废（${result.revoked_by || '未知'}，${result.revoked_at || '未知时间'}），无需重复操作` });
    process.exit(4);
  }
  if (result.reason === 'WRITE_FAILED') {
    out({ ok: false, reason: 'WRITE_FAILED', code: opts.code, message: '写入失败，激活码未作废，可重试', detail: String(result.error && result.error.message || result.error || '') });
    process.exit(3);
  }
  out({ ok: false, reason: result.reason, code: opts.code, message: result.reason === 'INVALID_FORMAT' ? '激活码格式不正确' : '激活码不存在' });
  process.exit(1);
}

main().catch(e => {
  console.error('作废失败:', e.message);
  process.exit(3);
});
