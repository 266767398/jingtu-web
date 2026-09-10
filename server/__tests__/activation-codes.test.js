/**
 * 激活码服务回归测试（有效期支持）。
 *
 * 覆盖「注册码有问题」加固轮的完整链路：
 *   - generateCodes 支持 expiresDays（0/缺省 = 永久，N 天后过期，上限 3650）
 *   - isEntryExpired 判定（无 expires_at / 未到期 / 已到期）
 *   - validateAndConsume 对过期码拒绝并返回 EXPIRED（且不消耗、不写盘），
 *     判定顺序 used → revoked → expired
 *   - checkCode 返回 expired / expires_at / reason=EXPIRED（供 P2P 侧离线校验）
 *   - listCodes 返回 expired 统计（只统计「未使用且未作废且已过期」）
 *   - importCodes 透传 expires_at（P2P 同步保留有效期字段，用作测试造码）
 *
 * 通过 setFilePath 把数据文件重定向到系统临时目录，测试不触碰真实数据。
 * 注意：测试码必须使用合法字符集（无 0/1/I/O），否则会被格式校验拒绝。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../activation_code_service');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-test-'));
  svc.setFilePath(path.join(tmpDir, 'activation-codes.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 用 importCodes 直接构造指定状态的码（含过期时间），避免依赖真实时钟 */
async function seedCodes(entries) {
  const r = await svc.importCodes(entries, 'test-seed');
  expect(r.ok).toBe(true);
  return r;
}

function readRaw() {
  return JSON.parse(fs.readFileSync(svc.getCodeFilePath(), 'utf8'));
}

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

describe('码格式与归一化', () => {
  test('normalizeCode 大写化并去空白', () => {
    expect(svc.normalizeCode(' jt-ab2c-3456-789a ')).toBe('JT-AB2C-3456-789A');
    expect(svc.normalizeCode('JT-AB2C-3456-789A')).toBe('JT-AB2C-3456-789A');
    expect(svc.normalizeCode(null)).toBe('');
  });

  test('isValidCodeFormat 拒绝易混淆字符与错误分段', () => {
    expect(svc.isValidCodeFormat('JT-AB2C-3456-789A')).toBe(true);
    expect(svc.isValidCodeFormat('JT-AB0C-3456-789A')).toBe(false); // 含 0
    expect(svc.isValidCodeFormat('JT-ABIC-3456-789A')).toBe(false); // 含 I
    expect(svc.isValidCodeFormat('JT-AB2C-3456')).toBe(false);      // 分段不足
    expect(svc.isValidCodeFormat('XX-AB2C-3456-789A')).toBe(false); // 前缀错误
  });
});

