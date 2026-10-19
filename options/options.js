// 设置页逻辑：读取 / 编辑 / 保存配置，并同步滑块与数值输入

// 键名约定：存储键统一使用 step（与 content/scrollEngine.js 读取的键一致）。
// 旧版本误用 speedStep，引擎读不到导致设置失效；load() 内含一次性迁移逻辑。
//
// 数值约定：所有速率与区间取自 shared/constants.js，此处不再持有本地副本。
// 新增配置项时，先确认 constants 与引擎读取端的拼写，避免数值漂移。
const C = globalThis.__SLOWSCROLL_CONSTANTS__;
if (!C) {
  console.error('[SlowScroll] shared/constants.js 未加载：扩展包不完整');
}

// 常量缺失时以0 区间进入降级态，控件全部禁用，
// 不用另一套数值静默运行——那正是「数值漂移」的来源。
const DEFAULTS = {
  defaultSpeed: C ? C.DEFAULT_SPEED : 0,
  overlayEnabled: true,
  autoHideOverlay: true,
  loopEnabled: false,
  gesturePolicy: C ? C.DEFAULT_GESTURE_POLICY : 'pause',
  rangeDwellMs: C ? C.DEFAULT_RANGE_DWELL_MS : 0,
  step: C ? C.DEFAULT_STEP : 0,
  // 自动翻页默认关闭：不可逆操作不得替用户做主
  autoNextPage: false,
  autoNextSites: [],
  stopAfterMinutes: C ? C.DEFAULT_STOP_AFTER_MINUTES : 0
};

const MIN_SPEED = C ? C.MIN_SPEED : 0;
const MAX_SPEED = C ? C.MAX_SPEED : 0;

// 策略取值必须与引擎的 GESTURE_POLICIES 一致。
// 读入非法值时回落到默认档，绝不把未知字符串透传给引擎。
const POLICIES = (C && Array.isArray(C.GESTURE_POLICIES)) ? C.GESTURE_POLICIES : ['pause', 'slowdown', 'ignore'];

function normalizePolicy(v) {
  return POLICIES.indexOf(v) !== -1 ? v : (C ? C.DEFAULT_GESTURE_POLICY : 'pause');
}

const $ = (id) => document.getElementById(id);

const els = {
  speedRange: $('defaultSpeedRange'),
  speedInput: $('defaultSpeed'),
  speedValue: $('defaultSpeedValue'),
  speedStep: $('speedStep'),
  loop: $('loopEnabled'),
  overlay: $('overlayEnabled'),
  autoHide: $('autoHideOverlay'),
  policyGroup: $('gesturePolicyGroup'),
  dwell: $('rangeDwellMs'),
  autoNext: $('autoNextPage'),
  autoNextSites: $('autoNextSites'),
  autoNextBlock: $('autoNextBlock'),
  stopAfter: $('stopAfterMinutes'),
  save: $('save'),
  reset: $('reset'),
  status: $('status')
};

let currentPolicy = DEFAULTS.gesturePolicy;

let statusTimer = null;

/* ---------- 滑块填充比例（--fill 供 CSS 渐变分界） ---------- */
function paintSlider(range) {
  const min = Number(range.min);
  const max = Number(range.max);
  const pct = ((Number(range.value) - min) / (max - min)) * 100;
  range.style.setProperty('--fill', `${pct}%`);
}

function clampSpeed(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return DEFAULTS.defaultSpeed;
  return Math.max(MIN_SPEED, Math.min(MAX_SPEED, n));
}

function setSpeed(v) {
  const speed = clampSpeed(v);
  els.speedRange.value = String(speed);
  els.speedInput.value = String(speed);
  els.speedValue.textContent = String(speed);
  paintSlider(els.speedRange);
}

