/* 浏览器端行为验证：驱动 Chrome 无头模式打开 temp_tests/browser_check.html，
   收集页面内的断言结果。
   与 Node 桩互补：桩测不出「标准模式下 documentElement 的 overflow 为 visible」
   这类真实浏览器才有差异的行为；「SVG 文档里 createElement 无 style」
   同理，只有真浏览器能复现。

   用法：
     node temp_tests/run_browser_check.js            缺依赖时跳过（本地开发）
     node temp_tests/run_browser_check.js --require  缺依赖时失败（CI / 发布前）
     SLOWSCROLL_REQUIRE_BROWSER=1 node ...           同 --require

   为什么默认仍允许跳过：本地装 playwright 要下载约 150 MB 的浏览器，
   强制会让「只想跑引擎自测」的人被迫先装一整套环境。
   但默认跳过绝不能一路绿灯 —— CI 上若不预装浏览器，
   这一层实际不会被执行，看起来「全绿」实则没跑。
   因此只要处于 CI 环境（CI / GITHUB_ACTIONS 等任一变量存在），
   自动切为强制模式，不给「静默跳过」留口子。 */
const path = require('path');
const fs = require('fs');

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

/* 被测根目录。构建脚本会把压缩产物铺到临时目录并设
   SLOWSCROLL_ROOT，浏览器层因此能对着压缩后的代码跑 ——
   这是唯一能验证「压缩后的真实浏览器行为一致」的方式，
   Node 层验不到 transition、visibility、热区坐标这些真实渲染语义。 */
const ROOT = process.env.SLOWSCROLL_ROOT || path.join(__dirname, '..');
function ROOT_PLUS() {
  return path.join.apply(path, [ROOT].concat(Array.from(arguments)));
}

/* 夹具位置恒为源码目录，不随 SLOWSCROLL_ROOT 变。
   原因：产物目录只铺 filelist.js 的 INCLUDE 清单（纯运行时文件），
   不含 temp_tests/。若把夹具也指向 ROOT，产物验证会去找
   __stage/temp_tests/browser_check.html —— 该文件不存在，
   直接 page.goto 失败。夹具是测试资产，本就不该进产物。
   夹具内的 `../` 相对引用指向的是源码目录的资源，
   而被测代码通过 ROOT_PLUS 单独从产物读取，两条路径互不干扰。 */
const FIXTURES = __dirname;

const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS
  || process.env.GITLAB_CI || process.env.JENKINS_URL || process.env.BUILDKITE);
const REQUIRE = process.argv.includes('--require')
  || process.env.SLOWSCROLL_REQUIRE_BROWSER === '1'
  || isCI;

/* 依赖缺失时的处理：强制模式失败并给出可执行的修复命令，
   非强制模式跳过但在输出里显著标注 —— 不能让「没跑」看起来像「跑过了」 */
function bailMissing(reason, installHint) {
  const mode = REQUIRE ? '强制模式' : '本地模式';
  if (REQUIRE) {
    console.error(`\n✗ 浏览器验证未执行（${mode}）：${reason}`);
    console.error('  这一层覆盖了 Node 桩测不出的真实浏览器差异，不能跳过。');
    console.error('  修复：');
    installHint.forEach((l) => console.error('    ' + l));
    process.exit(1);
  }
  console.log(`\n○ 浏览器验证已跳过（${mode}）：${reason}`);
  console.log('  注意：本次结果不含浏览器层覆盖。CI 与发布前会自动强制执行。');
  installHint.forEach((l) => console.log('    ' + l));
  process.exit(0);
}

let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  bailMissing('未安装 playwright', [
    'npm install -D playwright',
    'npx playwright install --with-deps chromium',
  ]);
}

/* 浏览器来源的优先级：playwright 自带的 chromium > 本机 Chrome / Edge。
   这不是可有可无的偏好 —— CI 上通常没有 Chrome，
   若只认本机浏览器，`npx playwright install chromium` 装完仍会被判为
   「未找到浏览器」而失败，那才是这条技术债的真正根因。
   playwright 自带的版本与库严格匹配，不会因系统浏览器版本差异出诡异问题。 */
const LOCAL_BROWSERS = CHROME_PATHS.filter((p) => fs.existsSync(p));
const PREFER_BUNDLED = process.env.SLOWSCROLL_USE_SYSTEM_BROWSER !== '1';

