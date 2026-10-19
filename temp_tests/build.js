/* ============================================================
   构建脚本：版本注入 → 压缩 → 自检 → 打包
   用法：
     node temp_tests/build.js              完整构建（默认压缩）
     node temp_tests/build.js --no-minify  跳过压缩
     node temp_tests/build.js --out dist/x.zip
     node temp_tests/build.js --check      只自检源文件，不产出

   关于「不做混淆」——这是有意的选择，理由记在 README：
     · Chrome Web Store 审核的是行为，不是可读性，混淆没有收益
     · content 脚本跑在第三方页面里，混淆后一旦线上出问题，
       用户侧只有一行乱码，既无法自证也无法上报堆栈
     · 本项目源码约 120 KB，压缩后收益以字节计，不值得用可维护性换
   真正做的是「压缩」：去注释、去缩进空白、去块级冗余，
   不改任何标识符，因此产物仍可逐行对照源码调试。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { ROOT, INCLUDE, collect, crossCheck } = require('./filelist.js');
const { writeZip } = require('./zip.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const MINIFY = !flag('--no-minify');
const CHECK_ONLY = flag('--check');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

/* ============================================================
   JS 词法扫描：压缩与自检共用同一个 tokenizer

   共用是刻意的：若校验自己再写一套正则去数字符串，
   压缩器与校验器会各自错向同一个方向，「校验通过」就成了摆设。
   token 流是唯一的语义事实来源：
     comment —— 可安全丢弃
     string / template / regex —— 必须原样保留
     code —— 可折叠空白
   ============================================================ */

// 这些关键字之后出现的 / 是正则开头而非除号
const REGEX_PREV_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'case', 'do', 'else', 'yield', 'await'
]);

function scanJs(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;

  // 连续 code 必须聚成一个 token：折叠空白时要看到左右上下文，
  // 若逐字符切分，foldCode 就永远只看到一个孤立空格。
  let buf = '';
  let bufStart = 0;
  const flush = () => {
    if (buf) tokens.push({ type: 'code', value: buf });
    buf = '';
  };

  while (i < n) {
    const ch = src[i];

    if (ch === '/' && src[i + 1] === '/') {
      flush();
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      tokens.push({ type: 'comment', value: src.slice(start, i) });
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      flush();
      const start = i;
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      tokens.push({ type: 'comment', value: src.slice(start, i) });
      continue;
    }
    if (ch === '"' || ch === "'") {
      flush();
      const start = i;
      const quote = ch;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      tokens.push({ type: 'string', value: src.slice(start, i) });
      continue;
    }
    if (ch === '`') {
      flush();
      const start = i;
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (depth === 0 && src[i] === '`') { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
        if (depth > 0 && src[i] === '}') { depth--; i++; continue; }
        i++;
      }
      tokens.push({ type: 'template', value: src.slice(start, i) });
      continue;
    }
    if (ch === '/' && isRegexStart(src, i)) {
      flush();
      const start = i;
      i++;
      let inClass = false;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; closed = true; break; }
        else if (src[i] === '\n') break;
        i++;
      }
      while (i < n && /[gimsuyd]/.test(src[i])) i++;
      tokens.push({
        type: closed ? 'regex' : 'code',
        value: src.slice(start, i)
      });
      continue;
    }

    if (!buf) bufStart = i;
    buf += ch;
    i++;
  }
  flush();
  return tokens;
}

// 上一个有意义的 token 决定 / 是除号还是正则
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const ch = src[j];
  if (/[)\]}\w$]/.test(ch)) {
    if (/[a-zA-Z]/.test(ch)) {
      let k = j;
      while (k >= 0 && /[a-zA-Z0-9_$]/.test(src[k])) k--;
      return REGEX_PREV_KEYWORDS.has(src.slice(k + 1, j + 1));
    }
    return false;
  }
  return true;
}

/* ---------- 折叠规则 ----------
   保守为主：只压行内空白与行首缩进，保留全部换行。
   换行全部保留意味着 ASI（自动分义插入）语义不可能被改变，
   这是压缩器最容易出致命错误的地方，用体积换确定性很划算。

   空格只在一处删除：两侧都不是标识符字符，且都不属于「必须留」
   的结构位置。理由是 `return x` 压成 `returnx` 语法合法但语义已变，
   这类错误语法校验抓不住，只能靠这条保守规则挡住。 */
