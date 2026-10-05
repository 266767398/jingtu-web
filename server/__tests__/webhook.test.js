// P2-149: webhook HMAC 签名 / SSRF 防护 / 发送与触发行为测试
const axios = require('axios');
const dns = require('dns');

const mockPool = { query: jest.fn() };

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('dns', () => ({ lookup: jest.fn() }));
jest.mock('../utils', () => ({
  getPool: () => mockPool
}));

const webhook = require('../webhook');

// 公网 DNS：example.com → 8.8.8.8；bad.invalid 解析失败；其余默认环回
// 注意：Node 的 promisify(dns.lookup) 解析为 { address, family } 对象（而非裸字符串），
// mock 必须回传对象形式，否则 validateWebhookUrl 的 `{ address }` 解构得到 undefined。
const net = require('net');
function mockDns(hostToIp) {
  dns.lookup.mockImplementation((host, cb) => {
    const ip = net.isIP(host);
    if (ip) return cb(null, { address: host, family: ip }); // IP 字面量原样返回（与 node 真实行为一致）
    if (hostToIp && hostToIp[host]) return cb(null, { address: hostToIp[host], family: 4 });
    if (host === 'bad.invalid') return cb(new Error('ENOTFOUND'));
    const def = hostToIp && hostToIp.__default ? hostToIp.__default : '127.0.0.1';
    return cb(null, { address: def, family: 4 });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDns({ __default: '8.8.8.8' });
});

describe('P2-149 signPayload / canonicalStringify', () => {
  test('signPayload 无 secret 返回 null', () => {
    expect(webhook.signPayload({ a: 1 }, '')).toBeNull();
    expect(webhook.signPayload({ a: 1 }, null)).toBeNull();
    expect(webhook.signPayload({ a: 1 }, undefined)).toBeNull();
  });

  test('signPayload 确定性 HMAC（同输入同签名，改 secret 变签名）', () => {
    const payload = { event: 'x', data: { id: 1 } };
    const s1 = webhook.signPayload(payload, 'secret-1');
    const s2 = webhook.signPayload(payload, 'secret-1');
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    const s3 = webhook.signPayload(payload, 'secret-2');
    expect(s3).not.toBe(s1);
  });

  test('canonicalStringify 按键排序、嵌套递归', () => {
    expect(webhook.canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(webhook.canonicalStringify([2, 1])).toBe('[2,1]');
    expect(webhook.canonicalStringify({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
    expect(webhook.canonicalStringify('str')).toBe('"str"');
  });

  test('isBlockedWebhookAddress 判定', () => {
    expect(webhook.isBlockedWebhookAddress('127.0.0.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('10.1.2.3')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('172.16.0.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('192.168.1.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('169.254.0.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('100.64.0.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('198.18.0.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('198.51.100.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('203.0.113.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('0.0.0.0')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('8.8.8.8')).toBe(false);
    expect(webhook.isBlockedWebhookAddress('1.1.1.1')).toBe(false);
  });

  test('isBlockedWebhookAddress IPv4-mapped IPv6 / 链路本地 / ULA（SSRF 绕过回归）', () => {
    expect(webhook.isBlockedWebhookAddress('::ffff:127.0.0.1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('::ffff:7f00:1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('::ffff:ac10:1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('::ffff:c0a8:101')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('::ffff:0a00:0001')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('fe80::1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('fc00::123')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('fd12:3456::1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('::1')).toBe(true);
    expect(webhook.isBlockedWebhookAddress('::ffff:8.8.8.8')).toBe(false);
    expect(webhook.isBlockedWebhookAddress('2606:4700:4700::1111')).toBe(false);
  });
});

describe('P2-149 validateWebhookUrl（SSRF 防护）', () => {
  test('非法 URL / 非 http(s) 协议拒绝', async () => {
    const r1 = await webhook.validateWebhookUrl('not-a-url');
    expect(r1.ok).toBe(false);
    expect(r1.reason).toContain('URL');
    const r2 = await webhook.validateWebhookUrl('ftp://example.com/x');
    expect(r2.ok).toBe(false);
  });

  test('环回/私网/链路本地地址拒绝', async () => {
    for (const url of [
      'https://127.0.0.1/x',
      'https://10.0.0.1/x',
      'https://172.16.0.1/x',
      'https://192.168.1.1/x',
      'https://169.254.1.1/x',
      'https://100.64.0.1/x',
      'https://198.18.0.1/x',
      'https://198.51.100.1/x',
      'https://203.0.113.1/x'
    ]) {
      const r = await webhook.validateWebhookUrl(url);
      expect(r.ok).toBe(false);
    }
  });

  test('公网地址放行', async () => {
    const r = await webhook.validateWebhookUrl('https://example.com/hook');
    expect(r.ok).toBe(true);
  });

  test('域名解析失败拒绝', async () => {
    const r = await webhook.validateWebhookUrl('https://bad.invalid/hook');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('解析');
  });
});

describe('P2-149 sendWebhook 发送行为', () => {
  test('被安全策略拦截的 URL 不发起请求', async () => {
    mockDns({});
    const r = await webhook.sendWebhook('https://127.0.0.1/hook', 'post_created', { id: 1 }, 'sec');
    expect(r.success).toBe(false);
    expect(r.error).toContain('拦截');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('带 secret 时注入 HMAC 签名头与事件头', async () => {
    axios.post.mockResolvedValue({ status: 200 });
    const r = await webhook.sendWebhook('https://example.com/hook', 'post_created', { id: 1 }, 'sec');
    expect(r.success).toBe(true);
    expect(r.status).toBe(200);
    const [, body, opts] = axios.post.mock.calls[0];
    expect(body.event).toBe('post_created');
    expect(opts.headers['X-JingTu-Event']).toBe('post_created');
    expect(opts.headers['X-JingTu-Timestamp']).toBe(String(body.timestamp));
    expect(opts.headers['X-JingTu-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  test('无 secret 时不注入签名头', async () => {
    axios.post.mockResolvedValue({ status: 200 });
    await webhook.sendWebhook('https://example.com/hook', 'user_login', {}, '');
    const opts = axios.post.mock.calls[0][2];
    expect(opts.headers['X-JingTu-Signature']).toBeUndefined();
  });

  test('上游请求失败返回 success:false 且不抛异常', async () => {
    axios.post.mockRejectedValue(new Error('ECONNRESET'));
    const r = await webhook.sendWebhook('https://example.com/hook', 'x', {}, '');
    expect(r.success).toBe(false);
    expect(r.error).toBe('ECONNRESET');
  });

  test('发送失败按指数退避重试，恢复后成功（P3-72）', async () => {
    webhook.resetPendingQueue();
    axios.post
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ status: 200 });
    const r = await webhook.sendWebhook('https://example.com/hook', 'x', {}, 's');
    expect(r.success).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(webhook.getPendingCount()).toBe(0);
  });

  test('重试耗尽仍失败时写入待补发队列（P3-72）', async () => {
    webhook.resetPendingQueue();
    axios.post.mockRejectedValue(new Error('ECONNRESET'));
    const r = await webhook.sendWebhook('https://example.com/hook', 'security_alert', { m: 1 }, '');
    expect(r.success).toBe(false);
    expect(axios.post).toHaveBeenCalledTimes(4); // 1 次 + 3 次重试
    expect(webhook.getPendingCount()).toBe(1);
  });

  test('待补发路径 noPending 不二次入队，且 flush 成功即清除（P3-72）', async () => {
    webhook.resetPendingQueue();
    axios.post.mockRejectedValue(new Error('down'));
    // 先产生一条失败入队（正常发送路径）
    await webhook.sendWebhook('https://example.com/hook', 'x', {}, '');
    expect(webhook.getPendingCount()).toBe(1);

    // noPending 重发仍失败 → 不二次入队（flush 内部换行计数）
    axios.post.mockClear();
    axios.post.mockRejectedValue(new Error('down'));
    await webhook.flushPendingDeliveries();
    // 5 轮封顶内仍失败 → 累计轮数小于 5 → 重新入队（此处为第 1 轮失败，仍滞留）
    expect(webhook.getPendingCount()).toBe(1);

    // 恢复后 flush 成功 → 队列清空
    axios.post.mockClear();
    axios.post.mockResolvedValue({ status: 200 });
    await webhook.flushPendingDeliveries();
    expect(webhook.getPendingCount()).toBe(0);
  });

  test('待补发队列超过上限拒绝入队（P3-72）', async () => {
    webhook.resetPendingQueue();
    for (let i = 0; i < 1000; i++) {
      webhook.enqueuePending({ url: `https://example.com/h${i}`, eventType: 'x', data: {}, secret: '' });
    }
    expect(webhook.getPendingCount()).toBe(1000);
    const ok = webhook.enqueuePending({ url: 'https://example.com/overflow', eventType: 'x', data: {}, secret: '' });
    expect(ok).toBe(false);
    expect(webhook.getPendingCount()).toBe(1000);
  });

  test('待补发重发轮数超限彻底放弃，不再入队（P3-72）', async () => {
    webhook.resetPendingQueue();
    axios.post.mockRejectedValue(new Error('down'));
    // attempts=4，本轮失败后 +1=5 → 达到 PENDING_ITEM_ATTEMPTS_MAX → 彻底放弃
    webhook.enqueuePending({ url: 'https://example.com/hook', eventType: 'x', data: {}, secret: '', attempts: 4 });
    await webhook.flushPendingDeliveries();
    expect(webhook.getPendingCount()).toBe(0);
  });
});

describe('P2-149 webhook CRUD 与触发', () => {
  test('getWebhooks 无事件返回全部启用 webhook', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 1, url: 'u' }]]);
    const rows = await webhook.getWebhooks();
    expect(rows).toHaveLength(1);
    expect(mockPool.query.mock.calls[0][0]).not.toContain('FIND_IN_SET');
  });

  test('getWebhooks 带事件过滤并传参', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    await webhook.getWebhooks('post_created');
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('FIND_IN_SET');
    expect(params).toEqual(['post_created']);
  });

  test('getWebhooks 查询失败返回空数组', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('down'));
    const rows = await webhook.getWebhooks('x');
    expect(rows).toEqual([]);
  });

  test('createWebhook 校验 URL 且内网地址拒绝', async () => {
    mockDns({ __default: '10.1.1.1' });
    await expect(
      webhook.createWebhook('https://10.1.1.1/h', ['a', 'b'], 'sec')
    ).rejects.toThrow('URL 校验失败');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('createWebhook 成功返回 insertId 且数组 events 拼接', async () => {
    mockPool.query.mockResolvedValueOnce([{ insertId: 42 }]);
    const id = await webhook.createWebhook('https://example.com/h', ['a', 'b'], 'sec');
    expect(id).toBe(42);
    const [, params] = mockPool.query.mock.calls[0];
    expect(params[1]).toBe('a,b');
  });

  test('updateWebhook 白名单字段归一且不透传任意列', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const ok = await webhook.updateWebhook(1, { url: 'https://example.com/h', events: ['a', 'b'], evil: 'drop' });
    expect(ok).toBe(true);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).not.toContain('evil');
    expect(params).not.toContain('drop');
    expect(sql).toContain('url = ?');
  });

  test('updateWebhook 空更新回查存在性', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 1 }]]);
    const ok = await webhook.updateWebhook(1, {});
    expect(ok).toBe(true);
    expect(mockPool.query.mock.calls[0][0]).toContain('SELECT id FROM webhooks');
  });

  test('updateWebhook 事件数组拼接入库', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const ok = await webhook.updateWebhook(1, { events: ['a', 'b'], enabled: 1 });
    expect(ok).toBe(true);
    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe('a,b');
  });

  test('deleteWebhook 返回 affectedRows>0', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    expect(await webhook.deleteWebhook(9)).toBe(false);
  });

  test('trigger 无匹配 webhook 不发请求', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    await webhook.trigger('post_created', { id: 1 });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('trigger 遍历启用 webhook 全量发送', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 1, url: 'https://example.com/h1', secret: 's' },
      { id: 2, url: 'https://example.com/h2', secret: '' }
    ]]);
    axios.post.mockResolvedValue({ status: 200 });
    await webhook.trigger('post_created', { id: 1 });
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('trigger 部分失败不抛异常（allSettled）', async () => {
    mockPool.query.mockResolvedValueOnce([[
      { id: 1, url: 'https://example.com/h1', secret: 's' }
    ]]);
    axios.post.mockRejectedValue(new Error('timeout'));
    await expect(webhook.trigger('post_created', { id: 1 })).resolves.toBeUndefined();
  });
});
