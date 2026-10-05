/**
 * 第六轮：群组同步「点了网页卡住 / 刷新后 VRChat 绑定没了」的回归防护。
 *
 * 三条实测确认的根因：
 *   A. vrchatGetCurrentUser 对任何非 2xx 都 return null，
 *      vrcWithFallback 把 null 当成 401 → VRChat 偶发一次 429 限流
 *      就会把用户 session 里的 VRChat cookie 清掉（实测 5 个 session 变 4 个），
 *      用户刷新后发现"绑定又没了"，而且报的还是误导性的"登录已过期"。
 *   B. 前端 api() 的 10 秒硬超时对"同步群组成员"这种要串行拉多页上游数据的
 *      批量操作远远不够（实测服务端 15 秒才跑完，客户端 10 秒就 abort），
 *      用户看到"请求超时"以为没反应就反复点，并发同步会互相看到对方的中间态，
 *      往 group_member_changes 里写出成片假的"已离开群组"（实测 left:100）。
 *   C. 分页是 while(true) 无上限；同步在事务里对每个成员各做一次 SELECT + 写入。
 *
 * 外加一类系统性问题：同名全局函数跨文件重复定义，后加载者静默覆盖前者。
 * 全站扫出 9 组，其中 showGlobalLoading/hideGlobalLoading 的"胜出"版本
 * 操作的是 index.html 里根本不存在的 #globalLoading —— 全局加载指示器从来没工作过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const JS_DIR = path.join(PUB, 'js');
const SRV = path.join(__dirname, '..');

const read = (p) => fs.readFileSync(p, 'utf8');
const stripJsComments = (js) =>
  js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const html = read(path.join(PUB, 'index.html'));
const js = (name) => stripJsComments(read(path.join(JS_DIR, name)));
const srv = (rel) => stripJsComments(read(path.join(SRV, rel)));

/** index.html 里按加载顺序引用的前端脚本（含 defer） */
const loadedScripts = [...html.matchAll(/<script[^>]*\ssrc="\/js\/(?:[\w.-]+\/)*([\w.-]+\.js)(?:\?[^"]*)?"/g)]
  .map((m) => m[1]);

/** loader.js 里 ROUTE_MODULES 数组声明的懒加载路由模块（SPA 按需加载，不写 <script>） */
const loaderJs = read(path.join(JS_DIR, 'loader.js'));
const loaderModules = new Set(
  [...loaderJs.matchAll(/'([\w.-]+\.js)'/g)].map((m) => m[1])
);

/** 被 public 下任意一个 HTML 页面引用、或被 loader.js 懒加载的脚本 */
const scriptsUsedByAnyPage = new Set();
for (const f of fs.readdirSync(PUB).filter((x) => x.endsWith('.html'))) {
  const src = read(path.join(PUB, f));
  for (const m of src.matchAll(/<script[^>]*\ssrc="\/js\/(?:[\w.-]+\/)*([\w.-]+\.js)(?:\?[^"]*)?"/g)) {
    scriptsUsedByAnyPage.add(m[1]);
  }
}
for (const m of loaderModules) scriptsUsedByAnyPage.add(m);

/** 全站所有可能被加载的前端脚本（index.html 急切加载 + loader.js 懒加载） */
const allLoadedScripts = [...new Set([...loadedScripts, ...loaderModules])];

// ---------------------------------------------------------------------------

