/* 暂停 / 返回标题 实测
 *
 * 覆盖五条链路：
 *   1) 开局后暂停按钮出现 → 点击进入 paused，面板弹出、HUD 淡掉
 *   2) 继续 → 原样接回 ready
 *   3) 蓄力中暂停 → 暂停期间松手 → 继续后必须回到 ready
 *      （历史坑：release() 会被 paused 状态吃掉，恢复后永远卡在 charging）
 *   4) 暂停面板的「返回标题」→ 回到开始页
 *   5) 结算页的「返回标题」→ 回到开始页
 *
 * 断言用 elementFromPoint 之外的另一条原则：凡是"看得见"的（HUD 淡出、面板
 * 弹出），一律读 computed style / class，不直接信内部状态变量。
 */
const g = window.__game;
if (!g) return { ok: false, err: 'no game' };

const show = (id) => !document.getElementById(id).classList.contains('hidden');
const hudOpacity = () => getComputedStyle(document.querySelector('.hud')).opacity;
/* 标题页的 HUD 是靠 body.intro 把 #score/#best/#pauseBtn 逐个藏起来的，
   .hud 本身透明度还是 1，所以这里单独量 #score */
const scoreOpacity = () => getComputedStyle(document.getElementById('score')).opacity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(1000);
document.getElementById('startBtn').click();
await sleep(500);
const afterStart = {
  state: g.state,
  pauseBtn: show('pauseBtn'),
  panel: show('pausePanel'),
};

/* 1) 点暂停按钮 */
document.getElementById('pauseBtn').click();
await sleep(350);
/* HUD 淡出是 CSS transition，机器忙的时候 350ms 可能还没走完 —— 再等一会儿，
 * 直到透明度真的落到很低，避免把"过渡没跑完"误判成"没淡出"。 */
for (let i = 0; i < 20 && Number(hudOpacity()) > 0.01; i++) await sleep(50);
const paused = {
  state: g.state,
  panel: show('pausePanel'),
  bodyPaused: document.body.classList.contains('paused'),
  hudOpacity: hudOpacity(),
  scoreShown: document.getElementById('pauseScore').textContent,
};

/* 2) 继续 */
document.getElementById('pauseResume').click();
await sleep(250);
const resumed = {
  state: g.state,
  panel: show('pausePanel'),
  bodyPaused: document.body.classList.contains('paused'),
};

/* 3) 蓄力中暂停 → 暂停期间松手 → 继续 */
g.press();
await sleep(400);
const midCharge = { state: g.state, power: +g.power.toFixed(2) };
document.getElementById('pauseBtn').click();
await sleep(250);
window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
await sleep(250);
const duringChargePause = { state: g.state, barShown: document.getElementById('barWrap').classList.contains('show') };
document.getElementById('pauseResume').click();
await sleep(350);
const afterChargeResume = {
  state: g.state,
  power: +g.power.toFixed(2),
  barShown: document.getElementById('barWrap').classList.contains('show'),
};

/* 4) 暂停面板 → 返回标题 */
document.getElementById('pauseBtn').click();
await sleep(250);
document.getElementById('pauseTitle').click();
await sleep(450);
const backTitle = {
  state: g.state,
  start: show('startScreen'),
  pausePanel: show('pausePanel'),
  pauseBtn: show('pauseBtn'),
  scoreOpacity: scoreOpacity(),
};

/* 5) 结算页 → 返回标题（gameOver() 是真实的掉落终点，这里只验 UI 链路） */
document.getElementById('startBtn').click();
await sleep(350);
g.gameOver();
await sleep(250);
const overState = { state: g.state, over: show('overScreen'), titleBtn: show('titleBtn') };
document.getElementById('titleBtn').click();
await sleep(450);
const fromOver = { state: g.state, start: show('startScreen'), over: show('overScreen') };

const ok =
  afterStart.state === 'ready' && afterStart.pauseBtn === true && afterStart.panel === false
  && paused.state === 'paused' && paused.panel === true && paused.bodyPaused === true
  && Number(paused.hudOpacity) < 0.02
  && resumed.state === 'ready' && resumed.panel === false && resumed.bodyPaused === false
  && midCharge.state === 'charging'
  && duringChargePause.state === 'paused' && duringChargePause.barShown === false
  && afterChargeResume.state === 'ready' && afterChargeResume.power === 0 && afterChargeResume.barShown === false
  && backTitle.state === 'start' && backTitle.start === true && backTitle.pausePanel === false
  && backTitle.pauseBtn === false && backTitle.scoreOpacity === '0'
  && overState.state === 'over' && overState.over === true && overState.titleBtn === true
  && fromOver.state === 'start' && fromOver.start === true && fromOver.over === false;

return { ok, afterStart, paused, resumed, midCharge, duringChargePause, afterChargeResume, backTitle, overState, fromOver };