function foldCode(code) {
  let out = '';
  let atLineStart = true;

  // 这些字符后必须留空格（如 `function(a)`、`return x`）
  const KEEP_AFTER = '([{,;:+-*/%<>=&|!?^~';
  // 这些字符前必须留空格（如 `x)`、`x,`）
  const KEEP_BEFORE = ')]},;';

  const isWordChar = (c) => !!c && /[A-Za-z0-9_$]/.test(c);

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\n') {
      out += '\n';
      atLineStart = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (atLineStart) continue;              // 行首空白直接丢
      let k = i;
      while (k < code.length && /[ \t\r]/.test(code[k])) k++;

      const prev = out[out.length - 1];
      const after = code[k];
      if (prev && after
        && (isWordChar(prev) || isWordChar(after)
          || KEEP_AFTER.includes(prev) || KEEP_BEFORE.includes(after))) {
        out += ' ';
      }
      i = k - 1;
      continue;
    }
    out += ch;
    atLineStart = false;
  }
  return out;
}

function minifyJs(src) {
  const tokens = scanJs(src);
  let out = '';
  for (const tk of tokens) {
    if (tk.type === 'comment') {
      // 块注释里的换行必须留，否则上一行尾与下一行首会被粘成一行
      if (tk.value.includes('\n')) out += '\n';
      continue;
    }
    out += tk.type === 'code' ? foldCode(tk.value) : tk.value;
  }
  return out.replace(/\n{2,}/g, '\n').trim() + '\n';
}

/* ============================================================
   CSS 压缩
   ============================================================ */
function minifyCss(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      let k = i + 1;
      while (k < n) {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === q) { k++; break; }
        k++;
      }
      out += src.slice(i, k);
      i = k;
      continue;
    }
    if (/\s/.test(ch)) {
      let k = i;
      while (k < n && /\s/.test(src[k])) k++;
      const prev = out[out.length - 1];
      const after = src[k];
      // 这些位置两侧的空格无意义，其余保留一个（选择器后代组合子必须留）
      if (prev && after && !'{};:,>+~)'.includes(prev) && !'{};:,>+~('.includes(after)) {
        out += ' ';
      }
      i = k;
      continue;
    }
    out += ch;
    i++;
  }
  return out
    .replace(/;}/g, '}')
    .replace(/}\s*/g, '}')
    .replace(/\s*{\s*/g, '{')
    .replace(/;\s*/g, ';')
    .replace(/,\s*/g, ',')
    .trim();
}

/* ============================================================
   HTML 压缩
   规则：只折叠「标签与标签之间」的空白，且必须区分块级与内联。
   折叠内联标签之间的空白会吃掉图标与文字的间距
   （<svg>…</svg> <span>播放</span> → 两者贴死），
   折叠块级标签之间的空白才会被浏览器当作可丢弃的空白。
   标签内部的空白一律不动：属性值与中文文案都依赖它。
   ============================================================ */

// 会产生块级盒子的标签：它们之间的换行不参与行内排版
const BLOCK_TAGS = new Set([
  'html', 'head', 'body', 'div', 'section', 'header', 'footer', 'main',
  'nav', 'aside', 'article', 'ul', 'ol', 'li', 'table', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'hr', 'br', 'pre',
  'title', 'style', 'script', 'link', 'meta', 'option', 'label'
]);

function minifyHtml(src) {
  let out = src
    // 条件注释（<!--[if IE]>）必须保留，其余注释可删
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, '');

  // 逐段折叠空白：判断 `> … <` 之间是否涉及内联元素
  out = out.replace(/>\s+</g, (match, offset) => {
    const before = lastTagBefore(out, offset);
    const after = firstTagAfter(out, offset + match.length);
    const inline = !BLOCK_TAGS.has(before) || !BLOCK_TAGS.has(after);
    return inline ? '> <' : '><';
  });

  return out
    .replace(/\s+\/?>/g, '>')
    .replace(/^\s+/gm, '')
    .replace(/\s+$/gm, '')
    .trim() + '\n';
}

function lastTagBefore(text, offset) {
  const m = /<([a-zA-Z][\w-]*)[^>]*$/.exec(text.slice(0, offset));
  return m ? m[1].toLowerCase() : '';
}
function firstTagAfter(text, offset) {
  const m = /^<([a-zA-Z][\w-]*)/.exec(text.slice(offset));
  return m ? m[1].toLowerCase() : '';
}

