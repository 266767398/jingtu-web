const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const script = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'reset-to-init.js'), 'utf8');

describe('初始化重置脚本', () => {
  test('会把旧 super_admin 降级而不是清空业务数据', () => {
    expect(script).toMatch(/UPDATE users SET role = 'member'/);
    expect(script).not.toMatch(/DELETE FROM users/);
  });

  test('不会删除 .env 与登录会话（自愈防线）', () => {
    expect(script).not.toMatch(/unlinkSync/);
    expect(script).toMatch(/\.env 与登录会话均不会被删除/);
  });
});
