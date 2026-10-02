/* 点击命中 + 蓄力实测（防"看不见的透明层吃掉点击"回归）
 *
 * 背景：面板内部（#charGrid/#bgGrid、.acctBody、#rankList）为了能滚动各自设了
 * pointer-events: auto。CSS 允许子元素从父级的 none 里恢复命中，于是面板一加
 * .hidden（opacity:0）就有几个看不见的透明层盖在屏幕中央 —— 3D 画面完全正常，
 * 但按哪儿都没反应。用户报的"游戏根本点不动"就是这个。
 *
 * 要点：必须用 elementFromPoint 做真实命中测试，直接往 window 派发事件绕过了
 * 命中判定，测不出来（当初就是这么漏掉的）。
 */
const g = window.__game;
if (!g) return { ok: false, err: 'no game' };

const pt = (x, y) => {
  const e = document.elementFromPoint(x, y);
  return e ? e.tagName + (e.id ? '#' + e.id : '') : 'null';
};

await new Promise((r) => setTimeout(r, 1200));
const before = { mid: pt(innerWidth / 2, innerHeight / 2), state: g.state };

document.getElementById('startBtn').click();
await new Promise((r) => setTimeout(r, 700));
const afterStart = { state: g.state, mid: pt(innerWidth / 2, innerHeight / 2) };

// 真实路径：先命中最上层元素，再让它冒泡到 window 的 pointerdown/up 监听
const t = document.elementFromPoint(innerWidth / 2, innerHeight / 2) || document.body;
const opt = {
  bubbles: true, cancelable: true,
  clientX: innerWidth / 2, clientY: innerHeight / 2,
  pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
};
t.dispatchEvent(new PointerEvent('pointerdown', opt));
await new Promise((r) => setTimeout(r, 600));
const charging = {
  state: g.state,
  power: Number((g.power || 0).toFixed(2)),
  hit: t.tagName + (t.id ? '#' + t.id : ''),
};
t.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opt, { buttons: 0 })));
await new Promise((r) => setTimeout(r, 1200));
const end = { state: g.state, score: g.score, steps: g.steps };

// 三个断言：命中 canvas / 蓄力进入 charging / 真的跳出去了一步
const ok = charging.hit === 'CANVAS#scene' && charging.state === 'charging' && end.steps >= 1;
return { ok, before, afterStart, charging, end };
