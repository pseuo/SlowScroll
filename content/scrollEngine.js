// 滚动引擎：负责选择容器、驱动滚动、触底检测、到底循环（回到顶部继续）
// 注释中文、命名英文

/* ============================================================
   非 HTML 文档守卫
   matches 为 <all_urls>，会命中 SVG / XML / 图片查看器。
   这些文档没有 body、没有可滚动容器，selectScrollContainer 里的
   querySelectorAll('body *') 恒为空，引擎无意义且易在 DOM 操作处抛错。
   判定函数来自 shared/constants.js，与悬浮条共用同一真源。
   ============================================================ */
/* 用 var 而非 const：本文件处于顶层词法作用域，若用 const/let，
   Service Worker 重启后 ensureContentInjected 二次注入同一文件会抛
   "Identifier 'IS_HTML_DOC' has already been declared"，引擎整体失效。
   var 挂在 window 上，重复声明被静默覆盖，重复注入天然幂等。
   引擎内部其余标识符都在下方 else 块内，不受此影响。 */
var IS_HTML_DOC = typeof globalThis.__SLOWSCROLL_IS_HTML_DOC__ === 'function'
  && globalThis.__SLOWSCROLL_IS_HTML_DOC__(document);

/* 子 frame 尺寸守卫
   all_frames 打开后，广告位与追踪像素所在的 iframe 也会注入本脚本。
   在其中初始化引擎 = 一次 storage 读 + 五个监听器 + 一次状态上报，
   而它们几乎不可能是可滚动正文。按视口面积划线，
   顶层文档（面积等于整个视口）永远不受影响。
   用 var 而非 const：理由同上，重复注入会抛词法冲突。 */
var IS_TINY_FRAME = (function () {
  try {
    const w = window.innerWidth || 0;
    const h = window.innerHeight || 0;
    const min = (globalThis.__SLOWSCROLL_CONSTANTS__ || {}).MIN_FRAME_AREA || 0;
    return (w * h) < min;
  } catch (e) {
    return false;
  }
})();