function hasBundledChromium() {
  try {
    // executablePath() 在浏览器未下载时抛错，是最可靠的可用性判据
    return !!chromium.executablePath();
  } catch (e) {
    return false;
  }
}

let executablePath = null;
if (!PREFER_BUNDLED && LOCAL_BROWSERS.length) {
  executablePath = LOCAL_BROWSERS[0];
} else if (PREFER_BUNDLED && hasBundledChromium()) {
  executablePath = null;   // 传 undefined 即用自带浏览器
} else if (LOCAL_BROWSERS.length) {
  executablePath = LOCAL_BROWSERS[0];   // 自带的没装，退回本机
} else {
  bailMissing('未找到可用浏览器（playwright 自带 chromium 与本机 Chrome / Edge 均不可用）', [
    'npx playwright install --with-deps chromium   # CI 推荐，无需本机浏览器',
    '或安装本机 Chrome / Edge 后重试',
  ]);
}

if (REQUIRE) {
  const mode = executablePath
    ? `本机浏览器 ${path.basename(executablePath)}`
    : 'playwright 自带 chromium';
  console.log(`浏览器验证：强制模式（${isCI ? '检测到 CI 环境' : '--require'}）· ${mode}`);
}

const launchOptions = () => ({
  ...(executablePath ? { executablePath } : {}),
  args: ['--allow-file-access-from-files']
});

/* 四组验证必须串行执行：每组各自 launch 一个浏览器实例，
   并发跑会互相争抢 CPU，导致依赖真实计时的断言（如 H13 的
   2800ms 热区停留）超时假失败。曾实测同一份代码单独跑通过、
   并发跑稳定失败。改为具名函数 + 链式 then，见文件末尾。 */
async function groupScroll() {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message));

  const file = 'file:///' + path
    .join(FIXTURES, 'browser_check.html')
    .replace(/\\/g, '/');
  await page.goto(file);
  await page.waitForTimeout(6000);

  const lines = logs.filter((l) => l.includes('✓') || l.includes('✗') || l.includes('====='));
  console.log(lines.join('\n'));

  const summary = lines.find((l) => l.includes('====='));
  await browser.close();

  // 形如 "===== 13 passed, 0 failed ====="，只有 failed 为 0 才算通过
  const m = summary ? summary.match(/(\d+)\s+passed,\s*(\d+)\s+failed/) : null;
  if (!m) {
    console.error('\n未取得浏览器验证汇总结果');
    process.exit(1);
  }
  if (Number(m[2]) !== 0) {
    console.error(`\n浏览器验证存在失败项：${m[2]} 项失败`);
    process.exit(1);
  }
  console.log(`\n浏览器验证通过：${m[1]} 项`);
}

/* ============================================================
   第二组：悬浮条自动隐藏
   显隐依赖真实 CSS 过渡、真实布局坐标与真实焦点语义：
   visibility 是否真的移出可聚焦范围、热区坐标在真实视口下的取值、
   过渡时序是否被 prefers-reduced-motion 影响，Node 桩一律测不出。
   页面：temp_tests/overlay_check.html
   ============================================================ */
const CHROME_STUB = `
window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: () => {} },
    sendMessage: (m, cb) => { if (typeof cb === 'function') cb({ ok: true }); },
    getURL: (p) => p
  },
  storage: {
    sync: { get: (d, cb) => cb(d), set: (v, cb) => { if (cb) cb(); } },
    onChanged: { addListener: () => {} }
  }
};
`;

async function groupOverlay() {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage();
  const logs = [];
  const errors = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => {
    errors.push(e.message);
    logs.push('PAGEERROR: ' + e.message);
  });

  const file = 'file:///' + path
    .join(FIXTURES, 'overlay_check.html')
    .replace(/\\/g, '/');
  await page.goto(file);
  // 自动隐藏是纯计时行为，等待时长由页面内各用例自行 sleep 决定，
  // 这里的预算必须覆盖最长的那条链路（约 21s）
  await page.waitForTimeout(26000);

  const lines = logs.filter((l) => l.includes('✓') || l.includes('✗') || l.includes('====='));
  console.log(lines.join('\n'));

  if (errors.length) {
    console.error('\n捕获到未处理异常：\n' + errors.join('\n'));
  }

  const summary = lines.filter((l) => l.includes('=====')).pop();
  await browser.close();

  const m = summary ? summary.match(/(\d+)\s+passed,\s*(\d+)\s+failed/) : null;
  if (!m) {
    console.error('\n未取得悬浮条验证汇总结果');
    process.exit(1);
  }
  if (Number(m[2]) !== 0 || errors.length) {
    console.error(`\n悬浮条验证存在失败项：${m[2]} 项失败，${errors.length} 个未捕获异常`);
    process.exit(1);
  }
  console.log(`\n悬浮条验证通过：${m[1]} 项`);
}

