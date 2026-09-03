/**
 * 第四轮排查（首页精简）中发现的回归防护。
 *
 * 触发点是用户反馈"首页快捷入口和上面的菜单重复""在线这一行能不能精简"，
 * 在动手改这块时用真实浏览器复现，顺带挖出四个一直存在、但没人定位到的故障。
 * 每条测试都写明症状与根因。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const JS_DIR = path.join(PUB, 'js');

const read = p => fs.readFileSync(p, 'utf8');
const stripJsComments = js =>
  js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const html = read(path.join(PUB, 'index.html'));
// 注释里会提到已删除的类名（说明为什么删），检测"是否还有残留"时必须先去掉注释，
// 否则会匹配到解释它为何被移除的那段话。
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
const js = name => stripJsComments(read(path.join(JS_DIR, name)));

// ---------------------------------------------------------------------------

describe('进入应用时首页必须真的被加载', () => {
  // 症状：登录后（以及带着会话刷新后）首页的统计、即将开始的活动、最新动态
  //       全部停在骨架屏的 "-"，必须先切到别的标签再切回来才会出现数据。
  // 根因：showApp() 用 switchTab(activeTab) 渲染初始标签，而 activeTab 的初始值
  //       就是 'home'，switchTab 开头的 `if (activeTab === tab) return;` 直接把它
  //       挡掉了，loadHome() 从来没有在进入应用时执行过。首页是落地页，
  //       等于每个用户进来第一眼看到的都是空的。
  const uiJs = js('ui.js');
  const mainJs = js('main.js');

  test('switchTab 支持 force 参数，可以重新渲染当前标签', () => {
    expect(uiJs).toMatch(/function\s+switchTab\s*\(\s*tab\s*,\s*force\s*\)/);
    expect(uiJs).toMatch(/if\s*\(\s*activeTab\s*===\s*tab\s*&&\s*!force\s*\)\s*return/);
  });

  test('init 用 force 渲染初始标签，否则 loadHome 永远不会跑', () => {
    // 该 force 渲染原在 auth.js 的 showApp() 里，现移至 main.js 的 init()：
    // 骨架屏先展开展开，随后用 switchTab('home', true) 强制跑 loadHome()。
    const call = mainJs.match(/switchTab\(\s*['"]home['"]\s*,\s*true\s*\)/);
    expect(call).not.toBeNull();
    expect(mainJs).toMatch(/if\s*\(\s*activeTab\s*===\s*['"]home['"]\s*\)\s*switchTab\(\s*['"]home['"]\s*,\s*true\s*\)/);
  });

  test('home 标签的分支仍然会调用 loadHome', () => {
    expect(uiJs).toMatch(/tab\s*===\s*'home'\s*\)\s*loadHome\(\)/);
  });
});

// ---------------------------------------------------------------------------

describe('写入统计数字时必须摘掉骨架屏 class', () => {
  // 症状：顶栏和首页的在线人数/成员数一直是一个灰色闪烁方块，数字看不见。
  // 根因：.skeleton-stat 是固定 32x24 且带渐变背景的占位块，只写 textContent
  //       而不移除这个 class，文字会被占位块盖住 —— 表现就是"永远在加载"。
  // 注：Hero 的三张统计卡片与顶栏"在线 N"后来因与统计条重复被移除，
  //     这里只保留仍然存在的统计条元素。
  const ids = ['dashOnline', 'dashMembers', 'dashEvents', 'dashPhotos', 'dashPosts'];
  const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));

  // 只检查 HTML 里初始就带 skeleton-stat 的元素，其它的没有骨架屏可摘。
  // class 和 id 属性的先后顺序在模板里不统一，两种都要匹配。
  const skeletonIds = ids.filter(id => {
    const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    return !!tag && /class="[^"]*skeleton-stat/.test(tag[0]);
  });

  test('待检查的 id 确实在 HTML 里带着 skeleton-stat（防止选择器写错导致空跑）', () => {
    expect(skeletonIds.sort()).toEqual(ids.slice().sort());
  });

  for (const id of ids) {
    test(`${id} 被赋值的地方，同一文件里也摘掉了 skeleton-stat`, () => {
      const offenders = [];
      for (const f of files) {
        const src = js(f);
        // 找出 `const x = document.getElementById('<id>')` 里的变量名，
        // 以及直接 `document.getElementById('<id>').textContent = ...` 的写法
        const direct = new RegExp(`getElementById\\(\\s*['"]${id}['"]\\s*\\)\\s*\\.textContent\\s*=`);
        const viaVar = new RegExp(`(\\w+)\\s*=\\s*document\\.getElementById\\(\\s*['"]${id}['"]\\s*\\)`);

        let writes = false;
        let varName = null;
        const vm = src.match(viaVar);
        if (vm) {
          varName = vm[1];
          writes = new RegExp(`\\b${varName}\\.textContent\\s*=`).test(src);
        }
        if (direct.test(src)) writes = true;
        if (!writes) continue;

        const clears =
          new RegExp(`\\b(${varName || '\\w+'})\\.classList\\.remove\\(\\s*['"]skeleton-stat['"]`).test(src) ||
          new RegExp(`getElementById\\(\\s*['"]${id}['"]\\s*\\)\\s*[\\s\\S]{0,80}?classList\\.remove\\(\\s*['"]skeleton-stat['"]`).test(src);
        if (!clears) offenders.push(f);
      }
      expect(offenders).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------

describe('不能给包含其它元素的容器整体写 textContent', () => {
  // 症状：顶栏在线人数在收到第一条 WebSocket 消息后就永久定死，不再更新。
  // 根因：当时的 #headerOnline 是包着 #heroOnline 的外层容器，给它写 textContent
  //       会把内部的 #heroOnline 节点整个删掉；下一条消息取 #heroOnline 得到 null
  //       并抛错，异常又被 onmessage 的 try/catch 吞掉，于是静默失效。
  // 那两个元素后来因重复被移除，但这个陷阱对任何"外层容器"都成立，
  // 所以这里改成通用扫描，而不是只盯着当初那一个 id。

  /** 取出指定 id 元素的完整 outerHTML（按同名标签配对，足以应付本项目的模板） */
  function outerHtmlById(source, id) {
    const open = source.match(new RegExp(`<([a-zA-Z][\\w-]*)([^>]*\\bid="${id}"[^>]*)>`));
    if (!open) return null;
    if (open[0].endsWith('/>')) return open[0];
    const tag = open[1];
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
    re.lastIndex = open.index + open[0].length;
    let depth = 1, t;
    while ((t = re.exec(source))) {
      if (t[1] === '/') {
        if (--depth === 0) return source.slice(open.index, t.index + t[0].length);
      } else if (!t[0].endsWith('/>')) depth++;
    }
    return null;
  }

  test('outerHtmlById 能正确配对嵌套标签（防止扫描静默空跑）', () => {
    const probe = outerHtmlById('<div id="a"><div id="b">x</div></div>', 'a');
    expect(probe).toBe('<div id="a"><div id="b">x</div></div>');
  });

  test('没有任何 JS 给"内部还包着其它元素"的容器整体写 textContent', () => {
    const offenders = [];
    for (const f of fs.readdirSync(JS_DIR).filter(x => x.endsWith('.js'))) {
      const src = js(f);
      const re = /getElementById\(\s*['"]([\w-]+)['"]\s*\)\s*\.textContent\s*=/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const outer = outerHtmlById(htmlNoComments, m[1]);
        if (!outer) continue;
        const inner = outer.slice(outer.indexOf('>') + 1);
        if (/\bid="/.test(inner)) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('API 响应不可被浏览器缓存', () => {
  // 症状：第二次打开/刷新页面时，各种列表和统计拿不到数据。
  // 根因：Express 默认给 res.json() 加 ETag，而 API 又没有任何 Cache-Control，
  //       浏览器按启发式规则缓存并发条件请求，服务端回 304 —— fetch 拿到的就是
  //       真正的 304，`res.ok` 为 false（只有 200~299 才为真）。
  //       前端大量 `if (!res.ok) return;` 的分支因此全部走空。
  //       顺带也堵住登录后私有数据被中间缓存留存的问题。
  const server = stripJsComments(read(path.join(ROOT, 'server', 'server.js')));
  // stripJsComments 对注释里的 URL（https:// 等）处理有缺陷，会误删后续代码行，
  // 因此 /api 中间件的断言改用未剥离注释的原始文本，只锚定关键要素。
  const serverRaw = read(path.join(ROOT, 'server', 'server.js'));

  test('关闭了 Express 对动态响应的自动 ETag', () => {
    expect(server).toMatch(/app\.set\(\s*['"]etag['"]\s*,\s*false\s*\)/);
  });

  test('/api 全量设置 no-store', () => {
    // 断言存在一个挂载在 /api 前缀、且用 res.setHeader 设置含 no-store 的 Cache-Control 的中间件。
    // 不再依赖旧版「箭头函数体不超过 400 字符」的脆弱正则，也不依赖 stripJsComments。
    const m = serverRaw.match(/app\.use\(\s*['"]\/api['"]\s*,\s*\([^)]*\)\s*=>\s*\{[\s\S]*?res\.setHeader\(\s*['"]Cache-Control['"]\s*,\s*['"][^'"]*no-store[^'"]*['"]\s*\)/);
    expect(m).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('首页快捷入口已移除且没有留下悬空引用', () => {
  // 用户反馈：那块九宫格的 6 个目的地（活动/动态/聊天/相册/公告/地图）
  // 在上方标签栏里全都有，移动端底栏加"更多"菜单也覆盖了全部标签，属于纯重复，
  // 而且把"即将开始的活动"挤出了首屏。
  test('HTML 里不再有 home-quick 结构', () => {
    // 内联 <script> 里的注释也要去掉：那里写了"为什么删除这块"的说明。
    expect(stripJsComments(htmlNoComments)).not.toMatch(/home-quick/);
  });

  test('CSS 里不再有 home-quick 规则', () => {
    const cssDir = path.join(PUB, 'css');
    for (const f of fs.readdirSync(cssDir).filter(x => x.endsWith('.css'))) {
      expect(read(path.join(cssDir, f)).replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/home-quick/);
    }
  });

  test('JS 里不再绑定 home-quick-card', () => {
    for (const f of fs.readdirSync(JS_DIR).filter(x => x.endsWith('.js'))) {
      expect(js(f)).not.toMatch(/home-quick/);
    }
    expect(stripJsComments(htmlNoComments)).not.toMatch(/home-quick/);
  });

  test('统计条接管了跳转，且每一项都有真实去处', () => {
    const bar = htmlNoComments.match(/<div class="home-stat-bar"[\s\S]*?<\/div>\s*(?=\n)/);
    expect(bar).not.toBeNull();

    const items = bar[0].match(/<\w+[^>]*class="hs-item"[^>]*>/g) || [];
    expect(items.length).toBe(5);

    // 「在线」项后来改成 data-action="online"（弹在线成员列表），
    // 其余四项仍是 data-tab 跳转。每一项都必须二者有其一，否则就是个点了没反应的死块。
    const homeJs = js('home.js');
    for (const it of items) {
      const tab = it.match(/data-tab="([^"]+)"/);
      const action = it.match(/data-action="([^"]+)"/);
      expect({ it, ok: !!(tab || action) }).toEqual({ it, ok: true });
      if (tab) {
        expect(html).toMatch(new RegExp(`id="tab-${tab[1]}"`));
      } else {
        expect(homeJs).toMatch(new RegExp(`action\\s*===\\s*'${action[1]}'`));
      }
    }
  });

  test('统计条的跳转只绑定一次，避免一次点击触发两次 switchTab', () => {
    // index.html 的内联脚本此前对快捷入口卡片单独绑过一次 click，
    // 与 home.js 的事件委托重复，点一下会触发两次 switchTab。
    const inlineScript = stripJsComments(htmlNoComments);
    expect(inlineScript).not.toMatch(/home-stat-bar[\s\S]{0,200}addEventListener/);

    const homeJs = js('home.js');
    const delegations = homeJs.match(/home-stat-bar/g) || [];
    expect(delegations.length).toBe(1);
  });
});