if (!IS_HTML_DOC) {
  console.log('[SlowScroll] engine skipped: not an HTML document');
} else if (IS_TINY_FRAME) {
  console.log('[SlowScroll] engine skipped: frame too small');
} else if (window.__slowScrollEngine) {
  console.log('[SlowScroll] engine already initialized');
} else {
  /* ============================================================
     全局常量：唯一来源为 shared/constants.js
     引擎不保留速率 / 区间的本地副本，避免与设置页漂移。
     缺失即视为注入顺序错误，直接中止而非静默降级——
     宁可扩展不工作，也不要在两处数值不一致时悄悄跑偏。
     ============================================================ */
  const CONSTANTS = globalThis.__SLOWSCROLL_CONSTANTS__;
  if (!CONSTANTS) {
    throw new Error('[SlowScroll] shared/constants.js 未加载：检查 manifest.content_scripts 顺序与 background 注入文件列表');
  }

  let state = {
    isScrolling: false,
    isPaused: false,
    speed: CONSTANTS.DEFAULT_SPEED,
    // slowdown 档的临时降速系数，1 表示未降速。
    // 与 speed 分离：降速只是手势期间的临时态，不能污染用户设定的速度。
    speedFactor: 1,
    // 手势接管策略，取值见 CONSTANTS.GESTURE_POLICIES
    gesturePolicy: CONSTANTS.DEFAULT_GESTURE_POLICY,
    container: null,
    lastTick: 0,
    frameCount: 0,            // 帧计数器，用于容器校验节流
    threshold: CONSTANTS.BOTTOM_THRESHOLD,
    suspectedInfinite: false,
    loopEnabled: false,      // 到底是否自动回到顶部继续滚动
    loopGraceMs: CONSTANTS.LOOP_GRACE_MS,  // 触底后观察多久再决定回顶（给懒加载留时间）
    step: CONSTANTS.DEFAULT_STEP,          // 加减速度的步进值
    // down：向下滚动 | returning：回顶/回锚点动画中 | dwelling：区间终点停留 | idle：已到尽头，低频探测中
    phase: 'down',
    idleTimer: null,          // idle 阶段的低频探测定时器
    dwellTimer: null,         // 区间终点停留计时器
    idleScrollTop: 0,         // 进入 idle 时的 scrollTop，用于识别用户手动回滚
    bottomSince: 0,           // 本次触底的起始时间戳
    bottomEntryHeight: 0,     // 本次触底时的内容高度，用于判断是否仍在加载
    loopCount: 0,             // 已完成的循环次数
    returnFrom: 0,
    returnElapsed: 0,
    returnDuration: 0,
    // 回弹目标：区间模式下为区间起点，否则为 0
    returnTarget: 0,
    // 区间循环锚点（scrollTop 像素）。rangeStart / rangeEnd 均为 null 表示未启用。
    // 仅在两个锚点都设置且区间有效时生效，此时忽略整页到底逻辑。
    rangeStart: null,
    rangeEnd: null,
    rangeDwellMs: CONSTANTS.DEFAULT_RANGE_DWELL_MS,
    // 用户手势造成的临时降速恢复计时器
    slowdownTimer: null,
    lastBottomNotify: 0,
    lastProgressPublish: 0,  // 上次上报滚动进度的时刻，用于节流
    lastScanAt: 0,      // 上次全量扫描容器的时间戳，用于失败退避
    scanFailures: 0,    // 连续扫描失败次数，决定退避窗口长度
    behaviorPatched: false,   // 是否已临时改写 scroll-behavior

    /* ---- 触底自动翻页（下一章 / 下一页）----
       判定为普通页面（非无限滚动）且触底停留一段时间后，
       按白名单锚点策略查找后续链接。先武装后点击，留出取消窗口。 */
    autoNextEnabled: false,        // 用户显式开启，默认关闭（不可逆操作）
    autoNextSites: [],             // 站点白名单（host 后缀），空数组表示不限站点
    autoNextCount: 0,              // 本次页面会话已翻页次数，硬上限防死链
    autoNextArmed: null,           // 待点击的候选链接与倒计时截止时刻
    autoNextTimer: null,           // 取消窗口计时器
    autoNextLastAt: 0,             // 上次点击时刻，用于冷却

    /* ---- 倒计时到点自动停 ---- */
    stopAfterMinutes: 0,       // 0 表示不启用
    stopDeadlineAt: 0,         // 本次会话的到期时刻（Date.now() 口径）
    stopTimer: null,           // 倒计时检查定时器
    stopLastSecond: -1,        // 上次上报的剩余秒数，用于跨整秒才发状态

    // 容器失败原因：'no-content' | 'virtual-list' | null
    // 由 scanFailures 累积触发诊断后写入，对外明示「为什么滚不动」
    containerIssue: null,
    // 最近一次容器扫描的候选元素数。诊断复用它，避免重复全量遍历
    lastCandidateCount: 0
  };

  function clampSpeed(v){
    return Math.max(CONSTANTS.MIN_SPEED, Math.min(CONSTANTS.MAX_SPEED, v));
  }

  // 实际生效速度：用户设定速度 × 临时系数。降速时按系数打折，
  // 但下限仍受 MIN_SPEED 约束——降得过慢会让用户以为滚动停了。
  function effectiveSpeed(){
    const v = state.speed * state.speedFactor;
    return Math.max(CONSTANTS.MIN_SPEED, Math.min(CONSTANTS.MAX_SPEED, v));
  }

  // 手势降速的恢复时机由 slowDownFor 控制，此处给外部（停止/策略切换）用
  function clearSlowdown() {
    if (state.slowdownTimer) {
      clearTimeout(state.slowdownTimer);
      state.slowdownTimer = null;
    }
    state.speedFactor = 1;
  }

  /* ============================================================
     滚动进度
     progress 为 0–1 的已滚动比例，remaining 为剩余像素。
     两者都由 scrollTop / (scrollHeight - clientHeight) 得出，
     属于已有读取的组合，不引入新的强制布局开销。
     ============================================================ */
  function readProgress() {
    // 未开始滚动时容器尚未选定，但用户仍应看到当前页面的进度。
    // 惰性选一次容器：只读 scrollTop / scrollHeight / clientHeight，
    // 是页面加载后立刻打开 popup 的常见路径，不能因容器为空就报 0%
    if (!state.container || !state.container.isConnected) {
      const el = selectScrollContainer();
      if (!el) return { progress: 0, remaining: 0 };
      state.container = el;
    }
    const el = state.container;
    const span = el.scrollHeight - el.clientHeight;
    // 不可滚动（内容不足一屏）时没有进度可言，给出确定的 0 而非 NaN
    if (!Number.isFinite(span) || span <= 0) return { progress: 0, remaining: 0 };
    const top = Math.max(0, Math.min(el.scrollTop, span));
    return {
      progress: top / span,
      remaining: Math.max(0, span - top)
    };
  }

  /* ============================================================
     容器选择：优先取视口内面积最大的可滚动元素，document 根兜底
     多数 SPA / 阅读类站点把滚动容器放在内部 div 上，只滚 document 会完全失效
     ============================================================ */

  function isScrollable(el) {
    if (!el || !(el instanceof Element)) return false;
    // 文档根元素是特殊的滚动容器：标准模式下其 overflow 计算值就是 visible，
    // 但它确实能滚动。若按普通元素判定会永远返回 false，
    // 导致容器抽检每次都失败并回落到全量扫描 body *，白白付出昂贵的样式重算。
    if (el === document.scrollingElement || el === document.documentElement) {
      return el.scrollHeight - el.clientHeight > CONSTANTS.SCROLLABLE_MIN_OVERFLOW;
    }
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const canScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    if (!canScroll) return false;
    // 必须真实存在溢出空间，否则 scrollHeight === clientHeight
    return el.scrollHeight - el.clientHeight > CONSTANTS.SCROLLABLE_MIN_OVERFLOW;
  }

  // 元素与视口相交面积（用于择优，过滤掉隐藏的滚动容器）
  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return 0;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return w * h;
  }

  /* ============================================================
     候选元素收集：穿透开放 Shadow DOM
     document.querySelectorAll('body *') 扫不到 shadow root 里的元素，
     而组件库驱动的站点（乃至浏览器自身的 UI）大量把滚动容器放在
     shadow tree 内 —— 这是容器探测的下一个天花板。

     只下钻开放（open）shadow root：封闭（closed）root 的 shadowRoot
     为 null，浏览器层面就不暴露，这是规范行为而非缺陷。

     深度与数量都设上限：无上限时一个页面可能牵出整棵子树，
     遍历成本会超过它解决的问题。closed root 自然终止，无需特殊处理。
     ============================================================ */
  function collectCandidates() {
    const out = [];
    const maxDepth = CONSTANTS.SHADOW_SCAN_MAX_DEPTH;
    const maxRoots = CONSTANTS.SHADOW_SCAN_MAX_ROOTS;
    const maxElements = CONSTANTS.CONTAINER_SCAN_MAX_ELEMENTS;
    let roots = 0;

    // 迭代而非递归：深层嵌套时递归会把栈撑爆，站点结构不可控。
    // 首轮从 document 出发，用 'body *' 排除 head 里的样式与脚本节点；
    // 进入 shadow root 后没有 body/head 之分，改用 '*'。
    const stack = [{ root: document, depth: 0, selector: 'body *' }];
    while (stack.length && roots < maxRoots && out.length < maxElements) {
      const { root, depth, selector } = stack.pop();
      roots++;
      const nodes = root.querySelectorAll(selector);
      for (const el of nodes) {
        if (out.length >= maxElements) break;
        out.push(el);
        // 先判 shadowRoot 再判深度：封闭 root 的 shadowRoot 为 null，
        // 自然跳过，不会把封闭子树误判为「需要下钻但超深」
        if (el.shadowRoot && depth < maxDepth) {
          stack.push({ root: el.shadowRoot, depth: depth + 1, selector: '*' });
        }
      }
    }
    return out;
  }

  function selectScrollContainer() {
    const docEl = document.scrollingElement || document.documentElement || document.body;
    const docScrollable = docEl.scrollHeight - docEl.clientHeight > CONSTANTS.SCROLLABLE_MIN_OVERFLOW;
    const docArea = visibleArea(docEl) || 1;

    let best = null;
    let bestArea = 0;

    // 扫描所有元素（含开放 shadow tree），挑选视口内面积最大的可滚动容器
    const candidates = collectCandidates();
    // 记下本次扫描的候选规模，供失败诊断复用。
    // 诊断若自己再扫一遍，等于在同一个失败点上做两次全量 DOM 遍历——
    // 而这恰恰是退避机制要消除的开销，不能在诊断环节把它又请回来。
    state.lastCandidateCount = candidates.length;
    for (const el of candidates) {
      if (el === docEl) continue;
      if (!isScrollable(el)) continue;
      const area = visibleArea(el);
      if (area <= 0) continue;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }

    // 内部容器可见面积不小于文档流时，优先用内部容器（SPA 典型布局）
    if (best && bestArea >= docArea * 0.5) return best;
    if (docScrollable) return docEl;
    return best || docEl;
  }

  /* ============================================================
     容器校验节流 + 扫描失败退避
     isScrollable 内部有 getComputedStyle 与 scrollHeight/clientHeight 读取，
     两者都会强制样式重算与布局，每帧执行是持续开销的主要来源。
     isConnected 是廉价属性，故每帧只做连通性判断，
     真正的「是否仍可滚动」按 CONTAINER_CHECK_INTERVAL_FRAMES 抽检。

     退避解决的是另一类开销。selectScrollContainer 恒返回非空
     （最差回落到 docEl），所以「扫描失败」的真实判据不是返回 null，
     而是「重扫后选出的容器依然不可滚动」——页面尚未渲染完成、
     全屏视频、纯展示型页面都会走到这里。此时若无退避，
     抽检每 30 帧就触发一次全量扫描：在几千个元素的页面上，
     这是持续的主线程占用。按连续失败次数指数增长，
     并在选出真正可滚动的容器后立即清零 —— 迟滞只惩罚「一直失败」。
     ============================================================ */
  function scanBackoffMs() {
    const n = Math.min(state.scanFailures, 16);
    return Math.min(
      CONSTANTS.CONTAINER_SCAN_BACKOFF_MAX_MS,
      CONSTANTS.CONTAINER_SCAN_BACKOFF_BASE_MS * Math.pow(2, n)
    );
  }

  function ensureContainer(force) {
    const el = state.container;
    // 容器仍然可用：抽检通过就完全不做任何扫描，这是最常见的路径
    if (el && el.isConnected) {
      if (!force && (state.frameCount % CONSTANTS.CONTAINER_CHECK_INTERVAL_FRAMES) !== 0) {
        return true;
      }
      if (isScrollable(el)) {
        state.scanFailures = 0;
        clearContainerIssue();
        return true;
      }
    }

    // 走到这里说明容器失联或已不可滚动。距上次全量扫描不足退避窗口时
    // 直接放弃本帧，避免在扫不到东西的页面上反复付出全量扫描的代价。
    const now = Date.now();
    if (state.lastScanAt && (now - state.lastScanAt) < scanBackoffMs()) {
      return false;
    }

    const next = selectScrollContainer();
    state.lastScanAt = now;
    // 只有重扫后确实拿到「可滚动」的容器才算恢复；
    // 又回落成不可滚动的 docEl 属于又一次失败，退避继续增长。
    if (next && isScrollable(next)) {
      state.scanFailures = 0;
      state.container = next;
      clearContainerIssue();
      return true;
    }
    state.scanFailures++;
    maybeDiagnoseContainer();
    return false;
  }

  /* ============================================================
     容器失败原因诊断
     扫描失败在用户侧的表现是「点了没反应」，无从判断是页面没内容、
     是虚拟列表、还是扩展选错了容器。这里把失败原因明示出来，
     把无解释的沉默变成可行动的提示。

     诊断只在连续失败达到阈值后做一次：
     开头的失败通常只是页面尚未渲染完成，那时报错反而是噪声。
     诊断本身要数节点、读 scrollHeight，比一次抽检贵，
     故用 issueReported 作迟滞，同一轮失败只诊断一次。
     ============================================================ */
  let issueReported = false;

  function clearContainerIssue() {
    issueReported = false;
    if (state.containerIssue == null) return;
    state.containerIssue = null;
    publishState();
  }

  function maybeDiagnoseContainer() {
    if (issueReported) return;
    if (state.scanFailures < CONSTANTS.CONTAINER_ISSUE_REPORT_AFTER) return;
    issueReported = true;
    state.containerIssue = diagnoseContainer();
    publishState();
    if (state.containerIssue && window.__slowScrollOverlay
        && typeof window.__slowScrollOverlay.showBottomPrompt === 'function') {
      window.__slowScrollOverlay.showBottomPrompt(state.containerIssue);
    }
  }

  // 返回 'no-content'（页面确实没有更多内容）或 'virtual-list'（疑似窗口化渲染）
  function diagnoseContainer() {
    const docEl = document.scrollingElement || document.documentElement;
    const overflow = docEl.scrollHeight - docEl.clientHeight;

    // 文档根本身有溢出却仍被判失败：说明选容器这一步出了问题，
    // 不是「页面没内容」，这种情形不应给出误导性的解释。
    if (overflow > CONSTANTS.SCROLLABLE_MIN_OVERFLOW) return null;

    // 无溢出。再看 DOM 规模：节点很多却撑不出滚动条，
    // 是虚拟列表 / 窗口化渲染的典型形态（内容被裁剪，滚动条不出现）。
    // 规模读自上一次扫描留下的计数，诊断本身不做任何遍历。
    if (state.lastCandidateCount >= CONSTANTS.CONTAINER_ISSUE_NODE_HINT) return 'virtual-list';
    return 'no-content';
  }

  function isAtBottom() {
    const el = state.container;
    if (!el) return false;
    const scrollTop = el.scrollTop;
    const clientHeight = el.clientHeight;
    const scrollHeight = el.scrollHeight;
    return scrollTop + clientHeight >= scrollHeight - state.threshold;
  }

  function isAtTop() {
    const el = state.container;
    if (!el) return true;
    return el.scrollTop <= state.threshold;
  }

  /* ============================================================
     scroll-behavior 覆盖
     页面若设置 scroll-behavior: smooth，每次写scrollTop 都会触发补间，
     引擎的 speed*dt 步进会被动画队列拖慢，表现为速度失真 / 卡顿
     ============================================================ */

  const BEHAVIOR_FLAG = 'data-slowscroll-scroll';
  let savedBehavior = null;

  function patchScrollBehavior() {
    if (state.behaviorPatched) return;
    const root = document.documentElement;
    if (!root) return;
    savedBehavior = {
      inline: root.style.getPropertyValue('scroll-behavior'),
      priority: root.style.getPropertyPriority('scroll-behavior')
    };
    root.setAttribute(BEHAVIOR_FLAG, '');
    root.style.setProperty('scroll-behavior', 'auto', 'important');
    state.behaviorPatched = true;
  }

  function restoreScrollBehavior() {
    if (!state.behaviorPatched) return;
    const root = document.documentElement;
    if (root) {
      root.removeAttribute(BEHAVIOR_FLAG);
      if (savedBehavior && savedBehavior.inline) {
        root.style.setProperty('scroll-behavior', savedBehavior.inline, savedBehavior.priority || '');
      } else {
        root.style.removeProperty('scroll-behavior');
      }
    }
    savedBehavior = null;
    state.behaviorPatched = false;
  }

  /* ============================================================
     触底检测与无限滚动判定
     ============================================================ */

  // 触底期间监测内容是否仍在增长（懒加载 / 无限滚动）
  function checkBottomContentGrowth() {
    const el = state.container;
    if (!el) return;
    const h = el.scrollHeight;
    if (!state.bottomEntryHeight) {
      state.bottomEntryHeight = h;
      return;
    }
    if (h > state.bottomEntryHeight + 10) {
      // 触底后内容还在增长 → 判定为无限滚动，不再回顶
      if (!state.suspectedInfinite) {
        state.suspectedInfinite = true;
        notifyBottom('infinite', true);
      }
      state.bottomEntryHeight = h;
    } else if (h < state.bottomEntryHeight - 10) {
      // 内容变少（换页 / 清空）→ 重置判定
      state.suspectedInfinite = false;
      state.bottomEntryHeight = h;
    }
  }

  function resetBottomWatch() {
    state.bottomSince = 0;
    state.bottomEntryHeight = 0;
    // 离开底部即作废上一轮的无限滚动判定。
    // 此前此字段只在「内容变少」时复位，导致一次误判后回顶循环在该页面永久失效。
    state.suspectedInfinite = false;
  }

  function notifyBottom(type, sticky) {
    const nowMs = Date.now();
    if (!sticky && nowMs - state.lastBottomNotify < CONSTANTS.BOTTOM_NOTIFY_THROTTLE_MS) return;
    state.lastBottomNotify = nowMs;
    try {
      chrome.runtime.sendMessage({ type: 'REACHED_BOTTOM' }, () => {
        // 读取 lastError 避免控制台报「Unchecked runtime.lastError」
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 扩展上下文可能已失效，忽略 */ }
    if (window.__slowScrollOverlay && typeof window.__slowScrollOverlay.showBottomPrompt === 'function') {
      window.__slowScrollOverlay.showBottomPrompt(type);
    }
  }

  /* ============================================================
     触底自动翻页（下一章 / 下一页）

     风险等级最高的改动：扩展替用户点击第三方页面上的元素，
     一次误判就可能把用户带到广告页、付费墙或站点内的删除操作上。
     因此这里用四道闸门把风险压到最低：

     1. 默认关闭（autoNextEnabled 初始 false），须用户在设置页显式开启；
     2. 站点白名单（autoNextSites），可限定只在可信站点生效；
     3. 锚点白名单：只认rel="next" 语义标记与精确文案，
        绝不按位置、尺寸或 URL 模式猜测；
     4. 武装 → 等待 → 点击三段式：先在悬浮条上明示「即将翻页」，
        留出 AUTO_NEXT_CONFIRM_MS 的取消窗口，用户任何接管手势都撤销它。

     失败模式的收口同样重要：站点若不响应点击，冷却与单页次数上限
     会把「点一次没反应」变成「不再尝试」，而不是无限重复点击。
     ============================================================ */

  // 站点是否在白名单内。白名单为空表示用户未限定站点，此时仅靠功能开关把关。
  function autoNextSiteAllowed() {
    const list = state.autoNextSites;
    if (!Array.isArray(list) || list.length === 0) return true;
    const host = String(window.location.hostname || '').toLowerCase();
    if (!host) return false;
    return list.some((raw) => {
      const s = String(raw || '').trim().toLowerCase();
      if (!s) return false;
      // 后缀匹配须带点边界，否则 evil-example.com 会被 example.com 放行
      return host === s || host.endsWith('.' + s);
    });
  }

  // 规范化链接文案：折叠空白、去零宽字符、剥装饰符号
  function normalizeLinkText(s) {
    return String(s == null ? '' : s)
      .replace(/[\s\u200b-\u200f\ufeff]+/g, ' ')
      // 常见的装饰性前后缀，如「下一章 »」「【下一页】」
      .replace(/^[\s>»›←【\[(（]+/, '')
      .replace(/[\s»›<【\])）]+$/, '')
      .trim();
  }

  // 候选链接是否安全：必须带 href、协议为 http(s)、且与当前页同源。
  // 同源这条很关键 —— 跨域的「下一页」十有八九是广告或联盟营销链接。
  function isSafeNextLink(el) {
    if (!el || el.tagName !== 'A') return false;
    const raw = el.getAttribute('href');
    if (!raw) return false;
    // 空 href 与纯锚点都表示「不导航」
    const t = String(raw).trim();
    if (!t || t === '#' || t.toLowerCase().startsWith('javascript:')) return false;
    let url;
    try {
      url = new URL(t, window.location.href);
    } catch (e) {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // 禁止点击未渲染 / 不可见的元素：那通常是移动端菜单里的隐藏副本
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  // 按白名单策略找一个后续链接。两级判定，先语义后文案。
  function findNextLink() {
    let candidates = null;
    try {
      candidates = document.querySelectorAll('a[rel~="next"], a[rel="next"]');
    } catch (e) {
      candidates = [];
    }
    for (const el of candidates) {
      if (isSafeNextLink(el)) return el;
    }

    // 文案精确匹配。注意是「规范化后完全相等」而非包含：
    // 正文里的「下一章预告」一旦用包含匹配就会被当成翻页链接点掉。
    const texts = Array.isArray(CONSTANTS.AUTO_NEXT_TEXTS) ? CONSTANTS.AUTO_NEXT_TEXTS : [];
    const maxLen = CONSTANTS.AUTO_NEXT_MAX_TEXT_LEN;
    let anchors;
    try {
      anchors = document.querySelectorAll('a[href]');
    } catch (e) {
      return null;
    }
    for (const el of anchors) {
      const raw = el.textContent;
      const norm = normalizeLinkText(raw);
      if (!norm || norm.length > maxLen) continue;
      if (texts.indexOf(norm) === -1) continue;
      if (!isSafeNextLink(el)) continue;
      return el;
    }
    return null;
  }

  function cancelAutoNext(silent) {
    if (state.autoNextTimer) {
      clearTimeout(state.autoNextTimer);
      state.autoNextTimer = null;
    }
    if (!state.autoNextArmed) return;
    state.autoNextArmed = null;
    if (!silent) publishState();
  }

  // 武装候选链接：先明示、再等待、最后才点
  function armAutoNext(link) {
    if (!link) return false;
    state.autoNextArmed = {
      // 只留必要信息：把DOM 节点挂在状态上会让每次 snapshot 都带着整棵子树
      href: link.getAttribute('href'),
      text: normalizeLinkText(link.textContent).slice(0, CONSTANTS.AUTO_NEXT_MAX_TEXT_LEN)
    };
    publishState();
    if (window.__slowScrollOverlay && typeof window.__slowScrollOverlay.showBottomPrompt === 'function') {
      window.__slowScrollOverlay.showBottomPrompt('auto-next-armed');
    }
    state.autoNextTimer = setTimeout(() => {
      state.autoNextTimer = null;
      commitAutoNext();
    }, CONSTANTS.AUTO_NEXT_CONFIRM_MS);
    return true;
  }

  // 到点执行：重新确认页面状态后点击，并立即停机等待导航
  function commitAutoNext() {
    const armed = state.autoNextArmed;
    state.autoNextArmed = null;
    if (!armed) return;
    // 武装期间用户可能已停止 / 暂停 / 打开循环，这些都应放弃本次翻页
    if (!state.isScrolling || state.isPaused || state.loopEnabled) {
      publishState();
      return;
    }
    const now = Date.now();
    if (now - state.autoNextLastAt < CONSTANTS.AUTO_NEXT_COOLDOWN_MS) return;
    if (state.autoNextCount >= CONSTANTS.AUTO_NEXT_MAX_PER_SESSION) {
      publishState();
      return;
    }
    state.autoNextLastAt = now;
    state.autoNextCount += 1;

    // 导航会销毁整个文档，此处的点击必须在停机之后：
    // 先停机可确保 scroll-behavior 被还原，不会把补丁状态带进新页面
    stopScrolling();

    let target = null;
    try {
      const url = new URL(armed.href, window.location.href);
      const list = document.querySelectorAll('a[href]');
      for (const el of list) {
        if (el.getAttribute('href') === armed.href && isSafeNextLink(el)) { target = el; break; }
      }
      if (!target) target = url;
    } catch (e) {
      return;
    }
    try {
      // 优先走真实点击以保留站点自身的跳转逻辑与埋点；
      // 元素已消失时退化为直接导航，保证翻页不静默失败
      if (target && target.tagName === 'A' && typeof target.click === 'function') target.click();
      else window.location.href = String(target);
    } catch (e) {
      try { window.location.href = armed.href; } catch (e2) { /* 忽略 */ }
    }
  }

  // 是否可以尝试翻页：所有前置闸门在此收口
  function autoNextEligible() {
    if (!state.autoNextEnabled) return false;
    if (state.loopEnabled || rangeActive()) return false;
    if (state.autoNextArmed) return false;
    if (state.autoNextCount >= CONSTANTS.AUTO_NEXT_MAX_PER_SESSION) return false;
    if (Date.now() - state.autoNextLastAt < CONSTANTS.AUTO_NEXT_COOLDOWN_MS) return false;
    return autoNextSiteAllowed();
  }

  // 触底且判定为普通页面时调用
  function tryAutoNext() {
    if (!autoNextEligible()) return false;
    const link = findNextLink();
    if (!link) return false;
    return armAutoNext(link);
  }

  /* ============================================================
     倒计时到点自动停
     与 dwellTimer 同构：一个 setTimeout + 一个到期时刻，无新增状态机。
     用绝对到期时刻而非递减计数器，这样标签页切到后台、
     定时器被节流甚至丢弃后，到点判断依然准确 —— setTimeout 在后台
     会被浏览器限流甚至丢弃，递减计数则会永久停在半路。
     ============================================================ */

  function clampStopAfterMinutes(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(CONSTANTS.MIN_STOP_AFTER_MINUTES, Math.min(CONSTANTS.MAX_STOP_AFTER_MINUTES, Math.round(n)));
  }

  function stopAfterRemainingMs() {
    if (!state.stopAfterMinutes) return 0;
    return Math.max(0, state.stopDeadlineAt - Date.now());
  }

  function cancelStopAfter() {
    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
    state.stopDeadlineAt = 0;
    state.stopLastSecond = -1;
  }

  function checkStopAfter() {
    if (!state.stopAfterMinutes) return;
    if (Date.now() < state.stopDeadlineAt) return;
    cancelStopAfter();
    // 先停机再提示：提示条要留在页面上，说明是「到点自动停」而非用户点的
    stopScrolling();
    if (window.__slowScrollOverlay && typeof window.__slowScrollOverlay.showBottomPrompt === 'function') {
      window.__slowScrollOverlay.showBottomPrompt('stop-after-done');
    }
  }

  // 剩余秒数变化时才发状态：每帧检查但每分钟才上报，
  // 否则会与进度上报叠加成高频消息
  function tickStopAfter() {
    state.stopTimer = null;
    // 以 deadlineAt 而非 stopAfterMinutes 作为「是否在计时」的判据：
    // minutes 是用户配置，到点后必须保留以便下次启动沿用，
    // 若拿它做判据，cancelStopAfter 之后定时器会每秒无限续期。
    if (!state.stopDeadlineAt) return;
    checkStopAfter();
    if (!state.stopDeadlineAt) return;
    const sec = Math.ceil(stopAfterRemainingMs() / 1000);
    if (sec !== state.stopLastSecond) {
      state.stopLastSecond = sec;
      publishState();
    }
    state.stopTimer = setTimeout(tickStopAfter, CONSTANTS.STOP_COUNTDOWN_TICK_MS);
  }

  function startStopAfter() {
    cancelStopAfter();
    if (!state.stopAfterMinutes) return;
    state.stopDeadlineAt = Date.now() + state.stopAfterMinutes * 60000;
    state.stopTimer = setTimeout(tickStopAfter, CONSTANTS.STOP_COUNTDOWN_TICK_MS);
  }

  function setStopAfterMinutes(v, options) {
    state.stopAfterMinutes = clampStopAfterMinutes(v);
    // 会话进行中改时长：按新值重新起算，避免旧截止时刻早于新值立刻触发
    if (state.isScrolling) startStopAfter();
    else cancelStopAfter();
    if (!options || options.persist) {
      try {
        chrome.storage?.sync?.set({ stopAfterMinutes: state.stopAfterMinutes }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* 忽略存储异常 */ }
    }
    publishState();
  }

  /* ---------- 触底自动翻页开关 ----------
     白名单清洗放这里而非设置页：popup / 悬浮条 / 快捷键都可能改它，
     只有引擎这一处真正生效，脏数据不该有机会越过白名单闸门。 */
  function normalizeSiteList(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
      const s = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!s || out.indexOf(s) !== -1) continue;
      out.push(s);
    }
    return out.slice(0, CONSTANTS.AUTO_NEXT_MAX_SITES);
  }

  function setAutoNext(enabled, options) {
    state.autoNextEnabled = !!enabled;
    // 关闭时立即撤销已武装的候选，否则用户关掉开关后仍会被带走
    if (!state.autoNextEnabled) cancelAutoNext(true);
    if (!options || options.persist) {
      try {
        chrome.storage?.sync?.set({ autoNextPage: state.autoNextEnabled }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* 忽略存储异常 */ }
    }
    publishState();
  }

  function setAutoNextSites(list, options) {
    state.autoNextSites = normalizeSiteList(list);
    if (!options || options.persist) {
      try {
        chrome.storage?.sync?.set({ autoNextSites: state.autoNextSites }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* 忽略存储异常 */ }
    }
    publishState();
  }

  /* ============================================================
     回弹动画
     回顶（目标 0）与区间回起点（目标 rangeStart）共用同一套插值逻辑，
     差别只在 returnTarget —— 换目标值即可，不需要第二份动画代码。
     ============================================================ */

  // 是否处于有效的区间循环模式：两个锚点都设置且区间足够长
  function rangeActive() {
    if (state.rangeStart == null || state.rangeEnd == null) return false;
    return state.rangeEnd - state.rangeStart >= CONSTANTS.MIN_RANGE_SPAN;
  }

  // 回弹目标：区间模式回区间起点，否则回页面顶部
  function computeReturnTarget() {
    return rangeActive() ? state.rangeStart : 0;
  }

  // 是否到达区间下沿。区间模式下替代整页 isAtBottom 判定
  function isAtRangeEnd() {
    const el = state.container;
    if (!el || !rangeActive()) return false;
    return el.scrollTop >= state.rangeEnd - state.threshold;
  }

  // 开始回弹动画
  function startReturnTop() {
    const el = state.container;
    if (!el) return;
    exitIdle();
    cancelDwell();
    state.phase = 'returning';
    state.returnFrom = el.scrollTop;
    state.returnTarget = computeReturnTarget();
    state.returnElapsed = 0;
    // 时长与距离相关，并做上下限约束，速度越快回弹越快。
    // 按实际行程而非 scrollTop 计算——区间模式的目标不是 0
    const distance = Math.abs(state.returnFrom - state.returnTarget);
    const approx = (distance / Math.max(effectiveSpeed() * 2.5, 1)) * 1000;
    state.returnDuration = Math.min(
      CONSTANTS.MAX_RETURN_MS,
      Math.max(CONSTANTS.MIN_RETURN_MS, approx)
    );
    if (window.__slowScrollOverlay && typeof window.__slowScrollOverlay.showBottomPrompt === 'function') {
      window.__slowScrollOverlay.showBottomPrompt(rangeActive() ? 'range-return' : 'returning');
    }
  }

  // 回弹动画推进：easeOutCubic，到目标后切回向下滚动
  function stepReturnTop(dt) {
    const el = state.container;
    if (!el) { finishReturnTop(); return; }
    state.returnElapsed += dt * 1000;
    const p = Math.min(1, state.returnElapsed / state.returnDuration);
    const eased = 1 - Math.pow(1 - p, 3);
    // 从 returnFrom 插值到 returnTarget，两个方向都能正确收敛
    el.scrollTop = state.returnFrom + (state.returnTarget - state.returnFrom) * eased;
    const reached = rangeActive()
      ? Math.abs(el.scrollTop - state.returnTarget) <= state.threshold
      : isAtTop();
    if (p >= 1 || reached) {
      el.scrollTop = state.returnTarget;
      finishReturnTop();
    }
  }

  function finishReturnTop() {
    state.phase = 'down';
    state.loopCount += 1;
    state.lastTick = 0;          // 重置时间基准，避免回顶后第一帧跳动
    resetBottomWatch();
    publishState();
  }

  /* ============================================================
     区间终点停留
     滚到区间下沿后原地停留 dwellMs 再回弹。
     没有停留期的话内容会「顶到头立刻弹回」，视觉上是高频抖动；
     停留同时给了用户读完这一段的自然时间。
     ============================================================ */
  function startDwell() {
    cancelDwell();
    state.phase = 'dwelling';
    state.lastTick = 0;
    const wait = Math.max(CONSTANTS.MIN_RANGE_DWELL_MS, state.rangeDwellMs);
    // 停留为 0 时不建定时器，下一帧直接回弹
    if (wait <= 0) {
      state.phase = 'down';
      startReturnTop();
      return;
    }
    state.dwellTimer = setTimeout(() => {
      state.dwellTimer = null;
      if (!state.isScrolling || state.isPaused || !rangeActive()) return;
      state.phase = 'down';
      startReturnTop();
      if (state.isScrolling && !state.isPaused) requestAnimationFrame(tick);
    }, wait);
    if (window.__slowScrollOverlay && typeof window.__slowScrollOverlay.showBottomPrompt === 'function') {
      window.__slowScrollOverlay.showBottomPrompt('range-end');
    }
    publishState();
  }

  function cancelDwell() {
    if (state.dwellTimer) {
      clearTimeout(state.dwellTimer);
      state.dwellTimer = null;
    }
  }

  /* ============================================================
     idle：已到尽头的低频探测
     触底且本轮不会回顶时，继续跑 rAF 只会每帧重复「写无效 scrollTop +
     读布局 + 被节流挡掉的通知」，在静止页面上是纯粹的持续开销。
     改为 1s 一次的定时探测：既能接住懒加载追加的内容，
     又能让主线程与合成器彻底空出来。
     ============================================================ */

  function enterIdle() {
    // 区间模式下「到区间下沿」不是尽头，不能进 idle 静默探测
    if (rangeActive()) return;
    state.phase = 'idle';
    state.idleScrollTop = state.container ? state.container.scrollTop : 0;
    if (state.idleTimer) return;
    state.idleTimer = setTimeout(idleProbe, CONSTANTS.IDLE_PROBE_MS);
  }

  function exitIdle() {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    if (state.phase === 'idle') state.phase = 'down';
  }

  function idleProbe() {
    state.idleTimer = null;
    if (!state.isScrolling || state.isPaused || state.phase !== 'idle') return;

    ensureContainer(true);

    // 用户用滚动条拖回上方：拖拽不产生 wheel / touch 事件，
    // 只有对比 idle 期间的 scrollTop 才能识别出这是用户操作
    if (state.container && state.container.scrollTop < state.idleScrollTop - state.threshold) {
      // 已离开底部：作废本轮的无限滚动判定，
      // 否则这次误判会让回顶循环在该页面此后永久失效
      resetBottomWatch();
      pauseScrolling();
      return;
    }

    // 内容被追加 / 容器切换 → 已离开底部，恢复主循环
    if (!isAtBottom()) {
      exitIdle();
      resetBottomWatch();
      state.lastTick = 0;
      requestAnimationFrame(tick);
      return;
    }

    // 仍在底部：刷新高度基准，维持无限滚动判定的时效性
    checkBottomContentGrowth();

    // 触底且判定为普通页面（内容不再增长、无循环、无区间）→ 尝试找后续链接。
    // 放在 idleProbe 而非 tick：此时主循环已停，正好是「页面到底了」的稳定时刻，
    // 而 idle 是 1s 低频探测，不会因为一次误判就疯狂点击。
    if (!state.suspectedInfinite && !state.loopEnabled && !rangeActive() && isAtBottom()) {
      tryAutoNext();
    }

    // 循环在 idle 期间被开启，或内容缩短推翻了无限滚动判定 → 交回主循环
    if (state.loopEnabled && !state.suspectedInfinite) {
      exitIdle();
      state.lastTick = 0;
      requestAnimationFrame(tick);
      return;
    }

    state.idleTimer = setTimeout(idleProbe, CONSTANTS.IDLE_PROBE_MS);
  }

  /* ============================================================
     主循环
     ============================================================ */

  function tick(ts) {
    if (!state.isScrolling || state.isPaused) return;
    if (!state.lastTick) state.lastTick = ts;
    // 钳制单帧步长：标签页切到后台后 rAF 停摆，lastTick 会冻结在旧值，
    // 回到前台首帧 dt 可能是数十秒，直接 scrollTop += speed*dt 会把页面甩到底
    const dt = Math.min(
      CONSTANTS.MAX_FRAME_DT,
      Math.max(0, ts - state.lastTick) / 1000
    );
    state.lastTick = ts;
    state.frameCount++;

    if (!ensureContainer(false)) {
      // 页面暂无可滚动容器（尚未渲染完成 / 全屏视频 / 纯展示页等）：
      // 降频探测。重试间隔跟随退避窗口，连续失败时逐步拉长，
      // 避免在同一批扫不到的元素上反复做全量扫描。
      const wait = Math.max(CONSTANTS.IDLE_PROBE_MS, scanBackoffMs());
      state.idleTimer = setTimeout(() => {
        state.idleTimer = null;
        if (state.isScrolling && !state.isPaused) requestAnimationFrame(tick);
      }, wait);
      return;
    }

    if (state.phase === 'returning') {
      stepReturnTop(dt);
      publishProgress();
      requestAnimationFrame(tick);
      return;
    }

    // 停留相位：不写 scrollTop，只等 dwellTimer 到点回弹
    if (state.phase === 'dwelling') {
      publishProgress();
      requestAnimationFrame(tick);
      return;
    }

    const delta = effectiveSpeed() * dt;
    state.container.scrollTop += delta;

    // 区间模式：到区间下沿即停留后回弹，不进入整页触底逻辑。
    // 区间是用户显式指定的范围，无限滚动判定在这里没有意义。
    if (rangeActive()) {
      if (isAtRangeEnd()) {
        startDwell();
        return;
      }
      resetBottomWatch();
      publishProgress();
      requestAnimationFrame(tick);
      return;
    }

    const atBottom = isAtBottom();
    if (atBottom) {
      if (!state.bottomSince) state.bottomSince = ts;
      checkBottomContentGrowth();

      // 循环模式：触底后先等一小段时间，若内容没有继续增长则回到顶部继续滚动
      const willReturn = state.loopEnabled && !state.suspectedInfinite;
      if (willReturn && (ts - state.bottomSince) >= state.loopGraceMs) {
        startReturnTop();
        requestAnimationFrame(tick);
        return;
      }

      // 到底部：通知 background，触发 overlay 提示
      notifyBottom(state.suspectedInfinite ? 'infinite' : 'normal', false);

      // 本轮不会回顶（未开循环 / 判定为无限滚动 / 观察期未满）→ 交给 idle 低频探测
      if (!willReturn || (ts - state.bottomSince) < state.loopGraceMs) {
        enterIdle();
        return;
      }
    } else {
      resetBottomWatch();
    }

    publishProgress();
    requestAnimationFrame(tick);
  }

  /* ============================================================
     控制接口
     ============================================================ */

  function startScrolling() {
    if (state.isScrolling) return;
    exitIdle();
    cancelDwell();
    cancelAutoNext(true);
    clearSlowdown();
    state.container = selectScrollContainer();
    // 用户主动启动：视作一次全新的探测起点，清掉失败退避。
    // 否则「启动前扫不到容器」的退避窗口会连带压制启动后的首次抽检。
    state.lastScanAt = 0;
    state.scanFailures = 0;
    clearContainerIssue();
    if (!state.container) return;
    state.isScrolling = true;
    state.isPaused = false;
    state.lastTick = 0;
    state.frameCount = 0;
    state.phase = 'down';
    state.returnTarget = 0;
    // 翻页计数按「页面会话」计：新页面由新文档重新初始化，自然归零
    state.autoNextCount = 0;
    state.autoNextLastAt = 0;
    resetBottomWatch();
    patchScrollBehavior();
    startStopAfter();
    requestAnimationFrame(tick);
    publishState();
  }

  function stopScrolling() {
    exitIdle();
    cancelDwell();
    cancelAutoNext(true);
    cancelStopAfter();
    clearSlowdown();
    state.isScrolling = false;
    state.isPaused = false;
    state.lastTick = 0;
    state.phase = 'down';
    state.returnTarget = 0;
    resetBottomWatch();
    restoreScrollBehavior();
    // 停止时冲一次进度落盘：拖动滑块后立刻点停止是常见操作，
    // 不应因为防抖窗口未到而丢掉这次调整
    flushSpeedPersist();
    publishState();
  }

  function pauseScrolling() {
    if (!state.isScrolling) return;
    exitIdle();
    cancelDwell();
    state.isPaused = true;
    publishState();
  }

  function resumeScrolling() {
    if (!state.isScrolling) return;
    state.isPaused = false;
    state.lastTick = 0;
    state.phase = 'down';
    requestAnimationFrame(tick);
    publishState();
  }

  /* ============================================================
     速度会话持久化
     setSpeed 只改内存的话，用户调到 300 px/s，切个页面就回到默认 600。
     这里与 setLoop 对齐：可持久化 + 落盘到会话键。
     直写会被滑块的高频事件打爆 storage.sync 写入配额（每分钟 120 次，
     超限后静默失败且不报错），故用防抖聚合，停止时强制冲刷。
     ============================================================ */

  let speedPersistTimer = null;
  let pendingSpeedPersist = null;

  function flushSpeedPersist() {
    if (speedPersistTimer) {
      clearTimeout(speedPersistTimer);
      speedPersistTimer = null;
    }
    if (pendingSpeedPersist == null) return;
    const value = pendingSpeedPersist;
    pendingSpeedPersist = null;
    try {
      chrome.storage?.sync?.set({ [CONSTANTS.SPEED_SESSION_KEY]: value }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 忽略存储异常 */ }
  }

  function scheduleSpeedPersist() {
    pendingSpeedPersist = state.speed;
    if (speedPersistTimer) clearTimeout(speedPersistTimer);
    speedPersistTimer = setTimeout(flushSpeedPersist, CONSTANTS.SPEED_PERSIST_DEBOUNCE_MS);
  }

  function setSpeed(v, options) {
    state.speed = clampSpeed(v);
    // 是否持久化到全局配置（由 popup / options 决定）
    if (!options || options.persist) scheduleSpeedPersist();
    publishState();
  }

  function adjustSpeed(delta, options) {
    setSpeed(state.speed + delta, options);
  }

  // 按当前步进加减，供快捷键使用（避免把步长写死在 background）
  function stepSpeed(direction) {
    const dir = Number(direction) >= 0 ? 1 : -1;
    adjustSpeed(dir * state.step, { persist: true });
    return state.speed;
  }

  /* ============================================================
     手势接管策略
     pause：一有滚轮就停（历史行为，对长文阅读过于激进）
     slowdown：临时降速让出控制权，停止滚轮后自动恢复
     ignore：完全不管，适合只想单向自动滚动的场景
     ============================================================ */
  function normalizePolicy(v) {
    return CONSTANTS.GESTURE_POLICIES.indexOf(v) !== -1
      ? v
      : CONSTANTS.DEFAULT_GESTURE_POLICY;
  }

  // slowdown 档：进入半速并在静默后恢复
  function slowDownTemporarily() {
    state.speedFactor = CONSTANTS.SLOWDOWN_FACTOR;
    if (state.slowdownTimer) clearTimeout(state.slowdownTimer);
    state.slowdownTimer = setTimeout(() => {
      state.slowdownTimer = null;
      // 恢复期间若已停止或暂停，就不必再发一次状态
      if (!state.isScrolling || state.isPaused) return;
      state.speedFactor = 1;
      publishState();
    }, CONSTANTS.SLOWDOWN_RECOVER_MS);
  }

  function setGesturePolicy(policy, options) {
    state.gesturePolicy = normalizePolicy(policy);
    // 离开 slowdown 档时清掉临时降速，否则会带着半速继续跑
    if (state.gesturePolicy !== 'slowdown') clearSlowdown();
    if (!options || options.persist) {
      try {
        chrome.storage?.sync?.set({ gesturePolicy: state.gesturePolicy }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* 忽略存储异常 */ }
    }
    publishState();
  }

  function setLoop(enabled, options) {
    state.loopEnabled = !!enabled;
    // 开启循环即表明用户想在这一页内反复读，与「翻到下一章」互斥，
    // 必须撤销已武装的候选，否则两套到底策略会同时生效
    if (state.loopEnabled) cancelAutoNext(true);
    // 关闭循环时若正处于回弹/停留/idle 探测，立即切回向下滚动
    if (!state.loopEnabled && (state.phase === 'returning' || state.phase === 'idle' || state.phase === 'dwelling')) {
      exitIdle();
      cancelDwell();
      state.phase = 'down';
      state.lastTick = 0;
      resetBottomWatch();
    }
    // idle 期间开启循环：立刻唤醒，让回弹在下一帧生效而非等满 1s
    if (state.loopEnabled && state.isScrolling && !state.isPaused && state.idleTimer) {
      exitIdle();
      state.lastTick = 0;
      requestAnimationFrame(tick);
    }
    // 是否持久化到全局配置（由 popup / options 决定）
    if (!options || options.persist) {
      try {
        chrome.storage?.sync?.set({ loopEnabled: state.loopEnabled }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) { /* 忽略存储异常 */ }
    }
    publishState();
  }

  function toggleLoop() {
    setLoop(!state.loopEnabled);
    return state.loopEnabled;
  }

  function toggleStartStop(){
    if (state.isScrolling) stopScrolling();
    else startScrolling();
  }

  function togglePauseResume(){
    if (!state.isScrolling) return;
    if (state.isPaused) resumeScrolling();
    else pauseScrolling();
  }

  // 平滑回到顶部。容器可能不是 window，统一走容器 scrollTo
  function scrollToTop() {
    stopScrolling();
    const el = state.container;
    if (el && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  /* ============================================================
     区间锚点
     背单词表、看乐谱、精读某一段这类场景，需要在指定范围内反复滚，
     而不是「到底 → 回顶」。锚点以 scrollTop 像素记录，属页面级状态，
     不写入 storage.sync —— 不同页面的 scrollTop 毫无可比性。
     ============================================================ */

  // 捕获当前滚动位置作为锚点。which 为 'start' | 'end'
  function captureAnchor(which) {
    if (which !== 'start' && which !== 'end') return null;
    // 容器只在 startScrolling 时选定，而标记锚点恰恰发生在滚动之前
    // （用户手动滚到某一段再标记）。此处兜底选一次，否则此刻 container
    // 恒为 null，锚点功能在真实使用路径上直接失效。
    if (!state.container || !state.container.isConnected) {
      state.container = selectScrollContainer();
    }
    const el = state.container;
    if (!el) return null;
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    const pos = Math.max(0, Math.min(Math.round(el.scrollTop), maxTop));
    if (which === 'start') state.rangeStart = pos;
    else state.rangeEnd = pos;

    // 两个锚点都到位后校验有效性：起点必须严格小于终点，
    // 且区间不能短于最小长度，否则拒绝并清空，避免出现死循环区间
    if (state.rangeStart != null && state.rangeEnd != null) {
      if (state.rangeEnd - state.rangeStart < CONSTANTS.MIN_RANGE_SPAN) {
        state.rangeStart = null;
        state.rangeEnd = null;
        publishState();
        return null;
      }
    }
    publishState();
    return pos;
  }

  function clearRange() {
    state.rangeStart = null;
    state.rangeEnd = null;
    // 区间被清除时若正处于停留/回弹，立即回到整页滚动模式
    if (state.phase === 'dwelling' || state.phase === 'returning') {
      cancelDwell();
      state.phase = 'down';
      state.lastTick = 0;
    }
    publishState();
  }

  function setRangeDwell(ms) {
    const n = Number(ms);
    state.rangeDwellMs = Number.isFinite(n)
      ? Math.max(CONSTANTS.MIN_RANGE_DWELL_MS, Math.min(CONSTANTS.MAX_RANGE_DWELL_MS, n))
      : CONSTANTS.DEFAULT_RANGE_DWELL_MS;
    try {
      chrome.storage?.sync?.set({ rangeDwellMs: state.rangeDwellMs }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 忽略存储异常 */ }
    publishState();
  }

  function snapshot() {
    // 进度为每次调用时实时读取，不缓存：snapshot 也用于响应 QUERY_STATE，
    // 此时必须拿到当下真实位置，不能返回过期的节流值
    const p = readProgress();
    return {
      isScrolling: state.isScrolling,
      isPaused: state.isPaused,
      speed: state.speed,
      // 手势临时降速时的实际速度。slowdown 档下与 speed 不同，
      // UI 应显示实际值而非用户设定值，否则「明明设了 600 却只有 300」无从解释
      effectiveSpeed: effectiveSpeed(),
      slowed: state.speedFactor !== 1,
      step: state.step,
      gesturePolicy: state.gesturePolicy,
      loopEnabled: state.loopEnabled,
      loopCount: state.loopCount,
      phase: state.phase,
      progress: p.progress,
      remaining: p.remaining,
      rangeStart: state.rangeStart,
      rangeEnd: state.rangeEnd,
      rangeActive: rangeActive(),
      rangeDwellMs: state.rangeDwellMs,
      suspectedInfinite: state.suspectedInfinite,
      // 容器失败原因。null 表示一切正常或尚未诊断，
      // 非null 时 UI 应把它显示为对「为什么滚不动」的明确解释
      containerIssue: state.containerIssue,
      scanFailures: state.scanFailures,
      // 触底自动翻页
      autoNextEnabled: state.autoNextEnabled,
      autoNextSites: state.autoNextSites.slice(),
      autoNextCount: state.autoNextCount,
      // 非null 表示已找到候选链接、正在等待取消窗口结束
      autoNextArmed: state.autoNextArmed ? state.autoNextArmed.text : null,
      // 倒计时到点自动停。remainingMs 为 0 表示未启用或已到期
      stopAfterMinutes: state.stopAfterMinutes,
      stopAfterRemainingMs: stopAfterRemainingMs()
    };
  }

  /* ============================================================
     状态上报节流
     控制类变更（启停/调速/切策略/锚点）必须即时送达，
     而 progress / remaining 每帧都在变。若不加区分地每帧上报，
     background 与所有打开的扩展页会被推爆。
     故拆成两个入口：publishState 即时、publishProgress 节流。
     ============================================================ */
  function publishState(){
    emitState();
  }

  function publishProgress(){
    const now = Date.now();
    if (now - state.lastProgressPublish < CONSTANTS.PROGRESS_PUBLISH_THROTTLE_MS) return;
    state.lastProgressPublish = now;
    emitState();
  }

  function emitState(){
    const payload = snapshot();
    try {
      chrome.runtime.sendMessage({ type: 'STATE_UPDATE', payload }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 忽略发送失败 */ }
    window.dispatchEvent(new CustomEvent('slowscroll:state', { detail: payload }));
  }

  /* ============================================================
     消息处理
     ============================================================ */

  /* 由 background 转发的控制方法调用（悬浮条 → background → 活动 frame）。
     方法名来自消息，必须走白名单：消息内容不可信，
     盲目 this[method](...args) 等于把引擎的控制面敞开。 */
  const REMOTE_METHODS = new Set([
    'toggleStartStop', 'togglePauseResume', 'toggleLoop',
    'adjustSpeed', 'setSpeed', 'scrollToTop',
    'setAutoNext', 'cancelAutoNext'
  ]);

  // 处理来自 background/popup 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case 'RUN_ENGINE_METHOD': {
        const m = message.method;
        const engine = window.__slowScrollEngine;
        if (typeof m !== 'string' || !REMOTE_METHODS.has(m)
            || !engine || typeof engine[m] !== 'function') {
          sendResponse({ ok: false, error: 'method_not_allowed' });
          break;
        }
        const args = Array.isArray(message.args) ? message.args : [];
        let result;
        try {
          result = engine[m](...args);
        } catch (e) {
          sendResponse({ ok: false, error: 'invoke_failed' });
          break;
        }
        sendResponse({ ok: true, payload: snapshot(), result: result ?? null });
        break;
      }
      case 'TOGGLE_START_STOP':
        toggleStartStop();
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'TOGGLE_PAUSE_RESUME':
        togglePauseResume();
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'SET_SPEED':
        setSpeed(message.payload?.speed ?? state.speed, {
          persist: message.persist === true || message.payload?.persist === true
        });
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'ADJUST_SPEED':
        adjustSpeed(message.delta ?? 0, {
          persist: message.persist === true || message.payload?.persist === true
        });
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'STEP_SPEED':
        // 快捷键调速：由引擎按自身step 步进，background 不再硬编码 50
        stepSpeed(message.direction ?? 1);
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'SET_GESTURE_POLICY':
        setGesturePolicy(message.payload?.policy ?? message.policy, {
          persist: message.persist === true || message.payload?.persist === true
        });
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'CAPTURE_ANCHOR':
        captureAnchor(message.payload?.which ?? message.which);
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'CLEAR_RANGE':
        clearRange();
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'SET_RANGE_DWELL':
        setRangeDwell(message.payload?.ms ?? message.ms);
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'SET_LOOP':
        setLoop(message.payload?.enabled ?? message.enabled ?? false, {
          persist: message.persist === true || message.payload?.persist === true
        });
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'TOGGLE_LOOP':
        toggleLoop();
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'SCROLL_TO_TOP':
        scrollToTop();
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'SET_AUTO_NEXT':
        setAutoNext(message.payload?.enabled ?? message.enabled ?? false, {
          persist: message.persist === true || message.payload?.persist === true
        });
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'SET_AUTO_NEXT_SITES':
        setAutoNextSites(message.payload?.sites ?? message.sites ?? [], {
          persist: message.persist === true || message.payload?.persist === true
        });
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'CANCEL_AUTO_NEXT':
        cancelAutoNext();
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'SET_STOP_AFTER':
        setStopAfterMinutes(message.payload?.minutes ?? message.minutes, {
          persist: message.persist === true || message.payload?.persist === true
        });
        sendResponse({ ok: true, payload: snapshot() });
        break;
      case 'QUERY_STATE':
        sendResponse({ ok: true, payload: snapshot() });
        break;
      default:
        break;
    }
  });

  // 标签页切回前台时重置时间基准，避免 rAF 停摆造成的巨量 dt
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) state.lastTick = 0;
  });

  /* ============================================================
     用户手势接管
     引擎持续写 scrollTop 会与用户的手动滚动互相拉锯，表现为「滚着滚着被拽回去」。
     这里不做静默夺权，而是在检测到明确的滚动意图时把控制权交还给用户。

     交还的力度由 gesturePolicy 决定：
       pause    — 一有滚轮就停，长文阅读时过于激进（历史行为）
       slowdown — 临时降速到一半，让用户能跟读，松手后自动恢复
       ignore   — 不响应，适合只想单向自动滚动的场景
     ============================================================ */
  function onUserScrollIntent() {
    if (!state.isScrolling || state.isPaused) return;
    // 武装中的自动翻页优先响应：用户一旦动手就说明他接管了，
    // 此时再把他送去下一章是不可接受的
    if (state.autoNextArmed) {
      cancelAutoNext();
      return;
    }
    if (state.gesturePolicy === 'ignore') return;
    if (state.gesturePolicy === 'slowdown') {
      slowDownTemporarily();
      return;
    }
    pauseScrolling();
  }

  // 悬浮条自身的交互不算用户滚动意图，否则点击 +/- 会被误判为接管
  function isOwnOverlay(target) {
    return !!(target && typeof target.closest === 'function'
      && target.closest('#slowScroll-overlay'));
  }

  window.addEventListener('wheel', (e) => {
    if (isOwnOverlay(e.target)) return;
    onUserScrollIntent();
  }, { passive: true, capture: true });

  window.addEventListener('touchstart', (e) => {
    if (isOwnOverlay(e.target)) return;
    onUserScrollIntent();
  }, { passive: true, capture: true });

  window.addEventListener('touchmove', (e) => {
    if (isOwnOverlay(e.target)) return;
    onUserScrollIntent();
  }, { passive: true, capture: true });

  window.addEventListener('keydown', (e) => {
    // 组合键归扩展自身或页面其他功能，不做接管
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!CONSTANTS.USER_SCROLL_KEYS.includes(e.key)) return;
    onUserScrollIntent();
  }, true);

  // 读取全局配置：循环开关 / 速度步进 / 默认速度 / 会话速度 / 手势策略 / 区间停留
  // 兼容旧键名speedStep：首次读到旧键时迁移为 step
  try {
    chrome.storage?.sync?.get(
      {
        loopEnabled: false,
        step: CONSTANTS.DEFAULT_STEP,
        defaultSpeed: CONSTANTS.DEFAULT_SPEED,
        speedStep: null, // 旧版本遗留键，仅用于迁移
        // 会话速度优先于 defaultSpeed：用户上次调到的速度才是他想要的
        [CONSTANTS.SPEED_SESSION_KEY]: null,
        gesturePolicy: CONSTANTS.DEFAULT_GESTURE_POLICY,
        rangeDwellMs: CONSTANTS.DEFAULT_RANGE_DWELL_MS,
        // 自动翻页默认关闭：不可逆操作不得替用户做主
        autoNextPage: false,
        autoNextSites: [],
        stopAfterMinutes: CONSTANTS.DEFAULT_STOP_AFTER_MINUTES
      },
      (items) => {
        if (!items) return;
        // 迁移：旧键存在且新键仍是默认值 → 提升为 step
        if (items.speedStep != null && items.step === CONSTANTS.DEFAULT_STEP) {
          const migrated = Math.max(
            CONSTANTS.MIN_STEP,
            Number(items.speedStep) || CONSTANTS.DEFAULT_STEP
          );
          state.step = migrated;
          try {
            // 必须同时移除旧键：否则用户日后把 step 调回默认值时，
            // 残留的 speedStep 会再次被当成迁移源，把设置「复活」成旧值。
            chrome.storage.sync.set({ step: migrated }, () => {
              void chrome.runtime.lastError;
              chrome.storage.sync.remove('speedStep', () => {
                void chrome.runtime.lastError;
              });
            });
          } catch (e) { /* 忽略 */ }
        } else {
          const s = Number(items.step);
          state.step = Number.isFinite(s) && s >= CONSTANTS.MIN_STEP ? s : CONSTANTS.DEFAULT_STEP;
        }

        state.loopEnabled = !!items.loopEnabled;
        state.gesturePolicy = normalizePolicy(items.gesturePolicy);
        state.autoNextEnabled = !!items.autoNextPage;
        state.autoNextSites = normalizeSiteList(items.autoNextSites);
        state.stopAfterMinutes = clampStopAfterMinutes(items.stopAfterMinutes);
        const dwell = Number(items.rangeDwellMs);
        state.rangeDwellMs = Number.isFinite(dwell)
          ? Math.max(CONSTANTS.MIN_RANGE_DWELL_MS, Math.min(CONSTANTS.MAX_RANGE_DWELL_MS, dwell))
          : CONSTANTS.DEFAULT_RANGE_DWELL_MS;

        // 速度优先级：会话速度 > 默认速度 > 常量默认。
        // 仅在未滚动时套用，避免正在进行的会话被配置覆盖
        if (!state.isScrolling) {
          const session = Number(items[CONSTANTS.SPEED_SESSION_KEY]);
          const fallback = Number(items.defaultSpeed);
          const chosen = Number.isFinite(session) && session > 0
            ? session
            : (Number.isFinite(fallback) ? fallback : CONSTANTS.DEFAULT_SPEED);
          state.speed = clampSpeed(chosen);
        }
        publishState();
      }
    );
  } catch (e) { /* 忽略存储异常 */ }

  /* ============================================================
     配置热更新：设置页保存后当前标签页立即生效，无需刷新
     ============================================================ */
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'sync' || !changes) return;
      const C2 = CONSTANTS;
      if (changes.gesturePolicy) {
        state.gesturePolicy = normalizePolicy(changes.gesturePolicy.newValue);
        if (state.gesturePolicy !== 'slowdown') clearSlowdown();
        publishState();
      }
      if (changes.rangeDwellMs) {
        const d = Number(changes.rangeDwellMs.newValue);
        state.rangeDwellMs = Number.isFinite(d)
          ? Math.max(C2.MIN_RANGE_DWELL_MS, Math.min(C2.MAX_RANGE_DWELL_MS, d))
          : C2.DEFAULT_RANGE_DWELL_MS;
        publishState();
      }
      // defaultSpeed 只影响尚未开始的会话，不打断正在进行的滚动
      if (changes.defaultSpeed && !state.isScrolling) {
        const s = Number(changes.defaultSpeed.newValue);
        if (Number.isFinite(s)) {
          state.speed = clampSpeed(s);
          publishState();
        }
      }
      // 自动翻页 / 倒计时：设置页保存后当前标签页立即生效。
      // 关闭翻页要立即撤销已武装的候选，否则用户关了开关仍会被带走。
      if (changes.autoNextPage) {
        state.autoNextEnabled = !!changes.autoNextPage.newValue;
        if (!state.autoNextEnabled) cancelAutoNext(true);
        publishState();
      }
      if (changes.autoNextSites) {
        state.autoNextSites = normalizeSiteList(changes.autoNextSites.newValue);
        publishState();
      }
      if (changes.stopAfterMinutes) {
        state.stopAfterMinutes = clampStopAfterMinutes(changes.stopAfterMinutes.newValue);
        if (state.isScrolling) startStopAfter();
        else cancelStopAfter();
        publishState();
      }
    });
  } catch (e) { /* 忽略监听失败 */ }

  // 导出到全局，避免重复初始化
  window.__slowScrollEngine = {
    startScrolling,
    stopScrolling,
    pauseScrolling,
    resumeScrolling,
    setSpeed,
    adjustSpeed,
    stepSpeed,
    setLoop,
    toggleLoop,
    setGesturePolicy,
    scrollToTop,
    captureAnchor,
    clearRange,
    setRangeDwell,
    setStopAfterMinutes,
    setAutoNext,
    setAutoNextSites,
    cancelAutoNext,
    // 测试与调试入口：把「武装」与「点击」拆成两步，
    // 才能在 Node 层验证取消窗口而不真的发生导航
    debugFindNextLink: findNextLink,
    debugTryAutoNext: tryAutoNext,
    toggleStartStop,
    togglePauseResume,
    reselectContainer: () => {
      state.container = selectScrollContainer();
      state.lastScanAt = 0;
      state.scanFailures = 0;
      // 手动重选同样是一次「恢复」：不清理的话界面上会一直挂着
      // 上一次的失败原因，而引擎其实已经不再受阻
      clearContainerIssue();
      return state.container;
    },
    // 本 frame 是否具备可滚动内容。
    // 顶层悬浮条据此决定命令走「直连本地引擎」还是「经 background 定向到活动 frame」：
    // iframe 正文页上顶层引擎存在却滚不动，直连会让用户「点了没反应」。
    // 只读已缓存的容器 + 廉价的连通性判断，不触发全量扫描。
    hasScrollableContent: () => {
      const el = state.container;
      if (el && el.isConnected) return isScrollable(el);
      return false;
    },
    getState: () => state,
    getSnapshot: snapshot
  };

  console.log('[SlowScroll] engine initialized');
}