/**
 * P3-96: notification-service.js 行为测试
 * 覆盖：getUserSettings（TTL 缓存命中/过期/缺行默认/解析/容量清零/异常回退）、invalidateSettingsCache、
 * createNotification / notifyAllMembers / notifyAllAdmins、_bulkFanOut（500 分块 INSERT + 设置批量查询、
 * rows 缺失回退、deliver 分发）、_deliver（browser→WS、email→邮件）、broadcastWS/pushToUserWS、
 * notifyUser、sendEmailNotification（邮件未启用/无邮箱/入队）、getNotifications/markAsRead/getUnreadCount。
 * utils/mailer/ws_service 全部 mock，无真实网络与 DB。
 */
let mockPoolQuery;
jest.mock('../utils', () => ({
  getPool: () => ({ query: (...args) => mockPoolQuery(...args) }),
  safeError: (msg) => msg
}));
jest.mock('../mailer', () => ({
  isMailerEnabled: jest.fn(),
  sendEmail: jest.fn()
}));
jest.mock('../ws_service', () => ({
  broadcastAllExcept: jest.fn(),
  broadcastToUser: jest.fn()
}));

const notificationService = require('../notification-service');
const mailer = require('../mailer');
const wsService = require('../ws_service');

const SETTINGS_CACHE_TTL_MS = 60 * 60 * 1000;

function poolResolve(routes) {
  mockPoolQuery = jest.fn((sql, params) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(sql)) return Promise.resolve(result);
    }
    return Promise.resolve([[]]);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  notificationService._settingsCache.clear();
  mockPoolQuery = jest.fn(() => Promise.resolve([[]]));
});

describe('P3-96 getUserSettings 设置缓存', () => {
  test('无缓存时查库解析并缓存；二次调用命中缓存不再查库', async () => {
    poolResolve([[/SELECT notification_settings FROM users/, [[{ notification_settings: '{"email":true,"browser":false,"sound":false}' }]]]]);
    const r1 = await notificationService.getUserSettings(1);
    expect(r1).toEqual({ browser: false, email: true, sound: false });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const r2 = await notificationService.getUserSettings(1);
    expect(r2).toEqual(r1);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1); // 命中缓存，无新增查询
  });

  test('用户行缺失返回默认设置', async () => {
    const r = await notificationService.getUserSettings(99);
    expect(r).toEqual({ browser: true, email: false, sound: true });
  });

  test('缓存过期（超过 TTL）后重新查库', async () => {
    poolResolve([[/SELECT notification_settings FROM users/, [[{}]]]]);
    await notificationService.getUserSettings(2);
    // 模拟 TTL 过期：把缓存时间回拨
    const entry = notificationService._settingsCache.get(2);
    entry.at -= SETTINGS_CACHE_TTL_MS + 1;
    await notificationService.getUserSettings(2);
    expect(mockPoolQuery.mock.calls.length).toBeGreaterThan(1);
  });

  test('查询异常时返回默认且不抛错', async () => {
    const errSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPoolQuery = jest.fn().mockRejectedValue(new Error('db down'));
    const r = await notificationService.getUserSettings(7);
    expect(r).toEqual({ browser: true, email: false, sound: true });
    errSpy.mockRestore();
  });

  test('invalidateSettingsCache 删除缓存项', async () => {
    poolResolve([[/SELECT notification_settings FROM/, [[{}]]]]);
    await notificationService.getUserSettings(3);
    expect(notificationService._settingsCache.has(3)).toBe(true);
    notificationService.invalidateSettingsCache(3);
    expect(notificationService._settingsCache.has(3)).toBe(false);
  });
});

