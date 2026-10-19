/* ============================================================
   迷你 DOM —— popup / options / overlay 交互自测的运行环境
   ============================================================

   为什么不用现成的 DOM 库：项目刻意零运行时依赖、零构建，
   为了跑测试引入 jsdom 会让「无构建」这条约束名存实亡。
   这里用 ~400 行实现测试所需的最小子集：

     · HTML 解析（含 void 元素、注释、script/style 原文跳过）
     · innerHTML 解析（overlay 靠它拼装控制条）
     · 选择器：tag / #id / .class / [attr] / 后代组合 / 逗号分组
     · 事件：addEventListener + 捕获冒泡 + 键盘/鼠标/自定义事件
     · classList / style 自定义属性 / dataset / animate 空实现
     · chrome.storage.sync、runtime 消息、onChanged 的行为级桩

   刻意不做：布局、样式计算、异步微任务调度。
   显隐与过渡仍由浏览器层验证，本桩只管「点击后状态与消息对不对」。
   ============================================================ */

/* ---------- HTML 解析 ---------- */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);
// 内容按纯文本处理：解析器不建子节点，避免脚本/CSS 文本污染 textContent
const RAW_TAGS = new Set(['script', 'style']);

// 标签内出现 '>' 的场合只有属性值中的引号，扫描时跳过引号即可
function findTagEnd(html, start) {
  let i = start + 1;
  let quote = null;
  while (i < html.length) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
    i++;
  }
  return html.length;
}

function parseAttributes(raw) {
  const attrs = {};
  const re = /([^\s=/>"']+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const val = m[3] !== undefined ? m[3]
      : m[4] !== undefined ? m[4]
        : m[5] !== undefined ? m[5] : '';
    attrs[m[1]] = decodeEntities(val);
  }
  return attrs;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[body] !== undefined ? ENTITIES[body] : all;
  });
}

