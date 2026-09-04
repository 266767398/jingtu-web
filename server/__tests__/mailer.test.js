/**
 * P2-4 邮件模块测试守卫。
 * 背景：项目内存在三处独立的 nodemailer transport（mailer.js / notification-service.js /
 * routes/auth.js）且环境变量命名分裂——安装向导写 SMTP_PASS，而 mailer.js 只读
 * SMTP_PASSWORD，导致向导配置的站点永远无法初始化邮件（forgot-password 还因
 * require('../../mailer') 错误路径在发送步骤必然 500）。P2-4 统一收口：
 *   1) 环境变量：SMTP_PASS 优先，SMTP_PASSWORD 兼容回退；
 *   2) 通知服务与路由不再自建 transporter，统一走 mailer 队列；
 *   3) 安装向导测试邮件改用表单配置直发（sendTestEmail）。
 * 通过 jest.mock 拦截 nodemailer，仅校验 createTransport 收到的配置，不做真实网络收发。
 * 注意：mailer.js 为模块级单例状态（isEnabled/transporter），「未配置降级」用例
 * 必须声明在最前，避免被后续 enable 用例污染。
 */
process.env.NODE_ENV = 'test';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'mock-message-id' })
  }))
}));

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const mailer = require('../mailer');

const SMTP_ENV_KEYS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PASSWORD',
  'SMTP_SECURE', 'SMTP_FROM', 'ADMIN_EMAIL'
];

beforeEach(() => {
  for (const key of SMTP_ENV_KEYS) delete process.env[key];
  nodemailer.createTransport.mockClear();
});

describe('P2-4 mailer：SMTP 环境变量统一 + 未配置降级', () => {
  test('未配置 SMTP：initMailer 跳过初始化不抛错，sendEmail 返回结构化失败', () => {
    expect(() => mailer.initMailer()).not.toThrow();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    expect(mailer.isMailerEnabled()).toBe(false);

    const result = mailer.sendEmail('a@b.c', '主题', '<p>内容</p>');
    expect(result).toEqual({ success: false, error: '邮件服务未配置' });
  });

  test('SMTP_PASS 优先：与 SMTP_PASSWORD 同时存在时采用 SMTP_PASS（向导配置场景）', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASS = 'wizard-pass';
    process.env.SMTP_PASSWORD = 'legacy-pass';

    mailer.initMailer();

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport.mock.calls[0][0].auth).toEqual({
      user: 'user@example.com',
      pass: 'wizard-pass'
    });
    expect(mailer.isMailerEnabled()).toBe(true);
  });

  test('SMTP_PASSWORD 兼容回退：历史配置未迁移时仍可初始化', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASSWORD = 'legacy-pass';

    mailer.initMailer();

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport.mock.calls[0][0].auth.pass).toBe('legacy-pass');
    expect(mailer.isMailerEnabled()).toBe(true);
  });
});

describe('P2-4 mailer：sendTestEmail 表单配置直发（安装向导测试邮件）', () => {
  test('使用请求提交的 SMTP 配置创建临时 transport 并直发，不依赖 .env', async () => {
    const result = await mailer.sendTestEmail({
      host: 'smtp.form.com',
      port: 465,
      secure: 'true',
      user: 'form-user@example.com',
      pass: 'form-pass',
      from: 'form-from@example.com'
    }, 'to@example.com');

    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    expect(nodemailer.createTransport.mock.calls[0][0]).toEqual({
      host: 'smtp.form.com',
      port: 465,
      secure: true,
      auth: { user: 'form-user@example.com', pass: 'form-pass' }
    });
    const transport = nodemailer.createTransport.mock.results[0].value;
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'to@example.com',
      subject: '【境途同游】邮件测试',
      text: '邮件测试成功！'
    }));
    expect(result).toEqual({ success: true, messageId: 'mock-message-id' });
  });

  test('SMTP 连接失败时返回结构化错误（不向调用方抛异常）', async () => {
    nodemailer.createTransport.mockImplementationOnce(() => ({
      sendMail: jest.fn().mockRejectedValue(new Error('连接超时'))
    }));

    const result = await mailer.sendTestEmail({
      host: 'unreachable.example.com', port: 587,
      user: 'u@example.com', pass: 'p'
    }, 'to@example.com');

    expect(result.success).toBe(false);
    expect(result.error).toBe('连接超时');
  });
});

describe('P2-4 邮件 transporter 收口静态守卫', () => {
  const serverDir = path.join(__dirname, '..');

  test('notification-service 不再自建 transporter，统一委托 mailer 队列', () => {
    const source = fs.readFileSync(path.join(serverDir, 'notification-service.js'), 'utf8');
    expect(source).not.toMatch(/require\(\s*['"]nodemailer['"]\s*\)/);
    expect(source).not.toContain('nodemailer.createTransport');
    expect(source).not.toContain('_emailTransporter');
    expect(source).toMatch(/require\(\s*['"]\.\/mailer['"]\s*\)/);
    expect(source).toMatch(/mailer\.sendEmail\(/);
  });

  test('routes/auth.js forgot-password 使用正确相对路径引入 mailer，且无残留死代码 transporter', () => {
    const source = fs.readFileSync(path.join(serverDir, 'routes', 'auth.js'), 'utf8');
    expect(source).toMatch(/require\(\s*['"]\.\.\/mailer['"]\s*\)/);
    expect(source).not.toMatch(/require\(\s*['"]\.\.\/\.\.\/mailer['"]\s*\)/);
    expect(source).not.toContain('createTransport');
  });

  test('routes/setup.js test-email 走表单配置直发（sendTestEmail），无错误路径 require', () => {
    const source = fs.readFileSync(path.join(serverDir, 'routes', 'setup.js'), 'utf8');
    expect(source).toMatch(/require\(\s*['"]\.\.\/mailer['"]\s*\)/);
    expect(source).not.toMatch(/require\(\s*['"]\.\.\/\.\.\/mailer['"]\s*\)/);
    expect(source).toMatch(/mailer\.sendTestEmail\(/);
  });
});
