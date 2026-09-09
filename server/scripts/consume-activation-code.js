#!/usr/bin/env node
/**
 * 境途同游 — 离线激活码消耗工具（完全离线：直接读写本地激活码文件，不连数据库、不需要网站运行、不联网）
 *
 * 用法：
 *   node server/scripts/consume-activation-code.js <激活码> <使用者标识> [--json] [--file <路径>]
 *
 * 示例：
 *   node server/scripts/consume-activation-code.js JT-AB2D-E3FG-H5JK p2p-client-001
 *
 * 语义：与网站注册消耗同一文件、同一把锁——校验存在且未使用、未作废后，原子标记
 *       used=true / used_by / used_at 并写回磁盘，激活码永久作废。
 *
 * 退出码：
 *   0 = 消耗成功
 *   1 = 无效（格式错误或不存在）
 *   2 = 已被使用
 *   3 = 写入失败 / 锁超时
 *   4 = 已被作废
 */
const { validateAndConsume, setFilePath } = require('../activation_code_service');

function parseArgs(argv) {
  const opts = { code: '', user: '', json: false, help: false, file: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--file') opts.file = argv[++i] || '';
    else positional.push(a);
  }
  opts.code = positional[0] || '';
  opts.user = positional[1] || '';
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.file) setFilePath(opts.file);
  if (opts.help || !opts.code || !opts.user) {
    console.log('用法: node server/scripts/consume-activation-code.js <激活码> <使用者标识> [--json] [--file <路径>]');
    process.exit(opts.help ? 0 : 1);
  }
  const result = await validateAndConsume(opts.code, opts.user);
  const out = (payload) => console.log(opts.json ? JSON.stringify(payload, null, 2) : payload.message);
  if (result.ok) {
    out({ ok: true, code: result.code, used_by: opts.user, used_at: result.entry.used_at, message: `消耗成功: ${result.code} → ${opts.user}` });
    process.exit(0);
  }
  if (result.reason === 'ALREADY_USED') {
    out({ ok: false, reason: 'ALREADY_USED', code: opts.code, used_by: result.used_by, used_at: result.used_at, message: `该激活码已被使用（${result.used_by || '未知'}，${result.used_at || '未知时间'}）` });
    process.exit(2);
  }
  if (result.reason === 'REVOKED') {
    out({ ok: false, reason: 'REVOKED', code: opts.code, revoked_by: result.revoked_by, revoked_at: result.revoked_at, message: `该激活码已被作废（${result.revoked_by || '未知'}，${result.revoked_at || '未知时间'}）` });
    process.exit(4);
  }
  if (result.reason === 'WRITE_FAILED') {
    out({ ok: false, reason: 'WRITE_FAILED', code: opts.code, message: '写入失败，激活码未消耗，可重试', detail: String(result.error && result.error.message || result.error || '') });
    process.exit(3);
  }
  out({ ok: false, reason: result.reason, code: opts.code, message: result.reason === 'INVALID_FORMAT' ? '激活码格式不正确' : '激活码不存在' });
  process.exit(1);
}

main().catch(e => {
  console.error('消耗失败:', e.message);
  process.exit(3);
});