/* ============================================================
   产物自检
   压缩器本身就是一段可能出错的代码，产物必须能被独立验证。
   关键约束：校验与压缩共用 scanJs —— 若校验另写一套正则，
   两者会一起错向同一个方向，「自检通过」就失去意义。
   ============================================================ */
function verifyJsSyntax(code, file) {
  try {
    // 用 Script 而非 run：只解析不执行，能捕获语法错误而无副作用
    new vm.Script(code, { filename: file });
    return null;
  } catch (e) {
    return e.message;
  }
}

// 语义载体：字符串 / 模板 / 正则必须逐字保留。
// 一律基于 scanJs 的 token 流 —— 用裸正则去数会把注释里的
// "Identifier 'IS_HTML_DOC' has already been declared" 也算进去，
// 那类假阳性会让人逐渐不再相信自检的结论。
function semanticLiterals(code) {
  return scanJs(code)
    .filter((tk) => tk.type === 'string' || tk.type === 'template' || tk.type === 'regex')
    .map((tk) => tk.value)
    .join('');
}

function verifyJsInvariants(code, original) {
  const problems = [];

  if (semanticLiterals(code) !== semanticLiterals(original)) {
    problems.push('字符串 / 模板 / 正则字面量内容发生变化');
  }

  // DOM id 与 class 是 content 脚本与宿主页面之间的唯一契约
  const ids = (s) => [...new Set((s.match(/id="[^"]+"/g) || []).map((x) => x.slice(4, -1)))].sort();
  if (ids(code).join(',') !== ids(original).join(',')) problems.push('DOM id 集合发生变化');

  // storage.sync 键名漂移会让设置静默失效
  const keys = (s) => [...new Set(s.match(/'(defaultSpeed|overlayEnabled|autoHideOverlay|loopEnabled|step|speedStep)'/g) || [])].sort();
  if (keys(code).join(',') !== keys(original).join(',')) problems.push('storage 键名发生变化');

  // 消息类型名是 background / content / popup 三端的接口
  const types = (s) => scanJs(s)
    .filter((tk) => tk.type === 'string' && /^'[A-Z_]{4,}'$/.test(tk.value))
    .map((tk) => tk.value).sort().join(',');
  if (types(code) !== types(original)) problems.push('消息类型常量发生变化');

  return problems;
}

// CSS 比对前先归一化：压缩必然改变空白，直接比原始空白没有意义。
// 只抹掉压缩器会抹掉的位置（括号、冒号、逗号、尖括号、花括号旁），
// 字母之间的空格一律保留 —— `@media screen and (...)` 里的 and 不能抹。
// 紧邻符号的空格也保留 —— `.a + .b` 压成 `.a+.b` 虽然等价，
// 但会让「选择器逐条比对」这条校验自己失效，保留它换来的是可读的差异。
// 必须先剥注释：选择器匹配会把注释一起吞进去，
// 压缩后注释消失，不剥离就会报出一堆「选择器被改」的假阳性。
function stripCssComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}
function cssNormalize(s) {
  return stripCssComments(s)
    .replace(/\s+/g, ' ')
    .replace(/\s*([:(),>{}])\s*/g, '$1')
    // 组合子两侧的空格补回来：`a + b` 与 `a+b` 语义相同，
    // 但归一化必须两侧对称，否则「选择器逐条比对」这条校验
    // 会把纯书写差异报成规则丢失。
    .replace(/\s*([+~])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function verifyCssInvariants(code, original) {
  const problems = [];
  const nc = cssNormalize(code);
  const no = cssNormalize(original);

  const vars = (s) => (s.match(/--[a-z0-9-]+(?=\s*:)/g) || []).sort().join(',');
  if (vars(nc) !== vars(no)) problems.push('CSS 自定义属性集合发生变化');

  const media = (s) => (s.match(/@media[^{]+/g) || []).map((x) => x.trim()).sort().join('|');
  if (media(nc) !== media(no)) problems.push('@media 条件发生变化');

  const kf = (s) => (s.match(/@keyframes\s+[\w-]+/g) || []).sort().join('|');
  if (kf(nc) !== kf(no)) problems.push('@keyframes 名称发生变化');

  // 选择器序列：少一条规则就是样式静默失效，必须逐条比对
  const sels = (s) => (s.match(/[^{}]+\{/g) || []).map((x) => x.trim()).sort().join('|');
  if (sels(nc) !== sels(no)) problems.push('CSS 规则选择器发生变化');

  // 声明：属性名集合必须一致
  const props = (s) => (s.match(/[a-z-]+(?=\s*:)/g) || []).sort().join(',');
  if (props(nc) !== props(no)) problems.push('CSS 属性名集合发生变化');

  return problems;
}

function verifyHtmlInvariants(code, original) {
  const problems = [];
  const ids = (s) => [...new Set((s.match(/id="[^"]+"/g) || []).map((x) => x.slice(4, -1)))].sort();
  if (ids(code).join(',') !== ids(original).join(',')) problems.push('HTML id 集合发生变化');

  // 文本内容：把标签之间的空白全部归一为空格后再比。
  // 只比可见文案是有意的 —— 折叠内联标签间空白仍会保留一个空格，
  // 而这正是渲染结果所依赖的间距。
  const text = (s) => s
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text(code) !== text(original)) problems.push('HTML 文本内容发生变化');

  // 标签序列：折叠空白不得增删元素
  const tags = (s) => (s.match(/<\/?[a-zA-Z][^>]*>/g) || [])
    .map((t) => t.match(/^<\/?([a-zA-Z][\w-]*)/)[1]).join(',');
  if (tags(code) !== tags(original)) problems.push('HTML 标签序列发生变化');

  return problems;
}

/* 调试入口：node temp_tests/build.js --debug <文件>
   放在文件末尾是因为它要用到上面定义的常量与函数，
   提前调用会撞上 const 的暂时性死区。 */
if (opt('--debug', null)) {
  const target = opt('--debug');
  const p = path.isAbsolute(target) ? target : path.join(ROOT, target);
  const src = fs.readFileSync(p, 'utf8');
  const out = p.endsWith('.css') ? minifyCss(src)
    : p.endsWith('.html') ? minifyHtml(src)
      : minifyJs(src);
  process.stdout.write(out);
  process.exit(0);
}

/* ---------- 版本注入 ---------- */
function buildManifest(version) {
  const raw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
  const m = JSON.parse(raw);
  m.version = version;
  return JSON.stringify(m, null, 2) + '\n';
}

// Chrome Web Store 的版本号只接受 1–4 段数字，注入前必须先拦
function assertVersion(v) {
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(v)) {
    throw new Error(
      `版本号 "${v}" 不符合 Chrome 要求：只允许 1–4 段数字（如 1.2.3）`);
  }
}

/* ============================================================
   主流程
   需要单独调试压缩器时可用 --debug <文件> 只打印压缩结果，不产出
   ============================================================ */

let totalIn = 0;
let totalOut = 0;
const rows = [];
const failures = [];

console.log(`构建 漫卷 SlowScroll v${VERSION}${MINIFY ? '（压缩）' : '（不压缩）'}`);
console.log('');

assertVersion(VERSION);

const manifestRaw = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestRaw);

// 版本一致性：package.json 与 manifest.json 两处手写版本号必然漂移
if (manifest.version !== VERSION) {
  console.log(`  ! manifest.json 版本为 ${manifest.version}，构建时以 package.json 的 ${VERSION} 为准`);
}

// 清单交叉校验：manifest 引用了却没进打包清单的文件
const missing = crossCheck(manifest);
if (missing.length) {
  console.error('✗ manifest 引用了未纳入打包清单的文件：');
  missing.forEach((f) => console.error('   -', f));
  process.exit(1);
}

// 清单中的文件必须真实存在
const absent = INCLUDE.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (absent.length) {
  console.error('✗ 打包清单中的文件不存在：');
  absent.forEach((f) => console.error('   -', f));
  process.exit(1);
}

// 打包集合只由 INCLUDE 决定，磁盘上多出的文件永远进不了包。
// 下面这一步是反向提醒：有运行时文件没登记进清单，多半是漏了。
const scanned = collect(ROOT);
const untracked = scanned.filter((f) => !INCLUDE.includes(f) && !isDevOnly(f));
if (untracked.length) {
  console.log('  ! 以下文件不在打包清单中，将不会被分发：');
  untracked.forEach((f) => console.log('     ·', f));
  console.log('');
}

// 开发期文件：文档、脚本、素材源文件，不随扩展分发
function isDevOnly(f) {
  return ['package.json', 'README.md', 'LICENSE'].includes(f)
    || f.endsWith('.md') || f.endsWith('.py')
    || /(^|\/)icon\.svg$/.test(f);   // PNG 是 MV3 唯一可用格式，SVG 仅作设计源
}

const entries = [];
for (const rel of INCLUDE) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs);
  totalIn += original.length;

  let data = original;
  let note = '';

  if (rel === 'manifest.json') {
    data = Buffer.from(buildManifest(VERSION), 'utf8');
    note = '注入版本 ' + VERSION;
  } else if (rel.endsWith('.js') && MINIFY) {
    const src = original.toString('utf8');
    const out = minifyJs(src);
    const err = verifyJsSyntax(out, rel);
    if (err) {
      failures.push(`${rel}: 压缩后语法错误 —— ${err}`);
      data = original;
      note = '压缩失败，回退原文件';
    } else {
      const inv = verifyJsInvariants(out, src);
      if (inv.length) {
        failures.push(`${rel}: ${inv.join('；')}`);
        data = original;
        note = '不变量校验失败，回退原文件';
      } else {
        data = Buffer.from(out, 'utf8');
        note = 'JS';
      }
    }
  } else if (rel.endsWith('.css') && MINIFY) {
    const src = original.toString('utf8');
    const out = minifyCss(src);
    const inv = verifyCssInvariants(out, src);
    if (inv.length) {
      failures.push(`${rel}: ${inv.join('；')}`);
      data = original;
      note = '不变量校验失败，回退原文件';
    } else {
      data = Buffer.from(out, 'utf8');
      note = 'CSS';
    }
  } else if (rel.endsWith('.html') && MINIFY) {
    const src = original.toString('utf8');
    const out = minifyHtml(src);
    const inv = verifyHtmlInvariants(out, src);
    if (inv.length) {
      failures.push(`${rel}: ${inv.join('；')}`);
      data = original;
      note = '不变量校验失败，回退原文件';
    } else {
      data = Buffer.from(out, 'utf8');
      note = 'HTML';
    }
  }

  totalOut += data.length;
  entries.push({ name: rel, data });
  const ratio = original.length === 0
    ? '—'
    : `${((1 - data.length / original.length) * 100).toFixed(0)}%`;
  rows.push({ rel, before: original.length, after: data.length, ratio, note });
}

if (failures.length) {
  console.error('✗ 产物自检未通过：');
  failures.forEach((f) => console.error('   -', f));
  process.exit(1);
}

/* ---------- 报告 ---------- */
const pad = (s, n) => String(s).padEnd(n, ' ');
console.log(`  ${pad('文件', 28)}${pad('原始', 10)}${pad('产出', 10)}${pad('压缩率', 8)}说明`);
for (const r of rows) {
  console.log(`  ${pad(r.rel, 28)}${pad(r.before + ' B', 10)}${pad(r.after + ' B', 10)}${pad(r.ratio, 8)}${r.note}`);
}
console.log(`  ${pad('合计', 28)}${pad(totalIn + ' B', 10)}${pad(totalOut + ' B', 10)}` +
  `${pad(((1 - totalOut / totalIn) * 100).toFixed(0) + '%', 8)}`);
console.log('');

/* ============================================================
   行为等价验证：用压缩后的产物跑完整测试套件
   ------------------------------------------------------------
   到这一步为止，能证明的只是「压缩后的代码仍能被解析、
   字面量与标识符没变」。那离「行为不变」还差得远：
   压缩器完全可能在语法合法的前提下改变求值顺序或作用域。

   真正有说服力的证据只有一个 —— 把产物铺到临时目录，
   让引擎 / 清单 / 交互三层测试全部对着压缩后的文件跑一遍。

   关键设计：同一套断言必须**先在源码上跑一遍**做基线。
   否则源码本身的失败会被算到压缩头上 ——
   那会让人去查一个根本不存在的压缩 bug，
   而真正该修的那个源码缺陷反而被淹没了。
   ============================================================ */

function runSuite(suite, root) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'temp_tests', suite)],
    { encoding: 'utf8', env: { ...process.env, ...(root ? { SLOWSCROLL_ROOT: root } : {}) } });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/===== (\d+) passed, (\d+) failed(, (\d+) skipped)? =====/);
  return {
    suite,
    code: r.status,
    passed: m ? Number(m[1]) : null,
    failed: m ? Number(m[2]) : null,
    output: r.stdout || '',
    failures: out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim())
  };
}

