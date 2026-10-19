// 对比度实测：按「最差叠加背景」校验 WCAG AA，非按色卡标称值。
//
// 为什么需要这个脚本：玻璃是半透明层，文字的最终颜色 = 文字色透过
// 「极光背景 + 玻璃填充」叠加后的结果，比色卡上看到的更低。目测「看着
// 挺清楚」曾导致 --text-muted 在三种真实背景上全部不达标。
//
// 改动任何文字色 / 品牌色 / 玻璃 alpha 后必须重跑：node temp_tests/contrast.test.js
// 全部通过后再更新 README 的对比度表。

function srgb(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function lum([r, g, b]) {
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}

function contrast(fg, bg) {
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hex(h) {
  const s = h.replace('#', '');
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16)
  ];
}

// 把半透明前景叠到底色上，得到实际可见色
function over(fg, alpha, bg) {
  return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));
}

let failed = 0;
let total = 0;

function check(label, fg, bg, min) {
  total++;
  const r = contrast(fg, bg);
  if (r < min) {
    failed++;
    console.log(`  FAIL  ${label.padEnd(42)} ${r.toFixed(2)}:1  (需 ≥ ${min})`);
  } else {
    console.log(`  PASS  ${label.padEnd(42)} ${r.toFixed(2)}:1`);
  }
}

/* ---- 背景构造：与 shared/tokens.css、content/overlay.css 保持一致 ---- */

// 浅色极光最差点：左上紫团 rgba(139,92,246,.30) over 线性渐变起点 #f4f6fc
const lightAurora = over(hex('#8b5cf6'), 0.30, hex('#f4f6fc'));
const lightSubtle = over([255, 255, 255], 0.30, lightAurora);   // --glass-fill-subtle
const lightCard = over([255, 255, 255], 0.46, lightAurora);     // --glass-fill
const lightStrong = over([255, 255, 255], 0.62, lightAurora);   // --glass-fill-strong

// 深色极光最差点
const darkAurora = over(hex('#8b5cf6'), 0.30, hex('#0e1119'));
const darkSubtle = over([38, 43, 58], 0.34, darkAurora);
const darkCard = over([38, 43, 58], 0.50, darkAurora);
const darkStrong = over([38, 43, 58], 0.66, darkAurora);
const darkHover = over([64, 71, 92], 0.62, darkAurora);         // --glass-fill-hover

// 悬浮条是自包含深色玻璃，最差情况为宿主页面纯白
const barPanel = over([18, 21, 33], 0.72, [255, 255, 255]);
const barPrompt = over([18, 21, 33], 0.82, [255, 255, 255]);

console.log('\n浅色主题');
check('--text-strong on card 玻璃', hex('#151a26'), lightCard, 4.5);
check('--text-body on card 玻璃', hex('#3d4557'), lightCard, 4.5);
check('--text-muted on section 玻璃', hex('#50586b'), lightSubtle, 4.5);
check('--text-muted on card 玻璃', hex('#50586b'), lightCard, 4.5);
check('--text-muted on 极光裸底', hex('#50586b'), lightAurora, 4.5);
check('--btn--primary 白字 on 起点', [255, 255, 255], hex('#5b5ee8'), 4.5);
check('--btn--primary 白字 on 终点', [255, 255, 255], hex('#7c3aed'), 4.5);
check('.btn.is-active 白字', [255, 255, 255], hex('#047857'), 4.5);
check('暂停态文字 on 按钮底', hex('#9a3412'), lightStrong, 4.5);
check('暂停态 badge on section 底', hex('#9a3412'), lightSubtle, 4.5);
check('暂停态副标题 on 极光', hex('#9a3412'), lightAurora, 4.5);
check('焦点环 brand-500 on card', hex('#6366f1'), lightCard, 3);
// 分段控件：未选中文字落在 strong 玻璃底上，选中态是白字叠品牌渐变
// （渐变最浅端 brand-500 最深，按 4.5:1 校核）
check('分段未选中文字 on strong 玻璃', hex('#50586b'), lightStrong, 4.5);
check('分段选中白字 on brand 起点', [255, 255, 255], hex('#4f46e5'), 4.5);
check('分段选中白字 on violet 终点', [255, 255, 255], hex('#7c3aed'), 4.5);
// 进度条本体为装饰性，无文字承载，仅其百分比沿用 --text-strong
check('进度百分比 on section 玻璃', hex('#151a26'), lightSubtle, 4.5);

console.log('\n深色主题');
check('--text-muted on section 玻璃', hex('#97a1b5'), darkSubtle, 4.5);
check('--text-body on section 玻璃', hex('#cbd3e1'), darkSubtle, 4.5);
check('--text-strong on section 玻璃', hex('#f2f5fb'), darkSubtle, 4.5);
check('.btn--glass 常态文字', hex('#f2f5fb'), darkStrong, 4.5);
check('.btn--glass hover 文字', hex('#f2f5fb'), darkHover, 4.5);
check('暂停态文字 on 按钮底', hex('#f59e0b'), darkStrong, 4.5);
check('暂停态 badge on section 底', hex('#f59e0b'), darkSubtle, 4.5);
check('焦点环 brand-300 on card', hex('#a5b4fc'), darkCard, 3);
check('分段未选中文字 on strong 玻璃', hex('#97a1b5'), darkStrong, 4.5);
check('分段选中白字 on brand 起点', [255, 255, 255], hex('#4f46e5'), 4.5);
check('分段选中白字 on violet 终点', [255, 255, 255], hex('#7c3aed'), 4.5);
check('进度百分比 on section 玻璃', hex('#f2f5fb'), darkSubtle, 4.5);

console.log('\n悬浮条（自包含深色玻璃）');
check('按钮文字', hex('#e9edf7'), barPanel, 4.5);
check('速度数值', hex('#f2f5fb'), barPanel, 4.5);
check('.unit 合成后', over([242, 245, 251], 0.78, barPanel), barPanel, 4.5);
check('#ss-play 白字', [255, 255, 255], hex('#5b5ee8'), 4.5);
check('#ss-play.running 白字', [255, 255, 255], hex('#dc2626'), 4.5);
check('button.active 白字', [255, 255, 255], hex('#047857'), 4.5);
check('底部提示文字', hex('#f2f5fb'), barPrompt, 4.5);
check('焦点环 on panel 底', hex('#a5b4fc'), barPanel, 3);

console.log(`\n共 ${total} 项，${failed === 0 ? '全部通过' : failed + ' 项未通过'}`);
process.exit(failed === 0 ? 0 : 1);