function showStatus(text) {
  clearTimeout(statusTimer);
  els.status.hidden = false;
  els.status.textContent = text;
  els.status.animate?.(
    [
      { opacity: 0, transform: 'translateY(6px) scale(0.96)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ],
    { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
  );
  statusTimer = setTimeout(() => { els.status.hidden = true; }, 1800);
}

// 分段控件选中态是纯展示，唯一真源是 currentPolicy
function applyPolicy(policy) {
  currentPolicy = normalizePolicy(policy);
  if (!els.policyGroup) return;
  els.policyGroup.querySelectorAll('.segmented__item').forEach((btn) => {
    const active = btn.dataset.policy === currentPolicy;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
    // roving tabindex：整组只留一个 Tab 落点，落在当前选中项上
    btn.setAttribute('tabindex', active ? '0' : '-1');
  });
}

// role=radio 的组需支持方向键切换：roving tabindex 下整组只占一个
// Tab 位，必须能在组内用方向键移动，否则键盘用户几乎无法操作。
// 设置页与 popup 用同一套键位映射，保持两处行为一致。
const POLICY_KEYS = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowDown: 1
};

function bindPolicyKeyboard(items) {
  items.forEach((btn, index) => {
    btn.addEventListener('keydown', (e) => {
      const step = POLICY_KEYS[e.key];
      if (step === undefined) return;
      e.preventDefault();
      const next = items[(index + step + items.length) % items.length];
      if (!next) return;
      next.focus();
      applyPolicy(next.dataset.policy);
    });
  });
}

function clampDwell(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULTS.rangeDwellMs;
  return Math.max(C ? C.MIN_RANGE_DWELL_MS : 0, Math.min(C ? C.MAX_RANGE_DWELL_MS : 0, n));
}

/* ---------- 自动翻页 ---------- */
// 白名单是逐行/逗号分隔的自由文本。这里只做拆分与清洗，
// 真正的准入判断在引擎（引擎是唯一生效点，脏数据不该越过它的闸门）。
function parseSites(text) {
  const raw = String(text == null ? '' : text);
  const list = raw.split(/[\n\r,，;；]+/);
  const out = [];
  for (const item of list) {
    const s = item.trim().toLowerCase();
    if (!s || out.indexOf(s) !== -1) continue;
    out.push(s);
    if (C && C.AUTO_NEXT_MAX_SITES && out.length >= C.AUTO_NEXT_MAX_SITES) break;
  }
  return out;
}

function formatSites(list) {
  return Array.isArray(list) ? list.join('\n') : '';
}

function applyAutoNext() {
  if (!els.autoNext) return;
  // 白名单输入框只在开启时才露出：关闭状态下它是一个无效配置，
  // 常驻会让用户以为填了就生效
  if (els.autoNextBlock) els.autoNextBlock.hidden = !els.autoNext.checked;
}

function clampStopAfter(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(C ? C.MIN_STOP_AFTER_MINUTES : 0, Math.min(C ? C.MAX_STOP_AFTER_MINUTES : 0, Math.round(n)));
}

function applyToForm(items) {
  setSpeed(items.defaultSpeed);
  els.speedStep.value = String(items.step ?? DEFAULTS.step);
  els.loop.checked = !!items.loopEnabled;
  els.overlay.checked = !!items.overlayEnabled;
  els.autoHide.checked = !!items.autoHideOverlay;
  applyPolicy(items.gesturePolicy);
  if (els.dwell) els.dwell.value = String(clampDwell(items.rangeDwellMs));
  if (els.autoNext) els.autoNext.checked = !!items.autoNextPage;
  if (els.autoNextSites) els.autoNextSites.value = formatSites(items.autoNextSites);
  applyAutoNext();
  if (els.stopAfter) els.stopAfter.value = String(clampStopAfter(items.stopAfterMinutes));
}

function collectForm() {
  return {
    defaultSpeed: clampSpeed(els.speedRange.value),
    step: Math.max(
      C ? C.MIN_STEP : 0,
      Math.min(C ? C.MAX_STEP : 0, Number(els.speedStep.value) || DEFAULTS.step)
    ),
    loopEnabled: !!els.loop.checked,
    gesturePolicy: currentPolicy,
    rangeDwellMs: els.dwell ? clampDwell(els.dwell.value) : DEFAULTS.rangeDwellMs,
    overlayEnabled: !!els.overlay.checked,
    autoHideOverlay: !!els.autoHide.checked,
    autoNextPage: !!(els.autoNext && els.autoNext.checked),
    autoNextSites: els.autoNextSites ? parseSites(els.autoNextSites.value) : [],
    stopAfterMinutes: els.stopAfter ? clampStopAfter(els.stopAfter.value) : 0
  };
}

/* ---------- 把常量应用到 HTML 表单 ----------
   区间与步进范围只在 constants.js 定义一次，此处同步到控件，
   避免调整范围时需要同时改 HTML 与 JS。 */
function applyConstantsToForm() {
  if (!C) return;
  for (const el of [els.speedRange, els.speedInput]) {
    el.min = String(C.MIN_SPEED);
    el.max = String(C.MAX_SPEED);
    el.step = String(C.SPEED_GRANULARITY);
  }
  els.speedStep.min = String(C.MIN_STEP);
  els.speedStep.max = String(C.MAX_STEP);
  els.speedStep.step = String(C.SPEED_GRANULARITY);

  if (els.dwell) {
    els.dwell.min = String(C.MIN_RANGE_DWELL_MS);
    els.dwell.max = String(C.MAX_RANGE_DWELL_MS);
    els.dwell.step = String(C.SPEED_GRANULARITY);
  }

  if (els.stopAfter) {
    els.stopAfter.min = '0';
    els.stopAfter.max = String(C.MAX_STOP_AFTER_MINUTES);
    els.stopAfter.step = '5';
  }

  // 刻度标签同样跟随区间，避免出现写着 4000 实际最大 3000 的情况
  const scale = document.querySelectorAll('.speed-control__scale span');
  const ticks = [C.MIN_SPEED, 1000, 2000, 3000, C.MAX_SPEED];
  scale.forEach((span, i) => {
    if (ticks[i] != null) span.textContent = String(ticks[i]);
  });
}

function load() {
  // 兼容旧键名speedStep：读到旧值且新键仍是默认值时迁移
  chrome.storage.sync.get({ ...DEFAULTS, speedStep: null }, (items) => {
    if (chrome.runtime.lastError) {
      console.warn('[SlowScroll] 读取设置失败', chrome.runtime.lastError);
      applyToForm(DEFAULTS);
      return;
    }
    if (items.speedStep != null && items.step === DEFAULTS.step) {
      items.step = Math.max(C ? C.MIN_STEP : 0, Number(items.speedStep) || DEFAULTS.step);
    }
    applyToForm(items);
  });
}

function save() {
  const payload = collectForm();
  chrome.storage.sync.set(payload, () => {
    if (chrome.runtime.lastError) {
      showStatus('保存失败：存储空间不足');
      return;
    }
    showStatus('设置已保存');
  });
}

function resetToDefaults() {
  applyToForm(DEFAULTS);
  chrome.storage.sync.set(DEFAULTS, () => {
    if (chrome.runtime.lastError) {
      showStatus('恢复失败：存储空间不足');
      return;
    }
    showStatus('已恢复默认设置');
  });
}

function bindUI() {
  els.speedRange.addEventListener('input', (e) => setSpeed(e.target.value));
  els.speedInput.addEventListener('input', (e) => {
    if (e.target.value === '') return;
    const speed = clampSpeed(e.target.value);
    els.speedRange.value = String(speed);
    els.speedValue.textContent = String(speed);
    paintSlider(els.speedRange);
  });
  // 失焦时归一化，避免残留超范围数值
  els.speedInput.addEventListener('blur', () => setSpeed(els.speedInput.value));

  // 停留时长失焦归一化
  els.dwell?.addEventListener('blur', () => {
    els.dwell.value = String(clampDwell(els.dwell.value));
  });

  // 自动翻页开关即时显隐白名单输入框
  els.autoNext?.addEventListener('change', applyAutoNext);

  els.stopAfter?.addEventListener('blur', () => {
    els.stopAfter.value = String(clampStopAfter(els.stopAfter.value));
  });

  // 手势策略分段控件
  const policyItems = els.policyGroup
    ? Array.from(els.policyGroup.querySelectorAll('.segmented__item'))
    : [];
  policyItems.forEach((btn) => {
    btn.addEventListener('click', () => applyPolicy(btn.dataset.policy));
  });
  bindPolicyKeyboard(policyItems);

  els.save.addEventListener('click', save);
  els.reset.addEventListener('click', resetToDefaults);

  // Cmd/Ctrl + S 保存
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });
}

/* ---------- 降级态：常量缺失时明示异常并禁用保存 ---------- */
function showBrokenState() {
  if (els.status) {
    els.status.hidden = false;
    els.status.textContent = '扩展文件不完整，shared/constants.js 未加载';
    els.status.classList.add('toast--error');
  }
  document.querySelectorAll('input, .btn').forEach((el) => {
    el.disabled = true;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if (!C) {
    showBrokenState();
    return;
  }
  bindUI();
  applyConstantsToForm();
  load();
  paintSlider(els.speedRange);
});