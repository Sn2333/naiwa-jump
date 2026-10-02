/* 昵称 + 排行榜的前端适配层。
 *
 * 这版没有账号系统：不注册、不登录、不存密码。玩家只需要填一个昵称，
 * 昵称和最高成绩都留在本机（localStorage）。服务端只负责一件事 ——
 * 让「最好成绩」这张榜是全网的，而不是本机的一张表；纯本机做不到这件事。
 *
 * 三种运行形态，按优先级自动选一个：
 *
 *   1. http   走 Cloudflare Worker（worker/src/index.js）。这是主力形态：
 *             GitHub Pages 和 workbuddy 域名都指向同一个 Worker，换域名
 *             只是往 Worker 的来源白名单里加一行，前端什么都不用改。
 *   2. cloud  走腾讯云 CloudBase。留作回退 —— Worker 挂了、或者没配
 *             __API_BASE 时，部署在 workbuddy 域名上的那份还能照常上榜。
 *   3. local  前两个都没有（双击单文件版、离线、断网）：榜单只统计本机，
 *             界面上会明确标出来，不让人误以为成绩真的上传了。
 */

const LS_NICK = 'jump3d_nick';
const LS_BEST = 'jump3d_best';
const LS_SCORES = 'jump3d_local_scores';   // 本地模式：{ 昵称: best }

const NICK_MIN = 2;
const NICK_MAX = 12;

/** 允许的昵称字符：中英文、数字、下划线、短横线。
 *  Worker 的 checkNick() 里有一套完全等价的校验（不信客户端），两边文案保持一致。 */
const NICK_RE = /^[0-9A-Za-z_\u4e00-\u9fa5\u3040-\u30ff-]+$/;

/** 当前昵称（内存里的那一份，磁盘上另存） */
export const profile = { nick: '' };

/* ------------------------------------------------------------------ */
/* 后端地址                                                            */
/* ------------------------------------------------------------------ */

/* 双击打开的本地文件一律走本地模式：服务端会校验请求来源域名，file:// 必被拒。
 * 与其发一个注定失败的请求，不如根本不发。 */
const IS_FILE = typeof location !== 'undefined' && location.protocol === 'file:';

/** Worker 地址。部署完 Worker 后填在 index.html 的 window.__API_BASE 里。
 *  另外支持 ?api=http://127.0.0.1:8787 临时指向别的后端 —— 本地回归要用，
 *  也方便把线上那份指到自己的测试后端上排查问题。 */
function resolveHttpBase() {
  if (IS_FILE || typeof location === 'undefined') return '';
  let base = '';
  try {
    base = new URLSearchParams(location.search).get('api') || '';
  } catch (e) { /* 老浏览器没有 URLSearchParams 也不影响主流程 */ }
  if (!base && typeof window !== 'undefined') base = window.__API_BASE || '';
  return String(base).trim().replace(/\/+$/, '');   // 尾巴上的斜杠统一去掉，拼路径时才不会出现 //
}

const HTTP_BASE = resolveHttpBase();

/* ------------------------------------------------------------------ */
/* 云服务客户端（回退路径）                                            */
/* ------------------------------------------------------------------ */

let cloudClient = null;
let cloudTried = false;

/** 懒初始化 CloudBase 客户端。拿不到就返回 null，调用方据此落到本地模式。
 *  endpoint / publishableKey 都来自开通云服务时返回的 publicConfig；
 *  publishableKey 本身不含权限（服务端按来源域名放行），放在前端是设计如此。 */
function ensureCloud() {
  if (cloudTried) return cloudClient;
  cloudTried = true;
  if (IS_FILE || HTTP_BASE) return null;   // 已经有 Worker 了，不用再问 CloudBase
  const WBC = typeof window !== 'undefined' ? window.WorkBuddyCloud : null;
  const cfg = (typeof window !== 'undefined' && window.__CLOUD_CONFIG) || null;
  if (!WBC || !WBC.createWorkBuddyCloud || !cfg || !cfg.endpoint || !cfg.publishableKey) {
    return null;
  }
  try {
    cloudClient = WBC.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      publishableKey: cfg.publishableKey,
    });
  } catch (e) {
    cloudClient = null;
  }
  return cloudClient;
}

/** 后端基地址。空串 = 本地模式（保留这个名字，界面上用它判断提示语） */
export const api = {
  base: HTTP_BASE,
  get online() { return !!HTTP_BASE || !!ensureCloud(); },
  get mode() {
    if (HTTP_BASE) return 'http';
    return ensureCloud() ? 'cloud' : 'local';
  },
};

/* ------------------------------------------------------------------ */
/* 把各种错误翻译成玩家看得懂的一句话                                  */
/* ------------------------------------------------------------------ */

function friendly(err) {
  if (!err) return '操作失败';
  const code = err.code || '';
  const msg = err.message || '';
  if (code === 'PGRST202' || /could not find the function|does not exist/i.test(msg)) {
    return '服务端还没就绪，稍后再试';
  }
  if (code === '42501' || /permission denied/i.test(msg)) {
    return '没有权限，请确认是从游戏官网打开的';
  }
  if (code === '401' || /401|unauthorized/i.test(msg)) {
    return '连接被拒绝，请确认是从游戏官网打开的';
  }
  if (/超时|timeout|aborted/i.test(msg)) {
    return '服务器响应太慢，待会儿再试';
  }
  if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
    return '连不上服务器，检查一下网络';
  }
  return msg || '操作失败';
}

/* ------------------------------------------------------------------ */
/* HTTP 后端（Cloudflare Worker）                                      */
/* ------------------------------------------------------------------ */

