/* 排行榜 HTTP 链路的端到端回归
 *
 * 走的是玩家真实路径：填昵称 → 本机最高分补交 → 打开榜单 → 看见自己的名次。
 * 不直接调用 api.js 的内部函数，因为要验证的正是"界面上的按钮真的把分传上去、
 * 榜单真的把名次显示出来"这一整条链路。
 *
 * 前置：页面必须以 ?api=<地址> 指向一个可用后端（dev/check.sh 里起的是
 * dev/mock_worker.mjs）。
 */
const g = window.__game;
if (!g) return { ok: false, err: 'no game' };

const api = window.__api;
await new Promise((r) => setTimeout(r, 1200));

const out = { mode: api.mode, base: api.base };

if (api.mode !== 'http' || !api.base) {
  out.ok = false;
  out.err = '没有走 HTTP 后端，?api= 没生效';
  return out;
}

const post = (nick, score) => fetch(api.base + '/api/submit', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ nick, score }),
}).then((r) => r.json());

// 先造两个对手，这样既能验证排序，也能验证"我不是第一名"时的名次计算
out.seedA = await post('对手甲', 100);
out.seedB = await post('对手乙', 50);

// 真实链路：本机最高分 321，填昵称时自动补交
localStorage.setItem('jump3d_best', '321');
g.best = 321;
g.dom.nickInput.value = '测试蛙';
g.saveNick();
await new Promise((r) => setTimeout(r, 1000));

await g.openRankPanel();
await new Promise((r) => setTimeout(r, 600));

const rows = [...document.querySelectorAll('#rankList .rankRow')];
out.rows = rows.map((el) => el.textContent.replace(/\s+/g, ' ').trim());
out.me = (document.querySelector('#rankMe').textContent || '').replace(/\s+/g, ' ').trim();
out.marked = rows.filter((el) => el.classList.contains('me')).length;

// 断言：走 HTTP / 三条记录 / 我 321 分排第一 / 对手按分数降序 / 我那一行被标出来
out.ok = out.mode === 'http'
  && out.rows.length === 3
  && out.rows[0].includes('测试蛙') && out.rows[0].includes('321')
  && out.rows[1].includes('对手甲')
  && out.rows[2].includes('对手乙')
  && out.rows[0].includes('#1')
  && out.marked === 1
  && out.me.includes('#1');

return out;
