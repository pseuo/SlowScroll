/* 打包脚本（开发用）：把扩展打成可上传 Chrome Web Store 的 zip。
   与 build.js 的区别：
     · 本脚本 = 原始文件打包，不压缩，用于「确认能装上」
     · build.js = 压缩 + 版本注入 + 全套自检，用于发布
   日常发布请用 npm run build。

   规则：只打包运行时必需文件，排除开发自测、预览页与文档。
   文件清单来自 filelist.js，与 build.js 共用同一份，避免两处漂移。
   用法：node temp_tests/pack.js  （或 npm run pack）

   不依赖系统 zip 命令：用 Node 内置 zlib 手写最小 ZIP 结构，
   避免 Windows 上 tar/zip 的路径与盘符转义问题。 */
const fs = require('fs');
const path = require('path');

const { ROOT, INCLUDE, EXCLUDE, collect, crossCheck } = require('./filelist.js');
const { writeZip } = require('./zip.js');

const OUT_DIR = path.join(ROOT, 'dist');
const OUT_NAME = 'manjuan-scroll.zip';

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// 交叉校验：manifest 引用的文件必须都在打包清单中
const missing = crossCheck(manifest);
if (missing.length) {
  console.error('✗ manifest 引用了未纳入打包清单的文件：');
  missing.forEach((f) => console.error('   -', f));
  process.exit(1);
}

// 兜底：INCLUDE 中列出的文件必须真实存在
const absent = INCLUDE.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (absent.length) {
  console.error('✗ 打包清单中的文件不存在：');
  absent.forEach((f) => console.error('   -', f));
  process.exit(1);
}

const files = collect(ROOT).filter((f) => !EXCLUDE.has(f));

fs.mkdirSync(OUT_DIR, { recursive: true });
const outPath = path.join(OUT_DIR, OUT_NAME);

const entries = files
  .map((f) => ({ name: f.split(path.sep).join('/'), data: fs.readFileSync(path.join(ROOT, f)) }))
  // 排序保证同样输入产出同样字节序列
  .sort((a, b) => (a.name < b.name ? -1 : 1));

console.log('打包文件清单：');
entries.forEach((e) => console.log('  ·', e.name));

const size = writeZip(entries, outPath);

console.log(`\n✓ 已生成 ${path.relative(ROOT, outPath)}（${entries.length} 个文件，${(size / 1024).toFixed(1)} KB）`);
console.log('提示：这是未压缩的原始文件包，仅用于验证安装；');
console.log('      正式发布请用 npm run build（含压缩、版本注入与全套自检）。');