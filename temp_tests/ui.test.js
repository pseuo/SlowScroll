/* ============================================================
   界面交互自测：popup / options / overlay 的点击、拖动、保存
   运行：node temp_tests/ui.test.js

   覆盖此前只能靠人工点一遍的部分：
     · 按钮点击 → 发出的消息是否正确
     · 速度滑块拖动 → 节流提交与松手立即提交的分工
     · 保存 / 恢复默认 → storage.sync 的实际写入内容
     · 旧键迁移、数值钳制、状态广播驱动的单向渲染
     · 悬浮条按钮 → 引擎方法的委派关系
     · 常量缺失时的降级态（禁用控件而非静默跑偏）

   不覆盖：真实布局、CSS 过渡、计时精度 —— 那些属于浏览器层。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { createDom, flush } = require('./dom.js');

/* 被测根目录。默认指向项目本身；构建脚本会把压缩后的产物
   铺到临时目录并设 SLOWSCROLL_ROOT，让同一套断言跑在压缩产物上 ——
   这是「压缩没有改变行为」唯一有说服力的证据。 */
const ROOT = process.env.SLOWSCROLL_ROOT || path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const constantsSrc = read('shared/constants.js');
const popupSrc = read('popup/popup.js');
const optionsSrc = read('options/options.js');
const overlaySrc = read('content/overlay.js');
const popupHtml = read('popup/popup.html');
const optionsHtml = read('options/options.html');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
function group(title) { console.log(`\n${title}`); }

const C = { MIN_SPEED: 50, MAX_SPEED: 4000, DEFAULT_SPEED: 600, SPEED_GRANULARITY: 50, DEFAULT_STEP: 50, MIN_STEP: 10, MAX_STEP: 500 };