/* stage 目录名带进程号：多个构建/验证进程并行时会各写各的。
   固定名曾导致「另一个进程刚跑完顺手清了目录」，
   表现为一会儿全绿一会儿报文件不存在，极难定位。 */
const STAGE_DIR = path.join(ROOT, 'temp_tests', `__stage_${process.pid}`);

/* 铺开压缩产物并跑完 Node 套件。
   stage 的清理由调用方负责：浏览器层跑完还需要它，
   在这里删掉会让后续的浏览器验证找不到夹具。 */
function stageAndRun(files, suites, fixtures) {
  const stage = STAGE_DIR;
  fs.rmSync(stage, { recursive: true, force: true });
  for (const e of files) {
    const p = path.join(stage, e.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, e.data);
  }
  // 夹具也要进 stage：它们的 ../ 相对引用才能指向压缩后的文件
  if (fixtures) {
    const dst = path.join(stage, 'temp_tests');
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fixtures) {
      fs.copyFileSync(path.join(ROOT, 'temp_tests', f), path.join(dst, f));
    }
  }
  // 只在验证阶段存在、不随扩展分发的文件
  for (const rel of STAGE_ONLY) {
    const p = path.join(stage, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), p);
  }

  const results = [];
  for (const suite of suites) {
    results.push(runSuite(suite, stage));
  }
  return { results, stage };
}

