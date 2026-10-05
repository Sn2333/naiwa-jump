/* 榜单/昵称维护模式的端到端回归（2026-10-05 关停）
 *
 * 原来这份文件走的是「填昵称 → 上报 → 拉榜」的真实链路；榜单关停后，
 * 它改成验证关停本身的三件事：
 *   1. 榜单按钮点开面板，榜单位置显示「正在维护中」（2026-10-05 下午改：
 *      用户反馈"直接点不开"不符合"点开显示维护中"的要求，面板要照常打开）；
 *   2. 保存/清除昵称被拦，本机昵称数据不被改；
 *   3. api 层（submitScore/leaderboard/fetchPid）零网络请求 ——
 *      页面挂着 ?api= 指向可达的 mock 后端，恰恰用来证明「够得着也不发」。
 * 后端的 503 总闸在 dev/test_worker.mjs 里测（node:sqlite 离线跑真 SQL 文件）。
 *
 * 前置：页面以 ?api=<地址> 指向 dev/mock_worker.mjs（check.sh 已起）。
 */
const g = window.__game;
if (!g) return { ok: false, err: 'no game' };

const M = window.__apiMaint;
const api = window.__api;
await new Promise((r) => setTimeout(r, 1200));

const out = { mode: api.mode, base: api.base, flag: M && M.MAINTENANCE };

if (!M || M.MAINTENANCE !== true) {
  out.ok = false;
  out.err = 'api.js 的 MAINTENANCE 总闸没有打开';
  return out;
}

/* 计数 fetch：任何走网络的调用都会被抓到 */
let calls = 0;
const realFetch = window.fetch;
window.fetch = (...a) => { calls++; return realFetch(...a); };

/* ① 榜单按钮：面板打开、内容是维护说明（不是"点不开"） */
g.dom.rankBtn.click();
await new Promise((r) => setTimeout(r, 80));
const panel = document.getElementById('rankPanel');
const list = document.getElementById('rankList');
out.rankPanelOpens = !panel.classList.contains('hidden');
out.rankMaintShown = list.textContent.indexOf('维护中') >= 0
  && list.querySelector('.rankMaint') !== null
  && list.children.length === 1;          // 只渲染了这一块，没混进榜单行

/* ② 保存昵称：不改 profile，只弹提示；清除昵称同样被拦 */
const toastEl = document.getElementById('shopToast');
localStorage.setItem('jump3d_nick', '');
g.dom.nickInput.value = '测试蛙';
g.saveNick();
await new Promise((r) => setTimeout(r, 80));
out.nickBlocked = !localStorage.getItem('jump3d_nick')
  && toastEl.textContent.indexOf('维护中') >= 0;
toastEl.classList.remove('show');

/* ③ api 层零网络：拉榜 / 补编号 / 提交成绩全走本地分支 */
const P = window.__profile || {};
P.nick = '测试蛙'; P.pid = null;
const lb = await M.leaderboard(50);
const pid = await M.fetchPid();
const sub = await M.submitScore(321);
window.fetch = realFetch;

out.lbLocal = !!(lb && lb.local === true);
out.pidNoNet = pid === null || typeof pid === 'number';
out.subLocal = !!(sub && sub.local === true);
out.netCalls = calls;                       // ★ 核心断言：必须是 0

out.ok = out.flag === true
  && out.rankPanelOpens === true && out.rankMaintShown === true
  && out.nickBlocked === true
  && out.lbLocal === true && out.pidNoNet === true && out.subLocal === true
  && out.netCalls === 0;

return out;
