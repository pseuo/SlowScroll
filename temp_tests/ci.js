/* ============================================================
   CI 入口：一条命令跑完全部校验
   用法：npm run ci

   与 npm test 的区别，也正是原技术债里那条：
     · npm test 允许浏览器层在缺依赖时跳过（本地开发友好）
     · npm run ci 强制浏览器层执行，缺依赖直接失败
   「缺依赖时静默跳过」是流水线里最危险的一种绿灯 ——
   看起来全过，实际有一整层根本没跑。所以 CI 入口不给这个选项。
   ============================================================ */
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const STEPS = [
  { name: '语法检查', argv: ['temp_tests/lint.js'] },
  { name: '引擎行为', argv: ['temp_tests/engine.test.js'] },
  { name: '清单一致性', argv: ['temp_tests/manifest.test.js'] },
  { name: '对比度', argv: ['temp_tests/contrast.test.js'] },
  { name: '界面交互', argv: ['temp_tests/ui.test.js'] },
  // 强制模式：playwright 或浏览器缺失即失败，不给静默跳过的余地
  { name: '浏览器真实行为', argv: ['temp_tests/run_browser_check.js', '--require'] },
  // build 内部会再跑一遍上面四层（对着压缩产物），这里只关心它能否产出
  { name: '构建与产物自检', argv: ['temp_tests/build.js'] }
];

let failed = 0;
const started = Date.now();

for (const step of STEPS) {
  const t0 = Date.now();
  process.stdout.write(`\n${'━'.repeat(64)}\n▶ ${step.name}\n${'━'.repeat(64)}\n`);
  const r = spawnSync(process.execPath, [path.join(ROOT, step.argv[0]), ...step.argv.slice(1)],
    { stdio: 'inherit', cwd: ROOT });
  const ms = Date.now() - t0;
  if (r.status !== 0) {
    failed++;
    console.error(`\n✗ ${step.name} 失败（${ms}ms）`);
  } else {
    console.log(`\n✓ ${step.name} 通过（${ms}ms）`);
  }
}

console.log(`\n${'━'.repeat(64)}`);
if (failed) {
  console.error(`✗ CI 校验未通过：${failed} / ${STEPS.length} 个环节失败（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
  process.exit(1);
}
console.log(`✓ 全部 ${STEPS.length} 个环节通过（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);