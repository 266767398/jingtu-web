// P3-74/75/78 回归测试：media_providers 重定向 SSRF 校验、security_alert 统计 Map 上限、
// metrics 路径归一化扩展（UUID/VRChat ID）。纯单元测试，无网络依赖。
jest.mock('dns', () => ({ lookup: jest.fn() }));

const dns = require('dns');
const { _assertPublicRedirectTarget } = require('../media_providers');
const metrics = require('../middleware/metrics');
const alert = require('../security_alert');

function mockDns(hostToIp) {
  dns.lookup.mockImplementation((host, cb) => {
    if (hostToIp && hostToIp[host]) return cb(null, { address: hostToIp[host], family: 4 });
    const def = hostToIp && hostToIp.__default ? hostToIp.__default : '8.8.8.8';
    return cb(null, { address: def, family: 4 });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDns({});
});

describe('P3-74 media_providers 重定向目标 SSRF 校验', () => {
  test('非 https 重定向一律拒绝', async () => {
    await expect(_assertPublicRedirectTarget(new URL('http://example.com/x'))).rejects.toThrow('non-https');
  });

  test('内网/环回/链路本地 IP 字面量拒绝', async () => {
    for (const url of [
      'https://127.0.0.1/x',
      'https://10.0.0.1/x',
      'https://172.16.0.1/x',
      'https://192.168.1.1/x',
      'https://169.254.1.1/x',
      'https://100.64.0.1/x',
      'https://198.18.0.1/x',
      'https://198.51.100.1/x',
      'https://203.0.113.1/x',
      'https://[::1]/x'
    ]) {
      await expect(_assertPublicRedirectTarget(new URL(url))).rejects.toThrow('internal');
    }
  });

  test('localhost 域名拒绝（无需 DNS）', async () => {
    await expect(_assertPublicRedirectTarget(new URL('https://localhost/x'))).rejects.toThrow('localhost');
  });

  test('域名解析到公网放行', async () => {
    mockDns({ 'example.com': '8.8.8.8' });
    await expect(_assertPublicRedirectTarget(new URL('https://example.com/x'))).resolves.toBeUndefined();
  });

  test('域名解析到内网拒绝', async () => {
    mockDns({ 'evil.example': '10.1.2.3' });
    await expect(_assertPublicRedirectTarget(new URL('https://evil.example/x'))).rejects.toThrow('internal');
  });
});

describe('P3-75 security_alert 告警统计 Map 条数上限', () => {
  test('超过 10000 条后最旧条目被淘汰，Map 有界', async () => {
    const N = 10001;
    for (let i = 0; i < N; i++) {
      await alert.onLoginFailure(`ip-${i}`, 'user');
    }
    const stats = alert.getStats();
    expect(stats.loginFailures).toBe(10000);
    expect(stats.loginFailures).toBeLessThanOrEqual(10000);
  });
});

describe('P3-78 metrics 路径归一化扩展', () => {
  function fire(path, method = 'GET') {
    metrics.resetStats();
    const res = {
      statusCode: 200,
      on: jest.fn((ev, cb) => { if (ev === 'finish') cb(); })
    };
    metrics.metricsMiddleware({ path, method }, res, () => {});
    return Object.keys(metrics.getStats().endpoints)[0];
  }

  test('纯数字段归一化为 :id（既有行为不变）', () => {
    expect(fire('/api/users/123')).toBe('/api/users/:id');
  });

  test('UUID 段归一化为 :uuid', () => {
    expect(fire('/api/groups/7a45b436-159c-4d9c-8303-e186ec25fc35/members')).toBe('/api/groups/:uuid/members');
  });

  test('VRChat ID（usr_/wrld_/grp_ 前缀 UUID）归一化为 :vrcid', () => {
    expect(fire('/api/vrc/user/usr_12345678-1234-1234-1234-123456789abc')).toBe('/api/vrc/user/:vrcid');
    expect(fire('/api/vrc/world/wrld_7a45b436-159c-4d9c-8303-e186ec25fc35')).toBe('/api/vrc/world/:vrcid');
  });

  test('普通路径段保持原样', () => {
    expect(fire('/api/health')).toBe('/api/health');
  });
});