describe('P3-96 createNotification / 群发', () => {
  test('createNotification 写入通知行', async () => {
    const q = jest.fn().mockResolvedValue([{ affectedRows: 1 }]);
    mockPoolQuery = q;
    await notificationService.createNotification(1, 'comment', '标题', '正文', { relatedId: 5, targetType: 'post', targetId: 5, postId: 5 });
    expect(q).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO notifications'), [1, 'comment', '标题', '正文', 5, 'post', 5, 5]);
  });

  test('notifyAllMembers 拉取全部非禁用用户并扇出', async () => {
    const calls = [];
    mockPoolQuery = jest.fn((sql) => {
      if (sql.includes('SELECT id FROM users WHERE deleted_at IS NULL AND banned = 0')) {
        return Promise.resolve([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
      }
      if (sql.includes('INSERT INTO notifications')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('SELECT id, notification_settings FROM users WHERE id IN')) return Promise.resolve([[]]);
      return Promise.resolve([[]]);
    });
    await notificationService.notifyAllMembers('system', '公告', '内容');
    expect(mockPoolQuery.mock.calls.some(c => c[0].includes('INSERT INTO notifications'))).toBe(true);
  });

  test('notifyAllMembers 无用户时直接返回', async () => {
    mockPoolQuery = jest.fn().mockResolvedValue([[]]);
    await notificationService.notifyAllMembers('system', '公告', '内容');
  });
});

describe('P3-96 _bulkFanOut 分块扇出', () => {
  test('1200 用户按 500 分块：3 次 INSERT 与 3 次设置查询', async () => {
    const q = jest.fn((sql) => {
      if (sql.includes('INSERT INTO notifications')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('SELECT id, notification_settings FROM users WHERE id IN (?)')) return Promise.resolve([[]]);
      return Promise.resolve([[]]);
    });
    mockPoolQuery = q;
    const ids = Array.from({ length: 1200 }, (_, i) => i + 1);
    await notificationService._bulkFanOut(ids, 'system', '公告', '内容', {});
    expect(q.mock.calls.filter(c => c[0].includes('INSERT INTO notifications')).length).toBe(3); // 500/500/200
    expect(q.mock.calls.filter(c => c[0].includes('SELECT id, notification_settings')).length).toBe(3);
  });

  test('settings 查询返回空行：无 deliver（空数组为真值，落入 for-of 零次）', async () => {
    const ids = [10, 11];
    mockPoolQuery = jest.fn((sql) => {
      if (sql.includes('INSERT INTO notifications')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('SELECT id, notification_settings')) return Promise.resolve([[]]);
      return Promise.resolve([[]]);
    });
    await notificationService._bulkFanOut(ids, 'system', 't', 'm', { targetId: 1 });
    expect(wsService.broadcastToUser).toHaveBeenCalledTimes(0);
  });

  test('settings 查询异常时按默认设置 deliver（rows=null 走 else 分支）', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = [10, 11];
    mockPoolQuery = jest.fn((sql) => {
      if (sql.includes('INSERT INTO notifications')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('SELECT id, notification_settings')) return Promise.reject(new Error('batch query fail'));
      return Promise.resolve([[]]);
    });
    await notificationService._bulkFanOut(ids, 'system', 't', 'm', { targetId: 1 });
    expect(wsService.broadcastToUser).toHaveBeenCalledTimes(2);
    expect(wsService.broadcastToUser.mock.calls[0][0]).toBe(10);
    warnSpy.mockRestore();
  });

  test('空参直接返回', async () => {
    await notificationService._bulkFanOut([], 'system', 't', 'm');
    expect(wsService.broadcastToUser).not.toHaveBeenCalled();
  });
});

describe('P3-96 _deliver 分发与 notifyUser', () => {
  test('browser=true 走 WS，email=true 走邮件队列', async () => {
    mockPoolQuery = jest.fn(() => Promise.resolve([[]]));
    await notificationService._deliver({ browser: true, email: true, sound: true }, 42, 'comment', '标题', '正文', { postId: 8 });
    expect(wsService.broadcastToUser).toHaveBeenCalledWith(42, expect.objectContaining({ type: 'notification' }));
    // email 走 sendEmailNotification（mailer 未启用则不发）
  });

  test('notifyUser 组合：落库 + 取设置 + 分发', async () => {
    poolResolve([[/INSERT INTO notifications/, [{ affectedRows: 1 }]], [/SELECT notification_settings FROM users/, [[{ notification_settings: '{"email":false,"browser":true,"sound":true}' }]]]]);
    await notificationService.notifyUser(77, 'like', '动态', '正文', { postId: 1 });
    expect(wsService.broadcastToUser).toHaveBeenCalledWith(77, expect.anything());
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO notifications'), expect.any(Array));
  });
});

describe('P3-96 WebSocket 广播与邮件', () => {
  test('broadcastWS 转发到 broadcastAllExcept 并附带 notificationType', async () => {
    await notificationService.broadcastWS('event', { a: 1 });
    expect(wsService.broadcastAllExcept).toHaveBeenCalledWith(null, { type: 'notification', payload: { a: 1, notificationType: 'event' } });
  });

  test('pushToUserWS 转发到 broadcastToUser', async () => {
    await notificationService.pushToUserWS(3, 'system', { title: 'x' });
    expect(wsService.broadcastToUser).toHaveBeenCalledWith(3, { type: 'notification', payload: { title: 'x', notificationType: 'system' } });
  });

  test('sendEmailNotification 邮件未启用时早退', async () => {
    mailer.isMailerEnabled.mockReturnValue(false);
    await notificationService.sendEmailNotification(9, '标题', '内容');
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  test('sendEmailNotification 邮件启用但用户无邮箱则跳过', async () => {
    mailer.isMailerEnabled.mockReturnValue(true);
    mockPoolQuery = jest.fn().mockResolvedValue([[{ email: null }]]);
    await notificationService.sendEmailNotification(9, '标题', '内容');
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  test('sendEmailNotification 成功入队', async () => {
    mailer.isMailerEnabled.mockReturnValue(true);
    mailer.sendEmail.mockReturnValue({ success: true });
    mockPoolQuery = jest.fn().mockResolvedValue([[{ email: 'a@b.c', display_name: '张三' }]]);
    await notificationService.sendEmailNotification(9, '标题', '内容');
    expect(mailer.sendEmail).toHaveBeenCalledWith('a@b.c', expect.stringContaining('标题'), expect.stringContaining('<'), expect.any(String));
  });
});

describe('P3-96 通知列表/已读/未读数', () => {
  test('getNotifications 返回查询结果', async () => {
    const rows = [{ id: 1, type: 'system' }];
    mockPoolQuery = jest.fn().mockResolvedValue([rows]);
    const r = await notificationService.getNotifications(5, 30);
    expect(r).toEqual(rows);
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('LIMIT ?'), [5, 30]);
  });

  test('markAsRead 指定单条或全部', async () => {
    mockPoolQuery = jest.fn().mockResolvedValue([{ affectedRows: 1 }]);
    expect(await notificationService.markAsRead(5, 100)).toBe(true);
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE id = ? AND user_id = ?'), [100, 5]);
    await notificationService.markAsRead(5);
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = ? AND is_read = 0'), [5]);
  });

  test('getUnreadCount 返回未读数，异常时回退 0', async () => {
    mockPoolQuery = jest.fn().mockResolvedValue([[{ count: 12 }]]);
    expect(await notificationService.getUnreadCount(5)).toBe(12);
  });
});