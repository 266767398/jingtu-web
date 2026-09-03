#!/usr/bin/env node
/**
 * 破窗恢复脚本：重置/创建超级管理员账号
 * ----------------------------------------------------------------
 * 用途：当网站异常、超级管理员无法登录时，在服务器终端直接修复账号，
 *       无需经过 Web 登录。仅依赖 .env 中的数据库配置与 bcryptjs。
 *
 * 用法（在项目根目录执行）：
 *   node server/scripts/reset-superadmin.js                # 交互模式：列出超管并选择重置
 *   node server/scripts/reset-superadmin.js --login admin  # 重置指定 login_id 的超管
 *   node server/scripts/reset-superadmin.js --pass "xxx"   # 用指定密码重置（非交互）
 *   node server/scripts/reset-superadmin.js --create       # 若无超管则创建 login_id=super_admin
 *
 * 安全提示：本脚本无鉴权（设计如此，破窗用途）。仅服务器本地/SSH 可信环境使用；
 *          跑完后请提醒运维用新密码登录并立即修改。
 */
'use strict';
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const ROUNDS = 12;

function parseArgs(argv) {
  const a = { login: null, pass: null, create: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--login') a.login = argv[++i];
    else if (argv[i] === '--pass') a.pass = argv[++i];
    else if (argv[i] === '--create') a.create = true;
  }
  return a;
}

function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789#@%&';
  const bytes = crypto.randomBytes(18);
  let s = '';
  for (let i = 0; i < 18; i++) s += chars[bytes[i] % chars.length];
  return s;
}

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve((d || '').toString().trim()));
  });
}

async function main() {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
    console.error('✗ 未找到完整数据库配置，请确认项目根目录 .env 已正确填写 MYSQL_*');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });

  try {
    const [supers] = await conn.execute(
      `SELECT id, login_id, display_name, email FROM users WHERE role='super_admin' AND deleted_at IS NULL ORDER BY id ASC`
    );

    const args = parseArgs(process.argv);
    let target = null;
    let tempPass = args.pass || genPassword();

    if (args.login) {
      const hit = supers.find((u) => u.login_id === args.login);
      if (!hit) {
        console.error(`✗ 未找到 login_id="${args.login}" 的超级管理员`);
        await conn.end();
        process.exit(1);
      }
      target = hit;
    } else if (supers.length === 0) {
      if (!args.create) {
        const go = await ask('未发现任何超级管理员，是否立即创建一个（login_id=super_admin）？[y/N] ');
        if (go.toLowerCase() !== 'y') { console.log('已取消。'); await conn.end(); process.exit(0); }
      }
      // 创建
      const hash = await bcrypt.hash(tempPass, ROUNDS);
      await conn.execute(
        `INSERT INTO users (login_id, display_name, password_hash, role, approved, banned, email)
         VALUES (?, ?, ?, 'super_admin', 1, 0, ?)`,
        ['super_admin', '超级管理员', hash, process.env.ADMIN_EMAIL || null]
      );
      console.log('');
      console.log('══════════════════════════════════════════════════════════');
      console.log('✓ 已创建超级管理员');
      console.log(`  登录名 : super_admin`);
      console.log(`  临时密码: ${tempPass}`);
      console.log('  登录后请立即在「个人设置」中修改密码！');
      console.log('══════════════════════════════════════════════════════════');
      await conn.end();
      process.exit(0);
    } else if (supers.length === 1) {
      target = supers[0];
    } else {
      console.log('发现多个超级管理员：');
      supers.forEach((u, i) => console.log(`  [${i + 1}] ${u.login_id}  (${u.display_name || ''})`));
      const pick = await ask('请输入要重置的编号或 login_id（留空=全部）：');
      if (!pick) {
        // 全部重置为同一临时密码
        const hash = await bcrypt.hash(tempPass, ROUNDS);
        for (const u of supers) {
          await conn.execute(
            `UPDATE users SET password_hash=?, approved=1, banned=0, failed_login_attempts=0, locked_until=NULL, role='super_admin' WHERE id=?`,
            [hash, u.id]
          );
        }
        console.log('');
        console.log('══════════════════════════════════════════════════════════');
        console.log(`✓ 已重置全部 ${supers.length} 个超级管理员`);
        console.log(`  临时密码: ${tempPass}`);
        console.log('  登录后请立即修改密码！');
        console.log('══════════════════════════════════════════════════════════');
        await conn.end();
        process.exit(0);
      }
      const byNum = supers[parseInt(pick, 10) - 1];
      const byId = supers.find((u) => u.login_id === pick);
      target = byNum || byId;
      if (!target) { console.error('✗ 无效选择'); await conn.end(); process.exit(1); }
    }

    const hash = await bcrypt.hash(tempPass, ROUNDS);
    await conn.execute(
      `UPDATE users SET password_hash=?, approved=1, banned=0, failed_login_attempts=0, locked_until=NULL, role='super_admin' WHERE id=?`,
      [hash, target.id]
    );
    console.log('');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`✓ 已重置超级管理员：${target.login_id}  (${target.display_name || ''})`);
    console.log(`  临时密码: ${tempPass}`);
    console.log('  登录后请立即在「个人设置」中修改密码！');
    console.log('══════════════════════════════════════════════════════════');
    await conn.end();
    process.exit(0);
  } catch (e) {
    console.error('✗ 重置失败：' + e.message);
    try { await conn.end(); } catch {}
    process.exit(1);
  }
}

main();
