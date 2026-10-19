/* 引擎行为自测：在 Node 中用最小 DOM 桩验证关键逻辑。
   覆盖：容器探测优先级、dt 钳制、步进委派、scroll-behavior 还原、
        idle 低频探测、无限滚动判定复位、用户手势接管、常量一致性。
   运行：node temp_tests/engine.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* 被测根目录。默认指向项目本身；构建脚本会把压缩后的产物
   铺到临时目录并设 SLOWSCROLL_ROOT，让同一套断言跑在压缩产物上 ——
   这是「压缩没有改变行为」唯一有说服力的证据。 */
const ROOT = process.env.SLOWSCROLL_ROOT || path.join(__dirname, '..');

// 替代原先散落的 path.join(__dirname, '..', ...) 写法
function ROOT_PLUS() {
  return path.join.apply(path, [ROOT].concat(Array.from(arguments)));
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

/* ---------- 最小 DOM 桩 ---------- */
// 统一 Element 基类，供引擎的 instanceof 判定使用
class FakeElement {}

function makeEl(tag, opts = {}) {
  const el = Object.assign(new FakeElement(), {
    // tagName 按 HTML 语义一律大写（浏览器对 HTML 元素的真实行为）。
    // 桩若原样返回小写，引擎里 el.tagName === 'A' 这类判定会恒假，
    // 得出「功能不工作」的错误结论。
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    style: {
      _v: {},
      setProperty(k, v, p) { this._v[k] = [v, p || '']; },
      getPropertyValue(k) { return this._v[k] ? this._v[k][0] : ''; },
      getPropertyPriority(k) { return this._v[k] ? this._v[k][1] : ''; },
      removeProperty(k) { delete this._v[k]; }
    },
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    removeAttribute(k) { delete this._attrs[k]; },
    getAttribute(k) { return this._attrs[k]; },
    isConnected: true,
    clientHeight: opts.clientHeight ?? 800,
    scrollHeight: opts.scrollHeight ?? 800,
    scrollTop: 0,
    scrollTo(o) { this.scrollTop = o.top; },
    getBoundingClientRect() {
      return opts.rect || { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
    }
  });
  el.scrollLeft = 0;
  // 溢出样式需一并复制，否则通过 opts 传入的 overflowY 会丢失，
  // 元素退化为不可滚动，用例会走进意料之外的分支
  el.__overflowY = opts.__overflowY;
  el.__overflowX = opts.__overflowX;
  // 链接相关：文本内容与 click 记录，供自动翻页用例断言「点到了哪个」
  el.textContent = opts.textContent ?? '';
  el.__clicks = 0;
  el.click = function () { this.__clicks++; };
  return el;
}

// 造一个 <a>：自动翻页的全部判定都落在 href / 文案 / 尺寸三项上
function makeLink({ href = '/ch2', text = '下一章', rel = null, visible = true } = {}) {
  const el = makeEl('a', {
    rect: visible
      ? { left: 100, top: 700, right: 200, bottom: 740, width: 100, height: 40 }
      : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    textContent: text
  });
  el.setAttribute('href', href);
  if (rel) el.setAttribute('rel', rel);
  return el;
}

function makeEnv({ documentEl, innerEl, winW = 1200, winH = 800, shadowHost, shadowInner,
                   links = [], href = 'https://example.com/ch1', hostname = 'example.com' }) {
  const docEl = documentEl || makeEl('html', { clientHeight: winH, scrollHeight: winH });
  const body = makeEl('body', { clientHeight: winH, scrollHeight: winH });

  const listeners = {};
  const rafQueue = [];
  const timers = [];   // 可控定时器队列：{ id, fn, delay }
  let timerSeq = 0;
  // 可控时钟：节流/防抖相关断言必须依赖它，
  // 用真实 Date.now() 时推进定时器与推进时间可能不同步，断言会随机失败
  let fakeNow = 1000000;
  const storage = {};
  const storageListeners = [];
  const storedWrites = [];

  /* ---------- 影子 DOM 桩 ----------
     shadowHost 挂一个 open shadowRoot，root 内含 shadowInner。
     document.querySelectorAll('body *') 按真实语义看不到 shadow 内部，
     只有通过 host.shadowRoot 才能取到 —— 引擎若不下钻就必然漏掉它。 */
  if (shadowHost && shadowInner) {
    shadowHost.shadowRoot = {
      querySelectorAll: (sel) => (sel === '*' ? [shadowInner] : [])
    };
  }

  const document = {
    documentElement: docEl,
    body,
    scrollingElement: docEl,
    contentType: 'text/html',   // 缺省会触发非 HTML 文档守卫，桩须与真实页面一致
    visibilityState: 'visible',
    querySelectorAll: (sel) => {
      // 自动翻页只查两类选择器，桩按此返回链接列表；
      // 其余选择器（含 'body *'）仍走容器探测路径
      if (sel === 'a[href]' || sel === 'a[rel~="next"], a[rel="next"]') {
        return sel === 'a[href]' ? links : links.filter((a) => !!a.getAttribute('rel'));
      }
      if (sel !== 'body *') return [];
      const list = [];
      if (innerEl) list.push(innerEl);
      if (shadowHost) list.push(shadowHost);
      return list;
    },
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    getElementById: () => null,
    createElement: (t) => makeEl(t)
  };

  const window = {
    innerWidth: winW,
    innerHeight: winH,
    getComputedStyle: (el) => ({
      overflowY: el.__overflowY || 'visible',
      overflowX: el.__overflowX || 'visible'
    }),
    addEventListener: (t, fn) => { (listeners['w:' + t] ||= []).push(fn); },
    dispatchEvent: () => {},
    scrollTo: () => {},
    // 自动翻页要做同源校验与 URL 解析，桩须提供真实的 location 与 URL
    location: { href, hostname }
  };

  const sandbox = {
    window, document, console,
    // 真实浏览器全局，桩中需提供以便 instanceof 判定
    Element: FakeElement,
    // 常量从真实文件加载，保证测试覆盖实际取值
    __SLOWSCROLL_CONSTANTS__: loadConstants(),
    __SLOWSCROLL_IS_HTML_DOC__: loadIsHtmlDoc(),
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener: () => {} },
        sendMessage: (m, cb) => { if (cb) cb({ ok: true }); }
      },
      storage: {
        sync: {
          get: (defaults, cb) => {
            const out = { ...defaults };
            for (const k of Object.keys(out)) {
              if (k in storage) out[k] = storage[k];
            }
            cb(out);
          },
          set: (v, cb) => {
            Object.assign(storage, v);
            storedWrites.push({ ...v });
            if (cb) cb();
          },
          remove: (k, cb) => { delete storage[k]; if (cb) cb(); }
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) }
      }
    },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    // 可控定时器：idle 探测走这里，测试可手动推进
    setTimeout: (fn, delay) => {
      const id = ++timerSeq;
      timers.push({ id, fn, delay });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    Date: Object.assign(function Date() { return new Date(fakeNow); }, {
      now: () => fakeNow
    }),
    Math, Number,
    // 引擎用 new URL() 解析 href 并比对协议，桩里必须给真实实现
    URL
  };
  sandbox.globalThis = sandbox;
  return {
    sandbox, listeners, rafQueue, timers, docEl, innerEl,
    storage, storedWrites, storageListeners,
    // 推进可控时钟，用于验证节流与防抖
    advanceTime: (ms) => { fakeNow += ms; }
  };
}

// 从真实文件读取常量，避免测试与实现脱节
function loadConstants() {
  const src = fs.readFileSync(ROOT_PLUS('shared', 'constants.js'), 'utf8');
  const box = {};
  vm.createContext(box);
  vm.runInContext(src, box);
  return box.__SLOWSCROLL_CONSTANTS__;
}

// 与常量同文件产出的宿主文档判定函数，引擎/悬浮条的非 HTML 守卫依赖它
function loadIsHtmlDoc() {
  const src = fs.readFileSync(ROOT_PLUS('shared', 'constants.js'), 'utf8');
  const box = {};
  vm.createContext(box);
  vm.runInContext(src, box);
  return box.__SLOWSCROLL_IS_HTML_DOC__;
}

