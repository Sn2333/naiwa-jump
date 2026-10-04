/* 蜘蛛抓人 / 奶块 GIF —— 视觉验收截图（确定性版本）。
 * 教训：rAF 在无头软件 WebGL 下每帧上百 ms、dt 被 clamp 到 0.1，
 * "睡 1.4s 再截"的画面时刻完全不可控（第一次截到的就是演出后段的竞态帧）。
 * 正确姿势：停掉实时循环 → 手动逐帧推到目标时刻 → 真渲染一帧 → 截图。 */
const g = window.__game;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = (window.__DBG_Q || location.search).indexOf('gif') >= 0 ? 'gif' : 'spider';

await sleep(300);
if (MODE === 'gif') {
  g.forceTrait = 'milk';
  g.backToTitle();
  await sleep(150);
  g.beginRun();
  await sleep(250);
  g.spawnNext();
  const p = g.next;
  p.radius = 0.8; p.hitRadius = 0.8;
  g.charRoot.position.set(p.center.x, 0, p.center.z);
  g.state = 'jumping';
  g.current.center.x += 6;
  g.finishJump();
  /* GIF 纹理是异步解码的：留一点真实时间让它就位，再停循环推帧 */
  await sleep(400);
  g.renderer.setAnimationLoop(null);
  for (let i = 0; i < 8; i++) { g._noRender = true; g.tick(0.05); }   // 0.4s：GIF 已浮出
  g._noRender = false;
  g.tick(0.016);                                                       // 真渲染一帧
  return {
    ok: true, mode: MODE,
    gifAlive: g.fx.some((f) => f.kind === 'gif'),
    gifOpacity: (g.fx.find((f) => f.kind === 'gif') || {}).mesh
      ? +g.fx.find((f) => f.kind === 'gif').mesh.material.opacity.toFixed(2) : null,
  };
}

/* —— 蜘蛛抓人：截"蜘蛛落到角色头顶（grab 开端）"的那一帧 —— */
g.forceTrait = 'mj';
g.backToTitle();
await sleep(150);
g.beginRun();
await sleep(250);
g.spawnNext();
const p = g.next;
p.radius = 0.8; p.hitRadius = 0.8;
g.charRoot.position.set(p.center.x, 0, p.center.z);
g.state = 'jumping';
g.current.center.x += 6;
g.finishJump();
/* 手动触发蜘蛛（不走 1s 计时），先等蜘蛛图解码完（data URI 解码是异步的） */
g.mjTimer = 0.001;
g._noRender = true; g.tick(0.016); g._noRender = false;
if (!g.dom.mjSpider.complete) {
  await new Promise((r) => { g.dom.mjSpider.onload = r; setTimeout(r, 1500); });
}
await sleep(80);   // 布局稳定
/* 停实时循环 → 确定性推帧：drop 共 0.70s，推满正好落到角色头顶 */
g.renderer.setAnimationLoop(null);
for (let i = 0; i < 14; i++) { g._noRender = true; g.tick(0.05); }
g._noRender = false;
g.tick(0.016);      // grab 初段 + 真渲染
return {
  ok: true,
  mode: MODE,
  state: g.state,
  phase: g.mj ? g.mj.phase : null,
  spiderTop: g.dom.mjSpider.style.top || null,
  spiderLeft: g.dom.mjSpider.style.left || null,
  charVisible: g.charRoot.visible,
};
