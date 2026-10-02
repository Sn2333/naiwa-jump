/**
 * 本地的「假 Worker」——内存版排行榜后端，用来在没部署 Cloudflare 之前
 * 就把前端的 HTTP 链路整条跑通。
 *
 * 它和 worker/src/index.js 保持同一套接口与语义（同样的昵称校验、同样的
 * 「只升不降」upsert、同样的同分先达成者靠前），所以：
 *   - dev/check.sh 里的排行榜回归可以全自动跑，不需要任何云端账号
 *   - 本地开发时 `?api=http://127.0.0.1:8787` 就能把页面指过来
 *
 * 唯一不同的是存储：这里存在内存里，进程一退就没了。真正的 D1 是持久的。
 *
 * 用法：
 *   node dev/mock_worker.mjs            # 监听 8787
 *   node dev/mock_worker.mjs 9000       # 换端口
 */
import http from 'node:http';

const PORT = Number(process.argv[2]) || 8787;

const NICK_MIN = 2;
const NICK_MAX = 12;
const NICK_RE = /^[0-9A-Za-z_\u4e00-\u9fa5\u3040-\u30ff-]+$/;
const MAX_SCORE = 1000000;
const MAX_LIMIT = 200;

/** nick -> { best, updated_at } */
const board = new Map();

function checkNick(nick) {
  if (nick.length < NICK_MIN || nick.length > NICK_MAX) {
    return `昵称要 ${NICK_MIN}~${NICK_MAX} 个字`;
  }
  if (!NICK_RE.test(nick)) return '昵称只能用中英文、数字、下划线或短横线';
  return '';
}

function submit(nick, score) {
  const now = Date.now();
  const cur = board.get(nick);
  if (!cur) {
    board.set(nick, { best: score, updated_at: now });
  } else if (score > cur.best) {
    cur.best = score;
    cur.updated_at = now;
  }
  return board.get(nick).best;
}

function rankOf(nick) {
  const me = board.get(nick);
  if (!me) return null;
  let higher = 0;
  for (const v of board.values()) if (v.best > me.best) higher++;
  return higher + 1;
}

function rankList(limit) {
  return [...board.entries()]
    .sort((a, b) => b[1].best - a[1].best || a[1].updated_at - b[1].updated_at)
    .slice(0, limit)
    .map(([nick, v], i) => ({ rank: i + 1, nick, best: v.best }));
}

function json(res, status, obj, origin) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // mock 是本地开发工具，不设来源白名单；真 Worker 那边是有白名单的
    'access-control-allow-origin': origin || '*',
    vary: 'Origin',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve(null); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'Origin',
    });
    return res.end();
  }

  if (url.pathname === '/api/health') {
    /* 字段要和真 Worker 的 handleHealth 对齐：真那边绑了 D1 时返回
     * { ok:true, db:true, ts }，没绑返回 503 + db:false。
     * 内存版不存在「没绑库」，所以固定 db:true；多带的 n 是本地的榜容量，
     * 方便调试时一眼看到有没有数据。 */
    return json(res, 200, { ok: true, db: true, ts: Date.now(), n: board.size }, origin);
  }

  if (url.pathname === '/api/submit') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, msg: '只收 POST' }, origin);
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, msg: '请求格式不对' }, origin);

    const nick = String(body.nick || '').trim();
    const bad = checkNick(nick);
    if (bad) return json(res, 400, { ok: false, msg: bad }, origin);

    const score = Math.floor(Number(body.score));
    if (!Number.isFinite(score) || score < 0) {
      return json(res, 400, { ok: false, msg: '成绩不合法' }, origin);
    }
    if (score > MAX_SCORE) return json(res, 400, { ok: false, msg: '成绩超出上限' }, origin);

    const best = submit(nick, score);
    return json(res, 200, { ok: true, nick, best, rank: rankOf(nick) }, origin);
  }

  if (url.pathname === '/api/rank') {
    const rawLimit = parseInt(url.searchParams.get('limit') || '100', 10);
    const limit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(rawLimit) ? rawLimit : 100));
    const rawNick = (url.searchParams.get('nick') || '').trim();
    const nick = checkNick(rawNick) ? '' : rawNick;

    const list = rankList(limit);
    let me = null;
    if (nick) {
      const hit = list.find((e) => e.nick === nick);
      if (hit) me = { rank: hit.rank, best: hit.best };
      else if (board.has(nick)) me = { rank: rankOf(nick), best: board.get(nick).best };
    }
    return json(res, 200, { ok: true, list, me }, origin);
  }

  // 测试用：清空榜单
  if (url.pathname === '/api/reset') {
    board.clear();
    return json(res, 200, { ok: true, n: 0 }, origin);
  }

  return json(res, 404, { ok: false, msg: '没有这个接口' }, origin);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock worker on http://127.0.0.1:${PORT}`);
});