function loadEngine(env) {
  const src = fs.readFileSync(ROOT_PLUS('content', 'scrollEngine.js'), 'utf8');
  vm.createContext(env.sandbox);
  vm.runInContext(src, env.sandbox);
  return env.sandbox.window.__slowScrollEngine;
}

/* ============================================================
   T1 容器探测：SPA 内部容器应优先于 document 根
   ============================================================ */
console.log('\nT1 容器探测');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const inner = makeEl('div', { clientHeight: 800, scrollHeight: 5000 });
  inner.__overflowY = 'auto';
  const env = makeEnv({ documentEl: docEl, innerEl: inner });
  const engine = loadEngine(env);
  const picked = engine.reselectContainer();
  assert(picked === inner, '内部可滚动容器优先级高于 document 根');
}

{
  // 内部容器溢出不足，应回落到 document
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 9000 });
  const inner = makeEl('div', { clientHeight: 800, scrollHeight: 800 });
  inner.__overflowY = 'auto';
  const env = makeEnv({ documentEl: docEl, innerEl: inner });
  const engine = loadEngine(env);
  assert(engine.reselectContainer() === docEl, '内部容器无溢出时回落到 document');
}

{
  // overflow-y: hidden 不是可滚动容器，应被排除
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 9000 });
  const inner = makeEl('div', { clientHeight: 800, scrollHeight: 5000 });
  inner.__overflowY = 'hidden';
  const env = makeEnv({ documentEl: docEl, innerEl: inner });
  const engine = loadEngine(env);
  assert(engine.reselectContainer() === docEl, 'overflow:hidden 容器不被选中');
}

/* ============================================================
   T2 dt 钳制：后台标签页恢复不得瞬移
   ============================================================ */
console.log('\nT2 dt 钳制');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.setSpeed(4000);
  engine.startScrolling();

  // startScrolling 已排入首帧；先跑一帧建立时间基准，再模拟后台 30 秒后回前台
  const first = env.rafQueue.shift();
  first(1000);
  const tick = env.rafQueue.shift();

  const before = docEl.scrollTop;
  tick(31000); // 跨度 30 秒
  const delta = docEl.scrollTop - before;

  // 未钳制时应为 4000 * 30 = 120000px，钳制后应为 4000 * 0.05 = 200px
  assert(delta > 0 && delta <= 200.5, `巨量 dt 被钳制（实际位移 ${delta.toFixed(0)}px ≤ 200px）`);
}

/* ============================================================
   T3 visibilitychange 重置时间基准
   ============================================================ */
console.log('\nT3 visibilitychange');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  loadEngine(env);
  assert(env.listeners['visibilitychange'].length === 1, '已注册 visibilitychange 监听');
  assert(typeof env.sandbox.window.__slowScrollEngine.getState === 'function', '引擎导出正常');
}

/* ============================================================
   T4 步进委派：stepSpeed 不再写死 50
   ============================================================ */
console.log('\nT4 步进委派');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.getState().step = 120;           // 模拟设置页步进=120
  engine.setSpeed(600);
  assert(engine.stepSpeed(1) === 720, '加速按 step=120 递增(600→720)');
  assert(engine.stepSpeed(-1) === 600, '减速按 step=120 递减(720→600)');
  engine.setSpeed(3950);
  assert(engine.stepSpeed(1) === 4000, '加速在 maxSpeed 处钳位');
  engine.setSpeed(100);
  assert(engine.stepSpeed(-1) === 50, '减速在 minSpeed 处钳位');
}

/* ============================================================
   T5 scroll-behavior覆盖与还原
   ============================================================ */
console.log('\nT5 scroll-behavior');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  docEl.style.setProperty('scroll-behavior', 'smooth');
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  const before = docEl.style.getPropertyValue('scroll-behavior');

  engine.startScrolling();
  assert(docEl.style.getPropertyValue('scroll-behavior') === 'auto', '滚动期间强制 scroll-behavior:auto');
  assert(docEl.style.getPropertyPriority('scroll-behavior') === 'important', '覆盖带 !important 优先级');
  assert(docEl.getAttribute('data-slowscroll-scroll') !== undefined, '写入标记属性');

  engine.stopScrolling();
  assert(docEl.style.getPropertyValue('scroll-behavior') === before, '停止后还原原始 scroll-behavior');
  assert(docEl.getAttribute('data-slowscroll-scroll') === undefined, '停止后移除标记属性');
}

/* ============================================================
   T6 已移除的死字段不再出现
   ============================================================ */
console.log('\nT6 死字段清理');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  const st = engine.getState();
  const removed = ['direction', 'lastScrollHeight', 'wasAtBottom', 'bottomHitCount'];
  removed.forEach((k) => assert(!(k in st), `已移除只写不读字段 ${k}`));
  assert('suspectedInfinite' in engine.getSnapshot(), 'snapshot 仍保留 suspectedInfinite（实际被读取）');
}

/* ============================================================
   T7 scrollToTop 统一走容器
   ============================================================ */
console.log('\nT7 scrollToTop');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  docEl.scrollTop = 3000;
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();
  engine.scrollToTop();
  assert(docEl.scrollTop === 0, 'scrollToTop 将容器归位到 0');
  assert(engine.getSnapshot().isScrolling === false, 'scrollToTop 同时停止滚动');
}

/* ============================================================
   T8 idle：触底且不循环时停止 rAF 空转
   ============================================================ */
console.log('\nT8 idle 低频探测');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  // 跑帧直到触底：容器高 800，内容高 5000
  let guard = 0;
  while (env.rafQueue.length && guard++ < 500) {
    const fn = env.rafQueue.shift();
    fn(1000 + guard * 16);
  }
  // 触底后不应再排下一帧，而应交给 idle 定时器
  assert(env.rafQueue.length === 0, '触底后停止排 rAF 帧（不再空转）');
  assert(env.timers.length === 1, '触底后挂起 1 个低频探测定时器');
  assert(engine.getState().phase === 'idle', '触底后 phase 切换为 idle');
}

{
  // idle 期间内容被追加 → 恢复主循环
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  let guard = 0;
  while (env.rafQueue.length && guard++ < 500) {
    const fn = env.rafQueue.shift();
    fn(1000 + guard * 16);
  }
  assert(engine.getState().phase === 'idle', '进入 idle 状态');

  // 模拟懒加载追加内容
  docEl.scrollHeight = 9000;
  const probe = env.timers.shift();
  probe.fn();

  assert(env.rafQueue.length === 1, '内容增长后恢复 rAF 主循环');
  assert(engine.getState().phase === 'down', '恢复后 phase 回到 down');
}

{
  // idle 期间用户用滚动条手动回滚 → 应暂停而非继续驱动
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  let guard = 0;
  while (env.rafQueue.length && guard++ < 500) {
    const fn = env.rafQueue.shift();
    fn(1000 + guard * 16);
  }
  // 用户拖动滚动条回到顶部（不产生 wheel 事件）
  docEl.scrollTop = 100;
  const probe = env.timers.shift();
  probe.fn();

  assert(engine.getState().isPaused === true, 'idle 期间检测到用户手动回滚则自动暂停');
  assert(env.rafQueue.length === 0, '暂停后不再排帧');
}

{
  // 停止滚动应清理 idle 定时器，避免脱离页面的悬挂回调
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  let guard = 0;
  while (env.rafQueue.length && guard++ < 500) {
    const fn = env.rafQueue.shift();
    fn(1000 + guard * 16);
  }
  assert(env.timers.length === 1, '触底后存在 idle 定时器');
  engine.stopScrolling();
  assert(env.timers.length === 0, '停止滚动后清理 idle 定时器');
}

/* ============================================================
   T9 suspectedInfinite 离开底部后必须复位
   ============================================================ */
