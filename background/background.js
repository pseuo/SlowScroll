// 背景脚本：处理命令、注入脚本、管理与转发消息
// 说明：命名使用英文，注释使用中文

/* ============================================================
   常量
   Service Worker 不在 content_scripts 的注入列表里，拿不到
   shared/constants.js 的全局对象。动态 import 同一文件而非复制一份数值：
   复制即意味着两处会漂移，那正是项目明令禁止的情形。
   import() 是异步的，故用一个永不 reject 的 Promise 兜底，
   取值时用 ?? 退回保守默认 —— 宁可超时阈值偏大，也不能让消息永无返回。
   ============================================================ */
const C = import(chrome.runtime.getURL('shared/constants.js'))
  .then(() => globalThis.__SLOWSCROLL_CONSTANTS__ || {})
  .catch(() => ({}))
  // 每次取值都 await 同一个 Promise，开销可忽略
  .then((v) => { globalThis.__SS_C__ = v; });

async function constants() {
  await C;
  return globalThis.__SS_C__ || {};
}

/* ============================================================
   超时包装
   页面正在导航、Service Worker 刚被回收、或标签页正在关闭时，
   chrome.tabs.sendMessage 可能长时间不返回。没有超时的话，
   popup 会一直停在「等待中」，用户表现为界面卡死。
   Promise.race 只能保证「不等」，不能取消底层调用 ——
   迟到的响应会被丢弃，这正是期望行为（那时状态早已过时）。
   ============================================================ */
const TIMEOUT_FALLBACK = { MESSAGE_TIMEOUT_MS: 300, INJECT_TIMEOUT_MS: 2000 };

function withTimeout(promise, ms, fallbackValue) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallbackValue);
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallbackValue);
      }
    );
  });
}

/* ============================================================
   状态表：tabId -> frameId -> { payload, ts }
   all_frames 打开后一个页面会有多个引擎实例，各自上报状态。
   以 frameId 维度存储而非直接覆盖，才能在多个 frame 同时上报时
   保住「哪个 frame 正在滚」这一信息。
   ============================================================ */
const FRAME_STATES = new Map();   // tabId -> Map<frameId, { payload, ts }>
const INJECTED_TABS = new Set();  // 已确认注入成功的 tabId，避免重复注入

function frameMap(tabId, create = false) {
  let m = FRAME_STATES.get(tabId);
  if (!m && create) {
    m = new Map();
    FRAME_STATES.set(tabId, m);
  }
  return m;
}

function recordState(tabId, frameId, payload) {
  const m = frameMap(tabId, true);
  m.set(frameId, { payload, ts: Date.now() });
}

/* 选出「活动 frame」：优先正在滚动的那个，其次最近上报的。
   popup 与控制消息都以它为准，避免用户在 iframe 正文页操作时
   命令发给了顶层那个「滚不动」的 frame。 */
function activeFrame(tabId) {
  const m = FRAME_STATES.get(tabId);
  if (!m || m.size === 0) return { frameId: 0, payload: null };
  const c = constantsSync();
  const ttl = c.FRAME_STATE_TTL_MS ?? 30000;

  let scrolling = null;
  let freshest = null;
  const now = Date.now();
  for (const [frameId, entry] of m) {
    if (entry.payload?.isScrolling) {
      if (!scrolling || entry.ts > scrolling.ts) scrolling = { frameId, entry };
    }
    // 非滚动状态会过期：iframe 被移除后不会再发消息，
    // 留着会让活动 frame 一直指向一个已经不存在的文档
    if (!entry.payload?.isScrolling && (now - entry.ts) > ttl) continue;
    if (!freshest || entry.ts > freshest.ts) freshest = { frameId, entry };
  }
  const pick = scrolling || freshest;
  return pick ? { frameId: pick.frameId, payload: pick.entry.payload } : { frameId: 0, payload: null };
}

// 同步读取常量：import() 已在模块顶层启动，
// 绝大多数调用发生在扩展运行数秒之后，此时常量必然已就绪。
// 未就绪时退回保守默认，而不是让消息链卡死。
function constantsSync() {
  return globalThis.__SS_C__ || TIMEOUT_FALLBACK;
}

// 工具：获取当前活动tab
async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  } catch (e) {
    return null;
  }
}

// 工具：判断 content 脚本是否已就绪（用一次轻量 QUERY_STATE 探测）
async function isContentReady(tabId) {
  const c = constantsSync();
  try {
    const resp = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'QUERY_STATE' }),
      c.MESSAGE_TIMEOUT_MS ?? TIMEOUT_FALLBACK.MESSAGE_TIMEOUT_MS,
      null
    );
    return !!(resp && resp.ok);
  } catch (e) {
    // 接收端不存在（未注入 / 页面正在跳转 / 受限页面）
    return false;
  }
}

