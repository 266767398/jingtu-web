/**
 * 第三轮真实浏览器/数据库排查中发现的回归防护。
 *
 * 这些测试全部对应线上实际出现过的用户可见故障，每条都写明了症状与根因，
 * 避免后续重构时再次踩同一个坑。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const LANG_DIR = path.join(PUB, 'js', 'languages');
const CSS_DIR = path.join(PUB, 'css');

const read = p => fs.readFileSync(p, 'utf8');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJsComments = js => js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const cssFiles = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));

// ---------------------------------------------------------------------------

describe('CSS 自定义属性必须先定义再引用', () => {
  // 症状：直播弹窗输入框在深色主题下白底配浅色文字，完全读不出内容。
  // 根因：`var(--input-bg, #f5f5f5)` 引用的 --input-bg 从未定义，永远走浅色回退值。
  // 更隐蔽的是无回退值的情况 —— 按 CSS 规范整条声明会在"计算值时"静默失效，
  // 浏览器既不报错、devtools 里也看不出异常，全站一共有 30 条这样的死声明。
  const defined = new Set();
  const referenced = new Map(); // name -> [{file, fallback}]

  for (const f of cssFiles) {
    const css = stripComments(read(path.join(CSS_DIR, f)));
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*(,([^()]*(?:\([^()]*\))?[^()]*))?\)/g)) {
      if (!referenced.has(m[1])) referenced.set(m[1], []);
      referenced.get(m[1]).push({ file: f, fallback: (m[3] || '').trim() });
    }
  }

  // 有些变量由 JS 在运行时通过 element.style.setProperty 写入，样式表里自然查不到定义
  const jsSet = new Set();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      for (const m of read(full).matchAll(/setProperty\(\s*['"](--[\w-]+)['"]/g)) jsSet.add(m[1]);
    }
  })(path.join(PUB, 'js'));

  test('每个被 var() 引用的变量都已在某个样式表里定义（或由 JS 运行时写入）', () => {
    // 只有「无回退值」的引用才是真 bug：按 CSS 规范，引用未定义且无回退的自定义属性，
    // 整条声明会在「计算值时」静默失效（如 var(--muted)）。
    // 带回退值的 var(--x, fallback) 是刻意的主题可覆盖设计模式（安全默认值），不算缺陷。
    const undef = [...referenced.keys()]
      .filter(n => !defined.has(n) && !jsSet.has(n) && referenced.get(n).some(r => r.fallback === ''))
      .sort();
    expect(undef).toEqual([]);
  });

  test('存在可用的定义来源，说明扫描确实抓到了变量表', () => {
    // 防止上面的断言因为正则失效而变成"扫到 0 个引用所以永远通过"
    expect(defined.size).toBeGreaterThan(50);
    expect(referenced.size).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------

describe('页面滚动不能被 overflow 传播规则打断', () => {
  // 症状：滚动条在、拖动滚动条有效、鼠标滚轮完全无反应；同时所有弹窗的滚动锁失效。
  // 根因：一条"兜底防滚动锁泄漏"的 `html{overflow-y:auto}`。
  //   html 一旦有非 visible 的 overflow，body→viewport 的 overflow 传播就被切断，
  //   body 退化成独立滚动容器，而它的高度恒等于内容高度（scrollHeight === clientHeight）
  //   因此根本滚不动，滚轮事件被吞掉；`overscroll-behavior-y:none` 又阻止了向上冒泡。
  //   同一条规则还让 `document.body.style.overflow='hidden'` 不再作用于视口。
  const rulesFor = (tag) => {
    const hits = [];
    for (const f of cssFiles) {
      const css = stripComments(read(path.join(CSS_DIR, f)));
      for (const m of css.matchAll(/(^|[}\s;])([^{}@]*?)\{([^{}]*)\}/g)) {
        const sel = m[2].trim();
        if (!sel) continue;
        const isTag = sel.split(',').some(s => s.trim() === tag || s.trim() === `${tag}:not(.no-scroll)`);
        if (isTag) hits.push({ file: f, sel, body: m[3] });
      }
    }
    return hits;
  };

  test('html 不设置 overflow，否则 body 的滚动会被隔离', () => {
    const bad = rulesFor('html')
      .filter(r => /(^|;)\s*overflow(-y)?\s*:\s*(auto|scroll|hidden)/.test(r.body))
      .map(r => `${r.file}: ${r.sel} { ${r.body.trim()} }`);
    expect(bad).toEqual([]);
  });

  test('body 不设置 overscroll-behavior-y:none，否则滚轮无法冒泡到视口', () => {
    const bad = rulesFor('body')
      .filter(r => /overscroll-behavior(-y)?\s*:\s*none/.test(r.body))
      .map(r => `${r.file}: ${r.sel} { ${r.body.trim()} }`);
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('i18n 覆盖率（含 HTML 与无点号键）', () => {
  // 症状：用户点按钮后看到字面量「rate limited」，操作日志显示「unknown」。
  // 根因：__() 缺键时原样返回键名，而 server_error / rate_limited / unknown /
  //   session_expired 这些最高频的提示键在 zh.js 里压根不存在。
  // 旧测试有两个盲区：(1) 只扫 JS 的 __()，不扫 HTML 的 data-i18n；
  //   (2) 键名正则要求至少一个点号，于是 edit / delete / logout 这类单词键从未被检查。
  const zhSrc = stripJsComments(read(path.join(LANG_DIR, 'zh.js')));
  const zhKeys = new Set();
  for (const m of zhSrc.matchAll(/(?:^|[{,]\s*)(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/g)) {
    zhKeys.add(m[2] || m[3]);
  }

  const jsKeys = new Set();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      // 排除语言目录与未接线的死代码目录（_unwired/ 下的文件不被任何 HTML 引用）
      if (e.isDirectory()) { if (e.name !== 'languages' && e.name !== '_unwired') walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      // 注意不加点号限制，单词键同样要覆盖
      for (const m of read(full).matchAll(/\b__\(\s*(['"`])([^'"`]+)\1/g)) {
        const key = m[2];
        // 动态拼接前缀（如 __('error.' + code)、__('nav.' + tab)）不是完整键，
        // 以 . 或 _ 结尾视为前缀，跳过，避免误报为缺失键。
        if (/[._]$/.test(key)) continue;
        jsKeys.add(key);
      }
    }
  })(path.join(PUB, 'js'));

  const htmlKeys = new Set();
  {
    const html = read(path.join(PUB, 'index.html'));
    for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?\s*=\s*(['"])([^'"]+)\1/g)) {
      m[2].split(/[;,]/).map(s => s.trim()).filter(Boolean).forEach(k => htmlKeys.add(k));
    }
  }

  test('zh.js 字典解析成功', () => {
    expect(zhKeys.size).toBeGreaterThan(500);
    expect(jsKeys.size).toBeGreaterThan(500);
    expect(htmlKeys.size).toBeGreaterThan(20);
  });

  test('JS 中 __() 用到的每个键都存在（含无点号的单词键）', () => {
    expect([...jsKeys].filter(k => !zhKeys.has(k)).sort()).toEqual([]);
  });

  test('HTML data-i18n 引用的每个键都存在', () => {
    expect([...htmlKeys].filter(k => !zhKeys.has(k)).sort()).toEqual([]);
  });

  test('全局错误提示键必须齐全，否则用户会看到原始键名', () => {
    const critical = ['server_error', 'session_expired', 'rate_limited', 'network_error',
      'request_timeout', 'load_failed', 'unknown', 'permission_denied', 'please_login'];
    expect(critical.filter(k => !zhKeys.has(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('后端错误码与前端白名单保持同步', () => {
  // 症状：在管理页点"群组同步"直接被踢回登录页；搜索世界只提示"服务器错误"。
  // 根因：VRChat 代理端点的 401 表示"VRChat 那边登录失效"，而本站 401 表示
  //   "本站会话过期"。前端 api() 不加区分就强制登出。修复方案是后端统一带 code，
  //   前端用白名单放行 —— 但这要求两端的码字面量必须一致，否则白名单静默失效。
  const utils = read(path.join(ROOT, 'server', 'utils.js'));
  const core = read(path.join(PUB, 'js', 'core.js'));

  const backendCodes = new Set();
  {
    const m = utils.match(/const ErrorCodes\s*=\s*\{([\s\S]*?)\n\};/);
    expect(m).not.toBeNull();
    for (const mm of m[1].matchAll(/:\s*'([A-Z_]+)'/g)) backendCodes.add(mm[1]);
  }

  const frontendCodes = new Set();
  {
    const m = core.match(/VRC_BUSINESS_CODES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(m).not.toBeNull();
    for (const mm of m[1].matchAll(/'([A-Z_]+)'/g)) frontendCodes.add(mm[1]);
  }

  test('前端白名单里的每个码后端都真的会发出来', () => {
    expect([...frontendCodes].filter(c => !backendCodes.has(c))).toEqual([]);
  });

  test('VRChat 业务码已被前端放行，不会误触发强制登出', () => {
    expect(frontendCodes.size).toBeGreaterThan(0);
    expect([...frontendCodes].some(c => c.startsWith('VRC_'))).toBe(true);
  });

  test('VRChat 代理端点不再裸写 502，而是走 sendVrcError 分流', () => {
    // 裸 502 会把"VRChat 登录过期"和"VRChat 服务器挂了"混为一谈，
    // 前端只能笼统提示服务器错误，用户无从判断该重新登录 VRChat。
    for (const f of ['groups.js', 'events.js']) {
      const src = stripJsComments(read(path.join(ROOT, 'server', 'routes', f)));
      expect({ file: f, hits: (src.match(/res\.status\(502\)/g) || []).length }).toEqual({ file: f, hits: 0 });
    }
  });
});

// ---------------------------------------------------------------------------

describe('数据库表定义覆盖代码里的所有引用', () => {
  // 症状：/api/vrc/status/list 直接 500（ER_NO_SUCH_TABLE）。
  // 根因：vrc_account_status / user_tags / chat_offline_summary 三张表被代码引用，
  //   但 db_init.js 从未创建它们（有一张只在从不执行的迁移脚本里建）。
  const dbInit = read(path.join(ROOT, 'server', 'db_init.js'));
  const created = new Set();
  for (const m of dbInit.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/gi)) created.add(m[1]);

  test.each(['vrc_account_status', 'user_tags', 'chat_offline_summary', 'sys_oper_log', 'live_streams'])(
    '%s 在 db_init 中被创建', (t) => {
      expect(created.has(t)).toBe(true);
    });

  test('live_streams 带 stream_key 列，推流码才能唯一', () => {
    // 症状：OBS 推流地址是站内相对路径 /live/rtmp/4，根本不是 rtmp:// 协议，无法推流。
    expect(/stream_key/.test(dbInit)).toBe(true);
  });

  // 症状：新建群聊后一发消息就 500，读消息也 500，私聊同样不可用。
  // 根因：routes/chat.js 的 SELECT/INSERT 引用 media_url / media_type / file_size，
  //   而这三列既不在 CREATE TABLE 里、也没有任何迁移补过 —— ER_BAD_FIELD_ERROR。
  //   这类"SQL 写了列但表里没有"的错误只有真正执行到那条语句时才暴露，
  //   所以这里直接比对代码引用的列名与建表脚本里出现的列名。
  test.each([
    ['messages', ['media_url', 'media_type', 'file_size', 'edited_at', 'deleted_at']],
    ['chat_group_messages', ['media_url', 'media_type', 'file_size', 'msg_type', 'lat', 'lng']]
  ])('%s 的所有被查询列都在建表或迁移脚本中出现', (table, cols) => {
    const missing = cols.filter(c => {
      const inCreate = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}[\\s\\S]{0,1600}?\\b${c}\\b`, 'i').test(dbInit);
      const inMigrate = new RegExp(`ALTER TABLE\\s+\`?${table}\`?[\\s\\S]{0,120}?\\b${c}\\b`, 'i').test(dbInit);
      // 迁移也可能写成循环里的模板字符串，退一步只要该列名和表名同时出现即可
      const inLoop = new RegExp(`\\b${c}\\b`).test(dbInit) && new RegExp(`'${table}'`).test(dbInit);
      return !inCreate && !inMigrate && !inLoop;
    });
    expect({ table, missing }).toEqual({ table, missing: [] });
  });
});

// ---------------------------------------------------------------------------

describe('操作日志读写端点闭环', () => {
  // 症状：管理面板"操作日志"整列显示空白与 unknown。
  // 根因：sys_oper_log 被 20 处代码写入，却没有任何接口读取它；
  //   前端调的 /api/admin/logs 返回的是 logger.js 的文件日志，字段结构完全不同
  //   （没有 adminVrcId / operType / content），于是每一行都渲染成空。
  const admin = read(path.join(ROOT, 'server', 'routes', 'admin.js'));
  const adminVrcJs = read(path.join(PUB, 'js', 'admin-vrc.js'));
  const adminUsersJs = read(path.join(PUB, 'js', 'admin-users.js'));

  test('后端提供了读取 sys_oper_log 的端点', () => {
    expect(/router\.get\(\s*'\/admin\/oper-logs'/.test(admin)).toBe(true);
    expect(/FROM sys_oper_log/i.test(admin)).toBe(true);
  });

  test('操作日志面板只能有一份实现，且指向该端点而不是文件日志端点', () => {
    // 原先 admin-vrc.js 和 admin-users.js 各写了一份 loadOperLog，
    // 后加载的 admin-vrc.js 静默覆盖前者 —— admin-users.js 那份操作的
    // #operLogList / #operLogSearch 在 HTML 里根本不存在，是纯死代码。
    // 死代码已删，这里守住"只剩一份"，避免以后又改到不会执行的那一份。
    expect(/function\s+loadOperLog\s*\(/.test(adminVrcJs)).toBe(true);
    expect(/function\s+loadOperLog\s*\(/.test(adminUsersJs)).toBe(false);
    expect(adminVrcJs.includes('/api/admin/oper-logs')).toBe(true);
    for (const [name, src] of [['admin-vrc.js', adminVrcJs], ['admin-users.js', adminUsersJs]]) {
      expect({ name, leaked: /['"`]\/api\/admin\/logs\?/.test(src) }).toEqual({ name, leaked: false });
    }
  });

  test('日志内容经过转义后再插入 innerHTML', () => {
    // content 由用户可控的展示名拼接而成，未转义即为存储型 XSS
    const block = adminVrcJs.slice(adminVrcJs.indexOf('function loadOperLog'));
    expect(/\$\{l\.content\}/.test(block)).toBe(false);
    expect(/esc\(l\.content/.test(block)).toBe(true);
    expect(/esc\(l\.operType/.test(block)).toBe(true);
    expect(/esc\(l\.adminVrcId/.test(block)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('位置共享必须有 HTTP 持久化兜底', () => {
  // 症状：点了"共享位置"，按钮变成"停止共享"，但地图上永远一个标记都没有。
  // 根因：坐标只经 WebSocket 的 location:update 分支落库；
  //   sendLocationViaWS 在 WS 未连接时直接 return，于是 /api/users/all/locations
  //   （过滤 lat IS NOT NULL）恒返回空数组，而 UI 还显示"正在共享"。
  const mapJs = read(path.join(PUB, 'js', 'map.js'));
  const usersJs = read(path.join(ROOT, 'server', 'routes', 'users.js'));

  test('WS 不可用时改用 HTTP 上报坐标', () => {
    expect(/persistLocationViaHttp/.test(mapJs)).toBe(true);
    expect(/\/api\/users\/me\/location'[\s\S]{0,160}lat/.test(mapJs)).toBe(true);
  });

  test('sendLocationViaWS 不再在 WS 断开时直接返回', () => {
    const fn = mapJs.slice(mapJs.indexOf('function sendLocationViaWS'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);
    expect(/readyState !== WebSocket\.OPEN[^\n]*\)\s*return/.test(body)).toBe(false);
  });

  test('PUT /me/location 接受并校验 lat/lng', () => {
    const route = usersJs.slice(usersJs.indexOf("router.put('/me/location'"));
    const body = route.slice(0, 2000);
    expect(/updates\.lat\s*=/.test(body)).toBe(true);
    expect(/updates\.lng\s*=/.test(body)).toBe(true);
    // 缺少范围校验会把 NaN / 越界值写进库并污染地图
    expect(/v < -90 \|\| v > 90/.test(body)).toBe(true);
    expect(/v < -180 \|\| v > 180/.test(body)).toBe(true);
  });

  test('定位失败的三种 code 都有用户可见提示', () => {
    // 以前只处理 code===1（拒绝授权），超时和不可用两种失败完全静默，
    // 用户只会看到按钮变了却永远没有标记。
    //
    // 第六轮起改为统一调用 core.js 的 toastGeoError()：它按 err.code 分发到
    // geo.permission_denied / geo.unavailable / geo.timeout，
    // 并且会先排除「非安全上下文」——那种情况 code 同样是 1，
    // 但浏览器根本没弹过授权框，提示用户去授权是死循环。
    // 所以这里不再检查 map.js 里有没有那几个字面量，而是检查它确实把
    // 错误交给了统一处理，且统一处理覆盖了全部三种 code。
    expect(/toastGeoError\s*\(/.test(mapJs)).toBe(true);

    const coreJs = stripJsComments(read(path.join(ROOT, 'public', 'js', 'core.js')));
    expect(/function\s+geoErrorKey\s*\(/.test(coreJs)).toBe(true);
    for (const key of ['geo.permission_denied', 'geo.unavailable', 'geo.timeout']) {
      expect(coreJs).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------

describe('直播推流地址可用于 OBS', () => {
  // 症状：把弹窗里的地址填进 OBS 无法推流。
  // 根因：后端返回的是站内相对路径 /live/rtmp/<id>，既不是 rtmp:// 协议，
  //   也没有推流码，任何人猜到自增 id 就能顶替他人推流。
  const live = stripJsComments(read(path.join(ROOT, 'server', 'routes', 'live.js')));

  test('生成完整的 rtmp:// 地址而非站内相对路径', () => {
    // 注意：必须先去掉注释再检测。解释"这里以前写成 /live/rtmp/${id}"的注释
    // 本身就含有该字符串，不去注释会永远误报。
    expect(/rtmp:\/\//.test(live)).toBe(true);
    expect(/`\/live\/rtmp\/\$\{/.test(live)).toBe(false);
  });

  test('推流码随机生成，不能是可猜测的自增 id', () => {
    expect(/randomBytes/.test(live)).toBe(true);
    expect(/streamKey/.test(live)).toBe(true);
  });

  test('RTMP 地址可通过环境变量配置', () => {
    expect(/RTMP_HOST/.test(live)).toBe(true);
  });
});