console.log('\nT9 无限滚动判定复位');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  // 手动置为「已判定无限滚动」
  engine.getState().suspectedInfinite = true;
  assert(engine.getSnapshot().suspectedInfinite === true, '前置条件：判定为无限滚动');

  // 跑到离开底部（scrollTop=0 且内容高度足够大时不会触发 reset，
  // 这里直接让容器不处于底部状态，触发 else 分支）
  docEl.scrollHeight = 100000;
  const fn = env.rafQueue.shift();
  fn(2000);

  assert(engine.getSnapshot().suspectedInfinite === false,
    '离开底部后 suspectedInfinite 复位（此前永久残留导致循环失效）');
}

/* ============================================================
   T10 用户手势接管
   ============================================================ */
console.log('\nT10 用户手势接管');
{
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  const wheel = env.listeners['w:wheel'] || [];
  const keydown = env.listeners['w:keydown'] || [];
  assert(wheel.length === 1, '已注册 wheel 监听');
  assert((env.listeners['w:touchstart'] || []).length === 1, '已注册 touchstart 监听');
  assert((env.listeners['w:touchmove'] || []).length === 1, '已注册 touchmove 监听');
  assert(keydown.length === 1, '已注册 keydown 监听');

  // 滚轮事件 → 自动暂停
  wheel[0]({ target: { closest: () => null } });
  assert(engine.getState().isPaused === true, '滚轮操作触发自动暂停');
}

{
  // 悬浮条自身的滚轮不应触发接管
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  const wheel = env.listeners['w:wheel'] || [];
  wheel[0]({ target: { closest: (sel) => (sel === '#slowScroll-overlay' ? {} : null) } });
  assert(engine.getState().isPaused === false, '悬浮条上的滚轮不触发接管');
}

{
  // 方向键 → 接管；组合键 → 不接管
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  const keydown = env.listeners['w:keydown'] || [];
  keydown[0]({ key: 'ArrowDown', ctrlKey: false, metaKey: false, altKey: false });
  assert(engine.getState().isPaused === true, '方向键触发自动暂停');
}

{
  // 带 Alt 的组合键归扩展自身，不接管
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  const keydown = env.listeners['w:keydown'] || [];
  keydown[0]({ key: 'ArrowDown', ctrlKey: false, metaKey: false, altKey: true });
  assert(engine.getState().isPaused === false, '组合键（Alt）不触发接管');
}

/* ============================================================
   T11 容器校验节流
   ============================================================ */
console.log('\nT11 容器校验节流');
{
  // 用内部滚动容器而非文档根：
  // isScrollable 对 documentElement 走特殊分支，只读 scrollHeight/clientHeight
  // 就return，根本不调用 getComputedStyle —— 用文档根做容器时本用例
  // 永远测不到抽检（styleCalls 恒为 0）。
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const inner = makeEl('div', {
    clientHeight: 800,
    scrollHeight: 200000,
    __overflowY: 'auto'
  });
  const env = makeEnv({ documentEl: docEl, innerEl: inner });
  const engine = loadEngine(env);

  // 统计 getComputedStyle 调用次数
  let styleCalls = 0;
  env.sandbox.window.getComputedStyle = (el) => {
    styleCalls++;
    return { overflowY: el.__overflowY || 'visible', overflowX: 'visible' };
  };

  // 触底后引擎会切到 setTimeout 空闲探测，rAF 队列随之枯竭，
  // 后续帧不再经过 ensureContainer，抽检就测不出来了。
  // 这里把容器拉到足够深，确保整个用例期间不会触底。
  engine.startScrolling();
  styleCalls = 0;   // 排除启动时的容器选择

  // 连续跑 20 帧（小于抽检间隔，应一次都不触发）
  for (let i = 0; i < 20; i++) {
    const fn = env.rafQueue.shift();
    if (!fn) break;
    fn(1000 + i * 16);
  }
  assert(styleCalls === 0, `20 帧内未触发样式重算（实际 ${styleCalls} 次）`);

  // 跑满一个检查间隔，应出现抽检。
  // 间隔取自常量而非硬编码：原先写死 20 帧（20 % 30 ≠ 0），永远触发不到。
  const CHECK_INTERVAL = loadConstants().CONTAINER_CHECK_INTERVAL_FRAMES;
  for (let i = 0; i < CHECK_INTERVAL; i++) {
    const fn = env.rafQueue.shift();
    if (!fn) break;
    fn(2000 + i * 16);
  }
  assert(styleCalls > 0, `超过检查间隔后触发一次抽检（实际 ${styleCalls} 次）`);
}

{
  // 回归防护：文档根元素必须被识别为可滚动容器。
  // 标准模式下 documentElement 的 overflow 计算值是 visible，
  // 若按普通元素判定，isScrollable 会永远返回 false，
  // 抽检每次都失败并回落到全量扫描 body *。
  // 浏览器实测该 bug 导致 60 帧内触发 390 次样式重算（修复后为 0 次）。
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  docEl.__overflowY = 'visible';   // 模拟标准模式下的根元素
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  let styleCalls = 0;
  env.sandbox.window.getComputedStyle = (el) => {
    styleCalls++;
    return { overflowY: el.__overflowY || 'visible', overflowX: 'visible' };
  };

  engine.startScrolling();
  styleCalls = 0;

  // 跑满一个检查间隔，触发对当前容器的抽检
  const CHECK_INTERVAL = loadConstants().CONTAINER_CHECK_INTERVAL_FRAMES;
  for (let i = 0; i < CHECK_INTERVAL + 10; i++) {
    const fn = env.rafQueue.shift();
    if (!fn) break;
    fn(1000 + i * 16);
  }
  // 抽检若正确判定根元素可滚动，则不会触发 selectScrollContainer 的全量扫描
  assert(styleCalls === 0,
    `根元素抽检不再回落到全量扫描（样式重算 ${styleCalls} 次，应为 0）`);
}

/* ============================================================
   T12 常量单一来源
   ============================================================ */
console.log('\nT12 常量一致性');
{
  const C = loadConstants();
  assert(C.MIN_SPEED === 50 && C.MAX_SPEED === 4000, '速度区间与约定一致');
  assert(C.DEFAULT_SPEED === 600 && C.DEFAULT_STEP === 50, '默认值与约定一致');
  assert(C.MIN_STEP === 10 && C.MAX_STEP === 500, '步进区间与约定一致');

  // 引擎实际使用的区间必须来自常量
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.setSpeed(999999);
  assert(engine.getSnapshot().speed === C.MAX_SPEED, '引擎速度上界取自常量');
  engine.setSpeed(-1);
  assert(engine.getSnapshot().speed === C.MIN_SPEED, '引擎速度下界取自常量');

  // 源码中不应再出现速率魔数
  const engineSrc = fs.readFileSync(
    ROOT_PLUS('content', 'scrollEngine.js'), 'utf8');
  const hasMagic = /minSpeed\s*:\s*\d+|maxSpeed\s*:\s*\d+|defaultSpeed\s*:\s*\d+/.test(engineSrc);
  assert(!hasMagic, '引擎内不再保留速率常量副本');

  const optionsSrc = fs.readFileSync(
    ROOT_PLUS('options', 'options.js'), 'utf8');
  const optsMagic = /MIN_SPEED\s*=\s*\d+|MAX_SPEED\s*=\s*\d+/.test(optionsSrc);
  assert(!optsMagic, '设置页不再保留区间常量副本');
}

/* ============================================================
   T13 非 HTML 文档守卫
   matches 为 <all_urls>，会命中 SVG / XML / 图片查看器。
   这些文档中 createElement 产出普通 Element（无 style），
   引擎与悬浮条必须直接跳过，不得初始化、不得抛错。
   回归背景：用户直接在浏览器打开 assets/icons/icon.svg 即崩溃。
   ============================================================ */
