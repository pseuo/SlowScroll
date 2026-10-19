/* 清单一致性自测：校验 manifest 与 background 的注入顺序、以及键名与常量来源。
   这类「顺序 / 拼写」问题在浏览器里表现为静默失效，最适合用静态检查兜住。
   运行：node temp_tests/manifest.test.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* 被测根目录。默认指向项目本身；构建脚本会把压缩后的产物
   铺到临时目录并设 SLOWSCROLL_ROOT，让同一套断言跑在压缩产物上 ——
   这是「压缩没有改变行为」唯一有说服力的证据。 */
const ROOT = process.env.SLOWSCROLL_ROOT || path.join(__dirname, '..');

/* 本文件里有一部分断言是靠「源码长什么样」判断的：
   顶层 const/let 的缩进、函数体里的具体排版。
   这些检查在压缩产物上必然不成立，而它们要防的缺陷
   （重复注入抛词法冲突）在构建阶段已经由 engine.test.js
   在压缩产物上跑过真实行为验证覆盖了。

   所以这里的处理是「显式跳过并说明原因」，
   绝不能改成让它们在产物上假装通过 —— 那样只是把
   构建的绿灯建立在检查失效之上。 */
const ON_BUILT_ARTIFACT = !!process.env.SLOWSCROLL_ROOT;

let pass = 0, fail = 0, skipped = 0;

function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

  /* 按大括号配平提取函数体，而不是靠「空两格的 }」定位。
 缩进是排版，压缩后必然改变；大括号才是语法事实。 */
function extractFunction(src, name) {
const m = new RegExp(`function ${name}\\s*\\(`).exec(src);
if (!m) return null;
const open = src.indexOf('{', m.index);
if (open < 0) return null;
let d = 0;
for (let i = open; i < src.length; i++) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') {
    const q = c;
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') i++;
      i++;
    }
    continue;
  }
  if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
  if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i++; continue; }
  if (c === '{') d++;
  else if (c === '}') { d--; if (d === 0) return src.slice(m.index, i + 1); }
}
return null;
}

