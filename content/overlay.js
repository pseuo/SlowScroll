// 悬浮控件：注入控制条与到底提示
// 设计约定：DOM 结构与 content/overlay.css 严格对应，勿单独改动类名

(function(){
  /* ============================================================
     非 HTML 文档守卫
     matches 为 <all_urls>，会命中 SVG / XML / 图片查看器。
     这些文档里 document.createElement 产出的是普通 Element，
     没有 style 属性，document.body 为 null，注入悬浮条必然抛错。
     判定函数来自 shared/constants.js，与引擎共用同一真源。
     ============================================================ */
  if (typeof globalThis.__SLOWSCROLL_IS_HTML_DOC__ !== 'function'
      || !globalThis.__SLOWSCROLL_IS_HTML_DOC__(document)) {
    console.log('[SlowScroll] overlay skipped: not an HTML document');
    return;
  }

  /* ============================================================
     顶层 frame 守卫
     all_frames 打开后，悬浮条脚本也会进入每个 iframe。
     但控制条是「整页级」控件：每个 frame 各挂一条，
     用户会在 iframe 内部看到一堆悬浮控件，且互相独立、状态割裂。

     故只在顶层文档挂载一条。iframe 内的滚动由顶层悬浮条
     经 background 定向到活动 frame 的引擎来驱动（见 background 路由），
     用户看到的是一条始终位于页面右下角的控制条。

     判定用 window.top === window.self：跨域 iframe 读取 window.top
     的属性会抛安全错误，但比较引用本身始终安全，无需 try/catch 之外的判断。
     ============================================================ */
  if (window.top !== window.self) {
    console.log('[SlowScroll] overlay skipped: not top frame');
    return;
  }

  /* ============================================================
     常量：唯一来源 shared/constants.js
     悬浮条只读取不修改，缺失时按「关闭自动隐藏 + 回落默认值」降级，
     不抛错——content 两端行为不对称会让故障排查变困难。
     ============================================================ */
  const CONSTANTS = globalThis.__SLOWSCROLL_CONSTANTS__ || {};

  // 检查是否已经初始化
  if (window.__slowScrollOverlay) {
    console.log('[SlowScroll] overlay already initialized');
    return;
  }

  const STYLE_ID = 'slowScroll-overlay-style';

  /* ============================================================
     自动隐藏状态机
     开始滚动 → 延迟 OVERLAY_HIDE_DELAY_MS 后收起控制条；
     鼠标移入右下角热区或按 Esc → 唤回；若仍在滚动，移开后再延迟收起。

     不用内联样式（content 端硬约束），显隐一律由 .is-hidden class 驱动。
     热区用坐标判定而非实体元素：放置一个透明 div 会吞掉宿主页面
     右下角的点击，坐标判定零副作用。
     ============================================================ */
  const autoHide = {
    enabled: true,        // 由设置页 autoHideOverlay 决定
    hidden: false,        // 当前是否处于收起态
    hovered: false,       // 指针是否悬停在控制条上
    pointerInZone: false, // 指针是否在右下角热区内
    wasScrolling: false,  // 上一次的滚动态，用于捕捉 false → true 的跳变
    hideTimer: null,      // 开始滚动后的延迟收起
    idleTimer: null       // 唤回/移开后的闲置收起
  };

  function cancelAutoHideTimers() {
    if (autoHide.hideTimer) { clearTimeout(autoHide.hideTimer); autoHide.hideTimer = null; }
    if (autoHide.idleTimer) { clearTimeout(autoHide.idleTimer); autoHide.idleTimer = null; }
  }

  function setHidden(next) {
    if (autoHide.hidden === !!next) return;
    autoHide.hidden = !!next;
    const root = document.getElementById('slowScroll-overlay');
    if (root) root.classList.toggle('is-hidden', autoHide.hidden);
  }

  /* 指针是否「在场」。
     必须同时看两个信号：hovered 来自 panel 的 mouseenter，
     pointerInZone 来自全局坐标判定。用户把鼠标停在右下角唤回时，
     两者都成立；此时若只看 hovered，2.5s 后控制条会在用户手底下
     自行消失——鼠标还压在它上面，却什么都点不到。 */
  function isPointerPresent() {
    return autoHide.hovered || autoHide.pointerInZone;
  }

  function isScrollingNow() {
    const e = window.__slowScrollEngine;
    return !!(e && typeof e.getState === 'function' && e.getState().isScrolling);
  }

  // 闲置收起：仅在仍处于滚动中时才有意义
  function scheduleIdleHide() {
    if (autoHide.idleTimer) { clearTimeout(autoHide.idleTimer); autoHide.idleTimer = null; }
    if (!autoHide.enabled || !isScrollingNow()) return;
    autoHide.idleTimer = setTimeout(() => {
      autoHide.idleTimer = null;
      if (!isPointerPresent()) setHidden(true);
    }, CONSTANTS.OVERLAY_REHIDE_IDLE_MS);
  }

  function revealOverlay() {
    cancelAutoHideTimers();
    if (!autoHide.hidden) return;
    setHidden(false);
    // 唤回后若引擎仍在滚动，重新计时收起，避免控制条长时间压在内容上。
    // 指针此刻多半就停在热区里，计时器到点会因 isPointerPresent 而放弃收起
    scheduleIdleHide();
  }

  // 开始滚动后的延迟收起
  function scheduleHide() {
    if (!autoHide.enabled || autoHide.hidden) return;
    if (autoHide.hideTimer) clearTimeout(autoHide.hideTimer);
    autoHide.hideTimer = setTimeout(() => {
      autoHide.hideTimer = null;
      if (!isPointerPresent()) setHidden(true);
    }, CONSTANTS.OVERLAY_HIDE_DELAY_MS);
  }

  function cancelScheduledHide() {
    if (autoHide.hideTimer) { clearTimeout(autoHide.hideTimer); autoHide.hideTimer = null; }
  }

  // 滚动态跳变时驱动隐藏/取消隐藏
  function syncAutoHideWithState(isScrolling) {
    if (!autoHide.enabled) {
      cancelAutoHideTimers();
      setHidden(false);
      autoHide.wasScrolling = !!isScrolling;
      return;
    }
    if (!isScrolling) {
      cancelAutoHideTimers();
      // 停止后不主动弹回：用户已明确接管，弹回等于打断阅读。
      // 需要时用热区 / Esc 唤回，或从 popup 控制
      autoHide.wasScrolling = false;
      return;
    }
    if (!autoHide.wasScrolling) {
      scheduleHide();          // 刚开始滚动 → 延迟收起
    }
    autoHide.wasScrolling = true;
  }

  // 右下角热区：坐标判定，不插入任何 DOM
  function isPointerInRevealZone(e) {
    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    const size = CONSTANTS.OVERLAY_REVEAL_ZONE_SIZE;
    return e.clientX >= w - size && e.clientY >= h - size;
  }

  function bindAutoHide(root) {
    const panel = root.querySelector('.panel');
    if (panel) {
      panel.addEventListener('mouseenter', () => {
        autoHide.hovered = true;
        // 指针在场就取消一切待执行的收起
        cancelAutoHideTimers();
        if (!autoHide.hidden) revealOverlay();
      });
      panel.addEventListener('mouseleave', () => {
        autoHide.hovered = false;
        // 离开后若仍在滚动，重新计时收起
        if (!autoHide.pointerInZone) scheduleIdleHide();
      });
      // 键盘焦点进入控制条等同于悬停：Tab 到收起态的按钮时先唤回，
      // 否则用户会在看不见的控件上盲目操作
      panel.addEventListener('focusin', () => {
        autoHide.hovered = true;
        revealOverlay();
      });
      panel.addEventListener('focusout', () => { autoHide.hovered = false; });
    }

    window.addEventListener('mousemove', (e) => {
      if (!autoHide.enabled) return;
      const wasInZone = autoHide.pointerInZone;
      const inZone = isPointerInRevealZone(e);
      autoHide.pointerInZone = inZone;

      // 刚进入热区且当前收起 → 唤回。用状态跳变而非持续判定，
      // 避免指针停在热区内时反复重置收起计时
      if (inZone && !wasInZone && autoHide.hidden) {
        revealOverlay();
        return;
      }
      // 离开热区且不在控制条上 → 若仍展开则开始闲置收起计时
      if (wasInZone && !inZone && !autoHide.hidden && !autoHide.hovered) {
        scheduleIdleHide();
      }
    }, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (!autoHide.enabled || !autoHide.hidden) return;
      if (e.key !== 'Escape') return;
      // 不 preventDefault：Esc 在宿主页面常有其他语义（关弹窗等），
      // 只做「唤回」这一件事，不抢页面的按键行为
      revealOverlay();
    }, true);
  }

  // 内联 SVG 图标（避免额外网络请求与字体闪烁）
  const ICON = {
    play: '<svg class="icon-play" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6a1 1 0 0 0 1.53.85l10.6-6.8a1 1 0 0 0 0-1.7L9.53 4.35A1 1 0 0 0 8 5.2Z"/></svg>',
    stop: '<svg class="icon-stop" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.2"/></svg>',
    top: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V6"/><path d="m6 12 6-6 6 6"/></svg>',
    loop: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11a9 9 0 0 1 15.5-6.2L21 7"/><path d="M21 3v4h-4"/><path d="M21 13a9 9 0 0 1-15.5 6.2L3 17"/><path d="M3 21v-4h4"/></svg>',
    range: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5v14"/><path d="M20 5v14"/><path d="M8 12h8"/><path d="m11 9-3 3 3 3"/><path d="m13 9 3 3-3 3"/></svg>'
  };

  // overlay.css 已由 manifest 的 content_scripts.css 注入，
  // 此处不再无条件补 link —— 否则关闭悬浮条开关时 teardownOverlay
  // 只能删掉自己插的那份，manifest 注入的样式仍留在页面上，
  // 开关无法真正卸载样式。仅在探测不到已注入样式时兜底补一份。
  function ensureStyle(){
    if (document.getElementById(STYLE_ID)) return;
    const probe = getComputedStyle(document.documentElement)
      .getPropertyValue('--ss-overlay-probe');
    if (probe && probe.trim()) return;

    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = chrome.runtime.getURL('content/overlay.css');
    document.documentElement.appendChild(link);
  }

  function mountOverlay(){
    ensureStyle();
    if (document.getElementById('slowScroll-overlay')) return;

    const root = document.createElement('div');
    root.id = 'slowScroll-overlay';
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', '自动滚动控制条');
    root.innerHTML = `
      <div id="slowScroll-bottom-prompt" role="status" aria-live="polite"></div>
      <div class="panel">
        <button id="ss-play" type="button" title="启动 / 停止自动滚动" aria-pressed="false">
          ${ICON.play}${ICON.stop}<span id="ss-play-label">播放</span>
        </button>
        <span class="panel-sep" aria-hidden="true"></span>
        <button id="ss-speed-down" class="ss-icon" type="button" title="减速" aria-label="减速">−</button>
        <span class="speed" id="ss-speed"><span id="ss-speed-value">${(globalThis.__SLOWSCROLL_CONSTANTS__?.DEFAULT_SPEED) ?? 600}</span><span class="unit">px/s</span></span>
        <button id="ss-speed-up" class="ss-icon" type="button" title="加速" aria-label="加速">+</button>
        <span class="panel-sep" aria-hidden="true"></span>
        <button id="ss-loop" type="button" title="到底后自动回到顶部继续滚动" aria-pressed="false">
          ${ICON.loop}<span id="ss-loop-label">循环</span>
        </button>
        <button id="ss-range" type="button" title="区间循环：标记起点与终点，只在范围内反复滚动" aria-pressed="false">
          ${ICON.range}<span id="ss-range-label">区间</span>
        </button>
        <button id="ss-top" type="button" title="停止并回到页面顶部" aria-label="回到顶部">${ICON.top}</button>
      </div>
    `;
    document.documentElement.appendChild(root);

    bindEvents(root);
    bindAutoHide(root);
    // 悬浮条可能晚于引擎挂载（注入顺序为 overlay → engine），
    // 也可能晚于引擎的首次状态上报，此处主动拉一次避免初始值失真
    syncFromEngine();
    console.log('[SlowScroll] overlay mounted and event listeners attached');
  }

  // 从引擎拉取当前状态并渲染到悬浮条
  function syncFromEngine() {
    const e = window.__slowScrollEngine;
    if (!e || typeof e.getSnapshot !== 'function') return;
    try {
      updateOverlay(e.getSnapshot());
    } catch (err) { /* 引擎未就绪时忽略 */ }
  }

  /* ============================================================
     命令通道
     all_frames 打开后，悬浮条只在顶层挂载，但「正在滚动的内容」
     可能位于某个 iframe 内。此时顶层引擎存在却滚不动，
     直连它会让用户「点了播放没反应」。

     策略：顶层自己能滚 → 直连本地引擎（零消息往返，手感最好）；
     否则把命令交给 background，由它定向到活动 frame。
     两条路径最终都落到引擎的同一组方法上，语义一致。
     ============================================================ */
  function canDriveLocal() {
    const e = window.__slowScrollEngine;
    if (!e) return false;
    if (typeof e.hasScrollableContent === 'function') {
      return !!e.hasScrollableContent();
    }
    // 旧引擎无该接口时退回「引擎存在即可用」，保持向后兼容
    return true;
  }

  // 远程下发命令。走 popup 同一条消息通道（from: 'overlay'），
  // 由 background 统一做活动 frame 定向，避免两处各写一套路由
  function sendRemote(msg) {
    try {
      chrome.runtime.sendMessage({ from: 'overlay', ...msg }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 扩展上下文可能已失效 */ }
  }

  // 调用引擎方法；若本地不可驱动则改走 background。
  // 返回值仅在本地路径下有意义（远程路径要等状态广播回来）
  function invoke(method, args) {
    // 无参调用时 args 为 undefined，必须兜底 —— 直接展开会抛
    // "args is not iterable"，让整个点击处理崩掉
    const list = args || [];
    const e = window.__slowScrollEngine;
    if (canDriveLocal() && typeof e[method] === 'function') {
      return e[method](...list);
    }
    // 远程只传 JSON 可序列化的参数
    sendRemote({ type: 'OVERLAY_COMMAND', method, args: list });
    return undefined;
  }

  function bindEvents(root){
    const playBtn = root.querySelector('#ss-play');
    const speedUpBtn = root.querySelector('#ss-speed-up');
    const speedDownBtn = root.querySelector('#ss-speed-down');
    const topBtn = root.querySelector('#ss-top');
    const loopBtn = root.querySelector('#ss-loop');
    const rangeBtn = root.querySelector('#ss-range');

    const engine = () => window.__slowScrollEngine;

    if (playBtn) {
      playBtn.addEventListener('click', () => invoke('toggleStartStop'));
    }

    // 步进取自设置页，未配置时回退到常量默认值
    const step = () => {
      const fallback = CONSTANTS.DEFAULT_STEP ?? 50;
      const configured = Number(engine()?.getState?.().step);
      return Number.isFinite(configured) && configured > 0 ? configured : fallback;
    };

    if (speedUpBtn) {
      speedUpBtn.addEventListener('click', () => invoke('adjustSpeed', [step(), { persist: true }]));
    }

    if (speedDownBtn) {
      speedDownBtn.addEventListener('click',
        () => invoke('adjustSpeed', [-step(), { persist: true }]));
    }

    if (loopBtn) {
      loopBtn.addEventListener('click', () => {
        const enabled = invoke('toggleLoop');
        // 远程路径下拿不到同步返回值，等状态广播回来再刷新文案
        if (enabled === undefined) return;
        updateLoopLabel(enabled);
      });
    }

    /* ---------- 区间锚点 ----------
       单键循环推进：未设置 → 标记起点 → 标记终点 → 清除。
       两个锚点要分别在两个位置捕获，用户必须能看清当前处于哪一步，
       故每次点击都刷新按钮文案。
       区间锚点依赖引擎读自己的 scrollTop，远程路径下拿不到本地快照，
       故只在本地可驱动时提供该交互。 */
    if (rangeBtn) {
      rangeBtn.addEventListener('click', () => {
        const e = engine();
        if (!e || typeof e.getSnapshot !== 'function' || !canDriveLocal()) return;
        const snap = e.getSnapshot();
        if (snap.rangeStart == null && snap.rangeEnd == null) {
          e.captureAnchor('start');
        } else if (snap.rangeEnd == null) {
          // 已有起点，第二次点击补终点
          if (e.captureAnchor('end') == null) showBottomPrompt('range-invalid');
        } else {
          e.clearRange();
        }
      });
    }

    if (topBtn) {
      topBtn.addEventListener('click', () => {
        // 引擎完全不存在（未注入）时才退回页面原生回顶
        if (!engine()) {
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        invoke('scrollToTop');
      });
    }
  }

  // 区间按钮文案：随锚点完成度变化，让用户知道下一步该做什么
  function updateRangeLabel(snap) {
    const label = document.getElementById('ss-range-label');
    const btn = document.getElementById('ss-range');
    if (!label || !btn) return;
    const active = !!(snap && snap.rangeActive);
    let text = '区间';
    if (active) text = '区间循环中';
    else if (snap && snap.rangeStart != null) text = '设终点';
    else if (snap && snap.rangeEnd != null) text = '设起点';
    label.textContent = text;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }

  function updateLoopLabel(enabled){
    const label = document.getElementById('ss-loop-label');
    const btn = document.getElementById('ss-loop');
    if (label) label.textContent = enabled ? '循环开' : '循环';
    if (btn) {
      btn.classList.toggle('active', !!enabled);
      btn.setAttribute('aria-pressed', String(!!enabled));
    }
  }

  function updateOverlay(scrollState) {
    if (!scrollState) return;

    const valueEl = document.getElementById('ss-speed-value');
    if (valueEl) valueEl.textContent = String(scrollState.speed);

    // 播放 / 停止：图标 + 文案 + 语义色（running 类切换红色）
    // 图标显隐由 overlay.css 依据 .running 类决定，此处不写内联样式——
    // 内联 style 在非 HTML 文档里根本不存在，且与项目「禁止内联样式」约定冲突
    const playBtn = document.getElementById('ss-play');
    const playLabel = document.getElementById('ss-play-label');
    if (playBtn) {
      playBtn.classList.toggle('running', !!scrollState.isScrolling);
      playBtn.setAttribute('aria-pressed', String(!!scrollState.isScrolling));
      if (playLabel) playLabel.textContent = scrollState.isScrolling ? '停止' : '播放';
    }

    updateLoopLabel(!!scrollState.loopEnabled);
    updateRangeLabel(scrollState);

    // 显隐与滚动态联动。放在渲染末尾，保证先更新完文案再收起，
    // 用户不会看到「停止」文字还没变就已经消失
    syncAutoHideWithState(!!scrollState.isScrolling);
  }

  function showBottomPrompt(type){
    const el = document.getElementById('slowScroll-bottom-prompt');
    if (!el) return;
    // 容器失败原因由引擎诊断后透出，这里的文案是它面向用户的解释
    const CONTAINER_ISSUE = {
      'no-content': '本页无可滚动内容',
      'virtual-list': '页面疑似虚拟列表，无法滚动'
    };
    const texts = {
      infinite: '已到达底部（疑似无限滚动）',
      normal: '已到达底部',
      returning: '已到达底部，正在回到顶部…',
      // 区间相关的停留与回弹，区别于整页触底
      'range-end': '已到区间终点，稍后回到起点',
      'range-return': '正在回到区间起点…',
      'range-invalid': '区间太短或起止颠倒，请重新标记',
      // 自动翻页：武装期明示即将跳转，用户可在这段时间内手动滚动取消
      'auto-next-armed': '即将翻到下一章，滚动可取消',
      // 倒计时到点自动停
      'stop-after-done': '已到设定时间，自动停止'
    };
    const key = CONTAINER_ISSUE[type] ? type : (texts[type] ? type : 'normal');
    el.textContent = CONTAINER_ISSUE[type] || texts[type] || texts.normal;
    el.dataset.type = key;
    // 强制回流以重放入场动画
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(el._ssTimer);
    // 回弹提示要覆盖整段动画时长；容器失败原因常驻更久，
    // 用户往往需要时间才反应过来「原来是这样」
    const hold = type === 'returning' || type === 'range-return'
      ? 1400
      : (type === 'range-end' ? 3000
        : (type === 'auto-next-armed' ? (globalThis.__SLOWSCROLL_CONSTANTS__?.AUTO_NEXT_CONFIRM_MS ?? 1500)
          : (CONTAINER_ISSUE[type] ? 5000 : 2000)));
    el._ssTimer = setTimeout(() => el.classList.remove('show'), hold);
  }

  function teardownOverlay(){
    // 卸载前必须清掉挂起的定时器：控制条 DOM 已移除，
    // 残留的 hide/idle 计时器会在几秒后对不存在的元素执行 class 切换
    cancelAutoHideTimers();
    autoHide.hidden = false;
    autoHide.hovered = false;
    autoHide.pointerInZone = false;
    autoHide.wasScrolling = false;
    const el = document.getElementById('slowScroll-overlay');
    if (el) el.remove();
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  /* ============================================================
     悬浮条开关：读取 storage.sync 的 overlayEnabled / autoHideOverlay
     设置页此前只写不读，导致开关形同虚设；此处补上读取与实时响应
     ============================================================ */
  const OVERLAY_DEFAULTS = { overlayEnabled: true, autoHideOverlay: true };

  function readOverlayConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage?.sync?.get(OVERLAY_DEFAULTS, (items) => {
          void chrome.runtime?.lastError;
          resolve({
            overlayEnabled: items?.overlayEnabled !== false,
            autoHideOverlay: items?.autoHideOverlay !== false
          });
        });
      } catch (e) {
        resolve({ ...OVERLAY_DEFAULTS });
      }
    });
  }

  async function applyOverlayVisibility() {
    const cfg = await readOverlayConfig();
    // 自动隐藏开关变化时立即同步：关闭则强制展开并清掉挂起的收起计时，
    // 否则用户关了开关还要等上一次计时器到点才生效
    if (autoHide.enabled !== cfg.autoHideOverlay) {
      autoHide.enabled = cfg.autoHideOverlay;
      if (!cfg.autoHideOverlay) {
        cancelAutoHideTimers();
        setHidden(false);
      }
    }
    if (cfg.overlayEnabled) {
      mountOverlay();
    } else {
      teardownOverlay();
    }
    return cfg.overlayEnabled;
  }

  // 初始化：先确认开关状态，再决定是否挂载
  applyOverlayVisibility();

  // 设置页改动开关后，当前标签页无需刷新即可生效
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.overlayEnabled || changes.autoHideOverlay) {
        applyOverlayVisibility();
      }
    });
  } catch (e) { /* 忽略监听失败 */ }

  // 监听来自 scrollEngine 的状态更新
  window.addEventListener('slowscroll:state', (ev) => {
    updateOverlay(ev.detail);
  });

  // 初始更新一次状态
  if (window.__slowScrollEngine) {
    updateOverlay(window.__slowScrollEngine.getSnapshot());
  }

  // 处理来自 background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'UPDATE_OVERLAY') {
      updateOverlay(message.payload);
      sendResponse({ ok: true });
    }
  });

  // 导出到全局（供 scrollEngine 直接调用）
  window.__slowScrollOverlay = {
    mountOverlay,
    updateOverlay,
    showBottomPrompt,
    teardownOverlay,
    applyVisibility: applyOverlayVisibility,
    // 自动隐藏状态机：暴露给测试与后续的显隐控制入口
    revealOverlay,
    isHidden: () => autoHide.hidden,
    isAutoHideEnabled: () => autoHide.enabled,
    setAutoHideEnabled(v) {
      autoHide.enabled = !!v;
      if (!autoHide.enabled) { cancelAutoHideTimers(); setHidden(false); }
    }
  };

  console.log('[SlowScroll] overlay initialized');
})();