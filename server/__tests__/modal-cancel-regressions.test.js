const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const coreJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'core.js'), 'utf8');
const vrcJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'vrc.js'), 'utf8');

describe('弹窗取消按钮', () => {
  test('普通表单弹窗使用统一关闭声明且不会提交表单', () => {
    const document = new JSDOM(html).window.document;
    const modalIds = [
      'announceModal',
      'eventModal',
      'addUserModal',
      'editUserModal',
      'resetPwdModal',
      'birthdayEventModal',
      'nameChangeModal',
      'editEventModal',
      'createPermGroupModal',
      'editPermGroupModal',
      'editProfileModal',
      'albumModal'
    ];

    for (const modalId of modalIds) {
      const button = document.querySelector(
        `#${modalId} [data-modal-close="${modalId}"]`
      );
      expect(button).not.toBeNull();
      expect(button.type).toBe('button');
    }
  });

  test('统一关闭事件通过委托支持动态内容', () => {
    expect(coreJs).toMatch(
      /document\.addEventListener\('click',[\s\S]*closest\('\[data-modal-close\]'\)[\s\S]*closeModal\(button\.dataset\.modalClose\)/
    );
  });

  test('closeModal 同步隐藏，不能依赖可能被节流的定时器', () => {
    const start = coreJs.indexOf('function closeModal');
    const end = coreJs.indexOf('function initModalCloseActions', start);
    const block = coreJs.slice(start, end);

    expect(block).toContain("modal.style.display = 'none'");
    expect(block).not.toContain('setTimeout');
    expect(block).toContain('showModal(returnToModalId)');
  });

  test('嵌套 World 搜索按实际显示状态识别父弹窗', () => {
    const start = vrcJs.indexOf('function openWorldSearch');
    const end = vrcJs.indexOf('function clearWorld', start);
    const block = vrcJs.slice(start, end);

    expect(block).toContain("getComputedStyle(candidate).display !== 'none'");
    expect(block).not.toContain("querySelectorAll('.modal.show')");
  });
});