function serializeAttrs(attrs) {
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    out += v === '' ? ` ${k}=""` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`;
  }
  return out;
}

/* ---------- 文本节点 ---------- */

class MiniText {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentNode = null;
  }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get outerHTML() { return this.data; }
}

/* ---------- 元素 ---------- */

// 每个元素可有独立的矩形；未指定时给一个覆盖视口的矩形，
// 这样「元素在视口内」这类判定默认成立，测试要否定时再显式覆盖
function optsRect() {
  return this._rect || { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 };
}

class MiniElement {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = null;

    this._listeners = new Map();
    this._props = {};
    this.style = createStyle();
    this.dataset = createDataset(this);

    // 布局相关的几何接口。桩里没有真实布局，返回固定值即可 ——
    // 凡是用到坐标做判定的地方（可见面积、命中测试），
    // 该由哪一层负责已在对应测试里显式覆盖，不依赖桩算坐标。
    this.getBoundingClientRect = () => optsRect();
    this.getClientRects = () => optsRect() ? [optsRect()] : [];

    // 表单控件属性以 property 形式落地：脚本读写的正是 property
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selected = false;
    this.offsetWidth = 100;
    this.offsetHeight = 40;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 800;
    this.clientHeight = 800;
    this.clientWidth = 1280;
    this.isConnected = true;
    this._rect = null;
  }

  /* ---- 属性 ---- */
  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attributes[key] = String(value);
    // value 属性是初值来源；后续以 property 为准
    if (key === 'value' && this._props.value === undefined) this.value = String(value);
    if (key === 'checked') this._props.checked = true;
    if (key === 'disabled') this.disabled = true;
    if (key === 'hidden') this.hidden = true;
    if (key === 'selected') this.selected = true;
  }
  getAttribute(name) {
    const key = String(name).toLowerCase();
    return key in this.attributes ? this.attributes[key] : null;
  }
  hasAttribute(name) { return String(name).toLowerCase() in this.attributes; }
  removeAttribute(name) { delete this.attributes[String(name).toLowerCase()]; }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get classList() {
    const self = this;
    const list = () => (self.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const write = (arr) => self.setAttribute('class', arr.join(' '));
    return {
      get length() { return list().length; },
      contains: (c) => list().includes(c),
      add(...cs) { write(Array.from(new Set(list().concat(cs.filter(Boolean))))); },
      remove(...cs) {
        write(list().filter((c) => !cs.includes(c)));
      },
      toggle(c, force) {
        const has = list().includes(c);
        const next = force === undefined ? !has : !!force;
        if (next) write(list().concat([c]));
        else write(list().filter((x) => x !== c));
        return next;
      }
    };
  }

  /* ---- min / max / step 直通 attribute ---- */
  get min() { return this.getAttribute('min') ?? ''; }
  set min(v) { this.setAttribute('min', v); }
  get max() { return this.getAttribute('max') ?? ''; }
  set max(v) { this.setAttribute('max', v); }
  get step() { return this.getAttribute('step') ?? ''; }
  set step(v) { this.setAttribute('step', v); }
  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.setAttribute('type', v); }

  /* ---- 树 ---- */
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    if (node.ownerDocument === undefined) node.ownerDocument = this.ownerDocument;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  scrollTo(o) {
    if (typeof o === 'number') this.scrollTop = o;
    else if (o && typeof o.top === 'number') this.scrollTop = o.top;
  }
  scrollIntoView() {}
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) {
      this.appendChild(new MiniText(String(v)));
    }
  }

  get innerHTML() { return this.childNodes.map((n) => n.outerHTML).join(''); }
  set innerHTML(html) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    for (const node of parseFragment(String(html), this.ownerDocument)) {
      this.appendChild(node);
    }
  }

  get outerHTML() {
    const tag = this.localName;
    const open = `<${tag}${serializeAttrs(this.attributes)}>`;
    if (VOID_TAGS.has(tag)) return open;
    return `${open}${this.innerHTML}</${tag}>`;
  }

  /* ---- 查询 ---- */
  descendants() {
    const out = [];
    const walk = (el) => {
      for (const c of el.childNodes) {
        if (c.nodeType !== 1) continue;
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    const groups = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    return this.descendants().filter((el) => groups.some((g) => matchSelector(el, g)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementsByTagName(tag) {
    const t = String(tag).toLowerCase();
    return this.descendants().filter((el) => t === '*' || el.localName === t);
  }
  closest(sel) {
    const groups = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    let node = this;
    while (node && node.nodeType === 1) {
      if (groups.some((g) => matchSelector(node, g))) return node;
      node = node.parentNode;
    }
    return null;
  }
  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  /* ---- 事件 ---- */
  addEventListener(type, fn, opts) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ fn, once: !!(opts && opts.once) });
  }
  removeEventListener(type, fn) {
    const arr = this._listeners.get(type);
    if (!arr) return;
    const i = arr.findIndex((h) => h.fn === fn);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(event) {
    return dispatchOn(this, event);
  }
  click() {
    return this.dispatchEvent(new MiniEvent('click', { bubbles: true }));
  }
  focus() {
    return this.dispatchEvent(new MiniEvent('focus', { bubbles: false }));
  }
  blur() {
    return this.dispatchEvent(new MiniEvent('blur', { bubbles: false }));
  }
  // Web Animations 的空实现：只求不抛错
  animate() { return { cancel() {}, finished: Promise.resolve() }; }
}

/* ---------- 事件 ---------- */

class MiniEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = init.cancelable !== false;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._stopped = false;
    for (const [k, v] of Object.entries(init)) {
      if (k === 'bubbles' || k === 'cancelable') continue;
      this[k] = v;
    }
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; this._immediate = true; }
}

function dispatchOn(target, event) {
  event.target = target;
  const chain = [];
  for (let n = target; n; n = n.parentNode) chain.push(n);
  // 元素 → … → document → window
  if (target.ownerDocument && !chain.includes(target.ownerDocument)) {
    chain.push(target.ownerDocument);
  }
  if (target.ownerDocument && target.ownerDocument.defaultView
    && !chain.includes(target.ownerDocument.defaultView)) {
    chain.push(target.ownerDocument.defaultView);
  }

  for (const node of chain) {
    event.currentTarget = node;
    const handlers = node._listeners ? node._listeners.get(event.type) : null;
    if (handlers) {
      for (const h of handlers.slice()) {
        h.fn.call(node, event);
        if (h.once && node._listeners) {
          const arr = node._listeners.get(event.type);
          const i = arr.indexOf(h);
          if (i >= 0) arr.splice(i, 1);
        }
        if (event._immediate) break;
      }
    }
    if (!event.bubbles || event._stopped) break;
  }
  return !event.defaultPrevented;
}

/* ---------- style / dataset ---------- */

function createStyle() {
  const vars = new Map();
  return {
    setProperty(k, v, priority) { vars.set(k, { value: String(v), priority: priority || '' }); },
    getPropertyValue(k) {
      return vars.has(k) ? vars.get(k).value : '';
    },
    getPropertyPriority(k) {
      return vars.has(k) ? vars.get(k).priority : '';
    },
    removeProperty(k) {
      const old = vars.has(k) ? vars.get(k).value : '';
      vars.delete(k);
      return old;
    }
  };
}

function createDataset(el) {
  return new Proxy({}, {
    get(_t, key) {
      if (typeof key !== 'string') return undefined;
      return el.getAttribute('data-' + kebab(key)) ?? undefined;
    },
    set(_t, key, value) {
      if (typeof key !== 'string') return false;
      el.setAttribute('data-' + kebab(key), value);
      return true;
    },
    has(_t, key) {
      return typeof key === 'string' && el.hasAttribute('data-' + kebab(key));
    }
  });
}
function kebab(s) {
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

/* ---------- 选择器 ---------- */

function matchSelector(el, selector) {
  const parts = selector.split(/\s+(?![^[]*\])/).filter(Boolean);
  if (!parts.length) return false;
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  let node = el.parentNode;
  for (let k = parts.length - 2; k >= 0; k--) {
    while (node && node.nodeType === 1 && !matchSimple(node, parts[k])) {
      node = node.parentNode;
    }
    if (!node) return false;
    node = node.parentNode;
  }
  return true;
}

function matchSimple(el, sel) {
  const tokens = sel.match(/^[a-zA-Z][\w-]*|#[^\s.#:[\]]+|\.[^\s.#:[\]]+|\[[^\]]+\]/g) || [];
  if (!tokens.length) return false;
  for (const tk of tokens) {
    if (tk[0] === '#') {
      if (el.id !== tk.slice(1)) return false;
    } else if (tk[0] === '.') {
      if (!el.classList.contains(tk.slice(1))) return false;
    } else if (tk[0] === '[') {
      const m = /^\[\s*([^\]=~^$*|]+)\s*(?:([~^$*|]?=)\s*"?([^"\]]*)"?)?\s*\]$/.exec(tk);
      if (!m) return false;
      const [, name, op, val] = m;
      const actual = el.getAttribute(name);
      if (actual === null) return false;
      if (op === '=' && actual !== val) return false;
      if (op === '~=' && !actual.split(/\s+/).includes(val)) return false;
    } else if (el.localName !== tk.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/* ---------- HTML 解析入口 ---------- */

function parseFragment(html, doc) {
  const root = new MiniElement('#fragment');
  root.ownerDocument = doc;
  let cur = root;
  let i = 0;

  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', i)) {
      const end = html.indexOf('>', i);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html[i] === '<' && /[a-zA-Z/]/.test(html[i + 1] || '')) {
      if (html[i + 1] === '/') {
        const end = html.indexOf('>', i);
        const tag = html.slice(i + 2, end).trim().toLowerCase();
        for (let n = cur; n && n !== root; n = n.parentNode) {
          if (n.localName === tag) { cur = n.parentNode || root; break; }
        }
        i = end === -1 ? html.length : end + 1;
        continue;
      }
      const end = findTagEnd(html, i);
      const raw = html.slice(i + 1, end);
      const m = /^([a-zA-Z][\w:-]*)/.exec(raw);
      if (!m) { i = end + 1; continue; }
      const tag = m[1].toLowerCase();
      const el = new MiniElement(tag);
      el.ownerDocument = doc;
      for (const [k, v] of Object.entries(parseAttributes(raw.slice(m[1].length)))) {
        el.setAttribute(k, v);
      }
      cur.appendChild(el);
      i = end + 1;

      if (RAW_TAGS.has(tag)) {
        const close = html.toLowerCase().indexOf(`</${tag}`, i);
        i = close === -1 ? html.length : close;
      } else if (!VOID_TAGS.has(tag) && !/\/\s*$/.test(raw)) {
        cur = el;
      }
      continue;
    }
    const next = html.indexOf('<', i);
    const end = next === -1 ? html.length : next;
    const text = html.slice(i, end);
    if (text.trim()) cur.appendChild(new MiniText(decodeEntities(text)));
    i = end;
  }

  return root.childNodes.slice();
}

/* ============================================================
   页面环境：document + window + chrome
   ============================================================ */

function createDom(html) {
  const doc = {
    nodeType: 9,
    contentType: 'text/html',
    _listeners: new Map()
  };
  const docEl = new MiniElement('html');
  docEl.ownerDocument = doc;
  doc.documentElement = docEl;
  doc.defaultView = null;

  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    _listeners: new Map(),
    scrollTo() {},
    getComputedStyle(el) {
      return {
        getPropertyValue: (k) => (el && el.style ? el.style.getPropertyValue(k) : ''),
        overflowY: (el && el.__overflowY) || 'visible',
        overflowX: (el && el.__overflowX) || 'visible'
      };
    }
  };
  doc.defaultView = win;

  // 实时遍历而非建索引表：overlay 会在运行时插入带 id 的节点，
  // 索引表必须显式刷新，而漏刷一次就是「getElementById 返回 null」，
  // 那种假阴性比慢一点更难排查。
  const allElements = () => docEl.descendants();

  doc.getElementById = (id) => allElements().find((el) => el.id === id) || null;
  doc.querySelector = (sel) => docEl.querySelector(sel);
  doc.querySelectorAll = (sel) => docEl.querySelectorAll(sel);
  doc.getElementsByTagName = (tag) => docEl.getElementsByTagName(tag);
  doc.getElementsByClassName = (cls) => docEl.querySelectorAll('.' + cls);
  doc.createElement = (tag) => {
    const el = new MiniElement(tag);
    el.ownerDocument = doc;
    return el;
  };
  doc.createTextNode = (data) => new MiniText(String(data));
  doc.addEventListener = (type, fn, opts) => {
    if (!doc._listeners.has(type)) doc._listeners.set(type, []);
    doc._listeners.get(type).push({ fn, once: !!(opts && opts.once) });
  };
  doc.removeEventListener = () => {};
  doc.dispatchEvent = (ev) => dispatchOn(doc, ev);

  win.addEventListener = (type, fn, opts) => {
    if (!win._listeners.has(type)) win._listeners.set(type, []);
    win._listeners.get(type).push({ fn, once: !!(opts && opts.once) });
  };
  win.removeEventListener = () => {};
  win.dispatchEvent = (ev) => {
    ev.target = ev.target || win;
    ev.currentTarget = win;
    const handlers = win._listeners.get(ev.type) || [];
    for (const h of handlers.slice()) h.fn.call(win, ev);
    return !ev.defaultPrevented;
  };

  for (const node of parseFragment(html, doc)) docEl.appendChild(node);
  doc.body = docEl.querySelector('body') || docEl;

  /* ---- 可控定时器：popup 的节流、悬浮条的自动隐藏都靠它推进 ---- */
  let timerSeq = 0;
  const timers = [];
  const api = {
    rafQueue: [],
    setTimeout(fn, delay = 0) {
      const id = ++timerSeq;
      timers.push({ id, fn, delay });
      return id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval() { return 0; },
    clearInterval() {}
  };

  /* ---- chrome 桩：行为级而非空壳，测试才能断言真实副作用 ---- */
  const store = Object.create(null);
  const storageLog = [];
  const chrome = {
    runtime: {
      lastError: null,
      _messageListeners: [],
      onMessage: {
        addListener(fn) { chrome.runtime._messageListeners.push(fn); }
      },
      sendMessage(msg, cb) {
        storageLog.push({ area: 'runtime.sendMessage', msg });
        const resp = chrome.runtime._responder
          ? chrome.runtime._responder(msg)
          : { ok: true, payload: { ...chrome.runtime._state } };
        if (typeof cb === 'function') queueMicrotask(() => cb(resp));
      },
      getURL: (p) => 'chrome-extension://slowscroll/' + p,
      openOptionsPage() {
        storageLog.push({ area: 'runtime.openOptionsPage' });
      }
    },
    storage: {
      sync: {
        get(defaults, cb) {
          const out = {};
          if (defaults === null || defaults === undefined) {
            Object.assign(out, store);
          } else if (typeof defaults === 'string') {
            if (defaults in store) out[defaults] = store[defaults];
          } else if (Array.isArray(defaults)) {
            for (const k of defaults) if (k in store) out[k] = store[k];
          } else {
            for (const k of Object.keys(defaults)) {
              out[k] = k in store ? store[k] : defaults[k];
            }
          }
          queueMicrotask(() => cb(out));
        },
        set(values, cb) {
          Object.assign(store, values);
          storageLog.push({ area: 'storage.sync.set', msg: { ...values } });
          if (typeof cb === 'function') queueMicrotask(cb);
        },
        remove(keys, cb) {
          for (const k of [].concat(keys)) delete store[k];
          if (typeof cb === 'function') queueMicrotask(cb);
        }
      },
      onChanged: {
        _listeners: [],
        addListener(fn) { this._listeners.push(fn); }
      }
    }
  };
  // popup 的 QUERY_STATE 响应来源
  chrome.runtime._state = {
    isScrolling: false, isPaused: false, speed: 600,
    loopEnabled: false, loopCount: 0
  };
  chrome.runtime._responder = null;

  /* ---- 定时器推进 ---- */
  api.runFrame = async (time) => {
    const fn = api.rafQueue.shift();
    if (fn) fn(time);
    await flush();
  };
  api.runTimers = async (predicate) => {
    const list = timers.slice();
    timers.length = 0;
    for (const t of list) {
      if (predicate && !predicate(t)) { timers.push(t); continue; }
      t.fn();
      await flush();
    }
  };
  api.tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const t = timers.shift();
      if (!t) break;
      t.fn();
      await flush();
    }
  };
  api.pendingTimers = () => timers.slice();

  /* ---- 事件辅助 ---- */
  api.fire = async (target, type, init = {}) => {
    target.dispatchEvent(new MiniEvent(type, { bubbles: true, ...init }));
    await flush();
  };
  // 真实 onChanged 触发时底层存储已是新值，回调只是通知。
  // 桩里若不先写入，重读 storage 拿到的还是旧值，
  // 测出来的「开关不生效」是桩的假象。
  api.storageChange = async (changes, area = 'sync') => {
    if (area === 'sync') {
      for (const [key, ch] of Object.entries(changes)) {
        if ('newValue' in ch) store[key] = ch.newValue;
        else delete store[key];
      }
    }
    for (const fn of chrome.storage.onChanged._listeners) fn(changes, area);
    await flush();
  };
  api.runtimeMessage = async (msg) => {
    for (const fn of chrome.runtime._messageListeners) fn(msg, {}, () => {});
    await flush();
  };
  api.sendLog = storageLog;

  /* ---- 沙箱：把 document / window / chrome / 定时器挂进 vm 上下文 ---- */
  // 以下在真实页面里是裸全局，只挂 window.* 会让 content 脚本
  // 直接 ReferenceError —— 这类「桩不完整」与「代码有 bug」
  // 在报错信息上长得一模一样，必须逐个补齐
  const sandbox = {
    document: doc,
    window: win,
    chrome,
    console,
    getComputedStyle: (el) => win.getComputedStyle(el),
    CustomEvent: MiniEvent,
    Event: MiniEvent,
    KeyboardEvent: MiniEvent,
    MouseEvent: MiniEvent,
    Element: MiniElement,
    Node: class Node {},
    HTMLElement: MiniElement,
    setTimeout: api.setTimeout,
    clearTimeout: api.clearTimeout,
    setInterval: api.setInterval,
    clearInterval: api.clearInterval,
    requestAnimationFrame: (fn) => { api.rafQueue.push(fn); return api.rafQueue.length; },
    cancelAnimationFrame: () => {},
    Promise, Math, Number, Date, JSON, Object, Array, String, Boolean,
    Infinity, NaN, undefined, parseInt, parseFloat, isNaN, isFinite
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // document/window 互相引用，脚本里 window.document 与裸 document 等价
  win.document = doc;
  doc.defaultView = win;

  api.sandbox = sandbox;
  api.document = doc;
  api.window = win;
  api.chrome = chrome;
  api.store = store;
  api.MiniEvent = MiniEvent;

  api.runScript = (src, filename = 'inline') => {
    const vm = require('vm');
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename });
  };

  api.ready = async () => {
    doc.dispatchEvent(new MiniEvent('DOMContentLoaded', { bubbles: false }));
    await flush();
  };

  return api;
}

/* 等待 Promise 链与微任务落定。测试里统一用 await flush() 代替 setTimeout 轮询。 */
async function flush(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

module.exports = { createDom, MiniEvent, MiniElement, flush, parseFragment };