// 工具：确保 content 脚本已注入。
// 采用「先探测后注入」，避免每次消息都重复 executeScript —— 滑块拖动等高频操作会引发大量无谓注入。
async function ensureContentInjected(tabId) {
  if (INJECTED_TABS.has(tabId) && await isContentReady(tabId)) {
    return true;
  }
  const c = constantsSync();
  try {
    await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        files: [
          // 常量必须最先注入：引擎启动时即读取，缺失会直接抛错中止
          'shared/constants.js',
          'content/overlay.js',
          'content/scrollEngine.js'
        ]
      }),
      // 注入要读文件并建隔离世界，比普通消息慢得多，用独立阈值
      c.INJECT_TIMEOUT_MS ?? TIMEOUT_FALLBACK.INJECT_TIMEOUT_MS,
      null
    );
    INJECTED_TABS.add(tabId);
    return true;
  } catch (e) {
    console.warn('[SlowScroll] inject failed', e);
    INJECTED_TABS.delete(tabId);
    throw e;
  }
}

// 发送控制消息到tab
async function sendToTab(tabId, message) {
  const c = constantsSync();
  try {
    return await withTimeout(
      chrome.tabs.sendMessage(tabId, message),
      c.MESSAGE_TIMEOUT_MS ?? TIMEOUT_FALLBACK.MESSAGE_TIMEOUT_MS,
      null
    );
  } catch (err) {
    // 页面导航中 / 未注入 / 标签页已关闭，均属正常情况
    return null;
  }
}

// 标签页关闭时释放缓存，避免状态表无限增长
chrome.tabs.onRemoved.addListener((tabId) => {
  FRAME_STATES.delete(tabId);
  INJECTED_TABS.delete(tabId);
});

/* 向所有扩展页（popup / options）推送状态。
   无接收端时 sendMessage 会触发回调，此时读取 lastError 静默消化。
   seq 单调递增：popup 据此丢弃乱序到达的旧快照。
   并发多个 frame 上报时，只有活动 frame 的状态会被广播 ——
   合并窗口内的重复上报不再逐条推送。 */
function broadcastState(payload, tabId) {
  stateSeq += 1;
  const seq = stateSeq;
  scheduleBroadcast(payload, tabId, seq);
}

let stateSeq = 0;
// 同一 tabId 只保留一个待发定时器：N 个 frame 初始化时会同时上报，
// 逐条广播会放大成 N×N 次跨进程投递
const BROADCAST_PENDING = new Map();

function scheduleBroadcast(payload, tabId, seq) {
  if (BROADCAST_PENDING.has(tabId)) {
    // 已有待发：用更新的快照与序号覆盖
    const prev = BROADCAST_PENDING.get(tabId);
    prev.payload = payload;
    prev.seq = seq;
    return;
  }
  const entry = { payload, seq };
  entry.timer = setTimeout(() => {
    BROADCAST_PENDING.delete(tabId);
    try {
      chrome.runtime.sendMessage({
        type: 'STATE_BROADCAST',
        payload: entry.payload,
        tabId,
        seq: entry.seq
      }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 无扩展页打开时忽略 */ }
  }, constantsSync().BROADCAST_DEBOUNCE_MS ?? 50);
  BROADCAST_PENDING.set(tabId, entry);
}

// 标签页导航后原content 上下文失效，注入标记需作废
// 同时监听 url：SPA 的 pushState / replaceState 不会触发 status=loading，
// 若只等 loading，缓存会跨页面残留，导致 popup 读到上一个页面的状态
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    INJECTED_TABS.delete(tabId);
    FRAME_STATES.delete(tabId);
    const pending = BROADCAST_PENDING.get(tabId);
    if (pending) {
      clearTimeout(pending.timer);
      BROADCAST_PENDING.delete(tabId);
    }
  }
});

/* ============================================================
   快捷键命令
   调速通过 STEP_SPEED 委派给引擎，由引擎按自身 step 步进，
   不再在 background 硬编码 50，保证与设置页「速度步进」一致
   ============================================================ */
chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;

  // 受限页面（chrome:// 、扩展商店等）无法注入，直接退出
  try {
    await ensureContentInjected(tab.id);
  } catch (e) {
    return;
  }

  // 与 popup 走同一套定向逻辑：命令必须落到活动 frame 上。
  // 快捷键是用户在该 frame 的内容里按下的，语义上本就指向那个 frame。
  const active = activeFrame(tab.id);
  const target = active.payload ? active.frameId : 0;
  const c = constantsSync();
  const send = (msg) => withTimeout(
    chrome.tabs.sendMessage(tab.id, msg, { frameId: target }),
    c.MESSAGE_TIMEOUT_MS ?? TIMEOUT_FALLBACK.MESSAGE_TIMEOUT_MS,
    null
  ).catch(() => null);

  switch (command) {
    case 'start_stop':
      await send({ type: 'TOGGLE_START_STOP' });
      break;
    case 'pause_resume':
      await send({ type: 'TOGGLE_PAUSE_RESUME' });
      break;
    case 'speed_up':
      await send({ type: 'STEP_SPEED', direction: 1 });
      break;
    case 'speed_down':
      await send({ type: 'STEP_SPEED', direction: -1 });
      break;
    case 'toggle_loop':
      await send({ type: 'TOGGLE_LOOP' });
      break;
    default:
      break;
  }
});

