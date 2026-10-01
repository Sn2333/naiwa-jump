/* 账号 + 排行榜的后端适配层。
 *
 * 线上后端是 WorkBuddy 云服务（腾讯云托管）里的 PostgreSQL。账号体系是自建的，
 * 原因很具体：云端内置的 Auth 只支持「邮箱」登录（手机号和微信仅限小程序），
 * 而本游戏要的是「昵称 + 密码、不要手机号不要邮箱」。所以改成：
 *
 *   三张表（players / sessions / scores）全部 server-only —— 开了 RLS 但一条策略都
 *   不建、也不给 anon/authenticated 授权，客户端连读都读不到；
 *   所有操作走四个 SECURITY DEFINER 函数，服务端做真正的校验：
 *
 *     jump_register(nick, pwd)      服务端 bcrypt 入库；昵称唯一由 UNIQUE 索引保证，
 *                                   并发注册也不会重名
 *     jump_login(nick, pwd)         服务端比对 bcrypt，签发 192 位随机 token
 *     jump_submit(token, score)     token 换身份，写入成绩并算名次
 *     jump_rank(limit, token)       全服榜单 + 自己的名次
 *
 * 关键点：密码哈希永远不出数据库，客户端只拿得到一个随机 token；token 是不是真的，
 * 由服务端每次写成绩时校验。所以排行榜上的成绩不是随便谁都能替你改的。
 *
 * 没有云配置时（直接双击单文件 HTML、SDK 没加载出来、离线）落到「本地模式」：
 * 账号和成绩都写 localStorage，界面完全一样，只是榜单上只有自己。
 * 本地模式必须在界面上明确标出来，不能让人以为成绩真的上传了。
 */

const LS_TOKEN = 'jump3d_token';
const LS_NICK = 'jump3d_nick';
const LS_USERS = 'jump3d_local_users';     // 本地模式：{ 昵称: {hash, at} }
const LS_SCORES = 'jump3d_local_scores';   // 本地模式：{ 昵称: best }

const NICK_MIN = 2;
const NICK_MAX = 12;
const PWD_MIN = 6;
const PWD_MAX = 32;

/** 当前登录态（内存里的那一份，磁盘上另存） */
export const session = { token: '', nick: '' };

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
    return '没有权限，请重新登录';
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
/* 登录态                                                              */
/* ------------------------------------------------------------------ */

export function loadSession() {
  try {
    session.token = localStorage.getItem(LS_TOKEN) || '';
    session.nick = localStorage.getItem(LS_NICK) || '';
  } catch (e) { session.token = ''; session.nick = ''; }
  return session;
}

function saveSession(token, nick) {
  session.token = token;
  session.nick = nick;
  try {
    localStorage.setItem(LS_TOKEN, token);
    localStorage.setItem(LS_NICK, nick);
  } catch (e) { /* 隐私模式下写不进去，本次会话内仍然有效 */ }
}

export function isLoggedIn() { return !!session.token; }

export function logout() {
  session.token = '';
  session.nick = '';
  try {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_NICK);
  } catch (e) { /* 同上 */ }
}

/* ------------------------------------------------------------------ */
/* 本地模式的兜底实现                                                  */
/* ------------------------------------------------------------------ */
/* 本地模式只是为了「没联网 / 双击打开时界面仍然可用」，密码只做一层防呆哈希，
 * 不承担任何安全承诺 —— 真要存密码必须走云端，那边是服务端 bcrypt + 随机盐。 */

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
const localHash = (nick, pwd) => djb2(`${nick}\u0000${pwd}\u0000jump3d`);

function readJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '');
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) { return fallback; }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 忽略 */ }
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

/** 昵称/密码的本地校验，返回错误文案；通过则返回空串。
 *  服务端有一套等价的校验（不信客户端），两边文案保持一致。 */
