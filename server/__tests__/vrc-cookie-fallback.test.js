/**
 * VRChat cookie 降级的行为测试（不是文本匹配，是真的把路由跑起来）。
 *
 * 用户症状：管理面板「系统 VRChat 账号」显示 🟢 已登录，
 *          点「同步群组成员」却报「VRChat 登录已过期」。
 * 根因：getVRCCookie 无条件优先返回用户绑定时存进 session 的 cookie，
 *      那份 cookie 过期后所有调用都拿到它，永远不会 fallback 到系统账号 cookie。
 *
 * 这里把 ../vrc 和数据库都 mock 掉，用 supertest 打真实路由，
 * 断言「第一份 cookie 401 之后确实换成了第二份重试」。
 */
const express = require('express');
const request = require('supertest');

// --- mock VRChat SDK：DEAD_COOKIE 一律 401，GOOD_COOKIE 正常返回 ---
const DEAD = 'authcookie=dead';
const GOOD = 'authcookie=good';
const mockCalls = [];

jest.mock('../vrc', () => {
  const unauthorized = { status: 401, data: { error: 'Unauthorized' } };
  return {
    VRC_API: 'https://api.vrchat.cloud/api/1',
    VRC_API_KEY: 'test',
    vrchatGetCurrentUser: jest.fn(async (cookie) => {
      mockCalls.push(['getCurrentUser', cookie]);
      return cookie === 'authcookie=good' ? { id: 'usr_sys', displayName: 'SysAccount' } : null;
    }),
    // 带 HTTP 状态的版本：401 才代表 cookie 真的失效，
    // 其它非 2xx（限流/上游故障）不允许把用户的绑定 cookie 清掉
    vrchatGetCurrentUserResult: jest.fn(async (cookie) => {
      mockCalls.push(['getCurrentUser', cookie]);
      return cookie === 'authcookie=good'
        ? { status: 200, data: { id: 'usr_sys', displayName: 'SysAccount' } }
        : { status: 401, data: { error: 'Unauthorized' } };
    }),
    vrchatGetGroupMembers: jest.fn(async (gid, cookie) => {
      mockCalls.push(['getGroupMembers', cookie]);
      if (cookie !== 'authcookie=good') return unauthorized;
      return { status: 200, data: [] };
    }),
    vrchatSearchWorlds: jest.fn(async (q, n, cookie) => {
      mockCalls.push(['searchWorlds', cookie]);
      if (cookie !== 'authcookie=good') return unauthorized;
      return { status: 200, data: [{ id: 'wrld_1', name: 'Test World' }] };
    }),
    vrchatSetAvatar: jest.fn(async (id, cookie) => {
      mockCalls.push(['setAvatar', cookie]);
      if (cookie !== 'authcookie=good') return unauthorized;
      return { status: 200, data: {} };
    }),
    vrchatRequest: jest.fn(async () => ({ status: 200, data: {} })),
    vrchatGetUser: jest.fn(),
    vrchatGetWorld: jest.fn(),
    vrchatSearchAvatars: jest.fn(),
    vrchatGetAvatar: jest.fn(),
  };
});

// 数据库：同步流程里的查询全部返回空；P3-55 起全量同步走 GET_LOCK 跨进程互斥，
// mock 返回「已获得锁」，否则同步会被 409 拦在 VRChat 调用之前。
const mockQuery = jest.fn(async (sql) => {
  if (String(sql).includes('GET_LOCK')) return [[{ got: 1 }]];
  if (String(sql).includes('RELEASE_LOCK')) return [[]];
  return [[]];
});
const mockConn = {
  query: mockQuery,
  beginTransaction: jest.fn(async () => {}),
  commit: jest.fn(async () => {}),
  rollback: jest.fn(async () => {}),
  release: jest.fn(),
};
// 直接 mock ../db，避免 requireActual('../utils') 连带把真实连接池和心跳定时器拉起来
// （那个 setInterval 会一直吊住事件循环，导致 jest 跑完后挂住不退出）
jest.mock('../db', () => ({
  holder: { pool: null },
  DB_NAME: 'test',
  DB_CONFIG: {},
  getPool: () => ({ query: (...a) => mockQuery(...a), getConnection: async () => mockConn }),
  recreatePool: jest.fn(),
}));
jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    ...actual,
    getPool: () => ({ query: (...a) => mockQuery(...a), getConnection: async () => mockConn }),
  };
});