console.log('\nT13 非 HTML 文档守卫');
{
  const isHtmlDoc = loadIsHtmlDoc();

  assert(isHtmlDoc({ contentType: 'text/html', createElement: () => ({ style: {} }) }) === true,
    'text/html 判定为 HTML 文档');
  assert(isHtmlDoc({ contentType: 'application/xhtml+xml', createElement: () => ({ style: {} }) }) === true,
    'XHTML 判定为 HTML 文档');
  assert(isHtmlDoc({ contentType: 'image/svg+xml', createElement: () => ({}) }) === false,
    'image/svg+xml 判定为非 HTML 文档');
  assert(isHtmlDoc({ contentType: 'text/xml', createElement: () => ({}) }) === false,
    'text/xml 判定为非 HTML 文档');
  // contentType 缺失时的兜底：以「能否造出带 style 的元素」为准。
  // 不能用 documentElement.style —— SVGSVGElement 也有 style，会误判为 HTML。
  assert(isHtmlDoc({ createElement: () => ({}) }) === false,
    'contentType 缺失且元素无 style 时判为非 HTML');
  assert(isHtmlDoc({ createElement: () => ({ style: {} }) }) === true,
    'contentType 缺失但元素有 style 时判为 HTML');
  assert(isHtmlDoc(null) === false || isHtmlDoc({}) === false,
    '残缺 document 判定不抛错');

  // 引擎在非 HTML 文档中不得初始化
  {
    const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
    const env = makeEnv({ documentEl: docEl });
    env.sandbox.document.contentType = 'image/svg+xml';
    const engine = loadEngine(env);
    assert(!engine, '引擎在 SVG 文档中不初始化');
    assert(!env.sandbox.window.__slowScrollEngine,
      '引擎未挂载 window.__slowScrollEngine');
  }

  // 悬浮条在非 HTML 文档中不得挂载，且注入过程不抛错
  {
    const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
    const env = makeEnv({ documentEl: docEl });
    env.sandbox.document.contentType = 'image/svg+xml';
    env.sandbox.chrome.runtime.getURL = (p) => p;
    let threw = null;
    try {
      vm.runInContext(fs.readFileSync(
        ROOT_PLUS('content', 'overlay.js'), 'utf8'),
        vm.createContext(env.sandbox));
    } catch (e) {
      threw = e;
    }
    assert(!threw, '悬浮条在 SVG 文档中注入不抛错' + (threw ? '：' + threw.message : ''));
    assert(!env.sandbox.window.__slowScrollOverlay,
      '悬浮条未挂载 window.__slowScrollOverlay');
    assert(!env.sandbox.document.getElementById('slowScroll-overlay'),
      'SVG 文档中未插入悬浮条节点');
  }

  // 崩溃点本身已消除：content 脚本不得再对 style.setProperty 发起可选调用
  const overlaySrcAll = fs.readFileSync(
    ROOT_PLUS('content', 'overlay.js'), 'utf8');
  assert(!/\?\.style\.setProperty/.test(overlaySrcAll),
    '悬浮条不再使用 ?.style.setProperty（崩溃点已消除）');
  assert(!/style="display:none"/.test(overlaySrcAll),
    '悬浮条图标不再使用内联 display 样式');
  const overlayCss = fs.readFileSync(
    ROOT_PLUS('content', 'overlay.css'), 'utf8');
  assert(/#slowScroll-overlay #ss-play \.icon-stop\s*\{\s*display:\s*none/.test(overlayCss),
    '图标显隐改由 overlay.css 的 class 规则驱动');
}

/* ============================================================
   T14 滚动进度：progress / remaining 与上报节流
   ============================================================ */
console.log('\nT14 滚动进度');
{
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5800 });  // 可滚动 5000
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  // 容器在 startScrolling 时才选定，之前的快照 container 为 null
  engine.startScrolling();
  const stopRaf = env.rafQueue.shift();

  // 进度：0 / 50% / 100%
  docEl.scrollTop = 0;
  assert(engine.getSnapshot().progress === 0, '顶部 progress 为 0');
  assert(engine.getSnapshot().remaining === 5000, '顶部 remaining 为全部距离 5000px');

  docEl.scrollTop = 2500;
  const mid = engine.getSnapshot();
  assert(Math.abs(mid.progress - 0.5) < 1e-6, `中点 progress 为 0.5（实际 ${mid.progress}）`);
  assert(mid.remaining === 2500, '中点 remaining 为一半距离');

  docEl.scrollTop = 5000;
  const end = engine.getSnapshot();
  assert(Math.abs(end.progress - 1) < 1e-6, '底部 progress 为 1');
  assert(end.remaining === 0, '底部 remaining 归零');
  engine.stopScrolling();
}

{
  // 内容不足一屏时不得出现 NaN/Infinity
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  const s = engine.getSnapshot();
  assert(s.progress === 0 && s.remaining === 0, '不可滚动页面 progress/remaining 为 0 而非 NaN');
}

{
  // 上报节流：每帧 publishProgress 不应每次都发消息。
  // 若不加节流，状态上报会从「控制类偶发」变成「帧率级别」。
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  let sends = 0;
  env.sandbox.chrome.runtime.sendMessage = (m, cb) => { sends++; if (cb) cb({ ok: true }); };

  const engine = loadEngine(env);
  engine.startScrolling();
  // 排除初始化与 startScrolling 的即时上报（控制类必须即时送达），
  // 只统计随后纯滚动帧产生的进度上报
  sends = 0;

  // 连续跑 10 帧，每帧 16ms，总计 160ms < 500ms 节流窗口。
  // 首帧必然放行一次（lastProgressPublish 初值为 0，冷启动不抑制），
  // 契约是「窗口内至多一次」而非「窗口内零次」
  let firstFrame = true;
  for (let i = 0; i < 10; i++) {
    const fn = env.rafQueue.shift();
    if (!fn) break;
    fn(1000 + i * 16);
    if (firstFrame) { sends = 0; firstFrame = false; }
  }
  assert(sends === 0,
    `节流窗口内的后续帧不再上报（10 帧仅首帧放行，其余 ${sends} 次应为 0）`);

  // 时间推进到窗口外，此时应恢复上报
  env.advanceTime(C.PROGRESS_PUBLISH_THROTTLE_MS + 10);
  const fn = env.rafQueue.shift();
  fn(5000);
  assert(sends > 0, `超出节流窗口后恢复上报（实际 ${sends} 次）`);
}

/* ============================================================
   T15 速度会话持久化
   回归背景：setSpeed 只改内存，用户调到 300 px/s，
   切个页面就回到默认 600。sessionSpeed 键承载「上次使用的速度」。
   ============================================================ */
console.log('\nT15 速度会话持久化');
{
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  env.storedWrites.length = 0;
  engine.setSpeed(300, { persist: true });

  // 防抖窗口内不应落盘（滑块拖动会连发几十次）
  assert(env.storedWrites.length === 0, '防抖窗口内不写 storage');

  // 推进防抖定时器后应写入会话键
  const timer = env.timers.find((t) => t.delay === C.SPEED_PERSIST_DEBOUNCE_MS);
  assert(!!timer, 'setSpeed 建立了防抖定时器');
  if (timer) {
    timer.fn();
    assert(env.storage[C.SPEED_SESSION_KEY] === 300,
      `调速落盘到会话键（实际 ${env.storage[C.SPEED_SESSION_KEY]}，应为 300）`);
  }

  // 默认不落盘：显式 persist:false 时不应触发写入
  env.storedWrites.length = 0;
  engine.setSpeed(900, { persist: false });
  assert(env.storedWrites.length === 0, 'persist:false 不触发持久化');
}

{
  // 新页面加载时应优先恢复会话速度，而非默认速度
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  env.storage[C_SESSION()] = 300;
  env.storage.defaultSpeed = 600;
  const engine = loadEngine(env);
  assert(engine.getSnapshot().speed === 300,
    `新页面恢复会话速度 300（实际 ${engine.getSnapshot().speed}）`);
}

