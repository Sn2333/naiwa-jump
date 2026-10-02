/* 昵称 + 排行榜的前端适配层。
 *
 * 这版没有账号系统：不注册、不登录、不存密码。玩家只需要填一个昵称，
 * 昵称和最高成绩都留在本机（localStorage）。服务端只负责一件事 ——
 * 让「最好成绩」这张榜是全网的，而不是本机的一张表；纯本机做不到这件事。
 *
 * 服务端只有两个 SECURITY DEFINER 函数：
 *
 *   jump_submit(nick, score)   按昵称 upsert 更高成绩，返回我的名次
 *   jump_rank(limit, nick)     全服榜 + 我的名次
 *
 * board 表开了 RLS 但一条策略都不建、也不给 anon/authenticated 授权，
 * 客户端连读都读不到，只能走上面两个函数。
 *
 * 没有云配置时（双击单文件、离线、SDK 没加载出来）落到「本地模式」：
 * 榜单只统计本机，界面上会明确标出来，不让人误以为成绩真的上传了。
 */

const LS_NICK = 'jump3d_nick';
const LS_BEST = 'jump3d_best';
const LS_SCORES = 'jump3d_local_scores';   // 本地模式：{ 昵称: best }

const NICK_MIN = 2;
const NICK_MAX = 12;

/** 允许的昵称字符：中英文、数字、下划线、短横线。
 *  服务端 jump_submit 里有一套等价的校验（不信客户端），两边文案保持一致。 */
const NICK_RE = /^[0-9A-Za-z_\u4e00-\u9fa5\u3040-\u30ff-]+$/;

/** 当前昵称（内存里的那一份，磁盘上另存） */
export const profile = { nick: '' };

/* ------------------------------------------------------------------ */
/* 云服务客户端                                                        */
/* ------------------------------------------------------------------ */

/* 双击打开的本地文件一律走本地模式：服务端会校验请求来源域名，file:// 必被拒。
 * 与其发一个注定失败的请求，不如根本不发。 */
const IS_FILE = typeof location !== 'undefined' && location.protocol === 'file:';

let cloudClient = null;
let cloudTried = false;

/** 懒初始化云客户端。拿不到就返回 null，调用方据此落到本地模式。
 *  endpoint / publishableKey 都来自开通云服务时返回的 publicConfig；
 *  publishableKey 本身不含权限（服务端按来源域名放行），放在前端是设计如此。 */
function ensureCloud() {
  if (cloudTried) return cloudClient;
  cloudTried = true;
  if (IS_FILE) return null;
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
  base: '',
  get online() { return !!ensureCloud(); },
  get mode() { return this.online ? 'cloud' : 'local'; },
};

/** rpc 的返回值有时是单元素数组，抹平一下 */
function first(data) {
  return Array.isArray(data) ? data[0] : data;
}

/** 把 PostgREST / 网络的错误翻译成玩家看得懂的一句话 */
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
  if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
    return '连不上服务器，检查一下网络';
  }
  return msg || '操作失败';
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

  const r = await rpc('jump_submit', { p_nick: nick, p_score: s });
  if (!r || !r.ok) throw new Error((r && r.msg) || '成绩提交失败');
  return { best: r.best, rank: r.rank, nick: r.nick || nick, local: false };
}

/** 拉排行榜。返回 { list: [{rank, nick, best, me}], me: {rank, best} | null } */
export async function leaderboard(limit = 100) {
  const nick = profile.nick;

  if (!api.online) {
    const all = readJSON(LS_SCORES, {});
    /* 本地模式下把本机最佳成绩也算进来。但没填昵称、本机也没成绩时不能凭空
     * 造一个「我 0 分」的条目 —— 榜单上挂一行 0 分毫无意义，还显得像 bug。 */
    if (nick) all[nick] = Math.max(all[nick] || 0, bestScore());
    const list = Object.keys(all)
      .map((k) => ({ nick: k, best: all[k] }))
      .sort((a, b) => b.best - a.best)
      .slice(0, limit)
      .map((e, i) => ({ ...e, rank: i + 1, me: !!nick && e.nick === nick }));
    const me = list.find((e) => e.me);
    return { list, me: me ? { rank: me.rank, best: me.best } : null, local: true };
  }

  const r = await rpc('jump_rank', {
    p_limit: Math.max(1, Math.min(500, limit | 0)),
    p_nick: nick || null,
  });
  const list = ((r && r.list) || []).map((e) => ({
    rank: e.rank, nick: e.nick, best: e.best,
    me: !!nick && e.nick === nick,
  }));
  return { list, me: (r && r.me) || null, local: false };
}