/* ============================================================
   消息路由
   content 侧的控制消息一律直连 window.__slowScrollEngine，
   不会经过 background，因此这里只保留状态上报与 popup 转发两类
   ============================================================ */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ---- 来自 content 的状态上报 ----
  if (sender.tab) {
    const tabId = sender.tab.id;
    // sender.frameId 区分同一页面里的不同 frame。
    // 顶层恒为 0，子 frame 为正数
    const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;

    if (message?.type === 'STATE_UPDATE') {
      recordState(tabId, frameId, message.payload);
      INJECTED_TABS.add(tabId);
      // 只广播活动 frame 的状态：popup 显示的是「正在滚动的那一个」，
      // 而不是最后上报的那个（iframe 可能晚于顶层初始化）
      const active = activeFrame(tabId);
      if (active.frameId === frameId) broadcastState(message.payload, tabId);
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'REACHED_BOTTOM') {
      sendResponse({ ok: true });
      return false;
    }

    return false;
  }

  // ---- 来自页面悬浮条的命令 ----
  // 悬浮条只挂在顶层，但滚动内容可能在 iframe 里。
  // 这里把它定向到活动 frame，让顶层那一条控制条驱动真正在滚的那个 frame。
  if (message?.from === 'overlay' && message?.type === 'OVERLAY_COMMAND') {
    (async () => {
      const tab = await getActiveTab();
      if (!tab || tab.id == null) {
        return sendResponse({ ok: false, error: 'no_active_tab' });
      }
      // 白名单：content 脚本的消息天然不可信，
      // 只放行引擎真实存在的控制方法，杜绝任意属性调用
      const ALLOWED = new Set([
        'toggleStartStop', 'togglePauseResume', 'toggleLoop',
        'adjustSpeed', 'setSpeed', 'scrollToTop',
        'setAutoNext', 'cancelAutoNext'
      ]);
      const method = message.method;
      const args = Array.isArray(message.args) ? message.args : [];
      if (typeof method !== 'string' || !ALLOWED.has(method)) {
        return sendResponse({ ok: false, error: 'method_not_allowed' });
      }

      const tabId = tab.id;
      try {
        await ensureContentInjected(tabId);
        const active = activeFrame(tabId);
        const target = active.payload ? active.frameId : 0;
        const c = constantsSync();
        const resp = await withTimeout(
          chrome.tabs.sendMessage(tabId, {
            type: 'RUN_ENGINE_METHOD',
            method,
            args
          }, { frameId: target }),
          c.MESSAGE_TIMEOUT_MS ?? TIMEOUT_FALLBACK.MESSAGE_TIMEOUT_MS,
          null
        ).catch(() => null);
        return sendResponse(resp || { ok: true });
      } catch (e) {
        return sendResponse({ ok: false, error: 'inject_failed' });
      }
    })();
    return true;
  }

  // ---- 来自 popup 的请求 ----
  if (message?.from === 'popup') {
    (async () => {
      const tab = await getActiveTab();
      if (!tab || tab.id == null) {
        return sendResponse({ ok: false, error: 'no_active_tab' });
      }

      const tabId = tab.id;
      try {
        // QUERY_STATE 优先走缓存，避免拖动滑块时的无谓注入与等待。
        // 取活动 frame 的状态：iframe 正文页上顶层往往「滚不动」，
        // 直接返回顶层快照会让 popup 显示成未滚动
        if (message.type === 'QUERY_STATE') {
          const active = activeFrame(tabId);
          if (active.payload) {
            return sendResponse({ ok: true, payload: active.payload, seq: stateSeq });
          }
          await ensureContentInjected(tabId);
          const resp = await sendToTab(tabId, { type: 'QUERY_STATE' });
          return sendResponse(resp || { ok: true, payload: null, seq: stateSeq });
        }

        // 控制类。消息体原样转发：引擎自行解析 payload 与 persist，
        // background 不解释业务字段，避免多一处可能拼错的映射
        await ensureContentInjected(tabId);

        // 定向发给活动 frame。iframe 正文页里命令必须落到 iframe 的引擎上，
        // 否则顶层那个「滚不动」的实例会把命令吃掉，用户表现为点了没反应。
        // 发送时带上最新的 seq，让 popup 能丢弃乱序的旧响应。
        const active = activeFrame(tabId);
        const target = active.payload ? active.frameId : 0;
        const c = constantsSync();
        let resp;
        try {
          resp = await withTimeout(
            chrome.tabs.sendMessage(tabId, {
              type: message.type,
              payload: message.payload,
              // persist 提升到顶层，供引擎的 message.persist 直接判定
              persist: message.persist,
              delta: message.delta,
              direction: message.direction
            }, { frameId: target }),
            c.MESSAGE_TIMEOUT_MS ?? TIMEOUT_FALLBACK.MESSAGE_TIMEOUT_MS,
            null
          );
        } catch (e) {
          resp = null;
        }
        return sendResponse(resp || { ok: true, seq: stateSeq });
      } catch (e) {
        return sendResponse({ ok: false, error: 'inject_failed' });
      }
    })();

    return true; // 声明异步响应
  }

  return false;
});