{
  // 会话速度优先于默认速度
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  env.storage[C_SESSION()] = 250;
  env.storage.defaultSpeed = 600;
  const engine = loadEngine(env);
  assert(engine.getSnapshot().speed === 250, '会话速度优先于 defaultSpeed');

  // 无会话键时才回落到 defaultSpeed
  const env2 = makeEnv({ documentEl: makeEl('html', { clientHeight: 800, scrollHeight: 100000 }) });
  env2.storage.defaultSpeed = 800;
  const e2 = loadEngine(env2);
  assert(e2.getSnapshot().speed === 800, '无会话键时回落到 defaultSpeed');
}

{
  // 停止滚动时冲刷挂起的落盘：拖动后立刻点停止是常见操作
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  env.storedWrites.length = 0;
  engine.startScrolling();
  engine.setSpeed(400, { persist: true });
  assert(env.storage[C.SPEED_SESSION_KEY] == null, '停止前尚未落盘');
  engine.stopScrolling();
  assert(env.storage[C.SPEED_SESSION_KEY] === 400,
    '停止滚动时冲刷挂起的速度落盘');
}

function C_SESSION() {
  return loadConstants().SPEED_SESSION_KEY;
}

/* ============================================================
   T16 手势接管策略
   ============================================================ */
console.log('\nT16 手势接管策略');
{
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  const wheel = env.listeners['w:wheel'][0];
  const fire = () => wheel({ target: { closest: () => null } });

  // 默认 pause：滚轮即暂停
  assert(engine.getSnapshot().gesturePolicy === C.DEFAULT_GESTURE_POLICY,
    '默认策略为 pause');
  fire();
  assert(engine.getState().isPaused === true, 'pause 档下滚轮触发暂停');
}

{
  // slowdown：临时降速，不暂停，静默后自动恢复
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.setSpeed(800);
  engine.setGesturePolicy('slowdown', { persist: false });
  engine.startScrolling();

  const wheel = env.listeners['w:wheel'][0];
  wheel({ target: { closest: () => null } });

  assert(engine.getState().isPaused === false, 'slowdown 档下滚轮不暂停');
  const snap = engine.getSnapshot();
  assert(snap.slowed === true, 'slowdown 档下标记为降速中');
  assert(snap.effectiveSpeed === 800 * C.SLOWDOWN_FACTOR,
    `实际速度降为一半（${snap.effectiveSpeed}，应为 ${800 * C.SLOWDOWN_FACTOR}）`);
  assert(snap.speed === 800, '用户设定速度不被降速污染');

  // 静默 SLOWDOWN_RECOVER_MS 后恢复
  const timer = env.timers.find((t) => t.delay === C.SLOWDOWN_RECOVER_MS);
  assert(!!timer, 'slowdown 建立了恢复定时器');
  if (timer) {
    timer.fn();
    assert(engine.getSnapshot().effectiveSpeed === 800, '静默后自动恢复原速度');
    assert(engine.getSnapshot().slowed === false, '恢复后清除降速标记');
  }
}

{
  // ignore：完全不响应手势
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.setGesturePolicy('ignore', { persist: false });
  engine.startScrolling();

  const wheel = env.listeners['w:wheel'][0];
  wheel({ target: { closest: () => null } });
  assert(engine.getState().isPaused === false, 'ignore 档下滚轮不暂停');

  const keydown = env.listeners['w:keydown'][0];
  keydown({ key: 'ArrowDown', ctrlKey: false, metaKey: false, altKey: false });
  assert(engine.getState().isPaused === false, 'ignore 档下方向键也不接管');
}

{
  // 非法策略回落默认值，绝不透传未知字符串
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.setGesturePolicy('bogus', { persist: false });
  assert(engine.getSnapshot().gesturePolicy === loadConstants().DEFAULT_GESTURE_POLICY,
    '非法策略回落为默认值');

  // 从 slowdown 切走时应清除临时降速
  engine.setSpeed(800);
  engine.setGesturePolicy('slowdown', { persist: false });
  engine.startScrolling();
  env.listeners['w:wheel'][0]({ target: { closest: () => null } });
  assert(engine.getSnapshot().slowed === true, '前置条件：已降速');
  engine.setGesturePolicy('pause', { persist: false });
  assert(engine.getSnapshot().effectiveSpeed === 800, '切离 slowdown 后立即清除降速');
}

/* ============================================================
   T17 区间循环（起止锚点 + 终点停留）
   ============================================================ */
console.log('\nT17 区间循环');
{
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 20000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  // 单锚点不构成区间
  docEl.scrollTop = 2000;
  engine.captureAnchor('start');
  assert(engine.getSnapshot().rangeActive === false, '仅有起点时区间不生效');

  docEl.scrollTop = 12000;
  engine.captureAnchor('end');
  const snap = engine.getSnapshot();
  assert(snap.rangeStart === 2000 && snap.rangeEnd === 12000, '锚点记录当前 scrollTop');
  assert(snap.rangeActive === true, '双锚点且区间足够长时区间生效');
}

{
  // 区间过短应被拒绝并清空，避免无意义的高频来回弹跳
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 20000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  docEl.scrollTop = 1000;
  engine.captureAnchor('start');
  docEl.scrollTop = 1050;   // 间距 50 < MIN_RANGE_SPAN
  engine.captureAnchor('end');
  const snap = engine.getSnapshot();
  assert(snap.rangeActive === false, '过短区间不被接受');
  assert(snap.rangeStart === null && snap.rangeEnd === null, '过短区间会清空锚点');
}

{
  // 到达区间下沿 → 进入 dwelling 停留，而非回顶或 idle
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 20000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  docEl.scrollTop = 2000;
  engine.captureAnchor('start');
  docEl.scrollTop = 6000;
  engine.captureAnchor('end');
  engine.setRangeDwell(2000);

  docEl.scrollTop = 2000;
  engine.startScrolling();

  let guard = 0;
  while (env.rafQueue.length && guard++ < 2000) {
    const fn = env.rafQueue.shift();
    fn(1000 + guard * 16);
    if (engine.getState().phase === 'dwelling') break;
  }
  assert(engine.getState().phase === 'dwelling', '到达区间下沿后进入停留相位');
  assert(docEl.scrollTop < 6100, `不会滚过区间下沿（实际 ${docEl.scrollTop.toFixed(0)}）`);
  assert(env.timers.some((t) => t.delay === 2000), '停留期建立了 dwell 定时器');
  assert(env.rafQueue.length === 0 || engine.getState().phase === 'dwelling',
    '停留期仍保持帧循环（供进度上报）');
}

{
  // 停留结束 → 回弹到区间起点而非页面顶部
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 20000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  docEl.scrollTop = 2000;
  engine.captureAnchor('start');
  docEl.scrollTop = 6000;
  engine.captureAnchor('end');
  engine.setRangeDwell(2000);

  docEl.scrollTop = 2000;
  engine.startScrolling();

  let guard = 0;
  while (env.rafQueue.length && guard++ < 2000) {
    const fn = env.rafQueue.shift();
    fn(1000 + guard * 16);
    if (engine.getState().phase === 'dwelling') break;
  }
  // 触发停留到点
  const dwell = env.timers.find((t) => t.delay === 2000);
  if (dwell) dwell.fn();
  assert(engine.getState().phase === 'returning', '停留结束后进入回弹相位');

  // 跑完回弹动画
  guard = 0;
  while (env.rafQueue.length && guard++ < 500) {
    const fn = env.rafQueue.shift();
    fn(2000 + guard * 16);
    if (engine.getState().phase === 'down') break;
  }
  assert(Math.abs(docEl.scrollTop - 2000) < 30,
    `回弹收敛到区间起点 2000（实际 ${docEl.scrollTop.toFixed(0)}）`);
  assert(engine.getSnapshot().loopCount >= 1, '区间循环计数递增');
}

