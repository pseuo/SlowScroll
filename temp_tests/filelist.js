/* ============================================================
   运行时文件清单 —— pack.js 与 build.js 的唯一来源
   两处若各写一份，改动必有一处漏掉，症状是「打包成功但扩展缺文件」。
   改动此清单后必须跑 npm run test:manifest（T8 会交叉校验）。
   ============================================================ */
const path = require('path');
const fs = require('fs');

/* 被测根目录。默认指向项目本身；构建脚本会把压缩后的产物
   铺到临时目录并设 SLOWSCROLL_ROOT，让同一套断言跑在压缩产物上 ——
   这是「压缩没有改变行为」唯一有说服力的证据。 */
const ROOT = process.env.SLOWSCROLL_ROOT || path.join(__dirname, '..');

// 需要打包的运行时文件（与 manifest 引用保持一致）
const INCLUDE = [
  'manifest.json',
  'LICENSE',
  'shared/constants.js',
  'shared/tokens.css',
  'shared/components.css',
  'content/overlay.js',
  'content/overlay.css',
  'content/scrollEngine.js',
  'background/background.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'options/options.html',
  'options/options.css',
  'options/options.js',
  'assets/icons/icon16.png',
  'assets/icons/icon32.png',
  'assets/icons/icon48.png',
  'assets/icons/icon128.png'
];

// 明确排除（即便目录遍历命中）
const EXCLUDE = new Set([
  'package.json',
  'package-lock.json',
  '.gitignore',
  'README.md'
]);

const SKIP_DIRS = ['node_modules', 'dist', 'temp_tests', 'preview', '.git', '.workbuddy'];

function collect(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(entry.name)) continue;
      out.push(...collect(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/* manifest 引用的文件必须全部纳入清单，否则商店包会缺文件 */
function crossCheck(manifest) {
  const referenced = new Set([
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts?.[0]?.js || []),
    ...(manifest.content_scripts?.[0]?.css || []),
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_page,
    ...(manifest.web_accessible_resources?.[0]?.resources || [])
  ].filter(Boolean));

  return [...referenced].filter((f) => !INCLUDE.includes(f));
}

module.exports = { ROOT, INCLUDE, EXCLUDE, SKIP_DIRS, collect, crossCheck };