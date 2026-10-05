/* 碰撞体积回归：每个角色的落脚判定必须由它的实际剪影决定
 *
 * 验两条：
 *   ① 数据链路 —— sprite_data 的 foot 真的流到了运行时（frog ≈0.33 / tiger ≈0.145
 *      @身高 1.30，单脚站的奶虎底盘必须明显小于全脚掌撑地的奶蛙）
 *   ② 行为差异 —— 同一个落点（超出砖缘 0.10）：要求"大部分脚掌还在砖上"，
 *      蛙（容差 ≈0.13）三成半脚掌在砖上站得住；虎（容差 ≈0.075）只剩
 *      一成半支撑，翻下去。判定松紧由 footSupport 控，不是"搭边就算站"。
 *
 * 前置：?plain&kind=round&r=0.8&gap=2.6 固定砖型，落点可复现。
 */
const g = window.__game;
if (!g) return { ok: false, err: 'no game' };

document.getElementById('startBtn').click();
await new Promise((r) => setTimeout(r, 800));

const target = g.next;
if (!target || target.kind !== 'round') return { ok: false, err: 'target 不是圆砖', kind: target && target.kind };

/* 落点：沿"当前砖 → 目标砖"方向，超出目标砖缘 OVER 这么远。
 * OVER=0.10 卡在两者中间：大于虎的 standTol(≈0.075)、小于蛙的(≈0.13)。 */
const OVER = 0.10;
const c = target.center, f = g.current.center;
let dx = c.x - f.x, dz = c.z - f.z;
const L = Math.hypot(dx, dz);
dx /= L; dz /= L;
const lx = c.x + dx * (target.hitRadius + OVER);
const lz = c.z + dz * (target.hitRadius + OVER);

const out = { over: OVER, chars: {} };

/* 先奶虎（摔，不消耗目标砖），复位后再奶蛙（站上，spawnNext 换下一块）。
 * 顺序反了的话蛙落完 target 就被换掉，虎就得对新砖重新算落点。 */
g.character.setChar('tiger');
await new Promise((r) => setTimeout(r, 150));
g.charRoot.position.set(lx, 0, lz);
g.state = 'jumping';
g.finishJump();
out.chars.tiger = {
  footR: +g.character.footR.toFixed(3),
  standTol: +g.standTol().toFixed(3),
  state: g.state,
};
if (g.state === 'falling') {       // 复位，别让下一轮在坠落态里跑
  g.state = 'ready';
  g.charRoot.position.y = 0;
  g.blob.visible = true;
}

g.character.setChar('frog');
await new Promise((r) => setTimeout(r, 150));
g.charRoot.position.set(lx, 0, lz);
g.state = 'jumping';
const scoreBefore = g.score;
g.finishJump();
out.chars.frog = {
  footR: +g.character.footR.toFixed(3),
  standTol: +g.standTol().toFixed(3),
  state: g.state,
  gained: g.score - scoreBefore,
};

const t = out.chars.tiger, fr = out.chars.frog;
/* footR 随 CFG.height 等比缩（1.48 → 1.30 时蛙 0.41→0.33 / 虎 0.18→0.145），
 * 所以这里断的是缩放后的期望值，改身高记得跟着改 */
out.ok = Math.abs(t.footR - 0.145) < 0.04     // 数据链路：剪影量出来的半径真的到位
  && Math.abs(fr.footR - 0.33) < 0.05
  && t.footR < fr.footR - 0.15                 // 单脚虎的底盘显著小于蛙
  && t.standTol < OVER                         // 松紧：虎的容差必须比落点小
  && fr.standTol > OVER                        //           蛙的容差必须比落点大
  && t.state === 'falling'                     // 行为：同一点，虎摔
  && fr.state === 'ready'                      //           蛙站
  && fr.gained >= 1;

return out;