// 放行权限校验，专注测 cookie 降级
jest.mock('../auth', () => ({
  requireAdminCompat: (req, res, next) => next(),
  requireAuth: (req, res, next) => next(),
}));

/**
 * 构造一个和 server.js 语义一致的 getVRCCookie：
 * 优先 session cookie，其次系统 cookie；invalidate 会清掉匹配的那一份。
 */
function makeCookieFn(state) {
  const fn = (req) => state.session || state.system || null;
  fn.invalidate = (req, dead) => {
    if (state.session && (!dead || state.session === dead)) { state.session = null; return true; }
    if (state.system && (!dead || state.system === dead)) { state.system = null; return true; }
    return false;
  };
  return fn;
}

// 仅取用户绑定 cookie（无系统回退），对应 server.js 的 getVRCCookieUserOnly
function makeUserOnlyCookieFn(state) {
  const fn = (req) => state.session || null;
  return fn;
}

function makeApp(state) {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/groups')(makeCookieFn(state), 'grp_test', makeUserOnlyCookieFn(state)));
  return app;
}

beforeEach(() => { mockCalls.length = 0; mockQuery.mockClear(); });

describe('用户绑定的 cookie 过期后应自动降级到系统账号 cookie', () => {
  test('群组同步：第一份 cookie 401 后换第二份重试并成功', async () => {
    const state = { session: DEAD, system: GOOD };
    const res = await request(makeApp(state)).post('/api/group/members/sync').send({});

    const currentUserCalls = mockCalls.filter(c => c[0] === 'getCurrentUser').map(c => c[1]);
    expect(currentUserCalls).toEqual([DEAD, GOOD]);
    expect(res.status).not.toBe(401);
  });

  test('群组同步：所有候选都失效时才报 VRC_COOKIE_EXPIRED', async () => {
    const state = { session: DEAD, system: null };
    const res = await request(makeApp(state)).post('/api/group/members/sync').send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('VRC_COOKIE_EXPIRED');
  });

  test('完全没有 cookie 时返回 VRC_SYSTEM_OFFLINE 而不是「已过期」', async () => {
    // 这两个错误语义不同：一个是"没登录"，一个是"登录过期"，
    // 混在一起会让用户不知道该去绑定还是去重新登录。
    const state = { session: null, system: null };
    const res = await request(makeApp(state)).post('/api/group/members/sync').send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('VRC_SYSTEM_OFFLINE');
  });

  test('世界搜索同样会降级（创建活动里搜世界报服务器错误的那条）', async () => {
    const state = { session: DEAD, system: GOOD };
    const res = await request(makeApp(state)).get('/api/vrc/worlds/search?q=test');

    const searchCalls = mockCalls.filter(c => c[0] === 'searchWorlds').map(c => c[1]);
    expect(searchCalls).toEqual([DEAD, GOOD]);
    expect(res.status).toBe(200);
    expect(res.body.worlds).toHaveLength(1);
  });

  test('第一份 cookie 就是好的时候不产生多余的重试', async () => {
    // 避免每次请求都白白多打一次 VRChat 接口（会撞限流）
    const state = { session: GOOD, system: GOOD };
    await request(makeApp(state)).get('/api/vrc/worlds/search?q=test');

    expect(mockCalls.filter(c => c[0] === 'searchWorlds')).toHaveLength(1);
  });

  test('切换模型是代表用户的写操作，绝不能降级到系统账号', async () => {
    // 一旦降级，会把系统账号的模型改掉。
    const state = { session: DEAD, system: GOOD };
    const res = await request(makeApp(state))
      .post('/api/vrc/avatar/set').send({ avatarId: 'avtr_1' });

    const setCalls = mockCalls.filter(c => c[0] === 'setAvatar').map(c => c[1]);
    expect(setCalls).toEqual([DEAD]);
    expect(res.status).toBe(401);
  });

  test('未绑定用户（无 session cookie）绝不能回退到系统账号写操作', async () => {
    // 真实越权场景：未绑定 VRChat 的会员若拿到系统账号 cookie，会改写系统账号头像。
    const state = { session: null, system: GOOD };
    const res = await request(makeApp(state)).post('/api/vrc/avatar/set').send({ avatarId: 'avtr_1' });

    const setCalls = mockCalls.filter(c => c[0] === 'setAvatar').map(c => c[1]);
    expect(setCalls).toEqual([]); // 绝不会用系统 cookie 调用 setAvatar
    expect(res.status).toBe(401);
  });
});