const cleanupStage = (stage) => fs.rmSync(stage, { recursive: true, force: true });

const NODE_SUITES = ['engine.test.js', 'manifest.test.js', 'ui.test.js'];
// 夹具：浏览器层要用，其 ../ 相对引用会指向 stage 内的产物
const FIXTURES = ['browser_check.html', 'overlay_check.html', 'long_page.html'];
// icon.svg 不随扩展分发（MV3 只认 PNG），但浏览器层要拿它当
// 「非 HTML 文档」的载体，故只补进 stage 而不进打包清单
const STAGE_ONLY = ['assets/icons/icon.svg'];

let nodeResults = [];

if (NODE_SUITES.length) {
  console.log(`行为等价验证（${MINIFY ? '压缩产物' : '原始文件'}）：`);

  // 基线：同一套断言先在源码上跑一遍
  const baselines = new Map();
  if (MINIFY) {
    for (const suite of NODE_SUITES) {
      const b = runSuite(suite, null);
      baselines.set(suite, b);
    }
  }

  const run = stageAndRun(entries, NODE_SUITES, FIXTURES);
  nodeResults = run.results;
  const results = nodeResults;
  let bad = false;
  let regressed = false;

  for (const r of results) {
    const base = baselines.get(r.suite);
    const baseFail = new Set(base ? base.failures : []);
    // 只在产物上出现、源码上没有的失败项 = 压缩引入的回归
    const newFails = base ? r.failures.filter((f) => !baseFail.has(f)) : r.failures;
    const ok = r.code === 0 && r.failed === 0;
    if (!ok && newFails.length) regressed = true;

    const mark = !ok ? (newFails.length ? '✗' : '○') : '✓';
    const tail = !ok
      ? (newFails.length ? `${r.failed} failed（压缩引入）` : `${r.failed} failed（源码基线同样存在）`)
      : '';
    console.log(`  ${mark} ${r.suite.padEnd(18)} ${r.passed ?? '—'} passed${tail ? '，' + tail : ''}`);

    newFails.slice(0, 8).forEach((l) => console.log('       ' + l));
    if (!r.output && base && base.output === '' && r.code !== 0) {
      console.log('       （套件异常退出，见 stderr）');
    }
  }

  if (regressed) {
    cleanupStage(run.stage);
    console.error('\n✗ 压缩引入了行为回归（源码基线全绿，产物上失败），构建中止');
    process.exit(1);
  }
  if (results.some((r) => r.code !== 0 || r.failed !== 0)) {
    cleanupStage(run.stage);
    console.error('\n✗ 测试套件在源码基线上即未通过，构建中止。');
    console.error('  这是源码本身的问题，与压缩无关，请先修复后再构建。');
    process.exit(1);
  }
  console.log('');
}