/* ============================================================
   第三组：非 HTML 文档（SVG）不得崩溃
   回归背景：用户直接在浏览器打开 assets/icons/icon.svg 时，
   content script 注入后抛 "Cannot read properties of undefined
   (reading 'setProperty')"。根因是 SVG 文档中 createElement
   返回普通 Element，没有 style 属性。此类差异 Node 桩无法模拟，
   必须在真实浏览器中断言。
   ============================================================ */
async function groupNonHtml() {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  /* 夹具从源码目录取，不随 SLOWSCROLL_ROOT 变。
   icon.svg 是设计源文件，按 filelist.js 的 isDevOnly 明确不进产物
   （MV3 只认 PNG），但它正是本组回归的起因——用户曾直接打开它。
   与 HTML 夹具同理：夹具属测试资产，被测代码才走 ROOT_PLUS。 */
  const svg = 'file:///' + path
    .join(FIXTURES, '..', 'assets', 'icons', 'icon.svg')
    .replace(/\\/g, '/');
  await page.goto(svg);

  // 先确认真实环境确实是非 HTML 文档，否则本组断言形同虚设
  const env = await page.evaluate(() => ({
    contentType: document.contentType,
    divHasStyle: 'style' in document.createElement('div')
  }));
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
  };

  check('S1 前置：当前确为非 HTML 文档',
    env.contentType !== 'text/html' && !env.divHasStyle,
    `contentType=${env.contentType}, div.style 存在=${env.divHasStyle}`);

  await page.evaluate(CHROME_STUB);
  for (const f of ['shared/constants.js', 'content/overlay.js', 'content/scrollEngine.js']) {
    // SVG 文档没有 head，addScriptTag 会失败，改用 evaluate 执行源码
    await page.evaluate(fs.readFileSync(
      ROOT_PLUS(f), 'utf8'));
  }
  await page.waitForTimeout(800);

  const after = await page.evaluate(() => ({
    overlayMounted: !!document.getElementById('slowScroll-overlay'),
    engineReady: !!window.__slowScrollEngine,
    overlayGlobal: !!window.__slowScrollOverlay
  }));

  check('S2 SVG 文档中无未捕获异常', errors.length === 0,
    errors.length ? errors.join(' | ') : '无 pageerror');
  check('S3 悬浮条未挂载 DOM', !after.overlayMounted);
  check('S4 引擎未初始化', !after.engineReady);
  check('S5 悬浮条未挂载全局', !after.overlayGlobal);

  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`===== ${results.length - failed} passed, ${failed} failed =====`);
  if (failed !== 0) throw new Error(`非 HTML 文档验证有 ${failed} 项失败`);
}

/* ============================================================
   第四组：重复注入必须幂等
   回归背景：scrollEngine.js 的非 HTML 守卫原本写作顶层 const
   IS_HTML_DOC。Service Worker 被回收重启后 INJECTED_TABS 丢失，
   background 的 ensureContentInjected 会再次 executeScript 同一组文件，
   而顶层 const 处于全局词法作用域，重复声明直接抛
   "Identifier 'IS_HTML_DOC' has already been declared"，引擎整体失效。

   为什么其他两层测不出：Node 桩每次 runInContext 都是全新沙箱；
   page.evaluate 又是独立函数作用域。只有用真正的 <script> 标签
   注入（等价于 executeScript 的经典脚本语义）才会复现。
   ============================================================ */
