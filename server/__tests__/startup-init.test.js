// 验证后台子系统在无配置环境下初始化不会抛错（P1-2 落地）
// cache.initCache / mailer.initMailer / tasks.startTasks 均应有环境守卫与错误处理，
// 缺失 REDIS_HOST / SMTP 配置时应安全跳过，不拖垮主进程。
describe('后台子系统启动初始化（P1-2）', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.REDIS_HOST;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('cache.initCache 无 REDIS_HOST 时不抛错', async () => {
    const cache = require('../cache');
    await expect(cache.initCache()).resolves.toBeUndefined();
  });

  test('mailer.initMailer 无 SMTP 配置时不抛错', () => {
    const mailer = require('../mailer');
    expect(() => mailer.initMailer()).not.toThrow();
  });

  test('tasks.startTasks 在无配置下不抛错', () => {
    const tasks = require('../tasks');
    expect(() => tasks.startTasks()).not.toThrow();
  });

  test('tasks.startTasks 幂等——二次调用不重复注册（P3-90）', () => {
    const tasks = require('../tasks');
    tasks.stopTasks();
    tasks.startTasks();
    const once = tasks.getTaskStatus().length;
    expect(once).toBeGreaterThan(0);
    tasks.startTasks(); // 二次调用：原实现会重复注册全部 CronJob 任务翻倍
    const twice = tasks.getTaskStatus().length;
    expect(twice).toBe(once);
    tasks.stopTasks();
  });
});
