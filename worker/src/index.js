/**
 * 奶蛙一跳 · 全服排行榜后端
 * 核心逻辑（Cloudflare Workers 与 Pages Functions 共用一份）
 *
 * 这份文件同时被两个入口使用：
 *   - functions/api/[[path]].js  → Cloudflare **Pages** Functions（现在的主力，
 *     因为 Pages 的 *.pages.dev 在国内可达，而 Workers 的 *.workers.dev 整段打不开）
 *   - export default { fetch }   → Cloudflare Workers（保留，随时可部署回 Worker）
 * 两份入口都只是薄壳，业务代码只有这一份，不存在同步问题。
 *
 * 为什么是 D1 而不是 KV：
 *   KV 免费档每天只有 1000 次「写」，而且没有事务 —— 两个人同时提交，
 *   后写的会把先写的整个覆盖掉（读-改-写竞态）。排行榜恰好是「高频写同一张表」，
 *   正中 KV 的短处。
 *   D1 免费档：5,000,000 行读 / 天、100,000 行写 / 天、5 GB 存储，
 *   而且有 INSERT ... ON CONFLICT 的原子 upsert 和原生 ORDER BY。
 *   同样是 0 元，量级和正确性都好一个档位。
 *
 * 对外只有三个接口（和前端 js/api.js 里的 httpJSON 一一对应）：
 *   POST /api/submit   { nick, score }        按昵称 upsert 更高成绩，返回我的名次
 *   GET  /api/rank?limit=&nick=               全服榜 + 我的名次
 *   GET  /api/health                          存活探针 + 数据库绑定自检
 *
 * 这份文件除了标准 Web API 不依赖任何东西，可以整份复制粘贴到 Cloudflare
 * 控制台的编辑器里跑。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/* 昵称规则要和前端 js/api.js 里的 validateNick 完全一致 ——
 * 前端校验是为了给玩家即时反馈，服务端校验是为了不信任任何客户端请求。
 * 两边文案也一样，免得同一个错误在本地和云端显示成两句不同的话。 */
const NICK_MIN = 2;
const NICK_MAX = 12;
const NICK_RE = /^[0-9A-Za-z_\u4e00-\u9fa5\u3040-\u30ff-]+$/;

/* 成绩上限：正常玩一局到不了这个数，超出一定是伪造或算错了 */
const MAX_SCORE = 1000000;
const MAX_LIMIT = 200;

/* 允许调用的来源。服务端按来源域名放行，所以前端的 publishableKey 之类的
 * 东西完全不需要 —— 这里没有密钥，也没有会话。
 *
 * 换域名（比如给 GitHub Pages 配了自定义域名）时，往这个数组里加一条就行。
 * 注意 Origin 不带路径、不带结尾斜杠：https://sn2333.github.io */