describe('同名全局函数不得跨文件重复定义（后加载者会静默覆盖前者）', () => {
  // 这一类错误不报任何错：两个文件各写一个 function foo，
  // 浏览器按加载顺序把后者覆盖前者，前者整段变成死代码。
  // 后来的人（包括改这段代码的我）很容易改到永远不会执行的那一份，
  // 改完发现"没生效"，却完全看不出为什么。
  //
  // 实际后果举例：
  //   - showGlobalLoading/hideGlobalLoading：ui.js 覆盖 core.js，
  //     而 ui.js 那份操作的 #globalLoading 在 HTML 里不存在 → 加载指示器全站失效
  //   - loadMePage：ui.js 那份被 admin-users.js 覆盖，
  //     导致只有它才调用的 updateMeStats() 从没执行 → 个人中心四张统计卡永远空着

  const defs = {}; // 函数名 -> [文件]
  for (const file of allLoadedScripts) {
    const p = path.join(JS_DIR, file);
    if (!fs.existsSync(p)) continue;
    const src = stripJsComments(read(p));
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      (defs[m[1]] = defs[m[1]] || new Set()).add(file);
    }
  }

  test('被 index.html 加载的脚本之间没有同名全局函数', () => {
    const dup = Object.entries(defs)
      .filter(([, files]) => files.size > 1)
      .map(([name, files]) => `${name}: ${[...files].join(' , ')}`);
    expect(dup).toEqual([]);
  });

  test('同一个文件内部也不得把同名函数写两遍', () => {
    const dup = [];
    for (const file of allLoadedScripts) {
      const p = path.join(JS_DIR, file);
      if (!fs.existsSync(p)) continue;
      const src = stripJsComments(read(p));
      const seen = new Map();
      for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
        seen.set(m[1], (seen.get(m[1]) || 0) + 1);
      }
      for (const [name, n] of seen) if (n > 1) dup.push(`${file}:${name} × ${n}`);
    }
    expect(dup).toEqual([]);
  });

  test('public/js 下不得存在任何 HTML 页面都没引用的脚本', () => {
    // admin-db.js 就是这么烂掉的：整个文件（25 个函数、一套数据库管理面板）
    // 既没有 <script> 引入，也没有对应的 HTML，却在别处留下
    // `if (typeof checkDbPermission === 'function')` 这种"看起来接好了"的调用。
    // checkin.js / achievements.js 更严重：后端接口、数据表、CSS、i18n 全都齐了，
    // 只差 index.html 里的两行 script，整套签到与成就功能对用户完全不可见。
    // 这类文件不会报任何错，只会让人以为功能存在。
    //
    // 例外（有意下线、保留资产的脚本，删除前先确认security-regressions仍引用）：
    //   live.js —— 前端直播模块已从 loader.js ROUTE_MODULES 移除（docs/19 P1-5：
    //   缺外部转码管线）。2026-09-12 P1-5 收尾：后端路由也已卸载并归档至
    //   routes/_archive/live.js，DISABLED_FEATURES 成为唯一事实来源。
    //   security-regressions.test.js 仍读取该文件校验"前端上传契约与后端对齐"，
    //   故前端文件保留在原位。若重新启用直播（P1-5 落地），把前端加回
    //   ROUTE_MODULES、后端移回 routes/ 并恢复挂载，同时移除下方防复活守卫。
    const intentionallyUnloaded = new Set(['live.js']);
    const orphans = fs
      .readdirSync(JS_DIR)
      .filter((f) => f.endsWith('.js') && !scriptsUsedByAnyPage.has(f) && !intentionallyUnloaded.has(f));
    expect(orphans).toEqual([]);
  });

  test('P1-5 防复活：前端已下线的 /api/live 后端不得仍被挂载', () => {
    // 「前端隐藏、后端裸露」曾是本仓库的安全惯性（P2-4 同类）。
    // loader.js DISABLED_FEATURES 下线了直播入口，服务端就必须同步不可达，
    // 否则未鉴权的直播列表/详情接口仍在公网上暴露。
    const serverSrc = srv('server.js');
    expect(serverSrc).not.toMatch(/app\.use\(\s*['"]\/api\/live/);
    expect(serverSrc).not.toMatch(/require\(\s*['"]\.\/routes\/live/);
  });
});

// ---------------------------------------------------------------------------

describe('全局加载指示器必须真的能显示', () => {
  const coreJs = js('core.js');

  test('showGlobalLoading 在元素不存在时要自己创建，而不是静默什么都不做', () => {
    const i = coreJs.indexOf('function showGlobalLoading');
    expect(i).toBeGreaterThan(-1);
    const body = coreJs.slice(i, coreJs.indexOf('\n}', i));
    // 原写法 `getElementById(x) || {style:{}}` 让下面的 `if (!bar)` 恒不成立，
    // 创建元素的分支是死代码 —— 而 index.html 里并没有这个元素。
    expect(body).not.toMatch(/getElementById\([^)]*\)\s*\|\|\s*\{/);
    expect(body).toMatch(/createElement\(/);
    expect(body).toMatch(/appendChild\(/);
  });

  test('它引用的元素要么在 HTML 里存在，要么由自己创建', () => {
    for (const fn of ['showGlobalLoading', 'hideGlobalLoading']) {
      const i = coreJs.indexOf(`function ${fn}`);
      const body = coreJs.slice(i, coreJs.indexOf('\n}', i));
      for (const m of body.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)) {
        const id = m[1];
        const inHtml = new RegExp(`\\sid="${id}"`).test(html);
        const selfCreated = new RegExp(`\\.id\\s*=\\s*['"]${id}['"]`).test(coreJs);
        expect({ fn, id, inHtml, selfCreated }).toEqual({ fn, id, inHtml, selfCreated: selfCreated || inHtml });
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('VRChat 上游临时故障不得销毁用户的登录凭据', () => {
  const vrcJs = srv('vrc.js');
  // P2-66 god-route 拆分：vrcWithFallback 实现迁至 groups_helpers.js，
  // 群组同步路由迁至 groups_members_sync.js，守卫随实现迁移。
  const groupsHelpersJs = srv('routes/groups_helpers.js');
  const groupsSyncJs = srv('routes/groups_members_sync.js');

  test('vrc.js 导出带 HTTP 状态的取当前用户接口', () => {
    expect(vrcJs).toMatch(/async\s+function\s+vrchatGetCurrentUserResult\s*\(/);
    expect(vrcJs).toMatch(/vrchatGetCurrentUserResult,/);
  });

  test('vrchatGetCurrentUserResult 不能因为上游返回 HTML 就抛异常', () => {
    const i = vrcJs.indexOf('async function vrchatGetCurrentUserResult');
    const body = vrcJs.slice(i, vrcJs.indexOf('\n}', i));
    // VRChat 故障时会返回 HTML 错误页，裸 JSON.parse 会把调用方整个炸掉。
    // 现实现经 vrchatRequest 委托，由 vrchatRequest 内部的 readJsonResponse 兜底 JSON 安全。
    expect(vrcJs).toMatch(/async function readJsonResponse[\s\S]*try\s*\{[\s\S]*JSON\.parse/);
    expect(body).toMatch(/await\s+vrchatRequest\(/);
    expect(body).toMatch(/return\s*\{\s*status:\s*r\.status/);
  });

  test('vrcWithFallback 只认 401，不能把 null 或 5xx 当成登录失效', () => {
    expect(groupsHelpersJs).toMatch(/const\s+unauthorized\s*=\s*result\?\.status\s*===\s*401\s*;/);
    expect(groupsHelpersJs).not.toMatch(/unauthorized\s*=\s*result\s*===\s*null/);
  });

  test('同步路由把「登录过期」和「上游故障」分开处理', () => {
    const i = groupsSyncJs.indexOf("router.post('/group/members/sync'");
    const body = groupsSyncJs.slice(i, i + 3000);
    // 401 才提示重新登录/重新绑定
    expect(body).toMatch(/status\s*===\s*401[\s\S]{0,400}VRC_COOKIE_EXPIRED/);
    // 其它非 200 走 sendVrcError 分流（会给出"限流"之类的准确原因）
    expect(body).toMatch(/status\s*!==\s*200[\s\S]{0,200}sendVrcError/);
  });
});

// ---------------------------------------------------------------------------

describe('群组同步不能把自己或整站拖住', () => {
  // P2-66 god-route 拆分：同步域整体迁至 groups_members_sync.js（同为工厂内 2 空格缩进，切片锚点不变）
  const groupsSyncJs = srv('routes/groups_members_sync.js');
  const syncStart = groupsSyncJs.indexOf("router.post('/group/members/sync'");
  const syncBody = groupsSyncJs.slice(syncStart, groupsSyncJs.indexOf('\n  });', syncStart));

  test('分页循环必须有轮次上限', () => {
    // 原来是 while (true)：上游一旦忽略 offset 一直返回满页，
    // 这个请求就永远不会结束，还会一直反复打 VRChat 直到撞限流。
    expect(syncBody).not.toMatch(/while\s*\(\s*true\s*\)/);
    expect(syncBody).toMatch(/MAX_PAGES/);
    expect(syncBody).toMatch(/while\s*\(\s*page\s*<\s*MAX_PAGES\s*\)/);
  });

  test('整个 routes 目录都不许出现无上限的 while(true) 分页', () => {
    const dir = path.join(SRV, 'routes');
    const bad = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = stripJsComments(read(path.join(dir, f)));
      if (/while\s*\(\s*true\s*\)/.test(src)) bad.push(f);
    }
    expect(bad).toEqual([]);
  });

  test('同一时刻只允许一次全量同步', () => {
    // 前端超时后用户会重复点；并发同步会互相看到对方
    // `UPDATE ... is_member=0` 的中间态，写出成片假的"已离开群组"。
    expect(groupsSyncJs).toMatch(/let\s+syncInFlight\s*=\s*false/);
    expect(syncBody).toMatch(/if\s*\(\s*syncInFlight\s*\)/);
    expect(syncBody).toMatch(/syncInFlight\s*=\s*true/);
    // 必须在 finally 里复位，否则一次异常就永久锁死同步功能
    expect(syncBody).toMatch(/finally\s*\{[\s\S]{0,200}syncInFlight\s*=\s*false/);
  });

  test('事务里不能对每个成员逐条查询/写入（N+1）', () => {
    // 一千人就是两千次串行往返，全压在一个事务里长时间锁住 group_roster。
    expect(syncBody).not.toMatch(/for\s*\([^)]*of\s+allMembers\s*\)[\s\S]{0,400}conn\.query\([^)]*SELECT[^)]*group_roster/);
    // 改成一次性取回已存在的 ID + 批量 upsert
    expect(syncBody).toMatch(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
  });
});

// ---------------------------------------------------------------------------

describe('长耗时接口的前端超时与按钮恢复', () => {
  const coreJs = js('core.js');
  const groupJs = js('group.js');

  test('api() 支持按调用方指定超时，而不是写死 10 秒', () => {
    const i = coreJs.indexOf('async function api(');
    const body = coreJs.slice(i, i + 2000);
    expect(body).toMatch(/opt\.timeout/);
    expect(body).not.toMatch(/setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*10000\)/);
  });

  test('群组同步必须给足超时（默认 10 秒会在服务端还在跑时就 abort）', () => {
    const i = groupJs.indexOf('async function syncGroupMembers');
    const body = groupJs.slice(i, groupJs.indexOf('\n}', i));
    const m = body.match(/timeout:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(60000);
  });

  test('presence/contribute 前端超时必须给足（20s 在服务端串行拉好友页时会被 abort）', () => {
    const i = groupJs.indexOf('async function contributePresence');
    const body = groupJs.slice(i, groupJs.indexOf('\n}', i));
    const m = body.match(/timeout:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(60000);
  });

  test('presence/contribute 服务端收紧好友分页预算且客户端中断即止损', () => {
    const s = srv('routes/groups_members_sync.js');
    const i = s.indexOf("router.post('/group/presence/contribute'");
    const body = s.slice(i, s.indexOf('\n  return router;', i));
    // 分页上限必须收紧（≤5 页），避免最坏 2×20=40 页串行拉取拖爆 20s 客户端超时
    expect(body).toMatch(/vrchatGetFriendsOnlineMap\(c,\s*\{\s*maxPages:\s*5\b/);
    // 客户端中断（req.aborted / res.destroyed）时立即停止，不再消耗配额与 DB 写入
    expect(body).toMatch(/req\.aborted\s*\|\|\s*res\.destroyed/);
    expect(body).toMatch(/aborted\s*=\s*true/);
    expect(body).toMatch(/result\.aborted/);
  });

  test('同步按钮的恢复放在 finally，且重复点击会被挡住', () => {
    const i = groupJs.indexOf('async function syncGroupMembers');
    const body = groupJs.slice(i, groupJs.indexOf('\n}', i));
    expect(body).toMatch(/if\s*\(\s*btn\.disabled\s*\)\s*return/);
    expect(body).toMatch(/finally\s*\{[\s\S]{0,300}btn\.disabled\s*=\s*false/);
  });

  test('先 disable 按钮再做异步操作的，恢复必须写在 finally', () => {
    // 判据：`x.disabled = true` 出现在第一个 await / .then( 之前，
    // 且函数里出现过 `x.disabled = false`（说明本来就打算恢复）。
    // 这样能排除"拿到结果后按状态设 disabled"的正常写法（点赞按钮等）。
    //
    // 中途 return 或二次抛错都可能绕过散落各处的恢复语句，
    // 把按钮永久留在禁用状态 —— 用户看到的就是"点了一次就再也点不动"。
    // 实际抓到的几处：
    //   - init.js:runEnvCheck 环境检查失败时按钮留在 disabled，
    //     却把 onclick 设成了"重试" → 初始化向导彻底走不下去。
    //   - group.js:refreshGroupStatus 把恢复语句抄了三份（早退/catch/末尾），
    //     任何一条新增的 return 路径漏抄就报废。
    //   - posts.js:submitCreatePost/submitEditPost 成功分支不恢复，
    //     一旦模态框没被正确移除，用户整个会话只能发一次帖。
    const offenders = [];
    for (const file of loadedScripts) {
      const p = path.join(JS_DIR, file);
      if (!fs.existsSync(p)) continue;
      const src = stripJsComments(read(p));
      for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
        const start = m.index;
        let depth = 0, end = start;
        for (let i = src.indexOf('{', start); i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        const body = src.slice(start, end + 1);
        const dis = body.match(/(\w+)\.disabled\s*=\s*true/);
        if (!dis) continue;
        const v = dis[1];
        if (!new RegExp(`${v}\\.disabled\\s*=\\s*false`).test(body)) continue;
        const asyncAt = body.search(/\bawait\s|\.then\s*\(/);
        if (asyncAt < 0 || dis.index > asyncAt) continue;
        const restoreInFinally =
          new RegExp(`finally\\s*\\{[\\s\\S]*?${v}\\.disabled\\s*=\\s*false`).test(body) ||
          new RegExp(`\\.finally\\s*\\([\\s\\S]*?${v}\\.disabled\\s*=\\s*false`).test(body);
        if (!restoreInFinally) offenders.push(`${file}:${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('通过 FormData 提交的接口必须自己判 res.ok', () => {
    // apiForm() 只对 401/403/429/5xx 抛错，400（内容超长、文件类型不支持等）
    // 会正常 resolve。不判 ok 就会在服务端已经拒绝的情况下弹"发布成功"。
    const offenders = [];
    for (const file of loadedScripts) {
      const p = path.join(JS_DIR, file);
      if (!fs.existsSync(p)) continue;
      const src = stripJsComments(read(p));
      // apiForm(...).then(function (r) { return r.json(); })  —— 直取 json 不判 ok
      for (const m of src.matchAll(/apiForm\([\s\S]{0,300}?\.then\(\s*function\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+\1\.json\(\)\s*;?\s*\}/g)) {
        offenders.push(`${file} @${m.index}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('查询用户私有数据的路由必须按 user_id 过滤', () => {
  // 实际抓到：achievements.js 的 /me、/me/type/:type、/me/unlocked、/me/locked
  // 四个端点全都 `FROM user_achievements ua LEFT JOIN achievements a ...` 之后
  // 忘了写 `WHERE ua.user_id = ?` —— userId 变量取出来了却根本没用上。
  // 后果不只是数据不对：任何登录用户都能读到全站所有人的成就进度，是越权泄露。
  // 这种漏洞不会报错、不会崩，只有专门去看 SQL 才发现。

  // 只保存"某个用户的"数据的表，查询时必须带 user_id 条件
  const PRIVATE_TABLES = [
    'user_achievements',
    'user_checkins',
    'user_favorites',
    'notifications',
  ];

  const routesDir = path.join(SRV, 'routes');
  const routeFiles = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'));

  test('/me 系列端点的 SQL 都带 user_id 过滤', () => {
    const offenders = [];
    let checked = 0;
    for (const f of routeFiles) {
      const src = stripJsComments(read(path.join(routesDir, f)));
      const blocks = src.split(/router\.(?=get\(|post\(|put\(|delete\()/).slice(1);
      for (const block of blocks) {
        const m = block.match(/^\w+\(\s*'([^']+)'/);
        if (!m) continue;
        const route = m[1];
        if (!/^\/me(\/|$)/.test(route)) continue;
        // 抽出这个路由块里所有 SQL 字面量（模板串 + 普通串），
        // 不管私有表出现在 FROM 还是 JOIN 还是子查询里都能覆盖到。
        const sqls = [
          ...[...block.matchAll(/`([^`]*?(?:SELECT|UPDATE|DELETE)[^`]*?)`/gi)].map((x) => x[1]),
          ...[...block.matchAll(/'((?:SELECT|UPDATE|DELETE)[^']*)'/gi)].map((x) => x[1]),
        ];
        for (const sql of sqls) {
          const table = PRIVATE_TABLES.find((t) => new RegExp('\\b' + t + '\\b', 'i').test(sql));
          if (!table) continue;
          checked++;
          if (!/user_id\s*=\s*\?/i.test(sql)) {
            offenders.push(`${f} ${route} -> 触碰 ${table} 却没有 user_id 过滤`);
          }
        }
      }
    }
    // 守住扫描器本身：如果一条 SQL 都没抽到，说明正则失效了，
    // 这个测试会变成永远通过的摆设。
    expect(checked).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });

  test('成就接口以成就目录为基准，新用户也能看到全部锁定成就', () => {
    // 原实现 `FROM user_achievements` 起手，新注册用户在这张表里一行都没有，
    // 于是返回 achievements: [] 却同时报 totalAchievements: 29，
    // 前端渲染出一个完全空白的成就墙。
    const src = stripJsComments(read(path.join(routesDir, 'achievements.js')));
    const i = src.indexOf("router.get('/me',");
    const block = src.slice(i, src.indexOf("router.get('/me/type", i));
    expect(block).toMatch(/FROM\s+achievements\s+a/i);
    expect(block).toMatch(/LEFT JOIN\s+user_achievements\s+ua/i);
    expect(block).toMatch(/ua\.user_id\s*=\s*\?/i);
  });

  test('百分比计算要防 condition_value 为 0（Infinity/NaN 会写进 style.width）', () => {
    const src = stripJsComments(read(path.join(routesDir, 'achievements.js')));
    const bad = [...src.matchAll(/percentage:\s*Math\.min\(100,\s*Math\.round\(\(/g)];
    expect(bad.map((m) => m.index)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('样式表必须真的被页面加载', () => {
  // checkin.css / achievements.css 写好了，却既不在任何 HTML 的 <link> 里，
  // 也不在 style.css 的 @import 列表里 —— 两个模块的卡片以完全无样式的
  // 裸 HTML 渲染（实测 padding:0 borderRadius:0 background:transparent）。
  // 和"孤儿脚本"是同一类问题：文件写完了但从没接进构建入口。
  const CSS_DIR = path.join(PUB, 'css');

  // 明确记录"存在但有意不引入"的文件，避免这条测试被随手加白名单绕过
  const INTENTIONALLY_UNUSED = {
    'animations.css': '定义了 .animate-* 工具类，全站 HTML/JS 均未使用，引入只会增加体积',
    'social.css': '旧社交页样式，已被 10-social.css（friends/follows 模块）取代',
    'favorites.css': '收藏功能样式，对应功能未上线（favorites.js 已归档至 _archive/）',
    'share-page.css': '分享落地页样式，对应 share.html 页面尚未实现',
  };

  const referencedCss = () => {
    const refs = new Set();
    for (const f of fs.readdirSync(PUB)) {
      if (!f.endsWith('.html')) continue;
      const src = read(path.join(PUB, f));
      for (const m of src.matchAll(/<link[^>]*\shref="\/css\/([\w.-]+\.css)(?:\?[^"]*)?"/g)) refs.add(m[1]);
    }
    for (const f of fs.readdirSync(CSS_DIR)) {
      if (!f.endsWith('.css')) continue;
      const src = read(path.join(CSS_DIR, f));
      for (const m of src.matchAll(/@import\s+url\(\s*['"]?([\w.-]+\.css)(?:\?[^'")]*)?['"]?\s*\)/g)) refs.add(m[1]);
    }
    return refs;
  };

  test('public/css 下没有既不被 <link> 也不被 @import 引用的样式表', () => {
    const refs = referencedCss();
    const orphans = fs
      .readdirSync(CSS_DIR)
      .filter((f) => f.endsWith('.css'))
      .filter((f) => !refs.has(f))
      .filter((f) => !INTENTIONALLY_UNUSED[f]);
    expect(orphans).toEqual([]);
  });

  test('签到与成就的样式表确实被引入', () => {
    const refs = referencedCss();
    expect(refs.has('checkin.css')).toBe(true);
    expect(refs.has('achievements.css')).toBe(true);
  });

  test('白名单里的文件必须真的存在（防止白名单腐烂成永久豁免）', () => {
    for (const f of Object.keys(INTENTIONALLY_UNUSED)) {
      expect(fs.existsSync(path.join(CSS_DIR, f))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe('index.html 内联的事件绑定不得指向不存在的元素', () => {
  // index.html 里的 bindClick/bindInput/bindChange 都是 `if (el) ...` 形式，
  // 元素不存在时静默跳过，不报任何错。于是"HTML 改了但绑定没跟上"这类问题
  // 会表现为"按钮点了没反应"，且控制台干干净净，极难排查。
  // 账号菜单的"我的资料"就是这么坏掉的（见下一条）。

  const declaredIds = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));

  test('bindClick/bindInput/bindChange 引用的 id 都在页面里存在', () => {
    const bound = [
      ...new Set(
        [...html.matchAll(/\bbind(?:Click|Input|Change)\(\s*'([\w-]+)'/g)].map((m) => m[1])
      ),
    ];
    // 守住扫描器：绑定数为 0 说明正则失效了
    expect(bound.length).toBeGreaterThan(50);
    expect(bound.filter((id) => !declaredIds.has(id))).toEqual([]);
  });

  test('账号下拉菜单的每一项都有点击绑定', () => {
    const itemIds = [...html.matchAll(/id="(userDropdown\w+)"/g)].map((m) => m[1]);
    expect(itemIds.length).toBeGreaterThanOrEqual(3);
    const unbound = itemIds.filter(
      (id) => !new RegExp("bindClick\\(\\s*'" + id + "'").test(html)
    );
    expect(unbound).toEqual([]);
  });

  test('账号菜单不再并列"个人中心"和"我的资料"两个同义入口', () => {
    // 两者都指向同一份资料：#tab-me 里就有完整的编辑表单，
    // 而 showEditProfileModal() 依赖 profileUser（只在打开他人主页时才有值），
    // 从头部菜单调用时首行 `if (!profileUser) return;` 直接静默返回。
    // 已合并为单项"我的信息"。
    expect(html).not.toMatch(/id="userDropdownEdit"/);
    expect(html).toMatch(/id="userDropdownProfile"[^>]*data-i18n="nav\.my_info"/);
  });

  test('showEditProfileModal 只在 profileUser 已就绪的页面里被调用', () => {
    // 允许 profile-page.js 内部调用（那里 profileUser 一定已加载），
    // 但 index.html 的全局菜单不能再直接调它。
    // 注意要先剥掉注释，否则解释这段历史的注释文本本身会被判成调用。
    const code = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/showEditProfileModal\s*\(/);
  });
});

// ---------------------------------------------------------------------------

describe('i18n：新增的界面文案要覆盖全部语言', () => {
  const LANG_DIR = path.join(JS_DIR, 'languages');
  const LANGS = ['zh', 'en', 'ja', 'fr', 'de', 'ru'];

  test('index.html 用到的 data-i18n key 在所有语言里都有（否则会回退成中文）', () => {
    // __() 缺 key 时回退到 zh，非中文用户会看到夹杂的中文块，不报错但体验降级。
    const keys = [...new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]))];
    expect(keys.length).toBeGreaterThan(20);

    const missing = [];
    for (const l of LANGS) {
      const src = read(path.join(LANG_DIR, `${l}.js`));
      for (const k of keys) {
        const re = new RegExp('["\']' + k.replace(/\./g, '\\.') + '["\']\\s*:');
        if (!re.test(src)) missing.push(`${l}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('语言包里不得残留「拼接到一半」的前缀键（如 events.month_）', () => {
    // 动态拼接的前缀一旦被当成完整键写进语言包，静态审计会把它当成"引用到了、但缺后缀"
    // 的假阳性，真正的缺键反而被淹没；同时代码运行时永远命中不了它（拼接结果带后缀）。
    const prefixes = ['nav.', 'error.', 'events.month_', 'events.weekday_',
      'friends.feed_', 'home.feature_cat_', 'home.feature_desc_'];
    const orphans = [];
    for (const l of LANGS) {
      const src = read(path.join(LANG_DIR, `${l}.js`));
      for (const p of prefixes) {
        if (new RegExp('["\']' + p.replace(/\./g, '\\.') + '["\']\\s*:').test(src)) orphans.push(`${l}: ${p}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  test('语言包与 i18n.js 的 ?v= 必须等于 I18N_PACK_VERSION（否则修复送不到客户端）', () => {
    // 带 ?v= 的静态资源：服务端 max-age=31536000 immutable（server.js），SW 对 ?v= 资源
    // cache-first 且零网络（sw.js）。也就是说改语言包内容本身对老客户端完全无效，
    // 唯一的失效手段就是换 URL 里的 ?v=。因此存在三方联动：
    //   i18n.js 的 I18N_PACK_VERSION 拼出运行时加载的包 URL
    //   各 HTML 里 document.write 的首包 ?v= 必须与它一致
    //   引用 /js/i18n.js 的 ?v= 也必须一致 —— 只改常量不改标签，老客户端仍在执行
    //   缓存里的旧 i18n.js、继续请求旧包，本次月份名修复就永远到不了线上。
    // 2026-09-12 核查 P1-8 时实测到三方漂移（index.html=20260906g、四个辅助页=20260906f、
    // 常量=20260912a），故加此守卫。
    const ver = js('i18n.js').match(/const I18N_PACK_VERSION\s*=\s*'([^']+)'/);
    expect(ver).not.toBeNull();
    const version = ver[1];

    const pages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(3);

    const drift = [];
    let pinned = 0;
    for (const f of pages) {
      for (const line of read(path.join(PUB, f)).split('\n')) {
        if (!/src=|document\.write/.test(line)) continue;
        if (!/languages\/|\/js\/i18n\.js/.test(line)) continue;
        const at = line.match(/\?v=([\w.-]+)/);
        if (!at) continue; // 不带版本号的（setup.html）走 etag 协商缓存，每次都是最新的
        pinned++;
        if (at[1] !== version) drift.push(`${f}: ?v=${at[1]} != I18N_PACK_VERSION ${version}`);
      }
    }
    expect(pinned).toBeGreaterThan(5);
    expect(drift).toEqual([]);
  });

  test('错误码翻译缺失时必须回退后端原文，而不是把 error.XXX 键名渲染给用户', () => {
    // error.<code> 的后缀来自服务端运行时（含上游 VRChat 透传码），无法穷举，
    // 所以这条链路的正确性靠"未命中就回退 message"的契约兜底，这里守住契约本身。
    // 契约已集中到 core.js errText()（翻译失败回退 d.error/detail/message），
    // 各业务页统一委托 errText，不再允许内联 `t !== 'error.' + code` 各写一份。
    const core = js('core.js');
    expect(core).toMatch(/__\(\s*['"]error\.['"]\s*\+\s*code\s*\)/);
    expect(core).toMatch(/translated\s*!==\s*['"]error\.['"]\s*\+\s*code/);
    expect(core).toMatch(/function\s+errText\s*\(/);
    for (const f of ['friends.js', 'follows.js']) {
      const src = js(f);
      expect(src).toMatch(/\berrText\s*\(/);
      expect(src).not.toMatch(/['"]error\.['"]\s*\+\s*code/);
    }
  });

  test('运行时拼接出来的 i18n 键必须在全部 6 种语言里都存在（P1-8 同类缺陷防护）', () => {
    // 静态审计脚本（server/scripts/audit-i18n-full.js）只能匹配字符串字面量常量，
    // `__('nav.' + it.tab)` 这类拼接它只会记录成残缺前缀 `nav.`，永远发现不了缺键 ——
    // P1-8 正是这么漏掉的；本次核查又抓出 events.month_1..12 在 6 种语言里全缺，
    // 日历/周视图/某日清单表头直接把原始键名渲染给用户。
    const SKIP_DIRS = new Set(['languages', '_archive', '_unwired']);
    const liveFiles = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(f); }
        else if (e.name.endsWith('.js')) liveFiles.push(f);
      }
    })(JS_DIR);
    expect(liveFiles.length).toBeGreaterThan(30);

    const found = new Map();
    for (const f of liveFiles) {
      const src = stripJsComments(read(f));
      for (const m of src.matchAll(/__\(\s*(['"])([^'"]+)\1\s*\+/g)) {
        if (!found.has(m[2])) found.set(m[2], path.basename(f));
      }
    }

    const FEATURE_TABS = ['members', 'vrc', 'chat', 'friends', 'follows', 'announcements',
      'posts', 'album', 'live', 'events', 'map', 'birthday', 'notifications', 'me', 'admin'];
    const FEATURE_CATS = ['community', 'content', 'discover', 'personal', 'admin'];
    const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const SUFFIXES = {
      'nav.': FEATURE_TABS,
      'home.feature_desc_': FEATURE_TABS,
      'home.feature_cat_': FEATURE_CATS,
      'events.weekday_': WEEKDAYS,
      'events.month_': Array.from({ length: 12 }, (_, i) => String(i + 1)),
      'friends.feed_': ['post', 'sign', 'photo'],
    };

    const dynamicPrefixes = [...found.keys()].filter((p) => p !== 'error.').sort();
    // 双向锁：新增了拼接点却没登记后缀清单 → 炸；清单里的拼接点被删掉/改写 → 也炸，
    // 避免这条守卫悄悄退化成什么都不检查的摆设。
    expect(dynamicPrefixes).toEqual(Object.keys(SUFFIXES).sort());

    // 清单必须与 home.js / events.js / friends.js 里的真实取值来源一致
    const home = stripJsComments(read(path.join(JS_DIR, 'home.js')));
    expect([...new Set([...home.matchAll(/tab:\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort())
      .toEqual([...FEATURE_TABS].sort());
    expect([...new Set([...home.matchAll(/cat:\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort())
      .toEqual([...FEATURE_CATS].sort());
    const events = stripJsComments(read(path.join(JS_DIR, 'events.js')));
    expect(events).toMatch(/\['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'\]/);
    const friends = stripJsComments(read(path.join(JS_DIR, 'friends.js')));
    expect(friends).toMatch(/'post'\s*\?\s*'post'\s*:\s*[^?:]*'event_sign'\s*\?\s*'sign'\s*:\s*'photo'/);

    const missing = [];
    for (const l of LANGS) {
      const src = read(path.join(LANG_DIR, `${l}.js`));
      for (const prefix of dynamicPrefixes) {
        for (const suffix of SUFFIXES[prefix]) {
          const key = prefix + suffix;
          const re = new RegExp('["\']' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']\\s*:');
          if (!re.test(src)) missing.push(`${l}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('地理定位：必须区分「用户拒绝授权」和「非安全上下文」', () => {
  // 用户反馈：地图点"共享位置"提示要开定位，但浏览器从来没弹过授权框。
  //
  // 实测（puppeteer + CDP 对照）：
  //   http://127.0.0.1:3456     isSecureContext=true  → "User denied Geolocation"
  //   http://192.168.2.104:3456 isSecureContext=false → "Only secure origins are allowed"
  //
  // 关键陷阱：非安全上下文下 navigator.geolocation **对象依然存在**，
  // 所以 `if (!navigator.geolocation)` 拦不住；而失败回调的 err.code 也是 1
  // （与"用户拒绝"完全相同），代码若只看 code 就会提示用户去授权一个
  // 根本没出现过的弹窗 —— 用户永远走不出这个死循环。
  // 唯一可靠的区分方式是 window.isSecureContext（message 文本会随浏览器版本变）。

  const GEO_CALLERS = ['map.js', 'profile.js', 'chat.js'];

  test('core.js 提供统一的可用性守卫与错误翻译，且不与其他文件重名', () => {
    const core = js('core.js');
    for (const fn of ['geoAvailability', 'ensureGeolocation', 'geoErrorKey', 'toastGeoError']) {
      expect(core).toMatch(new RegExp(`function\\s+${fn}\\s*\\(`));
    }
    expect(core).toMatch(/window\.isSecureContext/);

    // 全局脚本同名函数会被后加载者静默覆盖（本项目已栽过 9 次），这里守住。
    // loadedScripts 只保留了文件名，languages/ 等子目录脚本拼不出路径，跳过即可
    // —— 语言包里只有字典，不会定义函数。
    const dupes = [];
    let scanned = 0;
    for (const f of allLoadedScripts) {
      if (f === 'core.js') continue;
      if (!fs.existsSync(path.join(JS_DIR, f))) continue;
      scanned++;
      const src = js(f);
      for (const fn of ['geoAvailability', 'ensureGeolocation', 'geoErrorKey', 'toastGeoError']) {
        if (new RegExp(`function\\s+${fn}\\s*\\(`).test(src)) dupes.push(`${f}: ${fn}`);
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(dupes).toEqual([]);
  });

  test('调用 geolocation 前不得只判断 navigator.geolocation 是否存在', () => {
    // 这是本 bug 的直接成因：该对象在非安全上下文下照样存在。
    const offenders = [];
    for (const f of GEO_CALLERS) {
      const src = js(f);
      if (/if\s*\(\s*!\s*navigator\.geolocation\s*\)/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test('每个调用 geolocation 的文件都先经过 ensureGeolocation 守卫', () => {
    const missing = [];
    let checked = 0;
    for (const f of GEO_CALLERS) {
      const src = js(f);
      if (!/navigator\.geolocation\.(getCurrentPosition|watchPosition)/.test(src)) continue;
      checked++;
      if (!/ensureGeolocation\s*\(/.test(src)) missing.push(f);
    }
    // 守卫断言：正则若失效导致一个文件都没扫到，这条会先炸，
    // 而不是让整个测试退化成永远通过的摆设。
    expect(checked).toBe(GEO_CALLERS.length);
    expect(missing).toEqual([]);
  });

  test('定位错误回调不得自行按 err.code === 1 判定为「用户拒绝」', () => {
    // 必须走 toastGeoError，由它先排除 isSecureContext === false 的情况。
    const offenders = [];
    for (const f of GEO_CALLERS) {
      const src = js(f);
      for (const m of src.matchAll(/err(?:or)?\.code\s*===?\s*1\b/g)) {
        offenders.push(`${f}: ${src.slice(Math.max(0, m.index - 60), m.index + 40).trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('geo.* 提示文案在 6 种语言里齐全，且非安全上下文的提示是可操作的', () => {
    const LANG_DIR = path.join(JS_DIR, 'languages');
    const KEYS = ['geo.insecure_context', 'geo.unsupported', 'geo.permission_denied',
      'geo.unavailable', 'geo.timeout', 'geo.failed'];
    const missing = [];
    for (const l of ['zh', 'en', 'ja', 'fr', 'de', 'ru']) {
      const src = read(path.join(LANG_DIR, `${l}.js`));
      for (const k of KEYS) {
        const re = new RegExp('["\']' + k.replace(/\./g, '\\.') + '["\']\\s*:');
        if (!re.test(src)) missing.push(`${l}: ${k}`);
      }
    }
    expect(missing).toEqual([]);

    // 光说"不支持"没用，必须告诉用户怎么办（换 https 或 localhost）。
    const zh = read(path.join(LANG_DIR, 'zh.js'));
    const line = zh.match(/["']geo\.insecure_context["']\s*:\s*([\s\S]{0,400}?)\n/);
    expect(line).not.toBeNull();
    expect(line[1]).toMatch(/https/);
    expect(line[1]).toMatch(/localhost/);
  });

  test('"更新我的位置"按钮用 id 选择，而不是不存在的 onclick 属性', () => {
    // index.html 里是 <button id="updateMyLocationBtn">，没有 onclick，
    // 原先 querySelector('[onclick="updateMyLocation()"]') 永远返回 null，
    // 点击后既不禁用也不显示"正在获取"，用户完全没有反馈。
    expect(html).toMatch(/id="updateMyLocationBtn"/);
    const p = js('profile.js');
    expect(p).not.toMatch(/querySelector\(\s*['"]\[onclick=/);
    expect(p).toMatch(/getElementById\(\s*['"]updateMyLocationBtn['"]\s*\)/);
  });

  test('地图定位成功后调用的刷新函数必须真实存在', () => {
    // 实测抓到 `loadMemberLocations is not defined`：定位成功回调里调了一个
    // 全站都不存在的函数，ReferenceError 直接打断回调 —— 提示弹了"共享成功"，
    // 但其他成员的标记永远拉不下来，正是用户报的"地图上什么也没有"。
    const src = js('map.js');
    const declared = new Set(
      [...src.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)].map((m) => m[1]));
    expect(declared.size).toBeGreaterThan(10);
    expect(declared.has('loadMemberLocations')).toBe(false);
    expect(src).not.toMatch(/\bloadMemberLocations\s*\(/);
    expect(src).toMatch(/fetchRealtimeLocations\s*\(/);
  });
});

// ---------------------------------------------------------------------------

describe('前端脚本不得调用任何全站都不存在的全局函数', () => {
  // loadMemberLocations 那个 bug 属于此类：非模块全局脚本，调错名字不会有任何
  // 静态报错，只有真的执行到那一行才炸 —— 而它藏在定位成功回调里，
  // 常规点击测试根本走不到。这里做一次全站静态交叉核对。

  // 浏览器/第三方库提供的全局，不在项目源码里声明，需白名单排除。
  const AMBIENT = new Set([
    'require', 'define', 'importScripts', 'structuredClone', 'queueMicrotask',
    'fetch', 'alert', 'confirm', 'prompt', 'atob', 'btoa', 'escape', 'unescape',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
    'cancelAnimationFrame', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
    'decodeURI', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'print',
    'getComputedStyle', 'requestIdleCallback',
    'L', 'Chart', 'io', 'moment', 'dayjs', 'hljs', 'marked', 'QRCode', 'Sortable',
  ]);

  test('每个被调用的裸函数名都能在某个已加载脚本里找到定义', () => {
    const files = allLoadedScripts.filter((f) => fs.existsSync(path.join(JS_DIR, f)));
    expect(files.length).toBeGreaterThan(20);

    // 1) 收集全站声明：function 声明、function 表达式赋值、箭头函数赋值、class
    const declared = new Set(AMBIENT);
    const sources = {};
    for (const f of files) {
      const src = js(f);
      sources[f] = src;
      for (const m of src.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) declared.add(m[1]);
      for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|\w+\s*=>)/g)) declared.add(m[1]);
      for (const m of src.matchAll(/class\s+(\w+)/g)) declared.add(m[1]);
      // class 方法简写（createContainer() { ... }）：既是声明，也不该被当成裸调用
      for (const m of src.matchAll(/^\s*(?:static\s+|async\s+|get\s+|set\s+)*(?:[$\w]+\s+)?(\w+)\s*\([^)]*\)\s*\{/gm)) declared.add(m[1]);
      // window.foo = ... 形式的挂载
      for (const m of src.matchAll(/window\.(\w+)\s*=/g)) declared.add(m[1]);
    }
    expect(declared.size).toBeGreaterThan(100);

    // 2) 找出「裸调用」：前面不是 . 也不是 function/new 关键字
    //
    // 只审查**项目自身命名风格**的名字：小写开头 + 至少一个大写字母的多词驼峰
    // （loadMemberLocations、fetchRealtimeLocations…）。这样自然排除了：
    //   - 内置构造函数与类（Date/Error/Promise/URLSearchParams…，首字母大写）
    //   - 回调形参与单词名（resolve/reject/callback/async…，无内部大写）
    // 否则扫描结果会被上百条噪音淹没，很快就没人再看，等于没有这条测试。
    const PROJECT_FN = /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/;
    // typeof X === 'function' 是防御式可选调用：明确允许目标不存在而不崩溃。
    // 这类调用本身是「安全的空操作」，不该被当成调错名字的 bug 上报。
    const guarded = new Set();
    for (const src of Object.values(sources)) {
      for (const m of src.matchAll(/typeof\s+(\w+)\s*===\s*'function'/g)) guarded.add(m[1]);
    }
    const missing = [];
    for (const [f, src] of Object.entries(sources)) {
      // 形参也可能是被调用的函数（回调），收集进来避免误报
      const localNames = new Set(
        [...src.matchAll(/(?:const|let|var)\s+(\w+)/g)].map((m) => m[1]));
      for (const m of src.matchAll(/(?:function\s*\w*|\))\s*\(([^)]*)\)/g)) {
        for (const p of m[1].split(',')) {
          const n = p.trim().replace(/[=:].*$/, '').replace(/^\.\.\./, '').trim();
          if (/^\w+$/.test(n)) localNames.add(n);
        }
      }
      for (const m of src.matchAll(/(^|[^.\w$'"`])(\w+)\s*\(/gm)) {
        const name = m[2];
        if (!PROJECT_FN.test(name)) continue;
        if (declared.has(name) || localNames.has(name) || guarded.has(name)) continue;
        missing.push(`${f}: ${name}()`);
      }
    }
    // 去重后报告，便于一眼看出问题
    expect([...new Set(missing)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('toast 并发溢出不得死循环卡死主线程', () => {
  // 2026-09-12 核查 P1-8 时浏览器实测复现：DB 断开后 home 的三个渲染器在同一个
  // Promise.all 里并发弹「服务器内部错误」。旧实现溢出清理用
  //   setTimeout(() => first.remove(), 300)
  // 异步移除，而 while 条件读的 children.length 在同步阶段永远不会减少 ——
  // 第 4 条 toast 一旦进入清理循环就原地空转，整个标签页主线程永久卡死
  // （CDP Profiler.stop 同步超时，证实为同步死循环而非异步堆积；表现为"页面突然全冻"，
  // 不抛任何错误）。这类缺陷运行时难定位，静态守卫成本低，必须钉死。
  test('core.js 的 toast 溢出循环必须同步移除旧节点，不得依赖 setTimeout', () => {
    const core = js('core.js');
    const start = core.indexOf('while (c.children.length >= MAX_TOASTS)');
    expect(start).toBeGreaterThan(-1);

    let depth = 0;
    let end = start;
    for (let i = core.indexOf('{', start); i < core.length; i++) {
      if (core[i] === '{') depth++;
      else if (core[i] === '}' && --depth === 0) { end = i; break; }
    }
    expect(end).toBeGreaterThan(start);
    const body = core.slice(start, end + 1);

    expect(body).toContain('first.remove()');
    expect(body).not.toMatch(/setTimeout/);
    // 空引用兜底：children 非空但 firstElementChild 理论上为 null 时必须退出，
    // 否则同样的死循环会以另一种形式复活。
    expect(body).toMatch(/if\s*\(\s*!\s*first\s*\)\s*(break|return|throw)/);
  });
});