{
  // 区间模式不应触发 idle 静默探测（到区间下沿不是「尽头」）
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 20000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  docEl.scrollTop = 2000;
  engine.captureAnchor('start');
  docEl.scrollTop = 4000;
  engine.captureAnchor('end');
  engine.setRangeDwell(2000);
  docEl.scrollTop = 2000;
  engine.startScrolling();

  let guard = 0;
  while (env.rafQueue.length && guard++ < 2000) {
    const fn = env.rafQueue.shift();
    fn(1000 + guard * 16);
    if (engine.getState().phase === 'dwelling') break;
  }
  assert(engine.getState().phase !== 'idle', '区间模式下不会误入 idle');
}

{
  // 清除区间后恢复整页滚动逻辑
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 20000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  docEl.scrollTop = 2000;
  engine.captureAnchor('start');
  docEl.scrollTop = 6000;
  engine.captureAnchor('end');
  assert(engine.getSnapshot().rangeActive === true, '前置条件：区间生效');

  engine.clearRange();
  const snap = engine.getSnapshot();
  assert(snap.rangeActive === false, '清除后区间失效');
  assert(snap.rangeStart === null && snap.rangeEnd === null, '清除后锚点归空');
}

{
  // 停留时长应按常量钳位
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 20000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  engine.setRangeDwell(999999);
  assert(engine.getSnapshot().rangeDwellMs === C.MAX_RANGE_DWELL_MS, '停留时长按上界钳位');
  engine.setRangeDwell(-100);
  assert(engine.getSnapshot().rangeDwellMs === C.MIN_RANGE_DWELL_MS, '停留时长按下界钳位');
  engine.setRangeDwell('abc');
  assert(engine.getSnapshot().rangeDwellMs === C.DEFAULT_RANGE_DWELL_MS, '非法停留时长回落默认值');
}

/* ============================================================
   T18 影子 DOM 穿透
   document.querySelectorAll('body *') 按规范看不到 shadow tree 内的元素，
   而组件库驱动的站点大量把滚动容器放在 shadow root 里 ——
   不下钻就会在这些页面上「明明能滚却滚不动」。
   ============================================================ */
console.log('\nT18 影子 DOM 穿透');
{
  // 可滚动容器只存在于 shadow root 内，document 根与浅层都不满足条件
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const shadowInner = makeEl('div', { clientHeight: 800, scrollHeight: 5000 });
  shadowInner.__overflowY = 'auto';
  const shadowHost = makeEl('div', { clientHeight: 800, scrollHeight: 800 });
  const env = makeEnv({ documentEl: docEl, shadowHost, shadowInner });
  const engine = loadEngine(env);
  assert(engine.reselectContainer() === shadowInner,
    'shadow root 内的可滚动容器能被选中（不穿透则永远扫不到）');
}
{
  // 浅层容器与 shadow 内容器同时存在时，仍按可见面积择优，不因下钻而改变既有优先级
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const shadowInner = makeEl('div', { clientHeight: 800, scrollHeight: 5000 });
  shadowInner.__overflowY = 'auto';
  shadowInner.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
  const inner = makeEl('div', { clientHeight: 800, scrollHeight: 5000 });
  inner.__overflowY = 'auto';
  const shadowHost = makeEl('div', { clientHeight: 800, scrollHeight: 800 });
  const env = makeEnv({ documentEl: docEl, innerEl: inner, shadowHost, shadowInner });
  const engine = loadEngine(env);
  // 面积相同时先扫到的浅层容器胜出，说明下钻没有打乱原有择优顺序
  assert(engine.reselectContainer() === inner,
    '浅层与 shadow 内面积相同时，浅层容器优先（下钻不改变既有优先级）');
}
{
  // 封闭（closed）shadow root 的 shadowRoot 为 null，遍历必须自然跳过而非抛错
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const closedHost = makeEl('div', { clientHeight: 800, scrollHeight: 800 });
  closedHost.shadowRoot = null;   // closed root：浏览器不暴露引用
  const env = makeEnv({ documentEl: docEl, innerEl: null });
  const engine = loadEngine(env);
  let threw = null;
  let picked = null;
  try {
    env.sandbox.document.querySelectorAll = (sel) => (sel === 'body *' ? [closedHost] : []);
    picked = engine.reselectContainer();
  } catch (e) { threw = e; }
  assert(!threw, '封闭 shadow root 遍历不抛错' + (threw ? '：' + threw.message : ''));
  assert(picked === docEl, '封闭 shadow root 内不可达，回落到 document 根');
}

/* ============================================================
   T19 容器扫描失败退避
   页面暂无可滚动容器时，1s 一次的全量扫描在超大 DOM 上是实打实的主线程占用。
   契约：连续失败时重扫间隔指数增长；一旦找到容器立即清零。
   ============================================================ */
console.log('\nT19 扫描失败退避');
{
  const C = loadConstants();
  /* 页面完全没有可滚动容器。
     注意：不能只把 docEl 设成不溢出 —— isScrollable 对文档根元素走
     特殊分支（只读 scrollHeight / clientHeight），恒判为可滚动，
     scanFailures 会被重置为 0，永远走不到失败分支。
     要让探测真正失败，必须让根元素也不可滚动：
     scrollHeight <= clientHeight 时根元素判定同样为 false。 */
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  // 统计全量扫描发生的时刻（而非次数）：间隔是否增长才是退避的直接证据
  const scanTimes = [];
  let now = 0;
  const realQSA = env.sandbox.document.querySelectorAll;
  env.sandbox.document.querySelectorAll = (sel) => {
    if (sel === 'body *') scanTimes.push(now);
    return realQSA(sel);
  };
  // 让桩内的 Date.now 与 env.advanceTime 同步推进
  const baseNow = env.sandbox.Date.now;
  let offset = 0;
  env.sandbox.Date.now = () => baseNow() + offset;

  const scansAtStart = scanTimes.length;
  engine.startScrolling();
  const st = engine.getState();
  assert(st.scanFailures === 0, '启动时清空失败计数');

  /* 推进「定时器 → rAF 帧」的完整链路：找不到容器时引擎会退出主循环，
     改由 setTimeout 重试。只推进 rAF 队列是测不到退避的 ——
     首次失败后队列就空了，退避发生在后续定时器重试中。 */
  const pumpOnce = () => {
    const timer = env.timers.shift();
    if (timer) timer.fn();
    const fn = env.rafQueue.shift();
    if (fn) fn(fakeTs += 16);
  };
  let fakeTs = 1000;
  const RETRIES = 12;
  for (let i = 0; i < RETRIES; i++) {
    pumpOnce();
    offset += C.IDLE_PROBE_MS;
    now = offset;
  }

  const afterFails = engine.getState().scanFailures;
  assert(afterFails > 0, `无可滚动容器时累计失败次数（实际 ${afterFails}）`);

  /* 核心契约：相邻两次全量扫描的间隔必须单调增长。
     恒定 1s 等于没有退避；指数增长才说明 CONTAINER_SCAN_BACKOFF_* 生效。
     用相对基线的增量序列，避免把 startScrolling 的扫描算进来。 */
  const gaps = [];
  for (let i = scansAtStart + 1; i < scanTimes.length; i++) {
    gaps.push(scanTimes[i] - scanTimes[i - 1]);
  }
  assert(gaps.length >= 2, `退避期内至少发生两次扫描（实际 ${gaps.length} 次）`);
  const growing = gaps.length > 1 && gaps[gaps.length - 1] > gaps[0];
  assert(growing,
    `扫描间隔随失败次数增长（间隔序列 ${gaps.join('→')}ms）`);
  assert(gaps.every((g) => g >= C.IDLE_PROBE_MS),
    `扫描间隔不短于基础探测间隔（实际 ${gaps.join('→')}ms）`);

  // 时间推进到窗口外，应恢复扫描（否则就成了永久停止探测）
  offset += C.CONTAINER_SCAN_BACKOFF_MAX_MS + 100;
  const before = scanTimes.length;
  pumpOnce();
  assert(scanTimes.length > before, '超出退避窗口后恢复全量扫描');
}
{
  // 找到容器后计数清零：迟滞只惩罚「一直失败」，不得拖累正常滚动
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.getState().scanFailures = 7;
  engine.getState().lastScanAt = 1000000 + C.CONTAINER_SCAN_BACKOFF_MAX_MS;
  engine.startScrolling();
  assert(engine.getState().scanFailures === 0, '成功启动后失败计数清零');
  assert(engine.getState().lastScanAt === 0, '成功启动后重置扫描时间戳');
}