const ORIGIN_PATTERNS = [
  /^https:\/\/sn2333\.github\.io$/,
  /^https:\/\/jump3d\.app\.workbuddy\.host$/,
  /* 本地开发：dev/mock_worker.mjs 或 wrangler dev */
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

/* ------------------------------------------------------------------ */
/* 建表                                                                */
/* ------------------------------------------------------------------ */

/* 每个 Worker isolate 生命周期内只建一次表。放在代码里而不是让用户去控制台
 * 手敲 SQL —— 少一步就少一个劝退点，控制台里也没那么容易看清哪句执行成功。
 * worker/schema.sql 是同一份结构的留档，想手动建表或者想看清楚字段就用它。 */
let schemaReady = null;

function ensureSchema(env) {
  if (schemaReady) return schemaReady;
  schemaReady = env.DB.batch([
    env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS board ('
      + ' nick TEXT PRIMARY KEY,'
      + ' best INTEGER NOT NULL DEFAULT 0,'
      + ' updated_at INTEGER NOT NULL DEFAULT 0)'
    ),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS board_best_idx ON board (best DESC)'),
  ]).catch((e) => {
    schemaReady = null;   // 失败就别缓存，下次请求再试
    throw e;
  });
  return schemaReady;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function corsHeaders(origin) {
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

/** 判断请求来源放不放行。self 是这次请求自己的 URL（用来识别同源请求）。
 *
 *  三层依次判断：没 Origin（curl / 服务端调用）→ 放行；在域名白名单里 → 放行；
 *  与请求同域名 → 放行。最后那条是为了 Cloudflare Pages Functions 这种
 *  「网页和 API 同一个域名」的形态 —— 那时浏览器给出的 Origin 就是自家人，
 *  不该还要求它先被写进白名单，否则每换一次预览域名都要回来改代码。 */
function originAllowed(origin, self) {
  /* 没有 Origin 的请求（curl、健康检查、服务端调用）放行；
   * 榜单本来就是公开数据，这里不是安全边界，只是不让别的网站直接拿去用。 */
  if (!origin) return true;
  if (ORIGIN_PATTERNS.some((re) => re.test(origin))) return true;
  try {
    const o = new URL(origin);
    if (self && o.host === self.host && o.protocol === self.protocol) return true;
  } catch (e) { /* Origin 不是合法 URL，当外人处理 */ }
  return false;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }, cors || {}),
  });
}

function preflight(origin, self) {
  if (!originAllowed(origin, self)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: Object.assign(corsHeaders(origin), {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    }),
  });
}

/** 校验昵称，返回错误文案；通过则返回空串。文案与前端一致。 */
function checkNick(nick) {
  if (nick.length < NICK_MIN || nick.length > NICK_MAX) {
    return '昵称要 ' + NICK_MIN + '~' + NICK_MAX + ' 个字';
  }
  if (!NICK_RE.test(nick)) return '昵称只能用中英文、数字、下划线或短横线';
  return '';
}

/** 我的名次 = 比我分高的人数 + 1。board_best_idx 让这句走索引范围扫描，
 *  不用全表扫 —— D1 免费额度按「扫过的行数」计费，不是按请求数。 */
async function rankOf(env, nick) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) + 1 AS rank FROM board'
    + ' WHERE best > (SELECT best FROM board WHERE nick = ?)'
  ).bind(nick).first();
  return row ? row.rank : null;
}

/* ------------------------------------------------------------------ */
/* 接口实现                                                            */
/* ------------------------------------------------------------------ */

/* 存活探针。故意多做一件事：顺带报一次数据库绑定状态。
 *
 * 部署完第一次排查的时候，「Worker 没起来」和「Worker 起来了但没绑 D1」
 * 在浏览器里长得一模一样（都是 500 / 页面打不开），能卡人很久。
 * 这里把两种情况分成不同的状态码和文案：
 *   200 {ok:true,  db:true }              —— 全通了
 *   503 {ok:false, db:false, msg:"..."}   —— 起来了，但缺东西，msg 说清缺什么 */
async function handleHealth(env, cors) {
  if (!env || !env.DB) {
    return json({
      ok: false,
      db: false,
      msg: 'Worker 正常，但没有绑定 D1 数据库：'
        + '把仓库根目录 wrangler.toml 里的 [[d1_databases]] 三行取消注释、填上 database_id 再部署。'
        + '注意控制台里 Settings → Bindings 的「Add」是灰的 —— 项目连着仓库时以配置文件为准，界面不让改。',
    }, 503, cors);
  }
  try {
    await ensureSchema(env);
  } catch (e) {
    return json({
      ok: false,
      db: false,
      msg: 'D1 绑上了，但建表失败：' + (e && e.message ? e.message : String(e)),
    }, 503, cors);
  }
  return json({ ok: true, db: true, ts: Date.now() }, 200, cors);
}

