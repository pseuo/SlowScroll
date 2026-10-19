/* ============================================================
   全局常量 · 四端唯一真源
   以普通脚本（非 ES module）产出全局对象，供 content_scripts 与
   popup / options 页面直接引用。

   约定：任何速率、区间、时长类数值一律先改本文件，
   禁止在 content / background / popup / options 中重复硬编码。
   与 storage.sync 的键名一致同属硬约束，改动需同步校验读取端。
   ============================================================ */
(function (root) {
  'use strict';

  /* ============================================================
     宿主文档类型判定
     content_scripts 的 matches 为 <all_urls>，会命中 SVG / XML /
     图片查看器等非 HTML 文档。此类文档中 document.createElement
     返回的是普通 Element（无 style 属性）、document.body 为 null，
     悬浮条一旦注入就会在 ?.style.setProperty 处抛 TypeError。
     故 content 两端共用此判定，非 HTML 文档一律不初始化。
     ============================================================ */
  const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

  root.__SLOWSCROLL_IS_HTML_DOC__ = function isHtmlDocument(doc) {
    try {
      const d = doc || root.document;
      if (!d || typeof d.createElement !== 'function') return false;
      // 主判据：contentType。SVG 为 image/svg+xml，XML 为 text/xml
      if (HTML_CONTENT_TYPES.indexOf(d.contentType) !== -1) return true;
      if (d.contentType) return false;
      // 兜底：contentType 缺失时，用「能否造出带 style 的 HTML 元素」判定。
      // 不能只看 documentElement.style —— SVGSVGElement 同样有 style 与
      // insertAdjacentHTML，用它做判据会把 SVG 文档误判为 HTML（已实测踩过）。
      return !!(d.createElement('div') || {}).style;
    } catch (e) {
      return false;
    }
  };

  root.__SLOWSCROLL_CONSTANTS__ = {
    /* ---- 速度（px/s）---- */
    MIN_SPEED: 50,
    MAX_SPEED: 4000,
    DEFAULT_SPEED: 600,
    //滑块 / 数字输入的粒度，对应 HTML 的 step 属性
    SPEED_GRANULARITY: 50,

    /* ---- 速度步进 ---- */
    DEFAULT_STEP: 50,
    MIN_STEP: 10,
    MAX_STEP: 500,

    /* ---- 滚动引擎 ---- */
    // 触底判定容差
    BOTTOM_THRESHOLD: 4,
    // 单帧最大步进秒数，防止后台标签页恢复时页面瞬移
    MAX_FRAME_DT: 0.05,
    // 触底后观察多久再决定是否回顶（给懒加载留时间）
    LOOP_GRACE_MS: 600,
    // 回顶动画时长上下限
    MIN_RETURN_MS: 350,
    MAX_RETURN_MS: 1600,
    // 「已到达底部」非 sticky 通知的节流间隔
    BOTTOM_NOTIFY_THROTTLE_MS: 1500,
    // 判定元素「真实存在溢出」的最小像素差
    SCROLLABLE_MIN_OVERFLOW: 16,

    /* ---- 性能与交互 ---- */
    // 容器有效性校验间隔（帧）。每帧 getComputedStyle 会强制样式重算，
    // 在重排代价高的页面上是主要的持续开销来源。
    CONTAINER_CHECK_INTERVAL_FRAMES: 30,
    // 触底静止后改用低频探测的间隔，替代持续空转的 rAF 主循环
    IDLE_PROBE_MS: 1000,
    // 找不到可滚动容器时的全量重扫退避：按连续失败次数指数增长。
    // 超大 DOM 页面上「每秒一次 body * 全扫描 + 逐元素 getComputedStyle」
    // 是实打实的主线程占用，退避后失败路径几乎不花钱。
    CONTAINER_SCAN_BACKOFF_BASE_MS: 1000,
    CONTAINER_SCAN_BACKOFF_MAX_MS: 8000,
    // 影子 DOM 下钻的深度与 shadow root 数量上限。
    // 无上限时，一个组件库驱动的页面可能牵出整棵子树，
    // 遍历成本会超过它解决的问题；这两项只影响极端页面。
    SHADOW_SCAN_MAX_DEPTH: 4,
    SHADOW_SCAN_MAX_ROOTS: 24,
    // 单次容器扫描的候选元素总数上限（冻结保护，仅兜底极端页面）
    CONTAINER_SCAN_MAX_ELEMENTS: 20000,

    /* ---- 多 frame（iframe 支持）---- */
    // 子 frame 的视口面积下限（px²）。低于此值通常是广告位与追踪像素，
    // 在其中初始化引擎只是白白付一次 storage 读、五个监听器和一次状态上报。
    MIN_FRAME_AREA: 40000,
    // 单次控制消息最多尝试的候选 frame 数量，防止极端页面把一次点击放大成 N 次注入
    MAX_CONTROL_CANDIDATES: 8,
    // 状态广播的合并窗口（ms）。一个页面若有 N 个 frame，初始化时会同时上报 N 次，
    // 逐条广播会放大成 N×N 次跨进程投递；合并后只广播「活动 frame」的最终状态。
    BROADCAST_DEBOUNCE_MS: 50,
    // 非滚动状态的 frame 在内存中的最长保留时间。
    // iframe 被移除后不会再发消息，留着会让活动 frame 一直指向已消失的文档。
    FRAME_STATE_TTL_MS: 30000,

    /* ---- 消息 ---- */
    // 跨进程消息的等待上限。页面正在导航、或 Service Worker 刚被回收时，
    // chrome.tabs.sendMessage 可能长时间不返回，没有超时 popup 会一直转圈。
    MESSAGE_TIMEOUT_MS: 300,
    // 注入脚本的等待上限，比普通消息慢得多（要读文件并建隔离世界）
    INJECT_TIMEOUT_MS: 2000,
    // 滚动进度（progress / remaining）随每帧变化，若每次 publishState 都带上，
    // 会把状态上报放大到帧率级别（约 60 次/秒）推给 background 与所有扩展页。
    // 进度类上报按此间隔节流，控制类（启停 / 调速 / 切策略）仍即时上报。
    PROGRESS_PUBLISH_THROTTLE_MS: 500,

    /* ---- 速度会话持久化 ---- */
    // 调速落盘的防抖间隔。滑块拖动每秒可产生数十次变更，
    // 逐次直写 storage.sync 会撞上 Chrome 每分钟 120 次的写入配额上限而静默失败。
    SPEED_PERSIST_DEBOUNCE_MS: 800,
    // 会话内「上次使用的速度」：拖动即视为用户偏好，与默认速度分开存放，
    // 避免把临时微调污染成全局默认。
    SPEED_SESSION_KEY: 'sessionSpeed',

    /* ---- 用户手势接管策略 ---- */
    // 三档策略。pause 为历史行为（一有滚轮即暂停）；slowdown 临时降速让出控制权；
    // ignore 完全不接管，适合演示 / 只想单向下滚的场景。
    GESTURE_POLICIES: ['pause', 'slowdown', 'ignore'],
    DEFAULT_GESTURE_POLICY: 'pause',
    // slowdown 档的降速系数与恢复延迟：从手势发生起保持此系数，
    // 静默 SLOWDOWN_RECOVER_MS 后自动回到用户设定速度。
    SLOWDOWN_FACTOR: 0.5,
    SLOWDOWN_RECOVER_MS: 1800,

    /* ---- 区间循环（起止锚点）---- */
    // 区间终点停留时长：滚到区间下沿后原地停留，避免立刻弹回造成频闪
    DEFAULT_RANGE_DWELL_MS: 3000,
    MIN_RANGE_DWELL_MS: 0,
    MAX_RANGE_DWELL_MS: 60000,
    // 锚点捕获时允许的最大滚动位置与最小有效区间长度。
    // 区间短于一个视口高度时来回弹跳没有意义，直接拒绝设置。
    MIN_RANGE_SPAN: 200,
    // 锚点容差：scrollTop 读数是整数且受布局抖动影响，判定到达区间边界需留容差
    RANGE_EPSILON: 8,

    /* ---- 触底自动翻页（下一章 / 下一页）----
       自动点击第三方页面的元素是不可逆操作：扩展无权替用户决定
       「读完这一章该去哪」。故必须默认关闭、由用户显式开启，
       且候选链接要过白名单锚点策略（语义标记 + 精确文案 + 同源 + 站点白名单）。
     */
    // 候选文案白名单。必须是「规范化后完全相等」而非包含匹配：
    // 正文里出现「下一章预告」三个字时，包含匹配会点中完全无关的链接。
    AUTO_NEXT_TEXTS: [
      '下一章', '下一页', '下一节', '下一卷', '下一话', '下一回',
      'next chapter', 'next page', 'next', 'continue'
    ],
    // 文案长度上限：白名单文案本身很短，超过此长度的元素一律不作为候选，
    // 防止把整个导航栏或段落文字塞进 normalize 后意外相等
    AUTO_NEXT_MAX_TEXT_LEN: 12,
    // 单次页面会话内的翻页次数上限。站点的「下一章」可能指向自身形成死链，
    // 没有上限时扩展会带着用户无限跳转，必须硬性截断
    AUTO_NEXT_MAX_PER_SESSION: 200,
    // 点击前的可撤销窗口（ms）。这段时间内用户任何接管手势都会取消本次翻页，
    // 把不可逆的跳转变成可反悔的一步
    AUTO_NEXT_CONFIRM_MS: 1500,
    // 两次翻页尝试之间的最短间隔。点击可能因站点逻辑而未发生导航，
    // 没有冷却会以 idle 的 1s 频率反复点同一个链接
    AUTO_NEXT_COOLDOWN_MS: 3000,
    // 站点白名单的最大条目数。白名单靠用户逐条手输，
    // 不设上限的话一次粘贴就能撑爆 storage.sync 的单条目配额
    AUTO_NEXT_MAX_SITES: 50,

    /* ---- 倒计时到点自动停 ---- */
    // 0 表示不启用（默认关闭）。单位：分钟。
    // 「睡前读 20 分钟」这类场景到点自动停，避免页面整夜空转。
    DEFAULT_STOP_AFTER_MINUTES: 0,
    MIN_STOP_AFTER_MINUTES: 1,
    MAX_STOP_AFTER_MINUTES: 480,
    // 倒计时的检查粒度。到点自动停只关心「到没到」，
    // 但剩余秒数要驱动界面显示，故取 1s 与显示精度对齐
    STOP_COUNTDOWN_TICK_MS: 1000,

    /* ---- 容器失败原因明示 ---- */
    // 连续扫描失败达到此次数后才做一次诊断并对外明示。
    // 诊断要读 overflow 与节点规模，比一次抽检贵得多，
    // 而开头几百毫秒的失败往往只是页面尚未渲染完成
    CONTAINER_ISSUE_REPORT_AFTER: 3,
    // 判定「疑似虚拟列表」的节点数门槛：DOM 里挂了这么多节点
    // 却没有可滚动溢出，说明内容被窗口化了
    CONTAINER_ISSUE_NODE_HINT: 400,

    /* ---- 悬浮条自动隐藏 ---- */
    // 开始滚动后延迟多久隐藏。留出一小段时间让用户看清「停止」状态的变化
    OVERLAY_HIDE_DELAY_MS: 1200,
    // 唤回后若仍在滚动，鼠标移开悬浮条多久后再次隐藏
    OVERLAY_REHIDE_IDLE_MS: 2500,
    // 右下角唤回热区边长（px）。纯坐标判定，不放置实体元素，
    // 否则会挡住宿主页面右下角的按钮
    OVERLAY_REVEAL_ZONE_SIZE: 96,
    // 用户手动滚动意图的按键白名单（需配合修饰键过滤，见 scrollEngine）
    USER_SCROLL_KEYS: ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);