/** 带超时的 JSON 请求。没有超时的话，网络半死时 getLeaderboard 会一直挂着，
 *  榜单面板永远停在「正在拉取…」，玩家只能刷新页面。 */
async function httpJSON(method, path, body) {
  const url = HTTP_BASE + path;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    throw new Error(friendly(e));
  }
  if (timer) clearTimeout(timer);

  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }

  if (!res.ok) {
    throw new Error(friendly(new Error(
      (data && data.msg) || `服务器返回 ${res.status}`
    )));
  }
  if (!data || !data.ok) {
    throw new Error(friendly(new Error((data && data.msg) || '服务器返回的数据不对')));
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 云后端（CloudBase，回退）                                           */
/* ------------------------------------------------------------------ */

/** rpc 的返回值有时是单元素数组，抹平一下 */
function first(data) {
  return Array.isArray(data) ? data[0] : data;
}

async function rpc(fn, args) {
  const c = ensureCloud();
  if (!c) throw new Error('云服务没接上');
  let res;
  try {
    res = await c.database.rpc(fn, args);
  } catch (e) {
    throw new Error(friendly(e));
  }
  if (res && res.error) throw new Error(friendly(res.error));
  return first(res ? res.data : null);
}

/* ------------------------------------------------------------------ */
/* 本地存储                                                            */
/* ------------------------------------------------------------------ */

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '');
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) { return fallback; }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 忽略 */ }
}

export function loadProfile() {
  try { profile.nick = localStorage.getItem(LS_NICK) || ''; } catch (e) { profile.nick = ''; }
  return profile;
}

/** 本机最高成绩。它才是玩家真正在意的数，和昵称一样存在本地。 */
export function bestScore() {
  try { return Number(localStorage.getItem(LS_BEST) || 0); } catch (e) { return 0; }
}

/* ------------------------------------------------------------------ */
/* 昵称                                                                */
/* ------------------------------------------------------------------ */

/** 本地校验，返回错误文案；通过则返回空串 */
export function validateNick(nick) {
  const n = (nick || '').trim();
  if (n.length < NICK_MIN || n.length > NICK_MAX) return `昵称要 ${NICK_MIN}~${NICK_MAX} 个字`;
  if (!NICK_RE.test(n)) return '昵称只能用中英文、数字、下划线或短横线';
  return '';
}

/** 保存昵称。填了昵称，成绩才会往全服榜上传。 */
export function setNick(nick) {
  const n = (nick || '').trim();
  const bad = validateNick(n);
  if (bad) throw new Error(bad);
  profile.nick = n;
  try { localStorage.setItem(LS_NICK, n); } catch (e) { /* 隐私模式写不进去，本次会话内仍有效 */ }
  return n;
}

/** 清除昵称：退回「只存本机」，本机最高成绩保留不动。 */
export function clearNick() {
  profile.nick = '';
  try { localStorage.removeItem(LS_NICK); } catch (e) { /* 同上 */ }
}

/* ------------------------------------------------------------------ */
/* 成绩与榜单                                                          */
/* ------------------------------------------------------------------ */

/** 上报一局成绩。没填昵称就只留本机，返回 null。 */
export async function submitScore(score) {
  const nick = profile.nick;
  if (!nick) return null;
  const s = Math.max(0, Math.floor(score));

  if (!api.online) {
    const all = readJSON(LS_SCORES, {});
    all[nick] = Math.max(all[nick] || 0, s);
    writeJSON(LS_SCORES, all);
    return { best: all[nick], rank: null, nick, local: true };
  }

  if (HTTP_BASE) {
    const r = await httpJSON('POST', '/api/submit', { nick, score: s });
    return { best: r.best, rank: r.rank, nick: r.nick || nick, local: false };
  }

  const r = await rpc('jump_submit', { p_nick: nick, p_score: s });
  if (!r || !r.ok) throw new Error((r && r.msg) || '成绩提交失败');
  return { best: r.best, rank: r.rank, nick: r.nick || nick, local: false };
}

/** 拉排行榜。返回 { list: [{rank, nick, best, me}], me: {rank, best} | null } */
export async function leaderboard(limit = 100) {
  const nick = profile.nick;
  const n = Math.max(1, Math.min(500, limit | 0));

  if (!api.online) {
    const all = readJSON(LS_SCORES, {});
    /* 本地模式下把本机最佳成绩也算进来。但没填昵称、本机也没成绩时不能凭空
     * 造一个「我 0 分」的条目 —— 榜单上挂一行 0 分毫无意义，还显得像 bug。 */
    if (nick) all[nick] = Math.max(all[nick] || 0, bestScore());
    const list = Object.keys(all)
      .map((k) => ({ nick: k, best: all[k] }))
      .sort((a, b) => b.best - a.best)
      .slice(0, n)
      .map((e, i) => ({ ...e, rank: i + 1, me: !!nick && e.nick === nick }));
    const me = list.find((e) => e.me);
    return { list, me: me ? { rank: me.rank, best: me.best } : null, local: true };
  }

  if (HTTP_BASE) {
    const q = `/api/rank?limit=${n}` + (nick ? `&nick=${encodeURIComponent(nick)}` : '');
    const r = await httpJSON('GET', q);
    const list = (r.list || []).map((e) => ({
      rank: e.rank, nick: e.nick, best: e.best,
      me: !!nick && e.nick === nick,
    }));
    return { list, me: r.me || null, local: false };
  }

  const r = await rpc('jump_rank', { p_limit: n, p_nick: nick || null });
  const list = ((r && r.list) || []).map((e) => ({
    rank: e.rank, nick: e.nick, best: e.best,
    me: !!nick && e.nick === nick,
  }));
  return { list, me: (r && r.me) || null, local: false };
}
