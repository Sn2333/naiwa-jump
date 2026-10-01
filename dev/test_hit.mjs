/**
 * 落脚判定的单元测试：node dev/test_hit.mjs
 * 直接把 js/hit.js 的源码当 ESM 载入，测的就是游戏真正跑的那份代码。
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../js/hit.js', import.meta.url), 'utf8');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
const { edgeOver, onPlatform, perfectTol } = await import(dataUrl);

let fail = 0;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
function eq(name, got, want, eps) {
  const ok = typeof want === 'number' ? near(got, want, eps ?? 1e-6) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${name}  ->  ${got}${ok ? '' : `  (期望 ${want})`}`);
}

console.log('\n--- 圆砖 r=0.70 ---');
eq('圆心', edgeOver('round', 0.7, 0, 0, 0, 0, 0), -0.7);
eq('正好压线', edgeOver('round', 0.7, 0, 0, 0, 0.7, 0), 0);
eq('线内 1cm', edgeOver('round', 0.7, 0, 0, 0, 0.69, 0), -0.01);
eq('出界 20cm', edgeOver('round', 0.7, 0, 0, 0, 0.9, 0), 0.2);
eq('斜向压线', edgeOver('round', 0.7, 0, 0, 0, 0.7 / Math.SQRT2, 0.7 / Math.SQRT2), 0, 1e-9);

console.log('\n--- 方块 halfW=0.80（边长 1.6）---');
eq('中心', edgeOver('box', 0, 0.8, 0, 0, 0, 0), -0.8);
eq('沿轴压线', edgeOver('box', 0, 0.8, 0, 0, 0.8, 0), 0);
eq('沿轴出界 20cm', edgeOver('box', 0, 0.8, 0, 0, 1.0, 0), 0.2);
eq('方内但贴边', edgeOver('box', 0, 0.8, 0, 0, 0.79, 0), -0.01);
eq('一条边出去（另一条还在里面）', edgeOver('box', 0, 0.8, 0, 0, 1.0, 0.3), 0.2, 1e-9);
eq('角外', edgeOver('box', 0, 0.8, 0, 0, 1.0, 1.0), Math.hypot(0.2, 0.2), 1e-9);
eq('平移后的方块', edgeOver('box', 0, 0.8, 3, -2, 3.8, -2), 0, 1e-9);

console.log('\n--- 完美容差 ---');
eq('r=0.30 下限', perfectTol(0.3), 0.13, 1e-9);
eq('r=0.70', perfectTol(0.7), 0.21, 1e-9);
eq('r=1.20 上限', perfectTol(1.2), 0.26, 1e-9);

console.log('\n--- 八棱柱（判定半径 0.95r）---');
{
  const R = 0.75, hr = R * 0.95, grace = 0.05;
  eq('八棱柱中心', edgeOver('oct', hr, 0, 0, 0, 0, 0), -hr);
  eq('八棱柱 0.9R 处（可见棱面内）', onPlatform('oct', hr, 0, 0, 0, R * 0.9, 0, grace), true);
  eq('八棱柱外接圆顶点 R 处（严格几何）', onPlatform('oct', hr, 0, 0, 0, R, 0, 0), false);
  eq('八棱柱顶点处靠 edgeGrace 兜住', onPlatform('oct', hr, 0, 0, 0, R, 0, grace), true);
}

console.log('\n--- 弹簧砖（踏板 0.85r）---');
{
  const R = 0.80, hr = R * 0.85;
  eq('正好站在踏板边缘', edgeOver('spring', hr, 0, 0, 0, hr, 0), 0, 1e-9);
  eq('踏板内 95% 处站得住', onPlatform('spring', hr, 0, 0, 0, hr * 0.95, 0, 0.05), true);
  eq('落到砖座外（踏板之外）算掉', onPlatform('spring', hr, 0, 0, 0, R * 1.4, 0, 0.05), false);
}
{
  // 和普通圆砖同半径时，弹簧砖的踏板略小一圈（0.85r），不能按整圈半径判
  const R = 0.80;
  eq('普通圆砖在 R 处站得住', onPlatform('round', R, 0, 0, 0, R, 0, 0), true);
  eq('弹簧砖同一位置就掉', onPlatform('spring', R * 0.85, 0, 0, 0, R, 0, 0), false);
}

console.log('\n--- 迷你砖：判定随砖一起缩小 ---');
{
  const R = 0.75, miniR = R * 0.62;           // 0.465
  eq('迷你砖上 0.98R 处（按正常砖算站得住）',
    onPlatform('round', R, 0, 0, 0, R * 0.98, 0, 0.05), true);
  eq('同一落点对迷你砖就掉',
    onPlatform('round', miniR, 0, 0, 0, R * 0.98, 0, 0.05), false);
  eq('迷你砖圆心照样完美', perfectTol(miniR) >= 0.13, true);
}

console.log('\n--- 移动砖：判定跟着实时圆心走 ---');
{
  const R = 0.75;
  // 砖从 (0,0) 滑到 (0,1.0)，玩家落在旧位置上
  eq('落在旧中心（砖已滑走 1.0）', edgeOver('round', R, 0, 0, 1.0, 0, 0), 0.25, 1e-9);
  eq('追着砖心落', onPlatform('round', R, 0, 0, 1.0, 0, 1.0, 0.05), true);
}

console.log('\n--- 回归：这两种落点以前会被误判成"掉下去" ---');
{
  const R = 0.8, grace = 0.05;
  const land = R * 0.98;                      // 离圆心 0.784，肉眼稳稳在砖面上
  const oldOk = land <= R * 0.94;             // 旧规则：hitRadius * 0.94
  const newOk = onPlatform('round', R, 0, 0, 0, land, 0, grace);
  console.log(`  圆砖 r=${R} 落在 0.98R：旧=${oldOk ? '过' : '掉'}  新=${newOk ? '过' : '掉'}`);
  if (oldOk || !newOk) fail++;
}
{
  const R = 0.65;
  const oldHalf = R * 1.5;                    // 旧方块看着有 1.5R 半宽
  const land = R * 1.20;                      // 落在旧外观内部，但旧判定是 1.06R*0.94 的圆
  const oldOk = land <= R * 1.06 * 0.94;
  const newOk = onPlatform('box', R, R * 1.22, 0, 0, land, 0, 0.05);
  console.log(`  方块 r=${R}（外观半宽 ${oldHalf.toFixed(3)}）落在 ${land.toFixed(3)}：旧=${oldOk ? '过' : '掉'}  新=${newOk ? '过' : '掉'}`);
  if (oldOk || !newOk) fail++;
}

console.log(fail === 0 ? '\n全部通过 ✔' : `\n${fail} 项失败 ✘`);
process.exit(fail === 0 ? 0 : 1);
