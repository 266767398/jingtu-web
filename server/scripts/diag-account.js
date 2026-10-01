// 临时诊断账号：用完必须删除（scripts/diag-account.js --remove --yes）
// 安全守卫：TTY 交互确认 / 非 TTY 须显式 --yes；--remove 级联失败输出明细；不打印 login_id 清单
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const LOGIN = '__diag';
const PASS = 'Diag#2026x';

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve((d || '').toString().trim()));
  });
}

async function confirmGuard() {
  if (process.argv.includes('--yes')) return;
  const isTTY = Boolean(process.stdin && process.stdin.isTTY);
  if (!isTTY) {
    console.error('✗ 非交互环境（管道）执行本脚本必须显式加 --yes');
    process.exit(1);
  }
  const act = process.argv.includes('--remove') ? '删除临时诊断账号' : '创建/重置临时诊断账号（super_admin）';
  const ans = await ask(`⚠️ 将执行「${act}」（${LOGIN}），确认？[y/N] `);
  if (ans.toLowerCase() !== 'y') { console.log('已取消。'); process.exit(0); }
}

(async () => {
  await confirmGuard();
  const c = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });

  if (process.argv.includes('--remove')) {
    const [rows] = await c.execute('SELECT id FROM users WHERE login_id = ?', [LOGIN]);
    if (rows.length) {
      const id = rows[0].id;
      const [refs] = await c.query(
        `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = 'users'`,
        [process.env.MYSQL_DATABASE]
      );
      const failed = [];
      for (const t of refs) {
        try { await c.query(`DELETE FROM \`${t.TABLE_NAME}\` WHERE \`${t.COLUMN_NAME}\` = ?`, [id]); }
        catch (e) { failed.push(`${t.TABLE_NAME}.${t.COLUMN_NAME}: ${e.message}`); }
      }
      await c.execute('DELETE FROM users WHERE id = ?', [id]);
      console.log('已删除临时账号 ' + LOGIN);
      if (failed.length) console.warn('级联删除失败 ' + failed.length + ' 处（需人工核查）：\n' + failed.join('\n'));
    } else console.log('临时账号不存在');
    const [all] = await c.execute('SELECT id, login_id FROM users');
    console.log('剩余用户数: ' + all.length);
    await c.end();
    return;
  }

  const hash = await bcrypt.hash(PASS, 10);
  const [ex] = await c.execute('SELECT id FROM users WHERE login_id = ?', [LOGIN]);
  if (ex.length) {
    await c.execute('UPDATE users SET password_hash=?, role=?, approved=1, banned=0, failed_login_attempts=0, locked_until=NULL WHERE id=?',
      [hash, 'super_admin', ex[0].id]);
    console.log('已重置临时账号');
  } else {
    await c.execute(
      'INSERT INTO users (login_id, display_name, password_hash, role, approved, banned) VALUES (?,?,?,?,1,0)',
      [LOGIN, '诊断账号', hash, 'super_admin']
    );
    console.log('已创建临时账号');
  }
  console.log(`  ${LOGIN} / ${PASS}`);
  await c.end();
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
