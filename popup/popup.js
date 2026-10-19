// popup 逻辑：查询状态、渲染视图、发送控制命令
// 设计约定：所有渲染集中于 render()，保证 UI 与引擎状态单向同步

(function () {
  'use strict';

  /* ============================================================
     全局常量：唯一来源 shared/constants.js
     缺失即视为扩展包不完整，直接进入降级态并明示错误，
     不用另一套数值静默运行——那正是「数值漂移」的来源。
     ============================================================ */
  const C = globalThis.__SLOWSCROLL_CONSTANTS__;
  if (!C) {
    console.error('[SlowScroll] shared/constants.js 未加载：扩展包不完整');
  }

  const FALLBACK_STATE = {
    isScrolling: false,
    isPaused: false,
    speed: 0,
    effectiveSpeed: 0,
    slowed: false,
    gesturePolicy: 'pause',
    loopEnabled: false,
    loopCount: 0,
    progress: 0,
    remaining: 0,
    rangeStart: null,
    rangeEnd: null,
    rangeActive: false,
    rangeDwellMs: 3000,
    containerIssue: null,
    autoNextEnabled: false,
    autoNextSites: [],
    autoNextArmed: null,
    autoNextCount: 0,
    stopAfterMinutes: 0,
    stopAfterRemainingMs: 0
  };

  const $ = (id) => document.getElementById(id);

  let currentState = { ...FALLBACK_STATE };

  /* ---------- 消息发送 ----------
   必须带超时：Service Worker 被回收后重新冷启动、或页面正在导航时，
   sendMessage 可能长时间不返回。没有超时的话 popup 会一直停在旧状态，
   用户表现为「点了没反应」。 */
  function sendMessage(msg) {
    const timeoutMs = C ? C.MESSAGE_TIMEOUT_MS : 300;
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage({ from: 'popup', ...msg }, (resp) => {
          // 必须读取 lastError，否则 Service Worker 休眠/页面跳转时控制台抛未检查错误
          void chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(resp);
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  /* ---------- 状态采纳 ----------
     广播与命令响应都从这里进入，两条路径都可能乱序到达：
     连续快速点击时，先发的命令可能后返回，把新状态覆盖成旧状态。
     background 为每次广播分配单调递增的 seq（tabId 维度），
     这里丢弃比已采纳快照更旧的更新。

     tabId 一并参与比对：popup 属于某个具体标签页，
     其他标签页的广播与本 popup 无关，必须忽略。 */
  let lastSeq = 0;
  let lastTabId = null;

  function shouldAdopt(payload, seq, tabId) {
    if (tabId != null && lastTabId != null && tabId !== lastTabId) return false;
    if (typeof seq !== 'number') return true;   // 无 seq 的响应：无法判定顺序，放行
    if (typeof lastSeq === 'number' && seq < lastSeq) return false;
    return true;
  }

  function adopt(payload, seq, tabId) {
    if (!payload) return false;
    if (!shouldAdopt(payload, seq, tabId)) return false;
    if (typeof seq === 'number') lastSeq = seq;
    if (tabId != null) lastTabId = tabId;
    render(payload);
    return true;
  }

  async function queryState() {
    const resp = await sendMessage({ type: 'QUERY_STATE' });
    return resp;
  }

  /* ---------- 滑块填充比例 ---------- */
  function paintSlider(range) {
    const min = Number(range.min);
    const max = Number(range.max);
    const pct = ((Number(range.value) - min) / (max - min)) * 100;
    range.style.setProperty('--fill', `${pct}%`);
  }

  /* ---------- 滑块区间以常量为唯一来源 ----------
     HTML 上的 min/max 仅为无 JS 时的静态兜底，此处按常量覆写，
     避免调整范围时需要同时改 HTML 与 JS 两处。 */
  function applySpeedRange() {
    if (!C) return;
    const range = $('speedRange');
    if (!range) return;
    range.min = String(C.MIN_SPEED);
    range.max = String(C.MAX_SPEED);
    range.step = String(C.SPEED_GRANULARITY);
  }

  function applyDwellRange() {
    if (!C) return;
    const range = $('rangeDwell');
    if (!range) return;
    range.min = String(C.MIN_RANGE_DWELL_MS);
    range.max = String(C.MAX_RANGE_DWELL_MS);
    range.step = String(C.SPEED_GRANULARITY);
  }

  // 倒计时的范围同样以常量为唯一来源，与设置页保持一致
  function applyStopAfterRange() {
    if (!C) return;
    const input = $('stopAfterMinutes');
    if (!input) return;
    input.min = '0';
    input.max = String(C.MAX_STOP_AFTER_MINUTES);
  }

  /* ---------- 手势策略文案 ---------- */
  const POLICY_HINTS = {
    pause: '你一滚滚轮，滚动就停下',
    slowdown: '手动滚动时临时减速，停下后自动恢复',
    ignore: '始终自动滚动，不响应手动操作'
  };

  /* ---------- 分段控件键盘导航 ----------
     role=radio 的组必须能用方向键切换，否则键盘用户只能靠 Tab
     逐个走一遍（且 Tab 落在未选中项上，语义不对）。
     采用 roving tabindex：整组只占一个 Tab 位，方向键在组内移动，
     移动即选中——与原生 radio 行为一致。

     注意：renderPolicy 会把 tabindex 收敛到选中项，
     因此这里移动后需调用它刷新，避免与渲染逻辑打架。 */
  const POLICY_KEYS = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -1,
    ArrowDown: 1
  };

  function bindSegmentedKeyboard(items) {
    items.forEach((btn, index) => {
      btn.addEventListener('keydown', (e) => {
        const step = POLICY_KEYS[e.key];
        if (step === undefined) return;
        e.preventDefault();
        const next = items[(index + step + items.length) % items.length];
        if (!next) return;
        next.focus();
        dispatch(
          { type: 'SET_GESTURE_POLICY', payload: { policy: next.dataset.policy, persist: true } },
          { gesturePolicy: next.dataset.policy }
        );
      });
    });
  }

  /* ---------- 单一渲染入口 ---------- */
  function render(state) {
    currentState = { ...currentState, ...state };

    const running = !!currentState.isScrolling;
    const paused = !!currentState.isPaused;

    // 运行态：body 类驱动图标与配色切换
    document.body.classList.toggle('is-running', running);
    document.body.classList.toggle('is-paused', paused);

    const startStop = $('startStop');
    startStop.setAttribute('aria-pressed', String(running));
    $('startStopLabel').textContent = running ? '停止滚动' : '开始滚动';

    $('pauseResume').setAttribute('aria-pressed', String(paused));
    $('pauseResumeLabel').textContent = paused ? '继续' : '暂停';
    $('pauseResume').disabled = !running;

    // 状态文本三态：停止 / 运行中 / 已暂停
    const stateText = paused ? '已暂停' : (running ? '运行中' : '已停止');
    $('stateText').textContent = stateText;

    const badge = $('stateBadge');
    badge.textContent = stateText;
    badge.classList.toggle('badge--live', running && !paused);

    renderProgress();
    renderSpeed();
    renderPolicy();
    renderRange();
    renderAuto();

    // 循环
    $('loopToggle').checked = !!currentState.loopEnabled;

    // 循环计数
    const hint = $('loopCount');
    if (currentState.loopEnabled && currentState.loopCount > 0) {
      hint.hidden = false;
      hint.textContent = `已循环 ${currentState.loopCount} 次`;
    } else {
      hint.hidden = true;
    }
  }

  /* ---------- 滚动进度 ----------
     百分比与剩余像素来自引擎快照（已按 500ms 节流上报）。
     这里只做格式化，不自行读取 DOM 滚动位置——引擎才知道真正的滚动容器。 */
  function renderProgress() {
    const pct = Math.max(0, Math.min(1, Number(currentState.progress) || 0));
    const percent = Math.round(pct * 100);
    $('progressPercent').textContent = `${percent}%`;
    $('progressRemaining').textContent = `剩余 ${formatRemaining(currentState.remaining)}`;

    const bar = $('progressBar');
    // 宽度走 CSS 变量而非内联 style，保持「禁止内联样式」约定
    bar.style.setProperty('--pct', `${pct * 100}%`);
    bar.setAttribute('aria-valuenow', String(percent));
  }

  // 剩余量大时用「k」，避免 popup 里出现 7 位数字挤爆布局
  function formatRemaining(px) {
    const n = Math.max(0, Math.round(Number(px) || 0));
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k px`;
    return `${n} px`;
  }

  /* ---------- 容器失败原因 ----------
     引擎在连续扫描失败后诊断出原因并透出，这里只负责翻译成人话。
     文案与悬浮条保持一致，避免两个入口说法不同让用户以为是两个问题。 */
  const ISSUE_TEXTS = {
    'no-content': '本页无可滚动内容',
    'virtual-list': '页面疑似虚拟列表，无法滚动'
  };

  function renderContainerIssue() {
    const el = $('containerIssue');
    if (!el) return;
    const issue = currentState.containerIssue;
    const text = ISSUE_TEXTS[issue] || '';
    el.hidden = !text;
    if (text) el.textContent = text;
  }

  /* ---------- 自动翻页与定时停 ----------
     折叠区的标题行必须常驻显示状态，否则用户得展开才知道开没开。 */
  function renderAuto() {
    renderContainerIssue();

    const enabled = !!currentState.autoNextEnabled;
    const armed = currentState.autoNextArmed;
    const sites = Array.isArray(currentState.autoNextSites) ? currentState.autoNextSites : [];
    const minutes = Math.max(0, Number(currentState.stopAfterMinutes) || 0);

    const toggle = $('autoNextToggle');
    if (toggle) toggle.checked = enabled;

    // 白名单输入框只在用户聚焦时不回写，避免打断正在输入的光标
    const sitesEl = $('autoNextSites');
    if (sitesEl && document.activeElement !== sitesEl) {
      const next = sites.join('\n');
      if (sitesEl.value !== next) sitesEl.value = next;
    }

    const hint = $('autoNextHint');
    if (hint) {
      if (armed) hint.textContent = `即将翻到「${armed}」，滚动可取消`;
      else if (!enabled) hint.textContent = '关闭';
      else if (sites.length === 0) hint.textContent = '已开启 · 不限站点';
      else hint.textContent = `已开启 · ${sites.length} 个站点`;
    }

    const minutesEl = $('stopAfterMinutes');
    if (minutesEl && document.activeElement !== minutesEl) {
      const next = String(minutes);
      if (minutesEl.value !== next) minutesEl.value = next;
    }

    // 剩余时间只在会话进行中才有意义
    const left = $('stopAfterLeft');
    if (left) {
      const remaining = Math.max(0, Number(currentState.stopAfterRemainingMs) || 0);
      left.textContent = (minutes > 0 && currentState.isScrolling && remaining > 0)
        ? formatCountdown(remaining)
        : '';
    }

    const status = $('autoStatus');
    if (status) {
      if (enabled) status.textContent = armed ? '即将翻页' : '翻页已开';
      else if (minutes > 0) status.textContent = `${minutes} 分钟后停`;
      else status.textContent = '未开启';
    }
  }

  // 倒计时格式：不足 1 分钟显示秒，其余显示 mm:ss
  function formatCountdown(ms) {
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m <= 0) return `${s}s`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function renderSpeed() {
    $('speedLabel').textContent = String(currentState.speed);
    const speedRange = $('speedRange');
    if (Number(speedRange.value) !== Number(currentState.speed)) {
      speedRange.value = String(currentState.speed);
    }
    paintSlider(speedRange);

    // 降速态下用户设定值与实际值不同，必须显式说明，否则会以为调速失灵
    const note = $('speedNote');
    const slowed = !!currentState.slowed;
    note.hidden = !slowed;
    if (slowed) {
      note.textContent = `手势降速中，当前实际 ${Math.round(currentState.effectiveSpeed || 0)} px/s`;
    }
  }

  function renderPolicy() {
    const policy = currentState.gesturePolicy || 'pause';
    document.querySelectorAll('.segmented__item').forEach((btn) => {
      const active = btn.dataset.policy === policy;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', String(active));
      // roving tabindex：整组只留一个 Tab 落点，落在当前选中项上
      btn.setAttribute('tabindex', active ? '0' : '-1');
    });
    $('policyHint').textContent = POLICY_HINTS[policy] || POLICY_HINTS.pause;
  }

  function renderRange() {
    const { rangeStart, rangeEnd, rangeActive, rangeDwellMs } = currentState;
    const hasStart = rangeStart != null;
    const hasEnd = rangeEnd != null;

    const status = $('rangeStatus');
    if (rangeActive) {
      status.textContent = '循环中';
    } else if (hasStart && hasEnd) {
      status.textContent = '区间无效';
    } else if (hasStart) {
      status.textContent = '已设起点';
    } else if (hasEnd) {
      status.textContent = '已设终点';
    } else {
      status.textContent = '未设置';
    }

    $('clearRange').disabled = !hasStart && !hasEnd;

    // 停留时长只在区间真正可用时才显示：单锚点状态下无从谈起
    const dwellRow = $('dwellRow');
    dwellRow.hidden = !rangeActive;
    if (rangeActive) {
      const slider = $('rangeDwell');
      if (Number(slider.value) !== Number(rangeDwellMs)) slider.value = String(rangeDwellMs);
      paintSlider(slider);
      $('rangeDwellValue').textContent = `${(Number(rangeDwellMs) / 1000).toFixed(1)}s`;
    }
  }

  /* ---------- 速度滑块节流 ----------
     input 事件在拖动时每秒可触发数十次，若每次都发消息，
     background 侧会连带做一次脚本探测/注入，开销与延迟都不必要。
     这里拖动中只做本地反馈，节流提交；松手（change）时立即提交终值。 */
  const SPEED_THROTTLE_MS = 120;

  function createThrottledSubmit(fn, wait) {
    let timer = null;
    let pending = null;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending !== null) {
        const value = pending;
        pending = null;
        fn(value);
      }
    };

    return (value) => {
      pending = value;
      if (timer) return;
      timer = setTimeout(flush, wait);
    };
  }

  /* ---------- 命令下发 ----------
     每个操作都是「乐观更新 + 发出命令」，不再回读一次 queryState。

     原先每次点击都要「发命令 → 再发一次查询 → 渲染」，多一次跨进程往返；
     更糟的是它制造了竞态：连续快速点击时，先发的查询可能后返回，
     把已经更新的界面覆盖回旧值（表现为点两下开关又弹回去了）。
     引擎在任何状态变化后都会经 background 广播权威快照，
     界面据此收敛即可，本地先按预期结果渲染保证即时反馈。 */
  function dispatch(msg, optimistic) {
    if (optimistic) render(optimistic);
    return sendMessage(msg);
  }

  function bindUI() {
    $('startStop').addEventListener('click', () => {
      const next = !currentState.isScrolling;
      dispatch(
        { type: 'TOGGLE_START_STOP' },
        // 两种情形都要解除暂停：开始时 startScrolling 会重置 isPaused；
        // 停止时 stopScrolling 同样会重置。保留旧值会让界面卡在「已暂停」，
        // 而引擎其实已经停了。
        { isScrolling: next, isPaused: false }
      );
    });

    $('pauseResume').addEventListener('click', () => {
      if (!currentState.isScrolling) return;
      dispatch({ type: 'TOGGLE_PAUSE_RESUME' }, { isPaused: !currentState.isPaused });
    });

    const submitSpeed = createThrottledSubmit(async (speed) => {
      await sendMessage({ type: 'SET_SPEED', payload: { speed, persist: true } });
    }, SPEED_THROTTLE_MS);

    const speedRange = $('speedRange');

    speedRange.addEventListener('input', (e) => {
      // 拖动中本地即时反馈，避免网络往返造成的迟滞
      paintSlider(e.target);
      $('speedLabel').textContent = e.target.value;
      submitSpeed(Number(e.target.value));
    });

    // 松手时立刻提交最终值，避免节流窗口内关闭 popup 丢失末次调整
    speedRange.addEventListener('change', (e) => {
      const speed = Number(e.target.value);
      dispatch({ type: 'SET_SPEED', payload: { speed, persist: true } }, { speed });
    });

    $('loopToggle').addEventListener('change', (e) => {
      dispatch(
        { type: 'SET_LOOP', payload: { enabled: e.target.checked, persist: true } },
        { loopEnabled: e.target.checked }
      );
    });

    /* ---------- 手势策略分段控件 ----------
       用 radiogroup + role=radio 而非原生 radio，样式完全由 CSS 控制，
       键盘方向键切换由 bindSegmentedKeyboard 补齐。 */
    const policyItems = Array.from(document.querySelectorAll('.segmented__item'));
    policyItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        dispatch(
          { type: 'SET_GESTURE_POLICY', payload: { policy: btn.dataset.policy, persist: true } },
          { gesturePolicy: btn.dataset.policy }
        );
      });
    });
    bindSegmentedKeyboard(policyItems);

    /* ---------- 区间锚点 ----------
       标记动作发给当前标签页的引擎，引擎读自己的 scrollTop 记录锚点。
       锚点是页面级状态，跨页面没有意义，故不写入 storage。
       锚点位置由引擎计算后广播，这里不做乐观更新 ——
       猜一个假位置会让界面显示与实际滚动位置不符。 */
    $('markStart').addEventListener('click', () => {
      sendMessage({ type: 'CAPTURE_ANCHOR', payload: { which: 'start' } });
    });

    $('markEnd').addEventListener('click', () => {
      sendMessage({ type: 'CAPTURE_ANCHOR', payload: { which: 'end' } });
    });

    $('clearRange').addEventListener('click', () => {
      // 清空是纯本地可推导的终态，可以乐观更新
      dispatch({ type: 'CLEAR_RANGE' }, { rangeStart: null, rangeEnd: null, rangeActive: false });
    });

    const dwellRange = $('rangeDwell');
    const submitDwell = createThrottledSubmit(async (ms) => {
      await sendMessage({ type: 'SET_RANGE_DWELL', payload: { ms } });
    }, SPEED_THROTTLE_MS);

    dwellRange.addEventListener('input', (e) => {
      paintSlider(e.target);
      $('rangeDwellValue').textContent = `${(Number(e.target.value) / 1000).toFixed(1)}s`;
      submitDwell(Number(e.target.value));
    });
    dwellRange.addEventListener('change', (e) => {
      const ms = Number(e.target.value);
      dispatch({ type: 'SET_RANGE_DWELL', payload: { ms } }, { rangeDwellMs: ms });
    });

    $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  }

  /* ---------- 自动翻页与定时停 ----------
     白名单是「换行分隔」的纯文本，提交前拆成数组；
     输入过程中不提交，只在 change（失焦）时落盘，
     否则每敲一个字符就写一次 storage.sync，会撞上每分钟 120 次的写入配额。 */
  function parseSites(text) {
    const out = [];
    const list = String(text || '').split(/[\n\r,，;；\s]+/);
    for (const item of list) {
      const s = item.trim().toLowerCase();
      if (!s || out.indexOf(s) !== -1) continue;
      out.push(s);
    }
    return out;
  }

  function bindAutoUI() {
    $('autoNextToggle')?.addEventListener('change', (e) => {
      dispatch(
        { type: 'SET_AUTO_NEXT', payload: { enabled: e.target.checked, persist: true } },
        { autoNextEnabled: e.target.checked }
      );
    });

    $('autoNextSites')?.addEventListener('change', (e) => {
      const sites = parseSites(e.target.value);
      dispatch(
        { type: 'SET_AUTO_NEXT_SITES', payload: { sites, persist: true } },
        { autoNextSites: sites }
      );
    });

    const minutesEl = $('stopAfterMinutes');
    if (minutesEl) {
      const submit = (minutes) => {
        dispatch(
          { type: 'SET_STOP_AFTER', payload: { minutes, persist: true } },
          { stopAfterMinutes: minutes }
        );
      };
      // 失焦时提交一次即可：数字输入的每次按键都写存储没有必要，
      // 而 change 事件已经覆盖了「改完就走」的真实路径
      minutesEl.addEventListener('change', (e) => submit(Number(e.target.value) || 0));
    }
  }

  /* ---------- 实时状态订阅 ----------
     快捷键与页面悬浮条都能改变滚动状态，若只在打开时取一次快照，
     用户在 popup 打开期间用快捷键操作，这里会一直显示旧值。
     background 在收到 STATE_UPDATE 时广播，此处订阅即可保持同步。
     seq 过滤在这里生效：乱序到达的旧广播被丢弃，不会覆盖更新的状态。 */
  function subscribeState() {
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'STATE_BROADCAST' && message.payload) {
          adopt(message.payload, message.seq, message.tabId);
        }
      });
    } catch (e) {
      console.warn('[SlowScroll] 状态订阅失败', e);
    }
  }

  /* ---------- 降级态：常量缺失时明示异常而非静默跑偏 ---------- */
  function showBrokenState() {
    const badge = $('stateBadge');
    const text = $('stateText');
    if (badge) {
      badge.textContent = '异常';
      badge.classList.remove('badge--live');
    }
    if (text) text.textContent = '扩展文件不完整';
    document.querySelectorAll('.btn, .slider, .switch input').forEach((el) => {
      el.disabled = true;
    });
  }

  (async function init(){
    if (!C) {
      showBrokenState();
      return;
    }
    applySpeedRange();
    applyDwellRange();
    applyStopAfterRange();
    bindUI();
    bindAutoUI();
    subscribeState();
    const resp = await queryState();
    // 初始快照没有 seq 语义的竞争者，但若此时已收到更新的广播，
    // adopt 会按 seq 判定该用哪一份
    adopt(resp?.payload, resp?.seq, resp?.tabId);
  })();
})();