async function handleSubmit(request, env, cors) {
  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, msg: '请求格式不对' }, 400, cors);
  }

  const nick = String((body && body.nick) || '').trim();
  const bad = checkNick(nick);
  if (bad) return json({ ok: false, msg: bad }, 400, cors);

  const score = Math.floor(Number(body && body.score));
  if (!Number.isFinite(score) || score < 0) {
    return json({ ok: false, msg: '成绩不合法' }, 400, cors);
  }
  if (score > MAX_SCORE) {
    return json({ ok: false, msg: '成绩超出上限' }, 400, cors);
  }

  /* 原子 upsert：只升不降。MAX(board.best, excluded.best) 里 board.best 指的是
   * 冲突前那一行的原值，所以两个人同时提交也不会互相覆盖。 */
  await env.DB.prepare(
    'INSERT INTO board (nick, best, updated_at) VALUES (?, ?, ?)'
    + ' ON CONFLICT(nick) DO UPDATE SET'
    + '   best = MAX(board.best, excluded.best),'
    + '   updated_at = CASE WHEN excluded.best > board.best'
    + '                     THEN excluded.updated_at ELSE board.updated_at END'
  ).bind(nick, score, Date.now()).run();

  const row = await env.DB.prepare('SELECT best FROM board WHERE nick = ?')
    .bind(nick).first();

  return json({
    ok: true,
    nick,
    best: row ? row.best : score,
    rank: await rankOf(env, nick),
  }, 200, cors);
}

async function handleRank(url, env, cors) {
  const rawLimit = parseInt(url.searchParams.get('limit') || '100', 10);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : 100));

  const rawNick = (url.searchParams.get('nick') || '').trim();
  const nick = checkNick(rawNick) ? '' : rawNick;   // 昵称不合法就当没传，榜单照常返回

  /* 同分时先达成的排前面（updated_at 升序），否则同分玩家的名次会随查询抖动，
   * 刷新一次榜单一变，看着像 bug。 */
  const { results } = await env.DB.prepare(
    'SELECT nick, best FROM board ORDER BY best DESC, updated_at ASC LIMIT ?'
  ).bind(limit).all();

  const list = (results || []).map((e, i) => ({ rank: i + 1, nick: e.nick, best: e.best }));

  let me = null;
  if (nick) {
    const hit = list.find((e) => e.nick === nick);
    if (hit) {
      me = { rank: hit.rank, best: hit.best };
    } else if (results && results.length >= limit) {
      /* 只有榜单被截断时才需要额外查一次 —— 否则「不在前 N 名」就已经说明了结果 */
      const row = await env.DB.prepare('SELECT best FROM board WHERE nick = ?')
        .bind(nick).first();
      if (row) me = { rank: await rankOf(env, nick), best: row.best };
    }
  }

  return json({ ok: true, list, me }, 200, cors);
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return preflight(origin, url);

    if (!originAllowed(origin, url)) {
      /* 不加 CORS 头，浏览器会把整条响应挡在 JS 之外 */
      return json({ ok: false, msg: '来源不被允许' }, 403, null);
    }
    const cors = corsHeaders(origin);

    try {
      if (url.pathname === '/api/health') {
        return await handleHealth(env, cors);
      }

      /* 建表只放在真要读写的两个接口前 —— 健康检查要能在「没绑库」时也答得出来，
       * 所以不能让它先撞上建表这步。 */
      if (!env || !env.DB) {
        return json({
          ok: false,
          msg: '后端还没绑数据库（Worker → Settings → Bindings 加一个 D1 database，变量名 DB）',
        }, 503, cors);
      }
      await ensureSchema(env);

      if (url.pathname === '/api/submit') {
        if (request.method !== 'POST') return json({ ok: false, msg: '只收 POST' }, 405, cors);
        return await handleSubmit(request, env, cors);
      }
      if (url.pathname === '/api/rank') {
        return await handleRank(url, env, cors);
      }
      return json({ ok: false, msg: '没有这个接口' }, 404, cors);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      return json({ ok: false, msg: '服务端出错：' + msg }, 500, cors);
    }
  },
};
