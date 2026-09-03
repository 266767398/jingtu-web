const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const adminVrcJs = fs.readFileSync(
  path.join(ROOT, 'public', 'js', 'admin-vrc.js'),
  'utf8'
);

describe('改名审核入口', () => {
  test('事件委托覆盖整个管理页并在脚本加载时初始化', () => {
    expect(adminVrcJs).toMatch(
      /function\s+initVrcEventDelegates\(\)[\s\S]*getElementById\('tab-admin'\)/
    );
    expect(adminVrcJs).toMatch(/\ninitVrcEventDelegates\(\);\s*$/);
  });

  test('待审核列表使用接口返回的字段名', () => {
    for (const field of ['displayName', 'createTime', 'oldName', 'newName']) {
      expect(adminVrcJs).toContain(`r.${field}`);
    }
    for (const staleField of ['userName', 'createdAt', 'currentName', 'requestedName']) {
      expect(adminVrcJs).not.toContain(`r.${staleField}`);
    }
  });
});