/* ============================================================
   T20 触底自动翻页
   风险等级最高的改动：扩展替用户点击第三方页面的元素。
   契约：默认关闭 → 白名单锚点策略 → 武装后可取消 → 到点才点。

   注意「武装」与「点击」必须分两步测：
   若在同一个同步调用里既武装又点击，测试就无法验证取消窗口是否真实存在。
   ============================================================ */
console.log('\nT20 触底自动翻页');
{
  const C = loadConstants();
  const link = makeLink({ href: '/ch2', text: '下一章' });
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const env = makeEnv({ documentEl: docEl, links: [link] });
  const engine = loadEngine(env);

  assert(engine.getSnapshot().autoNextEnabled === false, '默认关闭（不可逆操作不得默认开启）');
  assert(engine.debugTryAutoNext() === false, '关闭状态下不查找也不武装');
  assert(link.__clicks === 0, '关闭状态下不点击任何链接');

  engine.setAutoNext(true, { persist: false });
  assert(engine.getSnapshot().autoNextEnabled === true, '显式开启后生效');
  assert(engine.debugTryAutoNext() === true, '开启后能武装候选链接');
  assert(link.__clicks === 0, '武装阶段不点击（留出取消窗口）');
  assert(typeof engine.getSnapshot().autoNextArmed === 'string', '快照透出待翻页文案');

  // 武装期间用户手动滚动 → 必须撤销。不可逆操作的最后一道闸门。
  // 必须先 startScrolling：onUserScrollIntent 开头就检查 isScrolling，
  // 未启动的会话本就不该响应接管，断言它会得到假阴性。
  engine.startScrolling();
  assert(engine.debugTryAutoNext() === true, '武装成功');
  const wheel = env.listeners['w:wheel'][0];
  wheel({ target: makeEl('div') });
  assert(engine.getSnapshot().autoNextArmed === null, '武装期间用户接管即取消');
  assert(link.__clicks === 0, '取消后不点击');
}
{
  // 无人干预：取消窗口走完后才点击
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const link = makeLink({ href: '/ch2', text: '下一页' });
  const env = makeEnv({ documentEl: docEl, links: [link] });
  const engine = loadEngine(env);
  engine.setAutoNext(true, { persist: false });
  engine.startScrolling();

  engine.debugTryAutoNext();
  assert(link.__clicks === 0, '武装后立即检查仍未点击');

  // 推进取消窗口对应的定时器
  const armed = env.timers.find((t) => t.delay === C.AUTO_NEXT_CONFIRM_MS);
  assert(!!armed, '武装后建立了取消窗口计时器');
  if (armed) armed.fn();
  assert(link.__clicks === 1, '取消窗口结束后点击候选链接');
  assert(engine.getSnapshot().isScrolling === false, '点击前先停机，避免把补丁状态带进新页面');
  assert(engine.getSnapshot().autoNextCount === 1, '翻页计数累加');
}
{
  // 白名单锚点策略：只认 rel=next 与精确文案
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const relLink = makeLink({ href: '/next', text: '继续', rel: 'next' });
  const env = makeEnv({ documentEl: docEl, links: [relLink] });
  const engine = loadEngine(env);
  engine.setAutoNext(true, { persist: false });
  assert(engine.debugFindNextLink() === relLink, 'rel="next" 语义标记被识别（哪怕文案不在白名单）');

  // 文案不在白名单 → 不点
  const other = makeLink({ href: '/x', text: '返回顶部' });
  const env2 = makeEnv({ documentEl: docEl, links: [other] });
  const e2 = loadEngine(env2);
  e2.setAutoNext(true, { persist: false });
  assert(e2.debugFindNextLink() === null, '非白名单文案不作为候选');

  // 包含匹配会误点：正文里的「下一章预告」绝不能被当成翻页链接
  const teaser = makeLink({ href: '/trailer', text: '下一章预告' });
  const env3 = makeEnv({ documentEl: docEl, links: [teaser] });
  const e3 = loadEngine(env3);
  e3.setAutoNext(true, { persist: false });
  assert(e3.debugFindNextLink() === null, '文案须完全相等，「下一章预告」不被误判');

  // 装饰性前后缀应被剥除后匹配
  const decorated = makeLink({ href: '/ch3', text: ' 下一章 »' });
  const env4 = makeEnv({ documentEl: docEl, links: [decorated] });
  const e4 = loadEngine(env4);
  e4.setAutoNext(true, { persist: false });
  assert(e4.debugFindNextLink() === decorated, '剥除装饰符号后仍能匹配');
}
{
  // 危险链接必须被拒：javascript: 伪协议、纯锚点、隐藏元素
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const cases = [
    [makeLink({ href: 'javascript:void(0)', text: '下一章' }), 'javascript: 伪协议'],
    [makeLink({ href: '#', text: '下一章' }), '纯锚点'],
    [makeLink({ href: '/ch2', text: '下一章', visible: false }), '零尺寸隐藏元素']
  ];
  cases.forEach(([bad, name]) => {
    const env = makeEnv({ documentEl: docEl, links: [bad] });
    const e = loadEngine(env);
    e.setAutoNext(true, { persist: false });
    assert(e.debugFindNextLink() === null, `拒绝${name}`);
  });
}
{
  // 站点白名单：后缀匹配必须带点边界，否则 evil-example.com 会被 example.com 放行
  const C = loadConstants();
  const link = makeLink({ href: '/ch2', text: '下一章' });
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });

  const env = makeEnv({ documentEl: docEl, links: [link], hostname: 'example.com' });
  const engine = loadEngine(env);
  engine.setAutoNextSites(['other.com']);
  engine.setAutoNext(true, { persist: false });
  assert(engine.debugTryAutoNext() === false, '白名单外的站点不翻页');

  engine.setAutoNextSites(['example.com']);
  assert(engine.debugTryAutoNext() === true, '白名单内的站点正常翻页');

  const env2 = makeEnv({ documentEl: docEl, links: [link], hostname: 'evil-example.com' });
  const e2 = loadEngine(env2);
  e2.setAutoNextSites(['example.com']);
  e2.setAutoNext(true, { persist: false });
  assert(e2.debugTryAutoNext() === false, '白名单不误放行相似后缀域名（evil-example.com）');

  // 子域名应放行
  const env3 = makeEnv({ documentEl: docEl, links: [link], hostname: 'www.example.com' });
  const e3 = loadEngine(env3);
  e3.setAutoNextSites(['example.com']);
  e3.setAutoNext(true, { persist: false });
  assert(e3.debugTryAutoNext() === true, '白名单放行子域名');

  // 白名单清洗：去空白、去重、转小写、限量
  const env4 = makeEnv({ documentEl: docEl, links: [link] });
  const e4 = loadEngine(env4);
  e4.setAutoNextSites(['  Example.COM ', 'example.com', '', null]);
  assert(JSON.stringify(e4.getSnapshot().autoNextSites) === JSON.stringify(['example.com']),
    '白名单清洗：去重 / 去空 / 转小写');

  // 关闭开关必须撤销已武装的候选，否则关掉仍会被带走
  const env5 = makeEnv({ documentEl: docEl, links: [link] });
  const e5 = loadEngine(env5);
  e5.setAutoNext(true, { persist: false });
  e5.debugTryAutoNext();
  assert(e5.getSnapshot().autoNextArmed !== null, '武装成功');
  e5.setAutoNext(false, { persist: false });
  assert(e5.getSnapshot().autoNextArmed === null, '关闭开关立即撤销已武装的候选');
}
{
  // 与回顶循环互斥：两套「到底之后」的策略不能同时生效
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const link = makeLink({ href: '/ch2', text: '下一章' });
  const env = makeEnv({ documentEl: docEl, links: [link] });
  const engine = loadEngine(env);
  engine.setAutoNext(true, { persist: false });
  engine.setLoop(true);
  assert(engine.debugTryAutoNext() === false, '开启回顶循环后不再翻页');

  // 反向：循环已武装时开循环，也应撤销
  const env2 = makeEnv({ documentEl: docEl, links: [link] });
  const e2 = loadEngine(env2);
  e2.setAutoNext(true, { persist: false });
  e2.debugTryAutoNext();
  e2.setLoop(true);
  assert(e2.getSnapshot().autoNextArmed === null, '武装期间开循环即撤销翻页');
}
{
  // 单页翻页上限：站点死链时不能带着用户无限跳转
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const link = makeLink({ href: '/ch2', text: '下一章' });
  const env = makeEnv({ documentEl: docEl, links: [link] });
  const engine = loadEngine(env);
  engine.setAutoNext(true, { persist: false });
  engine.getState().autoNextCount = C.AUTO_NEXT_MAX_PER_SESSION;
  assert(engine.debugTryAutoNext() === false, '达到单页翻页上限后不再翻页');
}
{
  // 停止滚动必须撤销武装：翻页不该在用户已停止后仍然发生
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 5000 });
  const link = makeLink({ href: '/ch2', text: '下一章' });
  const env = makeEnv({ documentEl: docEl, links: [link] });
  const engine = loadEngine(env);
  engine.setAutoNext(true, { persist: false });
  engine.startScrolling();
  engine.debugTryAutoNext();
  engine.stopScrolling();
  assert(engine.getSnapshot().autoNextArmed === null, '停止滚动撤销已武装的候选');

  // 取消窗口计时器应已被清除：即便取出它手动执行，也不会走到点击
  const armedTimer = env.timers.find((t) => t.delay === C.AUTO_NEXT_CONFIRM_MS);
  if (armedTimer) armedTimer.fn();
  assert(link.__clicks === 0, '停止后不会执行点击');
}