async function groupReinject() {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('file:///' + path
    .join(FIXTURES, 'browser_check.html').replace(/\\/g, '/'));
  await page.waitForTimeout(1500);
  await page.evaluate(CHROME_STUB);

  const files = ['shared/constants.js', 'content/overlay.js', 'content/scrollEngine.js'];
  const sources = {};
  for (const f of files) {
    sources[f] = fs.readFileSync(ROOT_PLUS(f), 'utf8');
  }
  await page.evaluate((s) => { window.__SS_SRC__ = s; }, sources);

  // 用 <script> 标签注入，模拟 executeScript({files}) 的经典脚本语义
  const inject = () => page.evaluate((list) => {
    for (const f of list) {
      const el = document.createElement('script');
      el.textContent = window.__SS_SRC__[f];
      document.documentElement.appendChild(el);
      el.remove();
    }
  }, files);

  const r2 = [];
  const check2 = (name, ok, detail) => {
    r2.push({ name, ok });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
  };

  await inject();
  check2('R1 首轮注入引擎就绪',
    await page.evaluate(() => !!window.__slowScrollEngine));

  errors.length = 0;
  await inject();
  await page.waitForTimeout(300);

  const dupErr = errors.find((e) => /already been declared/.test(e));
  check2('R2 重复注入不抛词法声明冲突', !dupErr,
    dupErr ? dupErr.split('\n')[0] : '无 Identifier already been declared');
  check2('R3 重复注入后引擎仍可用',
    await page.evaluate(() => !!(window.__slowScrollEngine
      && typeof window.__slowScrollEngine.startScrolling === 'function')));

  await browser.close();

  const failed2 = r2.filter((r) => !r.ok).length;
  console.log(`===== ${r2.length - failed2} passed, ${failed2} failed =====`);
  if (failed2 !== 0) throw new Error(`重复注入验证有 ${failed2} 项失败`);
}

/* ============================================================
   第五组：区间循环与进度上报
   这两块都重度依赖真实时序，Node 桩测不准：
     · 停留期用的是真实 setTimeout，回弹用的是真实 rAF 插值，
       两者的衔接顺序只有真浏览器能验证；
     · progress 上报节流依赖 Date.now() 的真实推进，
       桩里是可控时钟，与真实计时器的表现并不等价。
   ============================================================ */
