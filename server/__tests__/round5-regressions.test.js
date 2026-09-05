/**
 * 第五轮排查的回归防护。
 *
 * 用户反馈两件事：
 *   1. 点右上角用户账号（超级管理员）完全没反应，登出等功能一个都点不到。
 *   2. 管理面板的「系统 VRChat 账号」明明显示绿点已登录，
 *      点「同步群组成员」却弹「VRChat 登录已过期」。
 * 两个都定位到了确定的根因，这里各写一组测试守住。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const JS_DIR = path.join(PUB, 'js');
const SRV = path.join(__dirname, '..');

const read = p => fs.readFileSync(p, 'utf8');
const stripJsComments = js =>
  js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const html = read(path.join(PUB, 'index.html'));
const js = name => stripJsComments(read(path.join(JS_DIR, name)));
const srv = rel => stripJsComments(read(path.join(SRV, rel)));

// ---------------------------------------------------------------------------

describe('带 .d-none 的元素不能用内联 style.display 去显示', () => {
  // 症状：点头像用户菜单不弹出、通知中心空态不显示、绑定 VRChat 的结果提示看不到……
  //       代码读起来完全正常，元素也确实拿到了，就是不出现。
  // 根因：.d-none { display: none !important } 定义在样式表里，
  //       而内联 style.display 的优先级打不过样式表里的 !important。
  //       只要元素初始 class 带 d-none，JS 再怎么写 style.display='block' 都没用。
  // 修法：统一用 core.js 的 showEl/hideEl（操作 class，而不是内联样式）。

  // 收集 index.html 里所有初始带 d-none 的元素 id
  const dNoneIds = new Set();
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\bclass\s*=\s*["'][^"']*\bd-none\b/.test(tag)) continue;
    const idMatch = tag.match(/\bid\s*=\s*["']([^"']+)["']/);
    if (idMatch) dNoneIds.add(idMatch[1]);
  }

  const jsFiles = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));

  test('index.html 里确实存在带 d-none 的元素（防止本测试静默失效）', () => {
    expect(dNoneIds.size).toBeGreaterThan(10);
  });

  test('没有任何 JS 用 style.display 去显示带 d-none 的元素', () => {
    const offenders = [];
    for (const file of jsFiles) {
      const src = stripJsComments(read(path.join(JS_DIR, file)));
      for (const id of dNoneIds) {
        // 直接写法：getElementById('x').style.display = ...
        const direct = new RegExp(
          `getElementById\\(\\s*['"]${id}['"]\\s*\\)\\s*\\.style\\.display\\s*=`
        );
        if (direct.test(src)) { offenders.push(`${file}: ${id} (直接)`); continue; }

        // 变量写法：const el = getElementById('x'); ... el.style.display = ...
        const assign = new RegExp(
          `(?:const|let|var)\\s+(\\w+)\\s*=\\s*document\\.getElementById\\(\\s*['"]${id}['"]\\s*\\)`
        );
        const varMatch = src.match(assign);
        if (!varMatch) continue;
        const varName = varMatch[1];
        const viaVar = new RegExp(`\\b${varName}\\s*\\.style\\.display\\s*=`);
        if (viaVar.test(src)) offenders.push(`${file}: ${id} (变量 ${varName})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('core.js 暴露 showEl / hideEl / isElVisible 三个工具函数', () => {
    const core = js('core.js');
    expect(core).toMatch(/function\s+showEl\s*\(/);
    expect(core).toMatch(/function\s+hideEl\s*\(/);
    expect(core).toMatch(/function\s+isElVisible\s*\(/);
    // 必须操作 class，否则同样打不过 !important
    expect(core).toMatch(/classList\.remove\(\s*['"]d-none['"]\s*\)/);
    expect(core).toMatch(/classList\.add\(\s*['"]d-none['"]\s*\)/);
  });

  test('判断用户菜单是否展开时不能再读 style.display', () => {
    // 一旦改用 class 控制，style.display 永远是空字符串，
    // 任何还在读它的判断都会永远得到"已隐藏"，键盘导航和外部点击关闭都会失灵。
    const uiJs = js('ui.js');
    const mainJs = js('main.js');
    expect(uiJs).not.toMatch(/userDropdown[\s\S]{0,120}?\.style\.display\s*===/);
    expect(mainJs).not.toMatch(/userDropdown[\s\S]{0,120}?\.style\.display\s*===/);
    expect(mainJs).toMatch(/isElVisible/);
  });
});

// ---------------------------------------------------------------------------

describe('VRChat cookie 失效后必须能降级到下一个候选', () => {
  // 症状：管理面板「系统 VRChat 账号」显示 🟢 已登录，
  //       点「同步群组成员」却报「VRChat 登录已过期」，重新登录也没用。
  // 根因：getVRCCookie 无条件优先返回 req.session 里用户绑定时存的 cookie。
  //       那份 cookie 过期后，所有 VRChat 调用都拿到这份死 cookie，
  //       永远不会 fallback 到有效的系统账号 cookie；
  //       而绿点读的是 authState.loggedIn（系统账号），两者根本不是同一份凭据。
  const serverJs = srv('server.js');
  const vrcAuthJs = srv('vrc_auth.js');
  const groupsJs = srv(path.join('routes', 'groups.js'));
  const eventsJs = srv(path.join('routes', 'events.js'));
  const authJs = srv(path.join('routes', 'auth.js'));

  test('vrc_auth.js 提供 invalidateVRCCookie 并挂到 getVRCCookie 上，server.js 挂载该模块', () => {
    // P2-4 第二步第二批：VRC auth 块已从 server.js 抽至 vrc_auth.js，
    // 守卫随实现迁移；server.js 侧钉住挂载点防止漏装。
    expect(vrcAuthJs).toMatch(/function\s+invalidateVRCCookie\s*\(\s*req\s*,\s*deadCookie\s*\)/);
    expect(vrcAuthJs).toMatch(/getVRCCookie\.invalidate\s*=\s*invalidateVRCCookie/);
    expect(serverJs).toMatch(/setupVrcAuth\(\)/);
  });

  test('失效标记必须同时清理 vrchatCookie 和 vrcCookie 两个 key', () => {
    // 绑定流程写的是 vrcCookie，登录流程写的是 vrchatCookie，
    // 只清其中一个会留下另一份死 cookie 继续被 getVRCCookie 取到。
    expect(vrcAuthJs).toMatch(/\['vrchatCookie',\s*'vrcCookie'\]/);
  });

  test('解绑 VRChat 时两个 cookie key 都要清掉', () => {
    // 原来只清了 vrchatCookie，而绑定时写的是 vrcCookie，
    // 导致「解绑后重新绑定」依然在用那份旧 cookie。
    const unbind = authJs.slice(authJs.indexOf("router.post('/vrchat-unbind'"));
    const body = unbind.slice(0, 2000);
    expect(body).toMatch(/req\.session\.vrchatCookie\s*=\s*null/);
    expect(body).toMatch(/req\.session\.vrcCookie\s*=\s*null/);
  });

  test('groups.js 提供 vrcWithFallback，且只在真正的 401 才作废 cookie', () => {
    expect(groupsJs).toMatch(/async\s+function\s+vrcWithFallback\s*\(\s*req\s*,\s*run\s*\)/);
    // 关键：不能再把 `result === null` 当成未授权。
    // vrchatGetCurrentUser 对任何非 2xx（429 限流、500、超时）都返回 null，
    // 一旦按 null 判定就会把用户 session 里的 VRChat cookie 清掉，
    // 用户刷新后发现"绑定又没了"。上游临时故障绝不能销毁登录凭据。
    expect(groupsJs).toMatch(/const\s+unauthorized\s*=\s*result\?\.status\s*===\s*401\s*;/);
    expect(groupsJs).not.toMatch(/unauthorized\s*=\s*result\s*===\s*null/);
    // 降级后必须确认拿到的是不同的 cookie，否则会无意义地重试同一份
    expect(groupsJs).toMatch(/next\s*&&\s*next\s*!==\s*cookie/);
  });

  test('群组同步走 vrcWithFallback，且用带 HTTP 状态的取用户接口', () => {
    const syncStart = groupsJs.indexOf("router.post('/group/members/sync'");
    expect(syncStart).toBeGreaterThan(-1);
    const body = groupsJs.slice(syncStart, syncStart + 3000);
    // 必须用 vrchatGetCurrentUserResult：裸的 vrchatGetCurrentUser 失败时只返回 null，
    // 调用方分不清"cookie 过期"和"VRChat 挂了"
    expect(body).toMatch(/vrcWithFallback\(\s*req\s*,\s*\(c\)\s*=>\s*vrchatGetCurrentUserResult\(c\)\s*\)/);
  });

  test('世界搜索 / 模型搜索 / 群组信息都接入了降级', () => {
    for (const route of ["'/vrc/worlds/search'", "'/vrc/avatars/search'", "'/group'"]) {
      const i = groupsJs.indexOf(`router.get(${route}`);
      expect(i).toBeGreaterThan(-1);
      expect(groupsJs.slice(i, i + 900)).toMatch(/vrcWithFallback/);
    }
  });

  test('活动同步在 401 时也会降级重试一次', () => {
    const i = eventsJs.indexOf("router.post('/sync-vrchat'");
    expect(i).toBeGreaterThan(-1);
    const body = eventsJs.slice(i, i + 1200);
    expect(body).toMatch(/ge\.status\s*===\s*401/);
    expect(body).toMatch(/getVRCCookieFn\.invalidate/);
  });

  test('代表用户的写操作绝不能降级到系统账号', () => {
    // 切换模型是写操作：如果 fallback 到系统 cookie，
    // 会把系统账号的模型改掉，属于越权副作用。
    const i = groupsJs.indexOf("router.post('/vrc/avatar/set'");
    expect(i).toBeGreaterThan(-1);
    const body = groupsJs.slice(i, i + 800);
    expect(body).not.toMatch(/vrcWithFallback/);
  });
});

// ---------------------------------------------------------------------------

describe('在线/成员/照片 这些统计不能再出现多份副本', () => {
  // 用户连续两轮指出同一件事：首页上同一个数字出现了好几遍。
  // 收敛后的约定是：统计数字只有「首页统计条」一处；
  // 需要跨标签常驻可见的在线数，交给「群组」标签上的角标 #groupBadge。
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const inline = stripJsComments(htmlNoComments);
  const jsFiles = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));
  const dead = ['heroOnlineStat', 'heroMembers', 'heroPhotos', 'heroOnline', 'headerOnline'];

  test('Hero 里的统计卡片已整块移除', () => {
    expect(htmlNoComments).not.toMatch(/class="hero-stats"/);
    expect(htmlNoComments).not.toMatch(/id="heroOnlineStat"/);
    expect(htmlNoComments).not.toMatch(/id="heroMembers"/);
    expect(htmlNoComments).not.toMatch(/id="heroPhotos"/);
  });

  test('顶栏贴着品牌名的「在线 N」已移除', () => {
    expect(htmlNoComments).not.toMatch(/id="headerOnline"/);
    expect(htmlNoComments).not.toMatch(/id="heroOnline"/);
  });

  test('没有任何 JS 还在引用这些已删除的元素', () => {
    // 死引用不会报错（getElementById 返回 null 被 if 挡掉），
    // 但会让人误以为那块 UI 还在，下次改动时白白绕路。
    for (const id of dead) {
      const pat = new RegExp(`['"]${id}['"]`);
      const offenders = jsFiles.filter(f => pat.test(js(f)));
      expect({ id, offenders }).toEqual({ id, offenders: [] });
      expect(inline).not.toMatch(pat);
    }
  });

  test('样式表里 .hero-stat / .hero-stats 的规则块也一并清掉了', () => {
    // 允许残留在 :not() 排除列表里 —— 从 :not() 删条目会降低选择器特异性，
    // 可能连累同文件里别的规则，属于得不偿失。
    const cssDir = path.join(PUB, 'css');
    for (const f of fs.readdirSync(cssDir).filter(x => x.endsWith('.css'))) {
      const src = read(path.join(cssDir, f));
      const rules = src.match(/(^|[{};])\s*\.hero-stats?\b[^{};]*\{/g) || [];
      expect({ file: f, rules }).toEqual({ file: f, rules: [] });
    }
  });

  test('在线人数仍然有唯一入口，点击能打开在线成员列表', () => {
    // 两个旧入口（顶栏、Hero 卡片）都删了，功能必须落到统计条上，
    // 否则 showOnlineUsers() 就成了永远点不到的死代码。
    expect(htmlNoComments).toMatch(/data-action="online"[\s\S]{0,240}id="dashOnline"/);
    const homeJs = js('home.js');
    expect(homeJs).toMatch(/action\s*===\s*'online'/);
    expect(homeJs).toMatch(/showOnlineUsers\(\)/);
  });

  test('showOnlineUsers 不再靠读 DOM 文本判断人数', () => {
    // 统计条初始值是骨架屏占位的 "-"，parseInt('-') 得 NaN → 0，
    // 会导致明明有人在线却提示「当前无人在线」。应以 WS 推来的名单为准。
    const mainJs = js('main.js');
    const i = mainJs.indexOf('function showOnlineUsers');
    expect(i).toBeGreaterThan(-1);
    const body = mainJs.slice(i, i + 400);
    expect(body).not.toMatch(/getElementById[\s\S]{0,80}textContent/);
    expect(body).toMatch(/onlineUsersList/);
  });

  test('后台的「显示统计」开关改指首页统计条，没有变成空操作', () => {
    // sys_config 的 hero_show_stats 原本控制 .hero-stats，
    // 那个容器删掉后开关必须改指新的承载元素，否则后台点了没反应。
    const uiJs = js('ui.js');
    expect(uiJs).toMatch(/querySelector\(\s*'\.home-stat-bar'\s*\)/);
    expect(uiJs).not.toMatch(/querySelector\(\s*'\.hero-stats'\s*\)/);
  });

  test('统计条只由一个数据源写入，避免数字来回跳', () => {
    // loadHeroStats 曾经也往统计元素写一遍（数据来自 /api/public/stats），
    // 与 loadDashboardStats（/api/stats）打架。现在只保留后者。
    const uiJs = js('ui.js');
    const i = uiJs.indexOf('async function loadHeroStats');
    expect(i).toBeGreaterThan(-1);
    expect(uiJs.slice(i, i + 2500)).not.toMatch(/dashMembers|dashPhotos|dashOnline/);
  });

  test('WS 推送在线数时同步刷新群组角标', () => {
    // 顶栏那份删掉后，跨标签唯一可见的在线数就是 #groupBadge，
    // 忘了更新它的话，用户切到别的标签就再也看不到在线人数变化。
    const mainJs = js('main.js');
    const i = mainJs.indexOf("'online_users'");
    expect(i).toBeGreaterThan(-1);
    const body = mainJs.slice(i, i + 700);
    expect(body).toMatch(/dashOnline/);
    expect(body).toMatch(/updateGroupBadge/);
  });
});

// ---------------------------------------------------------------------------

describe('不能用"恒为真的占位对象"来兜底 getElementById', () => {
  // 症状：点首页统计条的「在线」完全没反应，控制台一条
  //      "Cannot set properties of null (setting 'textContent')"。
  // 根因：showOnlineUsers 里写成
  //        getElementById(x) || {style:{},querySelector:()=>null} || (() => {...创建弹窗...})()
  //      中间那个对象字面量恒为真，|| 直接短路，真正负责创建弹窗的 IIFE
  //      永远不执行，随后按 id 取弹窗内部元素自然是 null。
  //      events.js 的签到二维码是同一个套路的另一处：占位对象没有 remove()，
  //      弹窗不存在时会抛 "existing.remove is not a function"。
  const jsFiles = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));

  test('没有任何地方用带方法的占位对象兜底 DOM 查询', () => {
    // 只允许 `|| {style:{}}` 这种纯属性占位（globalLoadBar 那几处，
    // 后续也确实只碰 .style，不会撒谎说"元素存在"）。
    const offenders = [];
    for (const f of jsFiles) {
      const src = js(f);
      const re = /\|\|\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const inner = m[1];
        if (!/querySelector|innerHTML|remove|classList|appendChild|=>/.test(inner)) continue;
        offenders.push(`${f}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('showOnlineUsers 真的会创建弹窗，而不是只在弹窗已存在时才工作', () => {
    const mainJs = js('main.js');
    const i = mainJs.indexOf('function showOnlineUsers');
    expect(i).toBeGreaterThan(-1);
    const body = mainJs.slice(i, i + 2200);
    expect(body).toMatch(/if\s*\(\s*!modal\s*\)/);
    expect(body).toMatch(/document\.body\.appendChild/);
  });
});

// ---------------------------------------------------------------------------

describe('"在线人数"必须全站同一个语义', () => {
  // 症状：首页统计条显示"在线 0"，同一时刻群组标签角标显示"1"。
  // 根因：/api/stats 的 online 查的是 group_roster.is_online —— 那是 VRChat
  //      群成员在游戏里的在线状态；而 WebSocket 推的是本站登录在线用户。
  //      两个语义不同的数被写进同一个 #dashOnline，谁后到谁赢。
  //      统计条的「在线」点开展示的是本站在线名单，所以数字必须取本站口径。
  const serverJs = srv('server.js');
  const statsJs = srv(path.join('routes', 'stats.js'));

  test('/api/stats 与 /api/public/stats 的在线数取自 WebSocket 在线名单', () => {
    // P2-4 第二步第二批：两条路由已抽至 routes/stats.js，
    // 守卫随实现迁移；server.js 侧钉住挂载点防止漏装。
    expect(serverJs).toMatch(/createStatsRouter\(\)/);
    for (const route of ["router.get('/stats'", "router.get('/public/stats'"]) {
      const i = statsJs.indexOf(route);
      expect({ route, found: i > -1 }).toEqual({ route, found: true });
      const body = statsJs.slice(i, i + 3000);
      expect(body).toMatch(/wsService\.onlineUsers\.size/);
    }
  });

  test('VRChat 群组的在线数仍然保留，只是换了字段名不再冒充本站在线', () => {
    expect(statsJs).toMatch(/vrcOnline\s*:/);
    expect(statsJs).toMatch(/vrcOnlineCount\s*:/);
  });
});

// ---------------------------------------------------------------------------

describe('HTML 用到的组件类名必须在 CSS 里真的有规则', () => {
  // 症状：点开右上角用户菜单，弹出来的不是一张卡片，而是一段贴着顶栏、
  //      白底左对齐、还溢出到 header 外面的纯文字；菜单项没有 hover 反馈，
  //      看起来"按钮动不了"（事件绑定其实是好的，纯粹是样式一条没生效）。
  // 根因：这是一次做了一半的类名重构 ——
  //      · 容器的定位/背景/边框/阴影全写在 `.user-dropdown-menu` 上，
  //        但 HTML/JS 从来没给任何元素加过这个类，元素实际叫 `.user-dropdown`；
  //      · 菜单项样式写的是 `.user-dropdown .dropdown-item`，
  //        HTML 里却是 `.user-dropdown-item`。
  //      选择器和 DOM 对不上，CSS 全部落空，但没有任何报错。
  // 这里做成通用扫描，而不是只钉住 user-dropdown 这几个类名。

  const CSS_DIR = path.join(PUB, 'css');
  const allCss = fs
    .readdirSync(CSS_DIR)
    .filter(f => f.endsWith('.css'))
    .map(f => read(path.join(CSS_DIR, f)))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /** 取出 HTML 里所有 class 属性中出现过的类名 */
  const htmlClasses = new Set();
  {
    const re = /class\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      for (const c of m[1].split(/\s+/)) if (c) htmlClasses.add(c);
    }
  }

  /** CSS 里被任意选择器提到过的类名 */
  const cssClasses = new Set();
  {
    const re = /\.(-?[_a-zA-Z][\w-]*)/g;
    let m;
    while ((m = re.exec(allCss)) !== null) cssClasses.add(m[1]);
  }

  test('扫描本身要真的扫到东西（防止正则写错后静默通过）', () => {
    expect(htmlClasses.size).toBeGreaterThan(80);
    expect(cssClasses.size).toBeGreaterThan(200);
    // 这几个是确定存在的，用来自测两个集合都解析对了
    expect(htmlClasses.has('user-dropdown')).toBe(true);
    expect(htmlClasses.has('user-dropdown-item')).toBe(true);
    expect(cssClasses.has('user-dropdown')).toBe(true);
  });

  test('下拉/菜单类组件在 HTML 用到的类名，CSS 里都要有对应规则', () => {
    // 只管"看起来需要样式"的组件类：包含连字符的自定义类名，
    // 且落在这些组件前缀下（工具类如 d-none、flex-1 交给别的测试管）。
    const COMPONENT_RE = /^(user-dropdown|dropdown|notification|search-results|modal|hs)-/;
    const missing = [...htmlClasses].filter(
      c => COMPONENT_RE.test(c) && !cssClasses.has(c)
    );
    expect(missing).toEqual([]);
  });

  test('CSS 里不该留下 HTML 从未使用过的下拉容器类名（会把样式挂空）', () => {
    // .user-dropdown-menu 就是这么烂掉的：CSS 里写得好好的，DOM 上根本没有。
    const ORPHAN_SUSPECTS = ['user-dropdown-menu'];
    const orphans = ORPHAN_SUSPECTS.filter(
      c => cssClasses.has(c) && !htmlClasses.has(c)
    );
    expect(orphans).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('用户下拉菜单必须是一张浮层卡片', () => {
  const CSS_DIR = path.join(PUB, 'css');
  const cssFiles = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));

  /**
   * 按顺序扫描 CSS，跟踪 @media/@supports 嵌套，返回匹配选择器的规则块。
   * 关键是要能区分"顶层规则"和"只在某个 media query 里生效的规则" ——
   * 容器样式曾被整块关在 @media (max-width:480px) 里，桌面端一条都不生效。
   */
  const rulesFor = (src, selRe) => {
    const out = [];
    const stack = [];
    let i = 0;
    let buf = '';
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{') {
        const head = buf.trim().replace(/\s+/g, ' ');
        buf = '';
        if (/^@(media|supports|layer)/i.test(head)) {
          stack.push(head);
          i++;
          continue;
        }
        let depth = 1;
        let j = i + 1;
        while (j < src.length && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          j++;
        }
        if (selRe.test(head)) {
          out.push({
            media: stack.slice(),
            sel: head,
            body: src.slice(i + 1, j - 1).replace(/\s+/g, ' ').trim(),
          });
        }
        i = j;
        continue;
      }
      if (ch === '}') {
        stack.pop();
        buf = '';
        i++;
        continue;
      }
      buf += ch;
      i++;
    }
    return out;
  };

  const dropdownRules = cssFiles.flatMap(f =>
    rulesFor(read(path.join(CSS_DIR, f)).replace(/\/\*[\s\S]*?\*\//g, ''), /\.user-dropdown\b/).map(
      r => ({ ...r, file: f })
    )
  );

  test('扫描本身要真的扫到东西', () => {
    expect(dropdownRules.length).toBeGreaterThan(2);
  });

  test('容器的定位与外观样式必须在顶层，不能只活在 @media 里', () => {
    const topLevel = dropdownRules.filter(r => r.media.length === 0);
    const joined = topLevel.map(r => r.body).join(';');
    for (const prop of ['position', 'background', 'border', 'border-radius', 'box-shadow', 'z-index']) {
      expect({ prop, present: new RegExp(`(^|;|\\s)${prop}\\s*:`).test(joined) }).toEqual({
        prop,
        present: true,
      });
    }
    expect(joined).toMatch(/position\s*:\s*absolute/);
  });

  test('容器上不能写 display —— 显隐由 .d-none 负责，写了就永远打不开', () => {
    // .d-none 是 display:none !important，JS 靠 showEl() 摘掉它来显示。
    // 如果基础类自己还带一条 display:none，摘掉 .d-none 后依旧是隐藏的。
    const offenders = dropdownRules
      .filter(r => /^\.user-dropdown(\s|$|[.:,])/.test(r.sel.trim()))
      .filter(r => /(^|;|\s)display\s*:/.test(r.body))
      .map(r => `${r.file}: ${r.sel}`);
    expect(offenders).toEqual([]);
  });

  test('菜单项要有 cursor:pointer 和 hover 反馈，否则看起来点不动', () => {
    const itemRules = dropdownRules.filter(r => /user-dropdown-item/.test(r.sel));
    expect(itemRules.length).toBeGreaterThan(1);
    const base = itemRules.filter(r => !/:hover/.test(r.sel)).map(r => r.body).join(';');
    const hover = itemRules.filter(r => /:hover/.test(r.sel)).map(r => r.body).join(';');
    expect(base).toMatch(/cursor\s*:\s*pointer/);
    expect(base).toMatch(/padding\s*:/);
    expect(hover).toMatch(/background\s*:/);
  });

  test('移动端覆写的特异性要高于顶层容器规则，否则会被后加载的文件压掉', () => {
    // 顶层 .user-dropdown 在 06-members.css，移动端覆写在更早加载的 03-layout.css。
    // 两边都是 (0,1,0) 的话，@media 不加特异性，后加载的顶层规则会赢，覆写形同虚设。
    const mobile = dropdownRules.filter(r => r.media.some(m => /max-width/.test(m)));
    for (const r of mobile) {
      const classCount = (r.sel.match(/\.[-\w]+/g) || []).length;
      expect({ sel: r.sel, classCount }).toEqual({ sel: r.sel, classCount: expect.any(Number) });
      expect(classCount).toBeGreaterThan(1);
    }
  });
});