// 依赖源码排版的断言：产物上不适用，明示跳过而非伪装通过
function assertSourceShape(cond, msg) {
  if (ON_BUILT_ARTIFACT) {
    skipped++;
    console.log('  ○', msg, '（产物校验：依赖源码排版，已跳过）');
    return;
  }
  assert(cond, msg);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const bgSrc = fs.readFileSync(path.join(ROOT, 'background', 'background.js'), 'utf8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'content', 'scrollEngine.js'), 'utf8');
const overlaySrc = fs.readFileSync(path.join(ROOT, 'content', 'overlay.js'), 'utf8');
const popupSrc = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');
const optionsSrc = fs.readFileSync(path.join(ROOT, 'options', 'options.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
const optionsHtml = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');
const popupCss = fs.readFileSync(path.join(ROOT, 'popup', 'popup.css'), 'utf8');
const optionsCss = fs.readFileSync(path.join(ROOT, 'options', 'options.css'), 'utf8');

// background 的别名，与既有断言里的 bgSrc 并存，避免改动已有用例
const backgroundSrc = bgSrc;

// 常量从真实文件加载：键名与枚举值必须以实现为准，
// 不能在测试里复写一份（那正是「数值漂移」的来源）
function loadConstants() {
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'constants.js'), 'utf8');
  const box = {};
  vm.createContext(box);
  vm.runInContext(src, box);
  return box.__SLOWSCROLL_CONSTANTS__;
}

/* ============================================================
   T1 注入顺序：常量文件必须最先加载
   ============================================================ */
console.log('\nT1 注入顺序');
{
  const cs = manifest.content_scripts[0];
  assert(cs.js[0] === 'shared/constants.js',
    `manifest content_scripts 首项为 shared/constants.js（实际 ${cs.js[0]}）`);
  assert(cs.js.includes('content/scrollEngine.js'), 'manifest 声明注入 scrollEngine');
  assert(cs.js.includes('content/overlay.js'), 'manifest 声明注入 overlay');

  // background 的 executeScript 同样必须把常量排在最前
  const m = bgSrc.match(/files:\s*\[([\s\S]*?)\]/);
  assert(!!m, 'background 中存在 files 数组');
  const files = m[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert(files[0] === 'shared/constants.js',
    `background 注入首项为 shared/constants.js（实际 ${files[0]}）`);
  assert(files.includes('content/scrollEngine.js'), 'background 注入含 scrollEngine');
}

/* ============================================================
   T2 页面脚本引用：popup / options 需引入常量
   ============================================================ */
console.log('\nT2 页面引用');
{
  assert(popupHtml.includes('shared/constants.js'), 'popup.html 引入 shared/constants.js');
  assert(optionsHtml.includes('shared/constants.js'), 'options.html 引入 shared/constants.js');
  // 引入顺序必须早于使用方
  assert(
    popupHtml.indexOf('shared/constants.js') < popupHtml.indexOf('popup.js'),
    'popup 中常量脚本先于 popup.js'
  );
  assert(
    optionsHtml.indexOf('shared/constants.js') < optionsHtml.indexOf('options.js'),
    'options 中常量脚本先于 options.js'
  );
}

/* ============================================================
   T3 常量定义与引用一致
   ============================================================ */
console.log('\nT3 常量定义');
{
  const box = {};
  vm.createContext(box);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'shared', 'constants.js'), 'utf8'), box);
  const C = box.__SLOWSCROLL_CONSTANTS__;

  assert(!!C, 'constants.js 导出 __SLOWSCROLL_CONSTANTS__');
  assert(C.MIN_SPEED === 50, 'MIN_SPEED = 50');
  assert(C.MAX_SPEED === 4000, 'MAX_SPEED = 4000');
  assert(C.DEFAULT_SPEED === 600, 'DEFAULT_SPEED = 600');
  assert(C.SPEED_GRANULARITY === 50, 'SPEED_GRANULARITY = 50');
  assert(C.DEFAULT_STEP === 50, 'DEFAULT_STEP = 50');
  assert(C.MIN_STEP === 10, 'MIN_STEP = 10');
  assert(C.MAX_STEP === 500, 'MAX_STEP = 500');
  assert(C.OVERLAY_HIDE_DELAY_MS === 1200, 'OVERLAY_HIDE_DELAY_MS = 1200');
  assert(C.OVERLAY_REHIDE_IDLE_MS === 2500, 'OVERLAY_REHIDE_IDLE_MS = 2500');
  assert(C.OVERLAY_REVEAL_ZONE_SIZE === 96, 'OVERLAY_REVEAL_ZONE_SIZE = 96');

  // 引擎引用的每个常量名都必须在 constants.js 中存在
  const used = new Set();
  for (const src of [engineSrc, overlaySrc, popupSrc, optionsSrc]) {
    for (const m of src.matchAll(/CONSTANTS\.([A-Z_]+)/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in C));
  assert(missing.length === 0,
    `引擎与页面引用的常量均已定义${missing.length ? '（缺失：' + missing.join(', ') + '）' : ''}`);
}

/* ============================================================
   T4 存储键名三端一致
   ============================================================ */
console.log('\nT4 存储键名');
{
  // 引擎与设置页都必须用 step，不允许再出现 speedStep 作为正式键
  assert(/\bstep\b/.test(engineSrc), '引擎读取 step 键');
  assert(!/loopEnabled:\s*[^,]*speedStep/.test(optionsSrc),
    '设置页不把 speedStep 当作正式键使用');

  // 三端共用的正式键集合
  const official = ['defaultSpeed', 'overlayEnabled', 'autoHideOverlay', 'loopEnabled', 'step'];
  for (const key of official) {
    const inEngine = engineSrc.includes(key);
    const inOptions = optionsSrc.includes(key);
    const inOverlay = overlaySrc.includes(key) || key === 'defaultSpeed';
    assert(inOptions, `设置页使用 ${key}`);
    if (key !== 'defaultSpeed') {
      assert(inEngine || inOverlay, `引擎/悬浮条使用 ${key}`);
    }
  }
  // 设置页的开关必须在 HTML 里真实存在对应控件，
  // 只在 JS 里读一个不存在的 id 会静默失效（历史踩过）
  assert(/id="autoHideOverlay"/.test(optionsHtml), '设置页存在 autoHideOverlay 开关');
}

/* ============================================================
   T4b 新增配置的键名一致性与控件存在性
   键名拼错在浏览器里表现为「设置能存但永远不生效」，静态层必须兜住。
   ============================================================ */
console.log('\nT4b 新增配置键名');
{
  const C = loadConstants();

  // 手势策略：引擎、设置页、popup 三端必须用同一个键
  assert(/gesturePolicy/.test(engineSrc), '引擎读取 gesturePolicy 键');
  assert(/gesturePolicy/.test(optionsSrc), '设置页写入 gesturePolicy 键');
  assert(/SET_GESTURE_POLICY/.test(popupSrc), 'popup 发送 SET_GESTURE_POLICY');
  assert(/gesturePolicy/.test(backgroundSrc) === false,
    'background 不解释策略字段（避免多一处可能拼错的映射）');
  assert(/id="gesturePolicyGroup"/.test(optionsHtml), '设置页存在策略分段控件容器');

  // 策略取值必须与常量枚举一致，设置页不得自造一份
  assert(Array.isArray(C.GESTURE_POLICIES), 'GESTURE_POLICIES 为数组');
  for (const p of ['pause', 'slowdown', 'ignore']) {
    assert(C.GESTURE_POLICIES.includes(p), `常量枚举含 ${p}`);
    assert(new RegExp(`data-policy="${p}"`).test(optionsHtml), `设置页 HTML 提供 ${p} 选项`);
    assert(new RegExp(`data-policy="${p}"`).test(popupHtml), `popup HTML 提供 ${p} 选项`);
  }
  assert(optionsSrc.includes('C.GESTURE_POLICIES') || optionsSrc.includes('GESTURE_POLICIES'),
    '设置页的策略枚举取自常量而非硬编码');

  // 区间停留时长
  assert(/rangeDwellMs/.test(engineSrc), '引擎读取 rangeDwellMs 键');
  assert(/rangeDwellMs/.test(optionsSrc), '设置页写入 rangeDwellMs 键');
  assert(/id="rangeDwellMs"/.test(optionsHtml), '设置页存在停留时长输入框');

  // 会话速度键：必须经由常量引用，禁止在三处各写一遍字面量
  assert(engineSrc.includes('SPEED_SESSION_KEY'), '引擎经常量引用会话速度键');
  assert(C.SPEED_SESSION_KEY === 'sessionSpeed', '会话速度键名与约定一致');
  assert(!/sessionSpeed/.test(optionsSrc), '设置页不涉及会话速度键（属引擎内部状态）');
}

/* ============================================================
   T4c 进度上报节流：控制类即时、进度类节流
   两者若不分，状态上报会退化为帧率级别。
   ============================================================ */
console.log('\nT4c 进度上报节流');
{
  const C = loadConstants();
  assert(C.PROGRESS_PUBLISH_THROTTLE_MS > 0, '进度上报有节流间隔');
  // 快照必须带进度字段，且 engine 的 publishProgress 走节流判断
  assert(/progress:\s*p\.progress/.test(engineSrc), 'snapshot 输出 progress');
  assert(/remaining:\s*p\.remaining/.test(engineSrc), 'snapshot 输出 remaining');
  assert(/function publishProgress\(\)/.test(engineSrc), '存在 publishProgress 节流入口');
  assert(/lastProgressPublish < CONSTANTS\.PROGRESS_PUBLISH_THROTTLE_MS/.test(engineSrc),
    'publishProgress 使用常量节流');
  // 引擎源码里不得出现裸的数值节流
  assert(!/lastProgressPublish\s*<\s*\d+/.test(engineSrc), '节流阈值取自常量而非硬编码');

  // popup 必须消费进度字段，否则快照带了也没人用
  assert(/currentState\.progress/.test(popupSrc), 'popup 渲染 progress');
  assert(/currentState\.remaining/.test(popupSrc), 'popup 渲染 remaining');
  assert(/id="progressBar"/.test(popupHtml), 'popup 存在进度条元素');

  // 进度条宽度走 CSS 变量，遵守禁止内联样式约定
  assert(/--pct/.test(popupCss), '进度条宽度由 CSS 变量驱动');
  assert(!/\.style\.width\s*=/.test(popupSrc), 'popup 不写内联 width');
}

/* ============================================================
   T4d 区间循环契约
   ============================================================ */
console.log('\nT4d 区间循环契约');
{
  assert(/dwelling/.test(engineSrc), '引擎存在 dwelling 停留相位');
  assert(/captureAnchor/.test(engineSrc), '引擎导出 captureAnchor');
  assert(/clearRange/.test(engineSrc), '引擎导出 clearRange');
  assert(/CAPTURE_ANCHOR/.test(popupSrc), 'popup 发送 CAPTURE_ANCHOR');
  assert(/CLEAR_RANGE/.test(popupSrc), 'popup 发送 CLEAR_RANGE');
  assert(/ss-range/.test(overlaySrc), '悬浮条提供区间按钮');
  assert(/id="ss-range"/.test(overlaySrc) || /id="ss-range-label"/.test(overlaySrc),
    '悬浮条区间按钮 id 唯一');

  // 停留期必须清理定时器，否则 stopScrolling 后会对已停的会话执行回弹
  assert(/function cancelDwell\(\)/.test(engineSrc), '存在 cancelDwell');
  const stopBody = engineSrc.slice(
    engineSrc.indexOf('function stopScrolling'),
    engineSrc.indexOf('function pauseScrolling')
  );
  assert(/cancelDwell\(\)/.test(stopBody), 'stopScrolling 清理停留定时器');

  // 区间锚点是页面级状态，禁止写入 storage（跨页面 scrollTop 无意义）
  assert(!/sessionRange|storage[^\n]*rangeStart/.test(engineSrc),
    '区间锚点不写入 storage');
}

/* ============================================================
   T4e 自动翻页与倒计时契约
   两项都是「设置页能存、引擎能读」才算数。任何一端漏掉键名，
   表现都是开关拨了没反应，且不报任何错。
   ============================================================ */
console.log('\nT4e 自动翻页与倒计时契约');
{
  const C = loadConstants();

  /* ---- 触底自动翻页 ---- */
  assert(/autoNextPage/.test(engineSrc), '引擎读取 autoNextPage 键');
  assert(/autoNextPage/.test(optionsSrc), '设置页写入 autoNextPage 键');
  assert(/autoNextEnabled/.test(popupSrc), 'popup 消费快照字段 autoNextEnabled');
  assert(/id="autoNextToggle"/.test(popupHtml), 'popup 存在自动翻页开关控件');
  assert(/id="autoNextPage"/.test(optionsHtml), '设置页存在自动翻页开关控件');

  assert(/autoNextSites/.test(engineSrc), '引擎读取 autoNextSites 键');
  assert(/autoNextSites/.test(optionsSrc), '设置页写入 autoNextSites 键');
  assert(/id="autoNextSites"/.test(optionsHtml), '设置页存在白名单输入框');
  assert(/id="autoNextSites"/.test(popupHtml), 'popup 存在白名单输入框');

  /* ---- 倒计时到点自动停 ---- */
  assert(/stopAfterMinutes/.test(engineSrc), '引擎读取 stopAfterMinutes 键');
  assert(/stopAfterMinutes/.test(optionsSrc), '设置页写入 stopAfterMinutes 键');
  assert(/stopAfterMinutes/.test(popupSrc), 'popup 使用 stopAfterMinutes');
  assert(/id="stopAfterMinutes"/.test(optionsHtml), '设置页存在倒计时输入框');

  /* ---- 安全红线：默认关闭 ----
     不可逆操作绝不能默认开启。默认值只允许在常量里出现一次，
     三处硬编码 false/false 才是漂移的开始。 */
  assert(C.DEFAULT_STOP_AFTER_MINUTES === 0, '倒计时默认为 0（不限时）');
  assert(/autoNextPage: false/.test(engineSrc), '引擎把 autoNextPage 默认值设为 false');
  assert(/autoNextPage: false/.test(optionsSrc), '设置页把 autoNextPage 默认值设为 false');
  assert(C.AUTO_NEXT_TEXTS && C.AUTO_NEXT_TEXTS.length > 0, '存在候选文案白名单');
  assert(C.AUTO_NEXT_CONFIRM_MS > 0, '存在点击前的取消窗口');
  assert(C.AUTO_NEXT_MAX_PER_SESSION > 0, '存在单页翻页次数上限');

  /* ---- 白名单必须是精确匹配，不是包含 ----
     「下一章预告」若被包含匹配命中，扩展会点掉完全无关的链接。 */
  assert(/indexOf\(norm\)/.test(engineSrc), '候选文案按规范化后完全相等匹配');
  assert(!/indexOf\(norm\) !== -1 && norm\.length/.test(engineSrc), '未引入包含匹配旁路');

  /* ---- 危险协议必须被拒 ---- */
  assert(/javascript:/i.test(engineSrc), '显式拒绝 javascript: 伪协议');

  /* ---- 白名单后缀匹配须带点边界 ---- */
  const siteFn = extractFunction(engineSrc, 'autoNextSiteAllowed');
  assert(!!siteFn && /endsWith\(\s*['"]\.['"]\s*\+\s*s\s*\)/.test(siteFn),
    '站点白名单后缀匹配带点边界（否则 evil-example.com 会被 example.com 放行）');

  /* ---- 容器失败原因必须能抵达 UI ---- */
  assert(/containerIssue/.test(engineSrc), '引擎快照输出 containerIssue');
  assert(/containerIssue/.test(popupSrc), 'popup 消费 containerIssue');
  assert(/id="containerIssue"/.test(popupHtml), 'popup 存在失败原因展示元素');
  assert(/'no-content'/.test(engineSrc) && /'virtual-list'/.test(engineSrc),
    '两种失败原因均有定义');

  /* ---- 诊断不得绕过退避自扫全量DOM ---- */
  const diagFn = extractFunction(engineSrc, 'function diagnoseContainer');
  assert(!/querySelectorAll|collectCandidates/.test(diagFn),
    '诊断复用上次扫描的计数，不做额外遍历');
}

/* ============================================================
   T5 MV3 约束
   ============================================================ */
console.log('\nT5 MV3 约束');
{
  const cmdKeys = Object.values(manifest.commands || {})
    .filter((c) => c.suggested_key).length;
  assert(cmdKeys <= 4, `带 suggested_key 的命令数 ≤ 4（实际 ${cmdKeys}）`);

  for (const size of ['16', '32', '48', '128']) {
    const p = path.join(ROOT, 'assets', 'icons', `icon${size}.png`);
    assert(fs.existsSync(p) && p.endsWith('.png'), `icon${size}.png 存在且为 PNG`);
  }
  assert(!!manifest.background?.service_worker, '声明 Service Worker');
  assert(manifest.manifest_version === 3, 'manifest_version = 3');
}

/* ============================================================
   T6 非 HTML 文档守卫
   matches 为 <all_urls>，会命中 SVG / XML / 图片查看器。
   content 两端必须共用同一判定函数，且都不得初始化。
   这类问题在浏览器里表现为「打开某个文件就整页报红」，静态检查最易兜住。
   ============================================================ */
console.log('\nT6 非 HTML 文档守卫');
{
  const constantsSrc = fs.readFileSync(path.join(ROOT, 'shared', 'constants.js'), 'utf8');
  assert(constantsSrc.includes('__SLOWSCROLL_IS_HTML_DOC__'),
    'constants.js 导出 __SLOWSCROLL_IS_HTML_DOC__ 判定函数');

  assert(engineSrc.includes('__SLOWSCROLL_IS_HTML_DOC__'),
    'scrollEngine 使用共享的非 HTML 判定');
  assert(overlaySrc.includes('__SLOWSCROLL_IS_HTML_DOC__'),
    'overlay 使用共享的非 HTML 判定');

  // 两端不得各自另写一套判定，避免条件漂移
  assert(!/contentType\s*===?\s*['"]text\/html['"]/.test(engineSrc + overlaySrc),
    'content 两端不自行硬编码 contentType 判定');

  // 崩溃点回归：?.style.setProperty 在非 HTML 文档必炸
  assert(!/\?\.style\.setProperty/.test(overlaySrc),
    'overlay 不再使用 ?.style.setProperty');
}

/* ============================================================
   T6b 重复注入幂等性
   Service Worker 被回收重启后 INJECTED_TABS 清空，
   ensureContentInjected 会再次 executeScript 同一组文件。
   若 content 脚本在顶层用 const/let 声明标识符，重复注入会抛
   "Identifier 'X' has already been declared"，引擎整体失效。
   Node 桩每次 runInContext 都是全新沙箱，天然测不出；
   本项做静态拦截，真实复现由浏览器层 R 组负责。
   ============================================================ */
console.log('\nT6b 重复注入幂等性');
{
  for (const [name, src] of [
    ['content/scrollEngine.js', engineSrc],
    ['content/overlay.js', overlaySrc]
  ]) {
    // 顶层 const/let：只匹配不在任何花括号块内的声明
    const topLevel = src.split('\n').filter((line) => {
      if (/^\s/.test(line)) return false;           // 缩进 = 在块内
      if (/^\s*[)}\]]/.test(line)) return false;   // 块结束行
      return /^(const|let)\s+[A-Za-z_$]/.test(line);
    });
    // 依赖缩进判定的静态检查：产物上不适用。
    // 它要防的重复注入词法冲突，由浏览器层 R 组在真实 <script> 注入下兜底。
    assertSourceShape(topLevel.length === 0,
      `${name} 无顶层 const/let 声明（重复注入会抛词法冲突）` +
      (topLevel.length ? `：${topLevel[0].trim().slice(0, 40)}` : ''));
  }
}

/* ============================================================
   T7 悬浮条自动隐藏
   这类交互在浏览器里表现为「点了没反应」，静态检查最容易兜住：
   1) 显隐必须走 class，禁止内联样式（content 端硬约束）
   2) 收起态必须真正退出可聚焦范围，否则键盘 Tab 会落进看不见的控件
   3) 唤回热区不得插入实体 DOM，否则会吞掉宿主页面右下角的点击
   ============================================================ */
console.log('\nT7 悬浮条自动隐藏');
{
  const overlayCss = fs.readFileSync(path.join(ROOT, 'content', 'overlay.css'), 'utf8');

  assert(/\.is-hidden\s+\.panel/.test(overlayCss) || /#slowScroll-overlay\.is-hidden \.panel/.test(overlayCss),
    'overlay.css 定义 .is-hidden 收起态');
  assert(/visibility:\s*hidden/.test(overlayCss),
    '收起态使用 visibility:hidden 退出可聚焦范围');
  assert(/pointer-events:\s*none/.test(overlayCss),
    '收起态禁用指针事件');
  assert(/prefers-reduced-motion/.test(overlayCss) && /#slowScroll-overlay \.panel/.test(overlayCss),
    '控制条显隐过渡纳入 prefers-reduced-motion');

  // 显隐只能通过 class 驱动
  assert(/classList\.toggle\('is-hidden'/.test(overlaySrc),
    'JS 通过 class 驱动显隐');
  assert(!/\.is-hidden['"]\s*[,;)]/.test(overlaySrc),
    'JS 不直接操作收起态样式');

  // 常量必须来自 shared/constants.js，禁止在 content 里另写一份数值
  for (const k of ['OVERLAY_HIDE_DELAY_MS', 'OVERLAY_REHIDE_IDLE_MS', 'OVERLAY_REVEAL_ZONE_SIZE']) {
    assert(new RegExp(`CONSTANTS\\.${k}`).test(overlaySrc),
      `自动隐藏时长取自常量 ${k}`);
  }

  // 热区：坐标判定，禁止插入实体元素
  assert(/clientX/.test(overlaySrc) && /clientY/.test(overlaySrc),
    '唤回热区用鼠标坐标判定');
  assert(!/createElement\(['"]div['"]\)[^;]*(hot ?zone|zone)/i.test(overlaySrc),
    '未插入唤回热区实体元素');

  // 唤回入口：热区 + Esc
  assert(/Escape/.test(overlaySrc), '支持 Esc 唤回');
  assert(/'mousemove'/.test(overlaySrc), '监听 mousemove 判定热区');

  // Esc 不抢页面语义（先剥离注释，否则注释里提到 preventDefault 会造成误判）
  const codeOnly = overlaySrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const escHandler = codeOnly.match(
    /addEventListener\(\s*'keydown'[\s\S]{0,400}?'Escape'[\s\S]{0,300}?\}\s*,\s*true\s*\)/);
  assert(!!escHandler, '存在处理 Escape 的 keydown 监听');
  assert(!!escHandler && !/preventDefault|stopPropagation/.test(escHandler[0]),
    'Esc 唤回不阻止默认行为，不抢宿主页面按键语义');

  // 卸载时必须清理定时器
  const teardown = extractFunction(overlaySrc, 'teardownOverlay');
  assert(!!teardown && /cancelAutoHideTimers\(\)/.test(teardown),
    'teardownOverlay 清理自动隐藏定时器');

  // 收起前必须同时检查「悬停」与「在热区内」两个信号。
  // 只看 hovered 会导致：鼠标停在右下角唤回后，闲置计时到点把条抽走，
  // 而鼠标正压在上面，用户什么都点不到（浏览器层 H13b 已复现过）
  const presenceFn = extractFunction(overlaySrc, 'isPointerPresent');
  assert(!!presenceFn && /hovered/.test(presenceFn) && /pointerInZone/.test(presenceFn),
    '收起判定同时检查悬停与热区两个信号');
  assert(/if \(!isPointerPresent\(\)\) setHidden\(true\);/.test(overlaySrc),
    '两处收起分支统一走 isPointerPresent 判定');

  // 收起只针对控制条，底部提示条必须保持可见
  assert(!/#slowScroll-bottom-prompt[^{]*\.is-hidden/.test(overlayCss),
    '收起态不影响底部状态提示条');
}

/* ============================================================
   T8 多 frame（iframe）支持
   all_frames 打开后引擎会在每个 frame 里各跑一份，若不做三件事，
   用户会看到「iframe 正文页滚不动 / 悬浮条一堆 / popup 显示错乱」：
     1) manifest 必须真的开 all_frames
     2) 悬浮条只能挂在顶层，否则每个 iframe 内都有一条
     3) 控制消息必须按 frameId 定向，否则命令落到滚不动的顶层 frame
   这类问题在浏览器里表现为「点了没反应」，静态检查最适合兜住。
   ============================================================ */
console.log('\nT8 多 frame 支持');
{
  assert(manifest.content_scripts[0].all_frames === true,
    'manifest content_scripts 开启 all_frames（iframe 正文页可被驱动）');

  // 悬浮条只挂顶层
  assert(/window\.top\s*!==\s*window\.self/.test(overlaySrc),
    '悬浮条在非顶层 frame 直接返回（不在 iframe 内重复挂载）');
  // 守卫必须早于任何 DOM 操作，否则 iframe 里仍会插入节点
  const topGuard = overlaySrc.indexOf('window.top !== window.self');
  const mountCall = overlaySrc.indexOf('mountOverlay()');
  assert(topGuard !== -1 && topGuard < mountCall,
    '顶层守卫早于挂载调用');

  // 控制消息按 frameId 定向
  assert(/frameId:\s*target/.test(bgSrc),
    'background 控制消息按 frameId 定向到活动 frame');
  assert(/sender\.frameId/.test(bgSrc),
    'background 依据 sender.frameId 区分各 frame 的状态上报');
  assert(/activeFrame/.test(bgSrc),
    'background 存在「活动 frame」选择逻辑');

  // 引擎在过小的 iframe 里跳过初始化（广告位 / 追踪像素）
  assert(/IS_TINY_FRAME/.test(engineSrc),
    '引擎含小 frame 尺寸守卫');
  assert('MIN_FRAME_AREA' in loadConstants(),
    '小 frame 面积阈值定义在 constants.js');
  // 面积阈值必须真的被引擎读取，否则守卫会因 undefined 恒不生效
  assert(/CONSTANTS\.MIN_FRAME_AREA|\{\}\)\.MIN_FRAME_AREA/.test(engineSrc),
    '引擎从小 frame 守卫读取面积阈值（而非硬编码数值）');

  // 远程调用的方法白名单：消息内容不可信，
  // 盲目 this[method]() 等于把引擎控制面敞开
  assert(/REMOTE_METHODS/.test(engineSrc),
    '引擎对远程方法调用做白名单校验');
  const remoteBlock = engineSrc.match(/REMOTE_METHODS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert(!!remoteBlock && remoteBlock[1].includes('toggleStartStop'),
    '引擎远程方法白名单至少包含控制方法');
  assert(!/\beval\b\s*\(/.test(engineSrc) && !/new Function\s*\(/.test(engineSrc),
    '引擎不使用 eval / new Function 执行远程方法名');

  // background 侧同样要白名单：它是唯一做方法转发的环节
  assert(/ALLOWED\.has\(method\)/.test(bgSrc),
    'background 对转发的方法名做白名单校验');
}

/* ============================================================
   T9 消息超时
   页面导航中 / Service Worker 刚被回收时，sendMessage 可能长时间不返回。
   没有超时的话 popup 会一直停在旧状态，用户表现为「点了没反应」。
   ============================================================ */
console.log('\nT9 消息超时');
{
  const C = loadConstants();
  assert(C.MESSAGE_TIMEOUT_MS > 0 && C.INJECT_TIMEOUT_MS > C.MESSAGE_TIMEOUT_MS,
    '注入超时阈值大于普通消息（注入要读文件建隔离世界，本就更慢）');

  // background：探测、注入、发送三条路径都要有超时
  const withTimeout = extractFunction(bgSrc, 'withTimeout');
  assert(!!withTimeout && /setTimeout/.test(withTimeout),
    'background 实现 withTimeout 且真的用了 setTimeout');
  const sendCount = (bgSrc.match(/withTimeout\(/g) || []).length;
  assert(sendCount >= 3,
    `探测 / 注入 / 发送三条路径均加超时（实际 ${sendCount} 处）`);

  // popup：面向用户的一侧，超时缺失最容易被感知。
  // 判定只看「用了 setTimeout + 取自常量」，不依赖函数体在文件中的位置 ——
  // 压缩会重排空白与缩进，按字符窗口截取函数体在产物上必然失效。
  assert(/MESSAGE_TIMEOUT_MS/.test(popupSrc),
    'popup 超时阈值取自 constants.js');
  assert(/setTimeout/.test(popupSrc),
    'popup 使用 setTimeout 实现超时');
}

const tail = skipped ? `, ${skipped} skipped` : '';
console.log(`\n===== ${pass} passed, ${fail} failed${tail} =====`);
process.exit(fail ? 1 : 0);