/* ============================================================
   浏览器层验证：对着压缩产物跑真实渲染语义
   ------------------------------------------------------------
   CSS 压缩最危险的地方恰恰是 Node 层看不见的：
   收起态的 visibility / pointer-events 是否还生效、
   过渡是否仍受 prefers-reduced-motion 约束、
   选择器里的后代组合子有没有被空格变化改写。
   这些只有真实浏览器能给出答案，所以这一层是构建的最后一关。
   ============================================================ */
if (!flag('--skip-browser')) {
  const runBrowser = (root) => {
    const r = spawnSync(process.execPath,
      [path.join(ROOT, 'temp_tests', 'run_browser_check.js'), '--require'],
      { encoding: 'utf8', env: { ...process.env, ...(root ? { SLOWSCROLL_ROOT: root } : {}) } });
    const out = (r.stdout || '') + (r.stderr || '');
    return {
      status: r.status,
      out,
      mainPassed: (out.match(/浏览器验证通过：(\d+) 项/) || [])[1],
      barPassed: (out.match(/悬浮条验证通过：(\d+) 项/) || [])[1],
      failures: out.split('\n').filter((l) => l.includes('✗')).map((l) => l.trim())
    };
  };

  // 与 Node 层同理：先在源码上取基线，否则源码自身的失败
  // 会被算成压缩的锅 —— 那样既误导排查，也掩盖真正该修的源码缺陷
  const base = MINIFY ? runBrowser(null) : null;
  const r = runBrowser(STAGE_DIR);

  const baseFail = new Set(base ? base.failures : []);
  const newFails = base ? r.failures.filter((f) => !baseFail.has(f)) : r.failures;

  if (r.status === 0) {
    console.log(`  ✓ ${'run_browser_check.js'.padEnd(18)} 浏览器层通过` +
      (r.mainPassed ? `（主组 ${r.mainPassed} 项）` : '') +
      (r.barPassed ? `（悬浮条 ${r.barPassed} 项）` : ''));
  } else if (!newFails.length && base && base.status !== 0) {
    console.log(`  ○ ${'run_browser_check.js'.padEnd(18)} 浏览器层失败，但与源码基线完全一致（压缩无回归）`);
    console.log('       源码侧同样失败，请先修复源码；这不是压缩引入的问题。');
  } else {
    console.log(`  ✗ ${'run_browser_check.js'.padEnd(18)} 浏览器层未通过`);
    (newFails.length ? newFails : r.failures).slice(0, 8)
      .forEach((l) => console.log('       ' + l));
    // 依赖缺失时该脚本自身会给出可执行提示，原样透出即可
    if (!r.failures.length) {
      r.out.split('\n').filter((l) => l.trim() && !/^\s*✓/.test(l)).slice(-10)
        .forEach((l) => console.log('       ' + l));
    }
    cleanupStage(STAGE_DIR);
    console.error(newFails.length
      ? '\n✗ 压缩引入了浏览器层行为回归，构建中止'
      : '\n✗ 浏览器层验证在源码基线上即未通过，构建中止（与压缩无关）');
    process.exit(1);
  }
} else {
  console.log('  ○ 浏览器层已按 --skip-browser 跳过');
}