// ---------------------------------------------------------------------------

describe('登出必须收起用户菜单', () => {
  // 打开菜单时往 document 上挂了 keydown 监听做方向键导航，
  // 登出只是盖上登录遮罩，菜单没收起 → 监听不解绑，
  // 方向键/Esc 仍会把焦点送进被遮罩盖住的菜单项。
  const authJs = js('auth.js');
  const uiJs = js('ui.js');

  test('toggleUserMenu 打开时注册了 document 级 keydown', () => {
    expect(uiJs).toMatch(/document\.addEventListener\(\s*['"]keydown['"]\s*,\s*_handleUserMenuKeydown/);
  });

  test('hideUserMenu 会把这个监听解绑', () => {
    expect(uiJs).toMatch(/document\.removeEventListener\(\s*['"]keydown['"]\s*,\s*_handleUserMenuKeydown/);
  });

  test('logout() 里调用了 hideUserMenu', () => {
    const i = authJs.indexOf('async function logout(');
    expect(i).toBeGreaterThan(-1);
    const body = authJs.slice(i, authJs.indexOf('\n}', i));
    expect(body).toMatch(/hideUserMenu\s*\(/);
  });
});

// ---------------------------------------------------------------------------

describe('VRChat 绑定不能在拿不到账号 ID 时报成功', () => {
  // 症状：用户在个人中心绑定 VRChat，界面提示"绑定成功"，
  //      刷新之后又变回"未绑定"，反复绑也没用。
  // 取证：数据库里 vrchat_id = NULL，但 vrchat_name = ''（空串而不是 NULL）——
  //      说明 UPDATE 确实执行过，只是写进去的 ID 是空的。
  // 根因：VRChat 的 /auth/user 在需要 2FA 时返回的是 { requiresTwoFactorAuth:[...] }，
  //      响应体里没有 id。2FA 通过后要再调一次 /auth/user 才拿得到，
  //      而 verifyVrc2fa 内部的 vrchatGetCurrentUser 失败时只 warn 并返回 null，
  //      于是 `Object.assign(vrcUser, null)` 静默无操作，vrcUser.id 依旧 undefined。
  //      接下来 `const vrchatId = vrcUser.id` 没有任何校验就直接 UPDATE，
  //      还回了 success:true。
  //      同一个文件里 VRChat 登录那条路径写了 `vResult.user?.id || vrcUser.id` 的回退，
  //      绑定这条却一点没防 —— 典型的只修一半。
  const authSrv = srv('routes/auth.js');
  const profileJs = js('profile.js');

  test('写库前必须校验 vrchatId 存在，拿不到就返回错误', () => {
    const i = authSrv.indexOf("'/vrchat-bind-verify'");
    expect(i).toBeGreaterThan(-1);
    const body = authSrv.slice(i, i + 6000);

    const idLine = body.indexOf('const vrchatId');
    const updateLine = body.indexOf('UPDATE users SET vrchat_id');
    expect(idLine).toBeGreaterThan(-1);
    expect(updateLine).toBeGreaterThan(idLine);

    // 取 ID 之后、写库之前必须有一次"没有 ID 就 return"的守卫
    const between = body.slice(idLine, updateLine);
    expect(between).toMatch(/if\s*\(\s*!\s*vrchatId\s*\)/);
    expect(between).toMatch(/return\s+(sendError|res\.status)/);
  });

  test('这个失败要用 VRC_ 前缀的业务码，不能让前端误判成会话过期', () => {
    // utils.js 的注释写明：VRC_* 这些码必须与前端 VRC_BUSINESS_CODES 一致，
    // 否则前端会把它当成本站会话过期，强制登出跳回登录页。
    const i = authSrv.indexOf("'/vrchat-bind-verify'");
    const body = authSrv.slice(i, i + 6000);
    const guard = body.slice(body.indexOf('if (!vrchatId'), body.indexOf('UPDATE users SET vrchat_id'));
    expect(guard).toMatch(/ErrorCodes\.VRC_/);
  });

  test('verifyVrc2fa 要把"没取到用户资料"显式报出来，不能只返回 null', () => {
    const i = authSrv.indexOf('async function verifyVrc2fa');
    expect(i).toBeGreaterThan(-1);
    const body = authSrv.slice(i, authSrv.indexOf('\n}', i));
    // vrchatGetCurrentUser 在 HTTP 非 2xx 时是 return null 而不是抛异常，
    // 所以光靠 try/catch 兜不住，必须显式检查返回值。
    expect(body).toMatch(/userError/);
    expect(body).toMatch(/!\s*user(\s*\|\|\s*!\s*user\.id)?/);
  });

  test('2FA 后回填 displayName 必须先判空，否则会把已有名字冲成 NULL', () => {
    // vrcUser.displayName = vResult.user.displayName 这种无条件赋值，
    // 在上游没返回 displayName 时会写出 vrchat_name=NULL。
    const offenders = [];
    const re = /(\w+)\.displayName\s*=\s*(\w+(?:\.\w+)*)\.displayName\s*;/g;
    let m;
    while ((m = re.exec(authSrv)) !== null) {
      // 往前找 200 字符，看有没有判空
      const ctx = authSrv.slice(Math.max(0, m.index - 200), m.index + m[0].length);
      if (!/if\s*\([^)]*displayName[^)]*\)/.test(ctx)) offenders.push(m[0]);
    }
    expect(offenders).toEqual([]);
  });

  test('写 vrchat_name 时要能回退到库里的旧值，不能直接写 undefined', () => {
    const updates = authSrv.match(/UPDATE users SET vrchat_name = \?[^`]*`,\s*\[[^\]]+\]/g) || [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      // 参数数组第一个不能是裸的 vrcUser.displayName
      expect(u).not.toMatch(/\[\s*vrcUser\.displayName\s*,/);
    }
  });

  test('前端两条绑定路径都要回拉权威资料并校验 vrchatId', () => {
    // 以前只有 2FA 那条路径回拉了 /api/users/me/profile，
    // 无 2FA 那条只 Object.assign(currentUser, data.user) 就当成功了。
    expect(profileJs).toMatch(/async function refreshVrcBindState/);
    for (const fn of ['async function bindVRChatWithPassword', 'async function confirmVrcBind2fa']) {
      const i = profileJs.indexOf(fn);
      expect({ fn, found: i > -1 }).toEqual({ fn, found: true });
      const body = profileJs.slice(i, i + 2500);
      expect(body).toMatch(/refreshVrcBindState\s*\(/);
      expect(body).toMatch(/!\s*currentUser\.vrchatId/);
    }
  });

  test('refreshVrcBindState 要返回是否真的绑上了', () => {
    const i = profileJs.indexOf('async function refreshVrcBindState');
    const body = profileJs.slice(i, profileJs.indexOf('\n}', i));
    expect(body).toMatch(/return\s+!!\s*meData\.vrchatId/);
  });
});


