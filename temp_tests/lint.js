/* 语法检查：所有 JS 文件必须能被 V8 解析。
   独立成文件是为了让 ci.js 能按步骤调用，
   避免把一长串 -e 内联代码塞进 package.json。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const FILES = [
  'shared/constants.js',
  'content/scrollEngine.js',
  'content/overlay.js',
  'background/background.js',
  'popup/popup.js',
  'options/options.js',
  'temp_tests/engine.test.js',
  'temp_tests/manifest.test.js',
  'temp_tests/contrast.test.js',
  'temp_tests/ui.test.js',
  'temp_tests/dom.js',
  'temp_tests/build.js',
  'temp_tests/pack.js',
  'temp_tests/zip.js',
  'temp_tests/filelist.js',
  'temp_tests/run_browser_check.js',
  'temp_tests/ci.js'
];

let bad = 0;
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) {
    console.log('  ✗', f, '文件不存在');
    bad = 1;
    continue;
  }
  try {
    // 只解析不执行：这里要的是语法错误，不是运行时行为
    new vm.Script(fs.readFileSync(p, 'utf8'), { filename: f });
  } catch (e) {
    console.log('  ✗', f, e.message);
    bad = 1;
  }
}

console.log(`\n===== ${FILES.length - (bad ? 1 : 0)} 个文件语法通过 =====`);
process.exit(bad);