describe('generateCodes 有效期', () => {
  test('缺省 / 0 天 = 永久（expires_at 为 null）', async () => {
    const a = await svc.generateCodes(1, 'test', '', undefined);
    const b = await svc.generateCodes(1, 'test', '', 0);
    expect(a[0].expires_at).toBeNull();
    expect(b[0].expires_at).toBeNull();
    expect(a[0].used).toBe(false);
    expect(a[0].code).toMatch(/^JT-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });

  test('传 N 天 → expires_at 约为 now + N 天', async () => {
    const [entry] = await svc.generateCodes(1, 'test', '', 30);
    expect(entry.expires_at).not.toBeNull();
    const drift = Math.abs(new Date(entry.expires_at).getTime() - (Date.now() + 30 * 86400000));
    expect(drift).toBeLessThan(60000);
  });

  test('字符串数字与超上限均被 clamp', async () => {
    const [a] = await svc.generateCodes(1, 'test', '', '7');
    const driftA = Math.abs(new Date(a.expires_at).getTime() - (Date.now() + 7 * 86400000));
    expect(driftA).toBeLessThan(60000);

    const [b] = await svc.generateCodes(1, 'test', '', 99999);
    const driftB = Math.abs(new Date(b.expires_at).getTime() - (Date.now() + 3650 * 86400000));
    expect(driftB).toBeLessThan(60000);
  });

  test('批量生成码值唯一', async () => {
    const created = await svc.generateCodes(20, 'test', '', 0);
    expect(created.length).toBe(20);
    expect(new Set(created.map(c => c.code)).size).toBe(20);
  });
});

describe('isEntryExpired', () => {
  test('无 expires_at / null → 未过期', () => {
    expect(svc.isEntryExpired({})).toBe(false);
    expect(svc.isEntryExpired({ expires_at: null })).toBe(false);
    expect(svc.isEntryExpired(null)).toBe(false);
  });

  test('未来时间 → 未过期；过去时间 → 已过期', () => {
    expect(svc.isEntryExpired({ expires_at: FUTURE })).toBe(false);
    expect(svc.isEntryExpired({ expires_at: PAST })).toBe(true);
  });
});

describe('validateAndConsume 过期拦截', () => {
  test('过期码 → EXPIRED，且不消耗、不写盘', async () => {
    await seedCodes([{ code: 'JT-EXPD-TEST-2222', expires_at: PAST }]);
    const r = await svc.validateAndConsume('JT-EXPD-TEST-2222', 'someone');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('EXPIRED');
    expect(r.expired_at).toBe(PAST);

    // 文件中条目未被标记 used（EXPIRED 分支在 beforeMark/标记之前返回）
    const raw = readRaw();
    expect(raw.codes[0].used).toBe(false);
    expect(raw.codes[0].used_by).toBeNull();
  });

  test('未过期码正常消耗', async () => {
    await seedCodes([{ code: 'JT-AB2C-3456-789A', expires_at: FUTURE }]);
    const r = await svc.validateAndConsume('jt-ab2c-3456-789a', 'alice');
    expect(r.ok).toBe(true);
    expect(r.entry.used).toBe(true);
    expect(r.entry.used_by).toBe('alice');

    // 再消耗 → ALREADY_USED（判定顺序在 EXPIRED 之前）
    const again = await svc.validateAndConsume('JT-AB2C-3456-789A', 'bob');
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('ALREADY_USED');
  });

  test('判定顺序：已使用 + 已过期 → ALREADY_USED 优先', async () => {
    await seedCodes([{ code: 'JT-USED-EXPD-2222', expires_at: PAST, used: true, used_by: 'p1', used_at: PAST }]);
    const r = await svc.validateAndConsume('JT-USED-EXPD-2222', 'p2');
    expect(r.reason).toBe('ALREADY_USED');
  });

  test('判定顺序：已作废 + 已过期 → REVOKED 优先', async () => {
    await seedCodes([{ code: 'JT-REVK-EXPD-2222', expires_at: PAST, revoked: true, revoked_by: 'admin' }]);
    const r = await svc.validateAndConsume('JT-REVK-EXPD-2222', 'p1');
    expect(r.reason).toBe('REVOKED');
  });

  test('beforeMark 钩子抛错 → BEFORE_HOOK_FAILED 且码不消耗', async () => {
    await seedCodes([{ code: 'JT-HNKY-TEST-3333' }]);
    const r = await svc.validateAndConsume('JT-HNKY-TEST-3333', 'u1', () => {
      throw new Error('建号失败');
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BEFORE_HOOK_FAILED');
    expect(readRaw().codes[0].used).toBe(false);
  });
});

describe('checkCode 只读校验', () => {
  test('过期码 → valid:false / EXPIRED / expired:true / expires_at 原样', async () => {
    await seedCodes([{ code: 'JT-CHKP-EXPD-4444', expires_at: PAST, note: '批次A' }]);
    const r = await svc.checkCode('jt-chkp-expd-4444');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('EXPIRED');
    expect(r.expired).toBe(true);
    expect(r.expires_at).toBe(PAST);
    expect(r.exists).toBe(true);
    expect(r.note).toBe('批次A');
  });

  test('未过期码与永久码 → valid:true / expired:false', async () => {
    await seedCodes([
      { code: 'JT-CHKP-WRKD-4444', expires_at: FUTURE },
      { code: 'JT-CHKP-FREE-4444' }
    ]);
    const r1 = await svc.checkCode('JT-CHKP-WRKD-4444');
    expect(r1.valid).toBe(true);
    expect(r1.expired).toBe(false);
    expect(r1.expires_at).toBe(FUTURE);

    const r2 = await svc.checkCode('JT-CHKP-FREE-4444');
    expect(r2.valid).toBe(true);
    expect(r2.expired).toBe(false);
    expect(r2.expires_at).toBeNull();
  });

  test('不存在的码 / 非法格式', async () => {
    const miss = await svc.checkCode('JT-ZZZZ-9999-8888');
    expect(miss.valid).toBe(false);
    expect(miss.reason).toBe('NOT_FOUND');

    const bad = await svc.checkCode('garbage');
    expect(bad.reason).toBe('INVALID_FORMAT');
    expect(bad.exists).toBe(false);
  });
});

describe('listCodes expired 统计', () => {
  test('只统计「未使用且未作废且已过期」', async () => {
    await seedCodes([
      { code: 'JT-LSTA-EXPD-5555', expires_at: PAST },                                        // 过期未用
      { code: 'JT-LSTB-WRKD-5555', expires_at: FUTURE },                                      // 未过期未用
      { code: 'JT-LSTC-USED-5555', expires_at: PAST, used: true, used_by: 'p1', used_at: PAST }, // 已用过期
      { code: 'JT-LSTD-REVK-5555', expires_at: PAST, revoked: true, revoked_by: 'admin' }     // 已作废过期
    ]);
    const list = await svc.listCodes();
    expect(list.total).toBe(4);
    expect(list.unused).toBe(2);   // unused 定义为 !used && !revoked（含过期未用）
    expect(list.used).toBe(1);
    expect(list.revoked).toBe(1);
    expect(list.expired).toBe(1);  // 只算过期未用未作废
    expect(list.codes).toHaveLength(4);
  });
});

describe('importCodes 透传 expires_at', () => {
  test('带 expires_at 的条目导入后原样保留；不带 → null', async () => {
    const r = await svc.importCodes([
      { code: 'JT-MPRT-EXPD-6666', expires_at: PAST },
      { code: 'JT-MPRT-FREE-6666' }
    ], 'p2p-sync');
    expect(r.ok).toBe(true);
    expect(r.imported).toHaveLength(2);

    const raw = readRaw();
    const e1 = raw.codes.find(c => c.code === 'JT-MPRT-EXPD-6666');
    const e2 = raw.codes.find(c => c.code === 'JT-MPRT-FREE-6666');
    expect(e1.expires_at).toBe(PAST);
    expect(e2.expires_at).toBeNull();

    // 透传的过期码立即被消费侧拦截（P2P 同步过去时间也安全）
    const chk = await svc.checkCode('JT-MPRT-EXPD-6666');
    expect(chk.valid).toBe(false);
    expect(chk.reason).toBe('EXPIRED');
  });
});