async function groupRange() {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('file:///' + path
    .join(FIXTURES, 'long_page.html').replace(/\\/g, '/'));
  await page.waitForTimeout(1200);
  await page.evaluate(CHROME_STUB);

  const files = ['shared/constants.js', 'content/overlay.js', 'content/scrollEngine.js'];
  const sources = {};
  for (const f of files) {
    sources[f] = fs.readFileSync(ROOT_PLUS(f), 'utf8');
  }
  await page.evaluate((s) => { window.__SS_SRC__ = s; }, sources);
  await page.evaluate((list) => {
    for (const f of list) {
      const el = document.createElement('script');
      el.textContent = window.__SS_SRC__[f];
      document.documentElement.appendChild(el);
      el.remove();
    }
  }, files);

  const r = [];
  const check = (name, ok, detail) => {
    r.push({ name, ok });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
  };

  // 前置：引擎就绪且页面可滚动
  const ready = await page.evaluate(() => !!(window.__slowScrollEngine
    && window.__slowScrollEngine.reselectContainer()));
  check('G1 引擎就绪且容器可选', ready);

  // 区间锚点：未启动滚动时也能捕获（容器此前尚未选定）
  const anchor = await page.evaluate(() => {
    const e = window.__slowScrollEngine;
    const el = e.reselectContainer();
    window.scrollTo(0, 0);
    el.scrollTop = 0;
    const start = e.captureAnchor('start');
    el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.4);
    const end = e.captureAnchor('end');
    const snap = e.getSnapshot();
    return { start, end, rangeStart: snap.rangeStart, rangeEnd: snap.rangeEnd, active: snap.rangeActive };
  });
  check('G2 未启动滚动也能捕获锚点', anchor.start === 0,
    `start=${anchor.start}（容器未选定时应为 null，这里说明兜底生效）`);
  check('G3 区间锚点记录正确', anchor.rangeStart === anchor.start && anchor.rangeEnd === anchor.end,
    `区间 ${anchor.rangeStart} → ${anchor.rangeEnd}`);
  check('G4 区间处于激活态', anchor.active === true);

  // 进度读数：区间模式下应反映当前 scrollTop
  const prog = await page.evaluate(() => {
    const e = window.__slowScrollEngine;
    const el = e.reselectContainer();
    el.scrollTop = 0;
    const top = e.getSnapshot().progress;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    const mid = e.getSnapshot().progress;
    el.scrollTop = el.scrollHeight;
    const bot = e.getSnapshot().progress;
    return { top, mid, bot };
  });
  check('G5 进度随滚动变化', prog.top < 0.05 && prog.mid > 0.4 && prog.mid < 0.6,
    `top=${prog.top.toFixed(3)} mid=${prog.mid.toFixed(3)} bot=${prog.bot.toFixed(3)}`);
  check('G6 底部进度为 1', Math.abs(prog.bot - 1) < 1e-6);

  // 进度上报节流：真实 rAF 下 1 秒内的上报次数应远小于帧数
  const sends = await page.evaluate(async () => {
    const e = window.__slowScrollEngine;
    e.clearRange();
    const el = e.reselectContainer();
    el.scrollTop = 0;
    let n = 0;
    const orig = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (m, cb) => { n++; if (typeof cb === 'function') cb({ ok: true }); };
    e.setSpeed(1000, { persist: false });
    e.startScrolling();
    const t0 = performance.now();
    await new Promise((res) => {
      const tickFn = () => {
        if (performance.now() - t0 > 1000) return res();
        requestAnimationFrame(tickFn);
      };
      requestAnimationFrame(tickFn);
    });
    e.stopScrolling();
    chrome.runtime.sendMessage = orig;
    return n;
  });
  check('G7 1 秒内进度上报被节流', sends > 0 && sends <= 12,
    `1 秒共上报 ${sends} 次（未节流时约 60 次，上限按 500ms 节流应为个位）`);

  // 区间循环真实时序：滚到下沿 → 停留 → 回弹到区间起点。
  // 速度取 4000 px/s（区间上限）并把区间缩到视口高度的 3 倍左右，
  // 让「下行 + 停留 + 回弹」整轮在 9 秒预算内跑完 ——
  // 此前用 600 px/s + 全页 40% 区间，往返一趟要 20s+，超时导致误判
  const loop = await page.evaluate(async () => {
    const e = window.__slowScrollEngine;
    const el = e.reselectContainer();
    e.setSpeed(4000, { persist: false });
    e.setRangeDwell(700);
    el.scrollTop = 0;
    e.captureAnchor('start');
    // 区间长度约 3 个视口，远大于 MIN_RANGE_SPAN 且往返很快
    el.scrollTop = el.clientHeight * 3;
    e.captureAnchor('end');
    const rangeEnd = e.getSnapshot().rangeEnd;

    el.scrollTop = 0;
    e.startScrolling();

    const seen = { dwelling: false, returning: false };
    let guard = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 9000 && guard++ < 40000) {
      const ph = e.getState().phase;
      if (ph === 'dwelling') seen.dwelling = true;
      if (ph === 'returning') seen.returning = true;
      if (seen.dwelling && seen.returning && e.getSnapshot().loopCount > 0) break;
      await new Promise((res) => requestAnimationFrame(res));
    }
    const snap = e.getSnapshot();
    e.stopScrolling();
    return {
      ...seen,
      rangeEnd,
      loopCount: snap.loopCount,
      finalTop: el.scrollTop,
      start: snap.rangeStart
    };
  });
  check('G8 到达区间下沿进入停留', loop.dwelling, `rangeEnd=${loop.rangeEnd}`);
  check('G9 停留后进入回弹', loop.returning);
  check('G10 区间循环计数递增', loop.loopCount > 0, `loopCount=${loop.loopCount}`);
  check('G11 回弹收敛到区间起点',
    Math.abs(loop.finalTop - loop.start) < 60,
    `终点 ${loop.finalTop.toFixed(0)}，区间起点 ${loop.start}`);

  check('G12 无未捕获异常', errors.length === 0,
    errors.length ? errors[0].split('\n')[0] : '无 pageerror');

  await browser.close();

  const failed = r.filter((x) => !x.ok).length;
  console.log(`===== ${r.length - failed} passed, ${failed} failed =====`);
  if (failed !== 0) throw new Error(`区间循环验证有 ${failed} 项失败`);
}

/* ============================================================
   第六组：影子 DOM 与 iframe（真实浏览器差异）
   ------------------------------------------------------------
   为什么 Node 桩测不出：
     · querySelectorAll 不跨 shadow 边界，这是规范行为；
       桩里可以随手返回任意数组，测不到「引擎是否真的下钻」
     · 引擎的「本 frame 能否滚动」判定依赖真实布局尺寸，
       iframe 的 innerWidth/innerHeight 与顶层不同
     · attachShadow 的 closed 模式在真实浏览器里 shadowRoot 为 null，
       遍历必须自然终止而不抛错

   覆盖：
     F1 shadow root 内的可滚动容器能被选中
     F2 shadow 内容器确实能被驱动滚动
     F3 closed shadow root 不抛错且不误选
     F4 小尺寸 iframe 触发引擎跳过
     F5 正常尺寸 iframe 正常初始化
   ============================================================ */