export function validate(nick, pwd, pwd2) {
  const n = (nick || '').trim();
  if (n.length < NICK_MIN || n.length > NICK_MAX) return `昵称要 ${NICK_MIN}~${NICK_MAX} 个字`;
  /* 昵称是唯一登录名，先挡掉会和界面/日志打架的字符：
   * 空格、控制字符、以及各种括号引号。中文、英文、数字、下划线、短横线都放行。 */
  if (!/^[0-9A-Za-z_\u4e00-\u9fa5\u3040-\u30ff-]+$/.test(n)) return '昵称只能用中英文、数字、下划线或短横线';
  if (!pwd || pwd.length < PWD_MIN) return `密码至少 ${PWD_MIN} 位`;
  if (pwd.length > PWD_MAX) return `密码最多 ${PWD_MAX} 位`;
  if (pwd2 !== undefined && pwd !== pwd2) return '两次输入的密码不一样';
  return '';
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export async function register(nick, pwd, pwd2) {
  const n = (nick || '').trim();
  const bad = validate(n, pwd, pwd2);
  if (bad) throw new Error(bad);

  if (!api.online) {
    const users = readJSON(LS_USERS, {});
    if (users[n]) throw new Error('这个昵称已经有人用了');
    users[n] = { hash: localHash(n, pwd), at: Date.now() };
    writeJSON(LS_USERS, users);
    saveSession('local:' + n, n);
    return { nick: n, local: true };
  }

  const r = await rpc('jump_register', { p_nick: n, p_pwd: pwd });
  if (!r || !r.ok) throw new Error((r && r.msg) || '注册失败');
  saveSession(r.token, r.nick || n);
  return { nick: r.nick || n, local: false, best: r.best || 0 };
}

export async function login(nick, pwd) {
  const n = (nick || '').trim();
  if (!n || !pwd) throw new Error('昵称和密码都要填');

  if (!api.online) {
    const users = readJSON(LS_USERS, {});
    const u = users[n];
    if (!u) throw new Error('没有这个昵称，先去注册');
    if (u.hash !== localHash(n, pwd)) throw new Error('密码不对');
    saveSession('local:' + n, n);
    return { nick: n, local: true };
  }

  const r = await rpc('jump_login', { p_nick: n, p_pwd: pwd });
  if (!r || !r.ok) throw new Error((r && r.msg) || '登录失败');
  saveSession(r.token, r.nick || n);
  return { nick: r.nick || n, local: false, best: r.best || 0 };
}

/** 上报一局成绩。只有登录用户才会上报，游客的成绩只留在本机 */
export async function submitScore(score) {
  if (!isLoggedIn()) return null;
  const s = Math.max(0, Math.floor(score));

  if (!api.online) {
    const all = readJSON(LS_SCORES, {});
    all[session.nick] = Math.max(all[session.nick] || 0, s);
    writeJSON(LS_SCORES, all);
    return { best: all[session.nick], rank: null, local: true };
  }

  const r = await rpc('jump_submit', { p_token: session.token, p_score: s });
  if (!r || !r.ok) {
    // token 失效（比如换了设备或数据被清过）就当没登录，别让玩家卡在报错上
    if (r && r.msg && /失效|重新登录/.test(r.msg)) logout();
    throw new Error((r && r.msg) || '成绩提交失败');
  }
  return { best: r.best, rank: r.rank, local: false };
}

/** 拉排行榜。返回 { list: [{rank, nick, best, me}], me: {rank, best} | null } */
export async function leaderboard(limit = 100) {
  if (!api.online) {
    const all = readJSON(LS_SCORES, {});
    /* 本地模式下把本机最佳成绩也算进来。但游客 + 本机还没成绩时不能凭空
     * 造一个「我 0 分」的条目 —— 榜单上挂一行 0 分毫无意义，还显得像 bug。 */
    const mine = Number(localStorage.getItem('jump3d_best') || 0);
    if (session.nick) all[session.nick] = Math.max(all[session.nick] || 0, mine);
    const list = Object.keys(all)
      .map((nick) => ({ nick, best: all[nick] }))
      .sort((a, b) => b.best - a.best)
      .slice(0, limit)
      .map((e, i) => ({ ...e, rank: i + 1, me: e.nick === session.nick }));
    const me = list.find((e) => e.me);
    return { list, me: me ? { rank: me.rank, best: me.best } : null, local: true };
  }

  const r = await rpc('jump_rank', {
    p_limit: Math.max(1, Math.min(500, limit | 0)),
    p_token: session.token || null,
  });
  const list = ((r && r.list) || []).map((e) => ({
    rank: e.rank, nick: e.nick, best: e.best,
    me: !!session.nick && e.nick === session.nick,
  }));
  return { list, me: (r && r.me) || null, local: false };
}