// 全部验证通过后才清理 stage
cleanupStage(STAGE_DIR);

// 产物内容摘要：便于商店提交说明与回归比对
console.log('产物静态校验：');
console.log(`  ✓ JS 语法解析通过（${entries.filter((e) => e.name.endsWith('.js')).length} 个文件）`);
console.log(`  ✓ manifest 引用与打包清单一致（${INCLUDE.length} 个文件）`);
console.log(`  ✓ 字符串字面量 / DOM id / storage 键名在压缩前后一致`);
console.log(`  ✓ CSS 自定义属性 / @media / @keyframes / 选择器未丢失`);
console.log(`  ✓ HTML 标签序列与文本内容未丢失`);

if (CHECK_ONLY) {
  console.log('\n--check 模式：不产出 zip');
  process.exit(0);
}

/* ---------- 产出 ---------- */
const outPath = opt('--out', path.join(ROOT, 'dist', `manjuan-scroll-${VERSION}.zip`));
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// 排序保证同样输入产出同样字节序列
entries.sort((a, b) => (a.name < b.name ? -1 : 1));
const size = writeZip(entries, outPath);
const hash = crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');

console.log(`\n✓ ${path.relative(ROOT, outPath)}`);
console.log(`  ${(size / 1024).toFixed(1)} KB · sha256 ${hash.slice(0, 16)}…`);
console.log('\n提示：zip 内容为压缩后的产物，需「加载已解压的扩展程序」调试时请直接选项目根目录。');