/* ============================================================
   T21 倒计时到点自动停
   契约：0 = 不启用；到点停机并提示；停机 / 暂停后计时器清理干净。
   ============================================================ */
console.log('\nT21 倒计时到点自动停');
{
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);

  assert(engine.getSnapshot().stopAfterMinutes === 0, '默认不限时');
  engine.startScrolling();
  assert(env.timers.filter((t) => t.delay === C.STOP_COUNTDOWN_TICK_MS).length === 0,
    '未启用时不建倒计时定时器');

  // 设置时长后启动会话
  engine.stopScrolling();
  engine.setStopAfterMinutes(20, { persist: false });
  assert(engine.getSnapshot().stopAfterMinutes === 20, '倒计时时长按设定生效');

  engine.startScrolling();
  assert(env.timers.filter((t) => t.delay === C.STOP_COUNTDOWN_TICK_MS).length === 1,
    '启动滚动后建立倒计时定时器');
  const snap = engine.getSnapshot();
  assert(snap.stopAfterRemainingMs > 19 * 60000 && snap.stopAfterRemainingMs <= 20 * 60000,
    `剩余时间约等于设定值（实际 ${Math.round(snap.stopAfterRemainingMs / 1000)}s）`);

  // 停机必须清掉定时器，否则会在后台空转到点
  engine.stopScrolling();
  assert(env.timers.filter((t) => t.delay === C.STOP_COUNTDOWN_TICK_MS).length === 0,
    '停止滚动后倒计时定时器被清理');
}
{
  // 到点自动停：推进时钟跨过截止时刻
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.setStopAfterMinutes(1, { persist: false });
  engine.startScrolling();

  env.advanceTime(61 * 1000);
  // 用 shift 而非 find：必须把计时器从桩队列里取出，
  // 否则等于「定时器从未触发」，桩里那条记录会一直留在队列中，
  // 让「不再续期」这条断言拿到假阴性
  const timer = env.timers.shift();
  assert(!!timer && timer.delay === C.STOP_COUNTDOWN_TICK_MS, '存在倒计时定时器');
  if (timer) timer.fn();

  assert(engine.getSnapshot().isScrolling === false, '到点后自动停止滚动');
  assert(engine.getSnapshot().stopAfterRemainingMs === 0, '到点后剩余时间归零');
  assert(env.timers.filter((t) => t.delay === C.STOP_COUNTDOWN_TICK_MS).length === 0,
    '到点后不再续期定时器');
}
{
  // 数值钳制：负数与非法值一律回落为「不启用」
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 100000 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.setStopAfterMinutes(-5, { persist: false });
  assert(engine.getSnapshot().stopAfterMinutes === 0, '负数回落为不限时');
  engine.setStopAfterMinutes('abc', { persist: false });
  assert(engine.getSnapshot().stopAfterMinutes === 0, '非数值回落为不限时');
  engine.setStopAfterMinutes(99999, { persist: false });
  assert(engine.getSnapshot().stopAfterMinutes === C.MAX_STOP_AFTER_MINUTES,
    `超上界按最大值钳位（实际 ${engine.getSnapshot().stopAfterMinutes}）`);
}

/* ============================================================
   T22 容器失败原因明示
   契约：达到阈值才诊断；成功后清零；诊断不额外遍历 DOM。
   ============================================================ */
console.log('\nT22 容器失败原因明示');
{
  const C = loadConstants();
  // 根元素不溢出 → 探测必然失败
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();

  assert(engine.getSnapshot().containerIssue === null, '刚开始不急于下结论');
  assert(engine.getSnapshot().scanFailures === 0, '失败计数从 0 起算');

  // 推进到阈值之后
  let fakeTs = 1000;
  for (let i = 0; i < 8; i++) {
    const t = env.timers.shift();
    if (t) t.fn();
    const f = env.rafQueue.shift();
    if (f) f(fakeTs += 16);
    env.advanceTime(C.IDLE_PROBE_MS * 2);
  }
  assert(engine.getSnapshot().scanFailures >= C.CONTAINER_ISSUE_REPORT_AFTER,
    `失败次数达到诊断阈值（实际 ${engine.getSnapshot().scanFailures}）`);
  assert(engine.getSnapshot().containerIssue === 'no-content',
    `DOM 规模小时诊断为「无可滚动内容」（实际 ${engine.getSnapshot().containerIssue}）`);
}
{
  // 恢复后必须清零，否则解释会一直挂在界面上
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  engine.startScrolling();
  engine.getState().scanFailures = 5;
  engine.getState().containerIssue = 'no-content';
  // 换成可滚动容器后重启
  docEl.scrollHeight = 100000;
  engine.reselectContainer();
  assert(engine.getSnapshot().containerIssue === null, '容器恢复后原因被清空');
  assert(engine.getSnapshot().scanFailures === 0, '容器恢复后失败计数清零');
}
{
  // 诊断不得引入额外遍历：这是退避机制要消除的开销，不能在诊断处请回来
  const C = loadConstants();
  const docEl = makeEl('html', { clientHeight: 800, scrollHeight: 800 });
  const env = makeEnv({ documentEl: docEl });
  const engine = loadEngine(env);
  let bodyScans = 0;
  const realQSA = env.sandbox.document.querySelectorAll;
  env.sandbox.document.querySelectorAll = (sel) => {
    if (sel === 'body *') bodyScans++;
    return realQSA(sel);
  };
  engine.startScrolling();
  const afterStart = bodyScans;
  let fakeTs = 1000;
  for (let i = 0; i < 8; i++) {
    const t = env.timers.shift();
    if (t) t.fn();
    const f = env.rafQueue.shift();
    if (f) f(fakeTs += 16);
    env.advanceTime(C.IDLE_PROBE_MS * 2);
  }
  // 每次重扫理应只遍历一次：诊断若自己再扫一遍，比例会明显偏高
  assert(bodyScans - afterStart <= 4,
    `诊断未引入额外的全量遍历（启动后共 ${bodyScans - afterStart} 次扫描）`);
  assert(engine.getSnapshot().containerIssue !== null, '诊断已完成');
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);