async function main() {
/* ============================================================
   P1 popup：初始渲染与状态映射
   ============================================================ */
group('P1 popup 状态映射');
async function popup(opts = {}) {
  const dom = createDom(popupHtml);
  if (opts.constants !== false) dom.runScript(constantsSrc, 'constants.js');
  if (opts.state) Object.assign(dom.chrome.runtime._state, opts.state);
  if (opts.store) Object.assign(dom.store, opts.store);
  dom.runScript(popupSrc, 'popup.js');
  await flush();
  return dom;
}
{
  const dom = await popup({ state: { isScrolling: false, isPaused: false, speed: 600 } });
  const d = dom.document;
  assert(d.getElementById('stateText').textContent === '已停止', '停止态文案为「已停止」');
  assert(d.getElementById('startStopLabel').textContent === '开始滚动', '主按钮文案为「开始滚动」');
  assert(d.getElementById('pauseResumeLabel').textContent === '暂停', '暂停按钮文案为「暂停」');
  assert(d.getElementById('pauseResume').disabled === true, '未滚动时暂停按钮禁用');
  assert(d.getElementById('startStop').getAttribute('aria-pressed') === 'false', '主按钮 aria-pressed=false');
  assert(d.getElementById('stateBadge').classList.contains('badge--live') === false, '停止态徽标不带 live 类');
  assert(d.body.classList.contains('is-running') === false, '停止态 body 无 is-running');
}
{
  const dom = await popup({ state: { isScrolling: true, isPaused: false, speed: 800 } });
  const d = dom.document;
  assert(d.getElementById('stateText').textContent === '运行中', '运行态文案为「运行中」');
  assert(d.getElementById('startStopLabel').textContent === '停止滚动', '运行态主按钮变「停止滚动」');
  assert(d.getElementById('pauseResume').disabled === false, '运行态暂停按钮可用');
  assert(d.getElementById('stateBadge').classList.contains('badge--live') === true, '运行态徽标带 live 类');
  assert(d.getElementById('speedRange').value === '800', '滑块值同步为引擎速度');
  assert(d.getElementById('speedLabel').textContent === '800', '速度文本同步');
}
{
  const dom = await popup({ state: { isScrolling: true, isPaused: true } });
  const d = dom.document;
  assert(d.getElementById('stateText').textContent === '已暂停', '暂停态文案为「已暂停」');
  assert(d.getElementById('pauseResumeLabel').textContent === '继续', '暂停态按钮变「继续」');
  assert(d.getElementById('stateBadge').classList.contains('badge--live') === false, '暂停态徽标不带 live 类');
  assert(d.body.classList.contains('is-paused') === true, '暂停态 body 带 is-paused');
}

/* ============================================================
   P2 popup：滑块区间以常量为唯一来源
   ============================================================ */
group('P2 popup 滑块区间');
{
  const dom = await popup();
  const r = dom.document.getElementById('speedRange');
  assert(r.min === '50' && r.max === '4000', `滑块区间取自常量（实际 ${r.min}–${r.max}）`);
  assert(r.step === '50', '步进取自常量');
  // HTML 上写死的是 50–4000，构造一个更窄的常量集来证明覆写真的生效
  const dom2 = createDom(popupHtml);
  dom2.runScript(`globalThis.__SLOWSCROLL_CONSTANTS__ = ${JSON.stringify({ ...C, MIN_SPEED: 100, MAX_SPEED: 2000 })};`, 'fake');
  dom2.runScript(popupSrc, 'popup.js');
  await flush();
  const r2 = dom2.document.getElementById('speedRange');
  assert(r2.min === '100' && r2.max === '2000', '常量变化时滑块区间跟随覆写');
}

/* ============================================================
   P3 popup：按钮点击 → 消息
   ============================================================ */
group('P3 popup 点击');
{
  const dom = await popup({ state: { isScrolling: false } });
  dom.document.getElementById('startStop').click();
  await flush();
  const msg = dom.sendLog.find((e) => e.area === 'runtime.sendMessage' && e.msg.type === 'TOGGLE_START_STOP');
  assert(!!msg, '点击开始/停止发出 TOGGLE_START_STOP');
  assert(msg && msg.msg.from === 'popup', '控制消息带 from=popup 标记');
}
{
  const dom = await popup({ state: { isScrolling: true } });
  dom.document.getElementById('pauseResume').click();
  await flush();
  assert(dom.sendLog.some((e) => e.msg?.type === 'TOGGLE_PAUSE_RESUME'), '点击暂停发出 TOGGLE_PAUSE_RESUME');
}
{
  const dom = await popup();
  dom.document.getElementById('openOptions').click();
  await flush();
  assert(dom.sendLog.some((e) => e.area === 'runtime.openOptionsPage'), '点击设置调用 openOptionsPage');
}

/* ============================================================
   P3b popup 乐观更新与竞态防护
   回归背景：原先每次点击都是「发命令 → 再 queryState 一次 → 渲染」，
   既多一次跨进程往返，又制造了竞态 —— 连点两次时先发的查询后返回，
   把界面覆盖回旧值（用户表现为「开关又弹回去了」）。

   新契约：
     · 点击立即反映预期结果（乐观更新），不等往返
     · 操作后不再发 QUERY_STATE
     · 广播带 seq，乱序到达的旧快照被丢弃
     · 其他标签页的广播不被采纳
   ============================================================ */
group('P3b popup 乐观更新与竞态');
{
  const dom = await popup({ state: { isScrolling: false } });
  dom.document.getElementById('startStop').click();
  // 同步断言：不等任何 await，界面必须已经切到「运行中」
  assert(dom.document.getElementById('stateText').textContent === '运行中',
    `点击后立即乐观更新为运行中（实际「${dom.document.getElementById('stateText').textContent}」）`);
  await flush();
  const queries = dom.sendLog.filter((e) => e.msg?.type === 'QUERY_STATE');
  // 初始快照那一次是必要的；点击后不应再有
  assert(queries.length === 1,
    `操作后不再回读 queryState（实际共 ${queries.length} 次）`);
}
{
  // 暂停中点主按钮 = 停止：stopScrolling 会重置 isPaused，
  // 乐观更新若保留旧值，界面会卡在「已暂停」而引擎其实已停
  const dom = await popup({ state: { isScrolling: true, isPaused: true } });
  dom.document.getElementById('startStop').click();
  assert(dom.document.getElementById('stateText').textContent === '已停止',
    `暂停中点停止后显示「已停止」（实际「${dom.document.getElementById('stateText').textContent}」）`);
  assert(dom.document.getElementById('pauseResume').disabled === true,
    '停止后暂停按钮禁用');
}
{
  // 已停止时点开始：应同时切到运行中并解除暂停残留
  const dom = await popup({ state: { isScrolling: false, isPaused: false } });
  dom.document.getElementById('startStop').click();
  assert(dom.document.getElementById('stateText').textContent === '运行中',
    '停止态点开始切到运行中');
}
{
  // seq 单调：更大的 seq 覆盖，更小的 seq 被丢弃
  const dom = await popup({ state: { isScrolling: false, speed: 600 } });
  await dom.runtimeMessage({
    type: 'STATE_BROADCAST', tabId: 1, seq: 10,
    payload: { isScrolling: true, speed: 1200 }
  });
  assert(dom.document.getElementById('speedLabel').textContent === '1200',
    '较大 seq 的广播被采纳');

  await dom.runtimeMessage({
    type: 'STATE_BROADCAST', tabId: 1, seq: 3,
    payload: { isScrolling: false, speed: 300 }
  });
  assert(dom.document.getElementById('speedLabel').textContent === '1200',
    `过期 seq 的广播被丢弃（实际速度 ${dom.document.getElementById('speedLabel').textContent}）`);
  assert(dom.document.getElementById('stateText').textContent === '运行中',
    '过期广播不会把运行态改回停止态');

  await dom.runtimeMessage({
    type: 'STATE_BROADCAST', tabId: 1, seq: 11,
    payload: { isScrolling: true, speed: 900 }
  });
  assert(dom.document.getElementById('speedLabel').textContent === '900',
    '更大 seq 的广播仍能覆盖');
}
{
  // 标签页隔离：其他标签页的广播不应影响本 popup
  const dom = await popup({ state: { isScrolling: false, speed: 600 } });
  await dom.runtimeMessage({
    type: 'STATE_BROADCAST', tabId: 1, seq: 20,
    payload: { isScrolling: true, speed: 1500 }
  });
  await dom.runtimeMessage({
    type: 'STATE_BROADCAST', tabId: 2, seq: 21,
    payload: { isScrolling: false, speed: 200 }
  });
  assert(dom.document.getElementById('speedLabel').textContent === '1500',
    `忽略其他标签页的广播（实际速度 ${dom.document.getElementById('speedLabel').textContent}）`);
  assert(dom.document.getElementById('stateText').textContent === '运行中',
    '其他标签页的广播不改变本 popup 的运行态');
}

/* ============================================================
   P4 popup：速度滑块 —— 节流与松手立即提交
   回归背景：拖动中每秒触发数十次 input，若每次都发消息，
   background 会被拖入无谓的脚本探测。
   ============================================================ */
group('P4 popup 滑块节流');
{
  const dom = await popup({ state: { isScrolling: true, speed: 600 } });
  const range = dom.document.getElementById('speedRange');

  range.value = '700';
  await dom.fire(range, 'input', { target: range });
  assert(dom.document.getElementById('speedLabel').textContent === '700', '拖动中数值即时反馈，不等往返');
  const sentDuringDrag = dom.sendLog.filter((e) => e.msg?.type === 'SET_SPEED').length;
  assert(sentDuringDrag === 0, `拖动过程中不立即发消息（实际 ${sentDuringDrag} 次）`);

  // 节流窗口到期后才提交终值
  await dom.tick(1);
  const afterThrottle = dom.sendLog.filter((e) => e.msg?.type === 'SET_SPEED');
  assert(afterThrottle.length === 1, `节流窗口后提交一次（实际 ${afterThrottle.length} 次）`);
  assert(afterThrottle[0]?.msg.payload.speed === 700, '提交的是最后一次的拖动值');
}
{
  // 松手（change）必须立刻提交，不能等节流窗口，
  // 否则 popup 在窗口内关闭会丢掉末次调整
  const dom = await popup({ state: { isScrolling: true, speed: 600 } });
  const range = dom.document.getElementById('speedRange');
  range.value = '1200';
  await dom.fire(range, 'input', { target: range });
  range.value = '1500';
  await dom.fire(range, 'change', { target: range });
  const set = dom.sendLog.filter((e) => e.msg?.type === 'SET_SPEED');
  assert(set.length >= 1, '松手立即提交');
  assert(set[set.length - 1]?.msg.payload.speed === 1500, '松手提交的是最终值 1500');
}

/* ============================================================
   P5 popup：循环开关与状态广播
   ============================================================ */
group('P5 popup 循环与广播');
{
  const dom = await popup();
  const toggle = dom.document.getElementById('loopToggle');
  toggle.checked = true;
  await dom.fire(toggle, 'change', { target: toggle });
  const msg = dom.sendLog.find((e) => e.msg?.type === 'SET_LOOP');
  assert(!!msg, '切换循环发出 SET_LOOP');
  assert(msg?.msg.payload.enabled === true, 'SET_LOOP 携带 enabled=true');
  assert(msg?.msg.payload.persist === true, 'SET_LOOP 携带 persist=true（需写入全局配置）');
}
{
  const dom = await popup({ state: { isScrolling: false, loopCount: 0 } });
  const hint = dom.document.getElementById('loopCount');
  assert(hint.hidden === true, '未开启循环时不显示计数');
  await dom.runtimeMessage({ type: 'STATE_BROADCAST', payload: { isScrolling: true, loopEnabled: true, loopCount: 3 } });
  const d = dom.document;
  assert(d.getElementById('stateText').textContent === '运行中', '广播后主状态刷新（快捷键改动实时可见）');
  assert(d.getElementById('loopCount').hidden === false, '循环开启后显示计数');
  assert(d.getElementById('loopCount').textContent === '已循环 3 次', `计数文案正确（实际「${d.getElementById('loopCount').textContent}」）`);
  assert(d.getElementById('loopToggle').checked === true, '广播同步循环开关');
}

/* ============================================================
   P6 popup：常量缺失降级
   ============================================================ */
group('P6 popup 降级态');
{
  const dom = await popup({ constants: false });
  const d = dom.document;
  assert(d.getElementById('stateText').textContent === '扩展文件不完整', '缺常量时明示文件不完整');
  assert(d.getElementById('stateBadge').textContent === '异常', '徽标切为「异常」');
  const btns = d.querySelectorAll('.btn, .slider, .switch input');
  assert(btns.length > 0 && btns.every((b) => b.disabled === true),
    `全部控件禁用（共 ${btns.length} 个）`);
  assert(dom.sendLog.filter((e) => e.area === 'runtime.sendMessage').length === 0,
    '降级态不发送任何控制消息');
}

/* ============================================================
   O1 options：加载与回填
   ============================================================ */
group('O1 options 加载');
async function options(opts = {}) {
  const dom = createDom(optionsHtml);
  if (opts.constants !== false) dom.runScript(constantsSrc, 'constants.js');
  if (opts.store) Object.assign(dom.store, opts.store);
  dom.runScript(optionsSrc, 'options.js');
  await dom.ready();
  await flush();
  return dom;
}
{
  const dom = await options({ store: { defaultSpeed: 1200, step: 150, loopEnabled: true, overlayEnabled: false, autoHideOverlay: false } });
  const d = dom.document;
  assert(d.getElementById('defaultSpeedRange').value === '1200', '滑块回填已存速度');
  assert(d.getElementById('defaultSpeed').value === '1200', '数字输入同步回填');
  assert(d.getElementById('defaultSpeedValue').textContent === '1200', '数值标签同步');
  assert(d.getElementById('speedStep').value === '150', '步进回填');
  assert(d.getElementById('loopEnabled').checked === true, '循环开关回填');
  assert(d.getElementById('overlayEnabled').checked === false, '悬浮条开关回填');
  assert(d.getElementById('autoHideOverlay').checked === false, '自动隐藏开关回填');
}
{
  // 旧键 speedStep 迁移：历史上 options 写 speedStep、引擎读 step，
  // 导致设置永久失效。读到旧值且新键仍是默认值时必须迁移
  const dom = await options({ store: { speedStep: 240 } });
  assert(dom.document.getElementById('speedStep').value === '240',
    `旧键 speedStep 迁移到 step（实际 ${dom.document.getElementById('speedStep').value}）`);
}

/* ============================================================
   O2 options：滑块与数字输入双向同步 + 钳制
   ============================================================ */
group('O2 options 双向同步');
{
  const dom = await options();
  const d = dom.document;
  const range = d.getElementById('defaultSpeedRange');

  range.value = '2000';
  await dom.fire(range, 'input', { target: range });
  assert(d.getElementById('defaultSpeed').value === '2000', '滑块 → 数字输入');
  assert(d.getElementById('defaultSpeedValue').textContent === '2000', '滑块 → 数值标签');

  const num = d.getElementById('defaultSpeed');
  num.value = '900';
  await dom.fire(num, 'input', { target: num });
  assert(d.getElementById('defaultSpeedRange').value === '900', '数字输入 → 滑块');
}
{
  // 越界值必须被钳制，不能把非法值写进 storage
  const dom = await options();
  const d = dom.document;
  const num = d.getElementById('defaultSpeed');
  num.value = '99999';
  await dom.fire(num, 'input', { target: num });
  num.blur();
  await flush();
  assert(d.getElementById('defaultSpeedRange').value === '4000', '超上限钳制到 MAX_SPEED');
  num.value = '1';
  await dom.fire(num, 'input', { target: num });
  num.blur();
  await flush();
  assert(d.getElementById('defaultSpeedRange').value === '50', '低于下限钳制到 MIN_SPEED');
}
{
  // 输入框清空时不应把表单打成默认值，正在输入的用户会丢失输入
  const dom = await options();
  const num = dom.document.getElementById('defaultSpeed');
  num.value = '';
  await dom.fire(num, 'input', { target: num });
  assert(dom.document.getElementById('defaultSpeedRange').value === '600', '清空输入不改动滑块');
}

/* ============================================================
   O3 options：保存 / 恢复默认 / 快捷键
   ============================================================ */
group('O3 options 保存');
{
  const dom = await options();
  const d = dom.document;
  d.getElementById('defaultSpeedRange').value = '1500';
  await dom.fire(d.getElementById('defaultSpeedRange'), 'input', { target: d.getElementById('defaultSpeedRange') });
  d.getElementById('speedStep').value = '9999';
  d.getElementById('loopEnabled').checked = true;
  d.getElementById('overlayEnabled').checked = false;
  d.getElementById('save').click();
  await flush();

  const set = dom.sendLog.filter((e) => e.area === 'storage.sync.set').pop();
  assert(!!set, '点击保存写入 storage.sync');
  assert(set.msg.defaultSpeed === 1500, `保存速度正确（实际 ${set.msg.defaultSpeed}）`);
  assert(set.msg.step === 500, `步进钳制到 MAX_STEP（实际 ${set.msg.step}）`);
  assert(set.msg.loopEnabled === true, '保存循环开关');
  assert(set.msg.overlayEnabled === false, '保存悬浮条开关');
  assert(!('speedStep' in set.msg), '写入的是正式键 step，不含旧键 speedStep');
  assert(d.getElementById('status').textContent === '设置已保存', '保存后有状态提示');
}
{
  const dom = await options({ store: { defaultSpeed: 2000, step: 200 } });
  dom.document.getElementById('reset').click();
  await flush();
  assert(dom.document.getElementById('defaultSpeedRange').value === '600', '恢复默认回到 DEFAULT_SPEED');
  assert(dom.document.getElementById('speedStep').value === '50', '恢复默认回到 DEFAULT_STEP');
  const set = dom.sendLog.filter((e) => e.area === 'storage.sync.set').pop();
  assert(set?.msg.defaultSpeed === 600 && set?.msg.step === 50, '恢复默认值同步写回 storage');
  assert(dom.document.getElementById('status').textContent === '已恢复默认设置', '恢复默认有状态提示');
}
{
  const dom = await options();
  dom.fire(dom.document, 'keydown', { key: 's', ctrlKey: true, metaKey: false })
    .then(() => flush());
  await flush();
  assert(dom.sendLog.some((e) => e.area === 'storage.sync.set'), 'Ctrl+S 触发保存');
}

/* ============================================================
   O4 options：常量注入控件
   ============================================================ */
group('O4 options 常量注入');
{
  const dom = await options();
  const d = dom.document;
  assert(d.getElementById('speedStep').min === '10' && d.getElementById('speedStep').max === '500',
    '步进区间取自常量');
  const ticks = d.querySelectorAll('.speed-control__scale span').map((s) => s.textContent);
  assert(ticks.join(',') === '50,1000,2000,3000,4000',
    `刻度标签跟随常量（实际 ${ticks.join(',')}）`);
}
{
  const dom = createDom(optionsHtml);
  dom.runScript(`globalThis.__SLOWSCROLL_CONSTANTS__ = ${JSON.stringify({ ...C, MIN_SPEED: 200, MAX_SPEED: 1200 })};`, 'fake');
  dom.runScript(optionsSrc, 'options.js');
  await dom.ready();
  await flush();
  const ticks = dom.document.querySelectorAll('.speed-control__scale span').map((s) => s.textContent);
  assert(ticks[0] === '200' && ticks[4] === '1200',
    `刻度不与实际区间脱节（实际 ${ticks.join(',')}）`);
}

/* ============================================================
   O5 options：降级态
   ============================================================ */
group('O5 options 降级态');
{
  const dom = createDom(optionsHtml);
  dom.runScript(optionsSrc, 'options.js');
  await dom.ready();
  await flush();
  const d = dom.document;
  const status = d.getElementById('status');
  assert(status.hidden === false && /constants\.js/.test(status.textContent),
    '缺常量时明示 constants.js 未加载');
  assert(status.classList.contains('toast--error'), '降级提示标为错误态');
  const inputs = d.querySelectorAll('input, .btn');
  assert(inputs.length > 0 && inputs.every((i) => i.disabled === true), '全部控件禁用');
  assert(dom.sendLog.filter((e) => e.area === 'storage.sync.set').length === 0, '降级态不写配置');
}

/* ============================================================
   V1 overlay：挂载与按钮委派
   ============================================================ */
group('V1 overlay 按钮');
async function overlay(opts = {}) {
  const dom = createDom('<!doctype html><html><head><title>t</title></head><body></body></html>');
  dom.runScript(constantsSrc, 'constants.js');
  if (opts.store) Object.assign(dom.store, opts.store);
  const calls = [];
  dom.window.__slowScrollEngine = {
    getSnapshot: () => ({ isScrolling: false, isPaused: false, speed: 600, loopEnabled: false }),
    getState: () => ({ ...(opts.engineState || { isScrolling: false, step: 100 }) }),
    toggleStartStop: () => { calls.push(['toggleStartStop']); return true; },
    adjustSpeed: (d) => { calls.push(['adjustSpeed', d]); },
    toggleLoop: () => { calls.push(['toggleLoop']); return true; },
    scrollToTop: () => { calls.push(['scrollToTop']); }
  };
  dom.runScript(overlaySrc, 'overlay.js');
  await flush();
  dom.calls = calls;
  return dom;
}
{
  const dom = await overlay();
  const root = dom.document.getElementById('slowScroll-overlay');
  assert(!!root, '悬浮条已挂载');
  assert(!!root.querySelector('.panel'), '面板已挂载');
  ['ss-play', 'ss-speed-up', 'ss-speed-down', 'ss-loop', 'ss-top'].forEach((id) => {
    assert(!!dom.document.getElementById(id), `按钮 ${id} 存在`);
  });
  assert(dom.document.getElementById('ss-speed-value').textContent === '600',
    '速度初值取自常量快照');
}
{
  // 步进必须走引擎自身配置，而非 overlay 里硬编码 50：
  // 设置页把步进改成 120 时，悬浮条加减也应当是 120
  const dom = await overlay({ engineState: { isScrolling: false, step: 120 } });
  dom.document.getElementById('ss-speed-up').click();
  dom.document.getElementById('ss-speed-up').click();
  dom.document.getElementById('ss-speed-down').click();
  assert(dom.calls.filter((c) => c[0] === 'adjustSpeed').map((c) => c[1]).join(',') === '120,120,-120',
    `加减按引擎步进委派（实际 ${dom.calls.filter((c) => c[0] === 'adjustSpeed').map((c) => c[1]).join(',')}）`);
}
{
  const dom = await overlay({ engineState: { isScrolling: false, step: 0 } });
  dom.document.getElementById('ss-speed-up').click();
  assert(dom.calls.find((c) => c[0] === 'adjustSpeed')?.[1] === C.DEFAULT_STEP,
    '引擎未给有效步进时回退常量 DEFAULT_STEP');
}
{
  const dom = await overlay();
  dom.document.getElementById('ss-play').click();
  dom.document.getElementById('ss-top').click();
  dom.document.getElementById('ss-loop').click();
  const names = dom.calls.map((c) => c[0]);
  assert(names.includes('toggleStartStop'), '播放按钮委派 toggleStartStop');
  assert(names.includes('scrollToTop'), '回顶按钮委派 scrollToTop');
  assert(names.includes('toggleLoop'), '循环按钮委派 toggleLoop');
  assert(dom.document.getElementById('ss-loop-label').textContent === '循环开', '循环开启后标签更新');
}

/* ============================================================
   V2 overlay：状态渲染
   ============================================================ */
group('V2 overlay 渲染');
{
  const dom = await overlay();
  const api = dom.window.__slowScrollOverlay;
  api.updateOverlay({ isScrolling: true, speed: 900, loopEnabled: true });
  const d = dom.document;
  assert(d.getElementById('ss-speed-value').textContent === '900', '速度数值更新');
  assert(d.getElementById('ss-play-label').textContent === '停止', '运行态播放标签变「停止」');
  assert(d.getElementById('ss-play').classList.contains('running') === true, '运行态加 running 类');
  assert(d.getElementById('ss-play').getAttribute('aria-pressed') === 'true', '运行态 aria-pressed=true');
  assert(d.getElementById('ss-loop').classList.contains('active') === true, '循环态加 active 类');
  assert(d.getElementById('ss-loop-label').textContent === '循环开', '循环态标签更新');
}
{
  const dom = await overlay();
  const api = dom.window.__slowScrollOverlay;
  api.showBottomPrompt('infinite');
  const el = dom.document.getElementById('slowScroll-bottom-prompt');
  assert(/无限滚动/.test(el.textContent), '无限滚动提示文案正确');
  assert(el.dataset.type === 'infinite', '提示类型写入 data-type');
  api.showBottomPrompt('returning');
  assert(el.dataset.type === 'returning', '回顶中提示类型更新');
  assert(el.classList.contains('show') === true, '提示条进入展示态');
}

/* ============================================================
   V3 overlay：显隐开关与卸载
   ============================================================ */
group('V3 overlay 显隐');
{
  const dom = await overlay({ store: { overlayEnabled: false } });
  assert(!dom.document.getElementById('slowScroll-overlay'), '关闭开关时不挂载悬浮条');

  await dom.storageChange({ overlayEnabled: { newValue: true } });
  assert(!!dom.document.getElementById('slowScroll-overlay'), '设置页开启后当前标签页即时挂载');

  await dom.storageChange({ overlayEnabled: { newValue: false } });
  assert(!dom.document.getElementById('slowScroll-overlay'), '关闭后卸载悬浮条 DOM');
}
{
  // 自动隐藏开关必须被真正读取：只写不读的开关等于形同虚设
  const dom = await overlay({ store: { autoHideOverlay: false } });
  const api = dom.window.__slowScrollOverlay;
  assert(api.isAutoHideEnabled() === false, '读到 autoHideOverlay=false');
  api.updateOverlay({ isScrolling: true });
  await dom.tick(4);
  assert(api.isHidden() === false, '关闭自动隐藏时永不收起');

  const dom2 = await overlay({ store: { autoHideOverlay: true } });
  const api2 = dom2.window.__slowScrollOverlay;
  api2.updateOverlay({ isScrolling: true });
  await dom2.tick(2);
  assert(api2.isHidden() === true, '开始滚动后按延迟收起');
  api2.revealOverlay();
  assert(api2.isHidden() === false, '可显式唤回');
}
{
  const dom = await overlay();
  const api = dom.window.__slowScrollOverlay;
  api.setAutoHideEnabled(true);
  api.updateOverlay({ isScrolling: true });
  api.teardownOverlay();
  await dom.tick(4);
  assert(!dom.document.getElementById('slowScroll-overlay'), '卸载后 DOM 已移除');
  assert(dom.pendingTimers().length === 0, `卸载后无残留定时器（实际 ${dom.pendingTimers().length} 个）`);
}

/* ============================================================
   P7 popup：容器失败原因与自动翻页
   ============================================================ */
group('P7 popup 失败原因与自动翻页');
{
  // 默认无失败原因 → 不显示解释条
  const dom = await popup({ state: { isScrolling: true, progress: 0 } });
  const el = dom.document.getElementById('containerIssue');
  assert(el.hidden === true, '无失败原因时不显示解释');
  assert(el.textContent === '', '无失败原因时文案为空');
}
{
  // 引擎诊断出「无可滚动内容」→ 明示出来
  const dom = await popup({ state: { isScrolling: true, containerIssue: 'no-content' } });
  const el = dom.document.getElementById('containerIssue');
  assert(el.hidden === false, '诊断结果为 null 时不显示，实际有原因则显示');
  assert(el.textContent === '本页无可滚动内容', '「无可滚动内容」文案正确');
}
{
  const dom = await popup({ state: { isScrolling: true, containerIssue: 'virtual-list' } });
  const el = dom.document.getElementById('containerIssue');
  assert(el.textContent === '页面疑似虚拟列表，无法滚动', '「虚拟列表」文案正确');
}
{
  // 未知原因不得渲染成误导性文案
  const dom = await popup({ state: { containerIssue: 'something-new' } });
  const el = dom.document.getElementById('containerIssue');
  assert(el.hidden === true, '未知原因值保持隐藏（不猜测语义）');
}
{
  // 自动翻页：开关与白名单的初始渲染
  const dom = await popup({ state: { autoNextEnabled: false, autoNextSites: [] } });
  const d = dom.document;
  assert(d.getElementById('autoNextToggle').checked === false, '自动翻页默认关闭');
  assert(d.getElementById('autoNextSites').value === '', '白名单默认为空');
  assert(d.getElementById('autoNextHint').textContent === '关闭', '关闭态提示文案正确');
  assert(d.getElementById('autoStatus').textContent === '未开启', '折叠标题显示未开启');
}
{
  const dom = await popup({ state: { autoNextEnabled: true, autoNextSites: ['example.com'] } });
  const d = dom.document;
  assert(d.getElementById('autoNextToggle').checked === true, '开启态同步到开关');
  assert(d.getElementById('autoNextSites').value === 'example.com', '白名单数组渲染为逐行文本');
  assert(d.getElementById('autoNextHint').textContent === '已开启 · 1 个站点', '显示生效站点数');
  assert(d.getElementById('autoStatus').textContent === '翻页已开', '折叠标题显示已开');
}
{
  const dom = await popup({ state: { autoNextEnabled: true, autoNextSites: [] } });
  assert(dom.document.getElementById('autoNextHint').textContent === '已开启 · 不限站点',
    '空白名单明示为「不限站点」而非含糊带过');
}
{
  // 武装期状态要显式呈现，让用户知道即将被带走
  const dom = await popup({ state: { autoNextEnabled: true, autoNextArmed: '下一章' } });
  const d = dom.document;
  assert(d.getElementById('autoNextHint').textContent === '即将翻到「下一章」，滚动可取消',
    '武装期明示目标与取消方式');
  assert(d.getElementById('autoStatus').textContent === '即将翻页', '折叠标题同步为即将翻页');
}
{
  // 开关点击 → 发出正确的消息
  const dom = await popup({ state: { autoNextEnabled: false } });
  const toggle = dom.document.getElementById('autoNextToggle');
  toggle.checked = true;
  toggle.dispatchEvent(new dom.MiniEvent('change'));
  await flush();
  const msg = dom.sendLog.find((e) => e.msg?.type === 'SET_AUTO_NEXT');
  assert(!!msg, '开关发送 SET_AUTO_NEXT');
  assert(msg && msg.msg.payload.enabled === true, '开关状态随消息透传');
  assert(msg && msg.msg.payload.persist === true, '开关变更持久化');
}
{
  // 白名单失焦提交：多行文本拆成数组
  const dom = await popup({ state: { autoNextEnabled: true } });
  const sites = dom.document.getElementById('autoNextSites');
  sites.value = 'a.com\nb.com\n\na.com';
  sites.dispatchEvent(new dom.MiniEvent('change'));
  await flush();
  const msg = dom.sendLog.find((e) => e.msg?.type === 'SET_AUTO_NEXT_SITES');
  assert(!!msg, '白名单变更发送 SET_AUTO_NEXT_SITES');
  assert(msg && JSON.stringify(msg.msg.payload.sites) === JSON.stringify(['a.com', 'b.com']),
    `白名单按行拆分并去重（实际 ${JSON.stringify(msg.msg.payload.sites)}）`);
}
{
  // 倒计时：0 = 不限时，剩余时间只在会话进行中显示
  const dom = await popup({ state: { stopAfterMinutes: 0, isScrolling: true } });
  assert(dom.document.getElementById('stopAfterMinutes').value === '0', '倒计时默认不限时');
  assert(dom.document.getElementById('stopAfterLeft').textContent === '', '不限时时不显示剩余');
  assert(dom.document.getElementById('autoStatus').textContent === '未开启', '两项都关时标题为未开启');
}
{
  const dom = await popup({ state: { stopAfterMinutes: 20, isScrolling: true, stopAfterRemainingMs: 20 * 60 * 1000 } });
  const d = dom.document;
  assert(d.getElementById('stopAfterMinutes').value === '20', '倒计时时长同步到输入框');
  assert(d.getElementById('stopAfterLeft').textContent === '20:00', '剩余时间格式化为 mm:ss');
  assert(d.getElementById('autoStatus').textContent === '20 分钟后停', '仅倒计时启用时标题显示分钟数');
}
{
  // 不足一分钟显示秒
  const dom = await popup({ state: { stopAfterMinutes: 1, isScrolling: true, stopAfterRemainingMs: 45000 } });
  assert(dom.document.getElementById('stopAfterLeft').textContent === '45s', '不足一分钟显示秒数');
}
{
  // 未运行时不显示倒计时（会话已结束，没有「剩余」可言）
  const dom = await popup({ state: { stopAfterMinutes: 20, isScrolling: false, stopAfterRemainingMs: 600000 } });
  assert(dom.document.getElementById('stopAfterLeft').textContent === '', '未运行时隐藏剩余时间');
}
{
  // 倒计时输入失焦提交
  const dom = await popup({ state: { stopAfterMinutes: 0 } });
  const input = dom.document.getElementById('stopAfterMinutes');
  input.value = '25';
  input.dispatchEvent(new dom.MiniEvent('change'));
  await flush();
  const msg = dom.sendLog.find((e) => e.msg?.type === 'SET_STOP_AFTER');
  assert(!!msg, '倒计时变更发送 SET_STOP_AFTER');
  assert(msg && msg.msg.payload.minutes === 25, '分钟数随消息透传');
}

/* ============================================================
   P8 options：自动化配置项
   ============================================================ */
group('P8 options 自动化配置');
{
  const dom = await options({});
  const d = dom.document;
  assert(d.getElementById('autoNextPage').checked === false, '设置页自动翻页默认关闭');
  assert(d.getElementById('autoNextBlock').hidden === true, '白名单区在关闭时隐藏');
  assert(d.getElementById('stopAfterMinutes').value === '0', '设置页倒计时默认不限时');
}
{
  const dom = await options({ store: { autoNextPage: true } });
  const d = dom.document;
  assert(d.getElementById('autoNextPage').checked === true, '读回已保存的开关状态');
  assert(d.getElementById('autoNextBlock').hidden === false, '开启时白名单区显形');
}
{
  const dom = await options({ store: { autoNextPage: true, autoNextSites: ['a.com', 'b.com'] } });
  const ta = dom.document.getElementById('autoNextSites');
  assert(ta.value === 'a.com\nb.com', '白名单数组还原为逐行文本');
}
{
  // 开关切换即时显隐，无需刷新
  const dom = await options({});
  const toggle = dom.document.getElementById('autoNextPage');
  toggle.checked = true;
  toggle.dispatchEvent(new dom.MiniEvent('change'));
  await flush();
  assert(dom.document.getElementById('autoNextBlock').hidden === false, '切换开关即时显形白名单区');
  toggle.checked = false;
  toggle.dispatchEvent(new dom.MiniEvent('change'));
  await flush();
  assert(dom.document.getElementById('autoNextBlock').hidden === true, '关闭开关即时收起白名单区');
}
{
  // 保存：三项配置写入内容必须正确
  const dom = await options({});
  const d = dom.document;
  d.getElementById('autoNextPage').checked = true;
  d.getElementById('autoNextSites').value = 'a.com\n\nb.com\n a.com ';
  d.getElementById('stopAfterMinutes').value = '30';
  d.getElementById('save').click();
  await flush();
  const payload = dom.store;
  assert(payload.autoNextPage === true, '保存写入 autoNextPage=true');
  assert(JSON.stringify(payload.autoNextSites) === JSON.stringify(['a.com', 'b.com']),
    `保存清洗白名单（实际 ${JSON.stringify(payload.autoNextSites)}）`);
  assert(payload.stopAfterMinutes === 30, '保存写入倒计时分钟数');
}
{
  // 白名单未开启时仍保存数组：不清空用户的既有配置，
  // 否则「先填后开」的顺序会导致配置丢失
  const dom = await options({ store: { autoNextSites: ['keep.com'] } });
  const d = dom.document;
  d.getElementById('save').click();
  await flush();
  assert(JSON.stringify(dom.store.autoNextSites) === JSON.stringify(['keep.com']),
    '关闭开关时仍保留白名单内容');
}
{
  // 数值钳制
  const dom = await options({});
  const input = dom.document.getElementById('stopAfterMinutes');
  input.value = '99999';
  input.dispatchEvent(new dom.MiniEvent('blur'));
  await flush();
  assert(Number(input.value) <= 480, `超上界的倒计时被钳位（实际 ${input.value}）`);
}
{
  const dom = await options({});
  const input = dom.document.getElementById('stopAfterMinutes');
  input.value = '-3';
  input.dispatchEvent(new dom.MiniEvent('blur'));
  await flush();
  assert(Number(input.value) === 0, '负数倒计时归零（视为不限时）');
}
{
  // 恢复默认：自动翻页必须回到关闭
  const dom = await options({ store: { autoNextPage: true, autoNextSites: ['x.com'], stopAfterMinutes: 30 } });
  dom.document.getElementById('reset').click();
  await flush();
  assert(dom.store.autoNextPage === false, '恢复默认后自动翻页关闭');
  assert(JSON.stringify(dom.store.autoNextSites) === JSON.stringify([]), '恢复默认后白名单清空');
  assert(dom.store.stopAfterMinutes === 0, '恢复默认后倒计时归零');
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