async function groupShadowAndFrames() {
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage();
  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => logs.push(m.text()));

  /* 页面布局要点（踩过坑）：
     shadow 容器必须占据页面主体。若同时摆两个 iframe，视口被撑高后
     document 根的可见面积会超过 shadow 容器，selectScrollContainer
     按「面积优先」规则就会合理地选 body —— 那是既有择优规则的正确行为，
     不是穿透失败。所以 iframe 与 shadow 断言分开取证：
     F1/F2/F3 只留 shadow，F4/F5/F6 的 iframe 单独成组。 */
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>shadow/frame</title>
  <style>html,body{margin:0}#host{height:600px}</style></head>
  <body>
    <div id="host"></div>
    <script>
      const host = document.getElementById('host');
      const sr = host.attachShadow({ mode: 'open' });
      const box = document.createElement('div');
      box.id = 'shadowBox';
      box.style.cssText = 'height:500px;overflow-y:auto;background:#eee';
      box.innerHTML = '<div style="height:5000px">shadow 内容</div>';
      sr.appendChild(box);

      // 封闭 root：浏览器不暴露引用，遍历必须靠 shadowRoot === null 自然跳过
      const closedHost = document.createElement('div');
      closedHost.id = 'closedHost';
      document.body.appendChild(closedHost);
      const csr = closedHost.attachShadow({ mode: 'closed' });
      const cbox = document.createElement('div');
      cbox.style.cssText = 'height:120px;overflow-y:auto';
      cbox.innerHTML = '<div style="height:5000px">closed shadow 内容</div>';
      csr.appendChild(cbox);

      window.chrome = {
        runtime: {
          lastError: null,
          onMessage: { addListener: () => {} },
          sendMessage: (m, cb) => { if (typeof cb === 'function') cb({ ok: true }); },
          getURL: (p) => p
        },
        storage: {
          sync: { get: (d, cb) => cb(d), set: (v, cb) => { if (cb) cb(); } },
          onChanged: { addListener: () => {} }
        }
      };
    <\/script>
    <!-- iframe 放在 shadow 断言之后动态插入，避免与 shadow 容器争抢面积 -->
  </body></html>`;

  await page.setContent(html);
  // 顶层：注入 chrome 桩（已随 HTML 内联）后再注入常量与引擎
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'shared', 'constants.js'), 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'content', 'scrollEngine.js'), 'utf8') });

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
  };

  // 顶层引擎就绪是所有后续断言的前置：引擎没起来的话，
  // reselectContainer 不存在，失败会伪装成「穿透失败」
  const topReady = await page.evaluate(() => !!window.__slowScrollEngine);
  check('F0 顶层引擎已就绪（前置）', topReady);
  if (!topReady) {
    await browser.close();
    console.log(`===== ${results.length - results.filter((r) => !r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed =====`);
    throw new Error('顶层引擎未初始化，后续断言无意义');
  }

  const F1 = await page.evaluate(() => {
    const box = document.getElementById('host').shadowRoot.getElementById('shadowBox');
    const picked = window.__slowScrollEngine.reselectContainer();
    return { pickedId: picked ? picked.id : null, boxId: box.id, isShadow: picked === box };
  });
  check('F1 shadow root 内的可滚动容器能被选中', F1.isShadow,
    `选中 ${F1.pickedId || 'null'}，目标 ${F1.boxId}`);

  const F2 = await page.evaluate(async () => {
    const e = window.__slowScrollEngine;
    e.startScrolling();
    await new Promise((r) => setTimeout(r, 700));
    const box = document.getElementById('host').shadowRoot.getElementById('shadowBox');
    const top = box.scrollTop;
    e.stopScrolling();
    return { top };
  });
  check('F2 shadow 内容器确实被驱动滚动', F2.top > 0, `scrollTop=${F2.top.toFixed(0)}`);

  const F3 = await page.evaluate(() => {
    /* 回归背景：封闭 root 的 shadowRoot 为 null（规范如此，浏览器不暴露引用）。
       遍历若不做 null 判断就会在 el.shadowRoot.querySelectorAll 处抛错，
       表现为整页停止响应。断言只针对这一契约本身。

       注意不要断言「选中 document 根」：页面上本就有更大的可滚动容器，
       按面积择优规则本来就该选它，那与 closed root 无关。 */
    const closedHost = document.getElementById('closedHost');
    const exposed = closedHost.shadowRoot;
    let threw = null;
    let picked = null;
    try {
      picked = window.__slowScrollEngine.reselectContainer();
    } catch (e) {
      threw = e.message;
    }
    return { exposed, threw, pickedTag: picked ? picked.tagName : null };
  });
  check('F3 closed shadow root 不暴露引用且遍历不抛错',
    F3.exposed === null && F3.threw === null,
    `shadowRoot=${F3.exposed === null ? 'null（符合预期）' : '意外暴露'}` +
    (F3.threw ? `, 遍历抛错 ${F3.threw}` : `, 遍历正常（选中 ${F3.pickedTag}）`));

  // ---- iframe 行为 ----
  // shadow 断言跑完后再插入 iframe：两者同页会争抢可见面积，
  // 插早了会让上面的 shadow 容器因「面积不占优」被合理地落选
  await page.evaluate(() => {
    const big = document.createElement('iframe');
    big.id = 'big';
    big.style.cssText = 'width:800px;height:600px;border:0';
    const tiny = document.createElement('iframe');
    tiny.id = 'tiny';
    tiny.style.cssText = 'width:80px;height:40px;border:0';
    document.body.appendChild(big);
    document.body.appendChild(tiny);
  });
  await page.waitForTimeout(300);

  const frames = page.frames();
  const results2 = { big: false, tiny: false, sizes: {} };
  for (const f of frames) {
    if (f === page.mainFrame()) continue;
    const info = await f.evaluate(() => {
      try {
        return { w: window.innerWidth, h: window.innerHeight };
      } catch (e) {
        return null;
      }
    }).catch(() => null);
    if (!info) continue;
    if (info.w >= 800) results2.big = true;
    if (info.w <= 120 && info.h <= 80) results2.tiny = true;
  }
  check('F4 存在大尺寸与微小尺寸两类 iframe 前置', results2.big && results2.tiny,
    `大=${results2.big} 小=${results2.tiny}`);

  // 在两个 iframe 内分别注入引擎，验证尺寸守卫。
  // 每个 frame 都要先注入 chrome 桩：content script 环境下由浏览器提供，
  // 但这里是普通 iframe，必须手工补齐，否则引擎初始化直接抛错
  const constSrc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'constants.js'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'content', 'scrollEngine.js'), 'utf8');
  const frameStates = [];
  for (const f of frames) {
    if (f === page.mainFrame()) continue;
    const s = await f.evaluate(({ c, e }) => {
      window.chrome = {
        runtime: {
          lastError: null,
          onMessage: { addListener: () => {} },
          sendMessage: (m, cb) => { if (typeof cb === 'function') cb({ ok: true }); },
          getURL: (p) => p
        },
        storage: {
          sync: { get: (d, cb) => cb(d), set: (v2, cb) => { if (cb) cb(); } },
          onChanged: { addListener: () => {} }
        }
      };
      for (const src of [c, e]) {
        const el = document.createElement('script');
        el.textContent = src;
        document.documentElement.appendChild(el);
        el.remove();
      }
      return {
        w: window.innerWidth,
        h: window.innerHeight,
        hasEngine: !!window.__slowScrollEngine
      };
    }, { c: constSrc, e: engineSrc }).catch(() => null);
    if (s) frameStates.push(s);
  }

  check('F5 大尺寸 iframe 正常初始化引擎',
    frameStates.some((s) => s.w >= 800 && s.hasEngine),
    JSON.stringify(frameStates));
  check('F6 微小 iframe 跳过引擎初始化',
    frameStates.some((s) => s.w <= 120 && s.h <= 80 && !s.hasEngine),
    JSON.stringify(frameStates));

  check('F7 无未捕获异常', errors.length === 0,
    errors.length ? errors[0].split('\n')[0] : '无 pageerror');

  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`===== ${results.length - failed} passed, ${failed} failed =====`);
  if (failed !== 0) throw new Error(`影子 DOM / iframe 验证有 ${failed} 项失败`);
}

/* ============================================================
   串行执行六组
   ============================================================ */
groupScroll()
  .then(groupOverlay)
  .then(groupNonHtml)
  .then(groupReinject)
  .then(groupRange)
  .then(groupShadowAndFrames)
  .catch((e) => {
    console.error('浏览器验证执行失败:', e.message);
    process.exit(1);
  });
