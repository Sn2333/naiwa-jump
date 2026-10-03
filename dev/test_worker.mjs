/**
 * Worker 后端的离线回归。
 *
 * 为什么值得单独写一份：Worker 部署到 Cloudflare 之后，唯一的反馈渠道就是
 * 控制台的 `wrangler tail` 日志，改一句 SQL 再上线试错的成本太高。而这里用
 * Node 22 内置的 node:sqlite 造了一个 D1 适配层，于是 worker/src/index.js 里
 * 那段真正的 SQL（ON CONFLICT + MAX 的原子 upsert、按 best 排序取榜）可以在
 * 本地被真实执行 —— 语法错、语义错在推之前就暴露了。
 *
 * 用法： node dev/test_worker.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/src/index.js';

/* ------------------------------------------------------------------ */
/* D1 适配层：把 node:sqlite 包成 Workers 上 env.DB 的那几个方法        */
/* ------------------------------------------------------------------ */

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.args);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args) };
  }
  async run() {
    this.db.prepare(this.sql).run(...this.args);
    return { success: true };
  }
}

class FakeD1 {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

const env = { DB: new FakeD1() };

/* 预置一个「v1 时代已迁移过列、但号还是四位」的表：
 *  - 老玩家甲/乙：还没号（pid NULL，等补号）
 *  - v1老号：v1 时代发的四位号 1001（等平移成八位）
 * 第一次 API 调用会触发 ensureSchema 的迁移（列已存在 → 忽略；四位号平移；NULL 补号），
 * 后面的用例顺便把迁移结果一起验了。 */
env.DB.db.prepare(
  'CREATE TABLE board (nick TEXT PRIMARY KEY, best INTEGER NOT NULL DEFAULT 0,'
  + ' updated_at INTEGER NOT NULL DEFAULT 0)'
).run();
env.DB.db.prepare('ALTER TABLE board ADD COLUMN pid INTEGER').run();
env.DB.db.prepare(
  "INSERT INTO board (nick, best, updated_at, pid) VALUES"
  + " ('老玩家甲', 50, 100, NULL), ('老玩家乙', 60, 200, NULL), ('v1老号', 70, 150, 1001)"
).run();

/* ------------------------------------------------------------------ */
/* 测试脚手架                                                          */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else {
    fail++;
    console.log(`  ✗ ${name}`);
    if (extra !== undefined) console.log('     实际: ' + JSON.stringify(extra));
  }
}

const GH = 'https://sn2333.github.io';
const WB = 'https://jump3d.app.workbuddy.host';

function req(method, path, { body, origin = GH } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (body) headers['content-type'] = 'application/json';
  return new Request('https://api.example.com' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function call(method, path, opts) {
  const res = await worker.fetch(req(method, path, opts), env);
  let data = null;
  try { data = await res.clone().json(); } catch (e) { /* 204 没有 body */ }
  return { res, data };
}

/* ------------------------------------------------------------------ */

console.log('### 存活 / CORS ###');
{
  const { res, data } = await call('GET', '/api/health', { origin: '' });
  check('无 Origin 的健康检查放行', res.status === 200 && data.ok === true, data);
  check('健康检查报告已绑上 D1', data.db === true, data);

  const { res: r2 } = await call('GET', '/api/health', { origin: GH });
  check('github.io 的 CORS 回显正确',
    r2.headers.get('access-control-allow-origin') === GH,
    r2.headers.get('access-control-allow-origin'));

  const { res: r3 } = await call('GET', '/api/health', { origin: WB });
  check('workbuddy 域名的 CORS 回显正确',
    r3.headers.get('access-control-allow-origin') === WB,
    r3.headers.get('access-control-allow-origin'));

  const { res: r4, data: d4 } = await call('GET', '/api/health', { origin: 'https://evil.example.com' });
  check('陌生来源被拒且不带 CORS 头',
    r4.status === 403 && r4.headers.get('access-control-allow-origin') === null, { s: r4.status, d: d4 });

  const { res: r5 } = await call('OPTIONS', '/api/submit', { origin: GH });
  check('预检返回 204 且带方法和头',
    r5.status === 204
    && r5.headers.get('access-control-allow-methods').includes('POST')
    && r5.headers.get('access-control-allow-headers') === 'content-type');

  const { res: r6 } = await call('OPTIONS', '/api/submit', { origin: 'https://evil.example.com' });
  check('陌生来源的预检被拒', r6.status === 403, r6.status);

  /* 同源请求必须放行。Cloudflare Pages 的形态就是「网页和 API 落在同一个域名下」，
   * 那时浏览器给出的 Origin 就是自己，而域名（xxx.pages.dev）是平台分配的、
   * 不可能预先写进白名单 —— 只能靠「和请求同域名」这条规则接住，否则
   * 同域部署反而会被自己拒掉。 */
  const { res: r7 } = await call('GET', '/api/health', { origin: 'https://api.example.com' });
  check('同域来源不进白名单也放行',
    r7.status === 200 && r7.headers.get('access-control-allow-origin') === 'https://api.example.com',
    { s: r7.status, a: r7.headers.get('access-control-allow-origin') });

  const { res: r8 } = await call('GET', '/api/health', { origin: 'http://api.example.com' });
  check('同域名但协议不同不放行（防 http 冒充 https）', r8.status === 403, r8.status);
}

console.log('\n### 玩家编号（pid，八位、从 10000001 起） ###');
{
  /* 第一次调用已经跑完迁移：v1 四位号平移成八位，无号老玩家按首次上榜时间补号 */
  const { data: v1 } = await call('GET', '/api/who?nick=' + encodeURIComponent('v1老号'));
  check('v1 四位号 1001 平移成 #10000001（顺序不变）', v1.pid === 10000001, v1);

  const { data: w1 } = await call('GET', '/api/who?nick=' + encodeURIComponent('老玩家甲'));
  const { data: w2 } = await call('GET', '/api/who?nick=' + encodeURIComponent('老玩家乙'));
  check('老玩家甲补到 #10000002（接在最大号后面）', w1.pid === 10000002, w1);
  check('老玩家乙补到 #10000003', w2.pid === 10000003, w2);

  const { data: w3 } = await call('GET', '/api/who?nick=' + encodeURIComponent('查无此人'));
  check('who 给没上榜的昵称当场注册发号 #10000004（设昵称就能看到#号）',
    w3.ok === true && w3.pid === 10000004, w3);

  const { res: w4 } = await call('GET', '/api/who?nick=a');
  check('who 的昵称校验和 submit 一样严', w4.status === 400, w4.status);
}

console.log('\n### 提交成绩 ###');
{
  const { data } = await call('POST', '/api/submit', { body: { nick: '奶蛙', score: 120 } });
  check('首次提交 120 分，名次 #1',
    data.ok === true && data.best === 120 && data.rank === 1, data);
  check('新玩家领到编号 #10000005（接在老玩家与 who 注册者后面）', data.pid === 10000005, data);

  const { data: d2 } = await call('POST', '/api/submit', { body: { nick: '奶蛙', score: 80 } });
  check('低分不覆盖高分（只升不降）',
    d2.ok === true && d2.best === 120, d2);
  check('重复提交编号不变（#10000005 只发一次）', d2.pid === 10000005, d2);

  const { data: d3 } = await call('POST', '/api/submit', { body: { nick: '奶蛙', score: 300 } });
  check('高分正常刷新', d3.best === 300, d3);

  const { data: d4 } = await call('POST', '/api/submit', { body: { nick: '黄桃', score: 500 } });
  check('新玩家以 500 分拿到 #1', d4.rank === 1 && d4.best === 500, d4);
  check('第二位新玩家编号顺延 #10000006', d4.pid === 10000006, d4);
}

console.log('\n### 榜单 ###');
{
  const { data } = await call('GET', '/api/rank?limit=10&nick=' + encodeURIComponent('奶蛙'));
  check('按分数降序返回（含 v1 平移号与 who 注册的 0 分行共 6 行）',
    data.list.length === 6
    && data.list[0].nick === '黄桃' && data.list[0].rank === 1
    && data.list[1].nick === '奶蛙' && data.list[1].rank === 2
    && data.list[2].nick === 'v1老号' && data.list[2].pid === 10000001
    && data.list[3].nick === '老玩家乙' && data.list[4].nick === '老玩家甲'
    && data.list[5].nick === '查无此人' && data.list[5].best === 0,
    data.list);
  check('榜单每人带编号', data.list[0].pid === 10000006 && data.list[1].pid === 10000005, data.list);
  check('带上我的名次', data.me && data.me.rank === 2 && data.me.best === 300, data.me);
  check('我的名次也带编号', data.me && data.me.pid === 10000005, data.me);

  const { data: d2 } = await call('GET', '/api/rank?limit=1&nick=' + encodeURIComponent('奶蛙'));
  check('榜单被截断时仍能算出榜外的名次',
    d2.list.length === 1 && d2.me && d2.me.rank === 2, d2);

  const { data: d3 } = await call('GET', '/api/rank?limit=10');
  check('不传昵称时不返回 me', d3.me === null, d3.me);

  const { data: d4 } = await call('GET', '/api/rank?limit=1&nick=' + encodeURIComponent('真没有'));
  check('榜上没有的昵称不返回 me', d4.me === null, d4.me);
}

console.log('\n### 同分排序（先达成的靠前）###');
{
  await call('POST', '/api/submit', { body: { nick: '先到', score: 77 } });
  await new Promise((r) => setTimeout(r, 8));
  await call('POST', '/api/submit', { body: { nick: '后到', score: 77 } });
  await call('POST', '/api/submit', { body: { nick: '先到', score: 10 } });   // 再报一次低分，不该改变次序
  const { data } = await call('GET', '/api/rank?limit=10');
  const iFirst = data.list.findIndex((e) => e.nick === '先到');
  const iLate = data.list.findIndex((e) => e.nick === '后到');
  check('同分时先达成的排前面', iFirst >= 0 && iLate >= 0 && iFirst < iLate,
    { 先到: iFirst, 后到: iLate });
}

console.log('\n### 输入校验 ###');
{
  const cases = [
    ['太短', { nick: 'a', score: 1 }],
    ['太长', { nick: '一二三四五六七八九十十一十二十三', score: 1 }],
    ['带空格', { nick: '奶 蛙', score: 1 }],
    ['带控制字符', { nick: '奶\n蛙', score: 1 }],
    ['负数', { nick: '奶蛙', score: -5 }],
    ['超大值', { nick: '奶蛙', score: 99999999 }],
    ['非数字', { nick: '奶蛙', score: 'abc' }],
  ];
  for (const [name, body] of cases) {
    const { res, data } = await call('POST', '/api/submit', { body });
    check(`拒绝${name}`, res.status === 400 && data.ok === false, data);
  }

  // 12 个字，正好卡在上限；顺便验证中文、字母、数字、下划线、短横线都能过
  const { res: rOk } = await call('POST', '/api/submit', { body: { nick: '中文English_0-', score: 0 } });
  check('接受中英文数字下划线短横线、0 分合法', rOk.status === 200, rOk.status);

  const { res: rBadJson } = await worker.fetch(new Request('https://api.example.com/api/submit', {
    method: 'POST', headers: { origin: GH, 'content-type': 'application/json' }, body: '{{{',
  }), env).then((r) => ({ res: r }));
  check('坏 JSON 返回 400', rBadJson.status === 400, rBadJson.status);

  const { res: rGet } = await call('GET', '/api/submit');
  check('GET /api/submit 返回 405', rGet.status === 405, rGet.status);

  const { res: r404 } = await call('GET', '/api/nope');
  check('未知路径返回 404', r404.status === 404, r404.status);
}

/* 没绑数据库是最容易卡住部署的一种状态：构建能过、Worker 也能起来，但一调接口就 500。
 * 所以健康检查必须能在这种状态下明确说清楚「缺的是 D1 绑定」，而不是抛一个
 * "Cannot read properties of undefined" 让人去猜。 */
console.log('\n### 没绑 D1 时的报错要能看懂 ###');
{
  const bare = {};   // 没有 env.DB，模拟「Worker 部署了但 Bindings 里没加 D1」

  const r1 = await worker.fetch(req('GET', '/api/health', { origin: '' }), bare);
  const d1 = await r1.json();
  check('健康检查返回 503、db:false，且文案里点明是 D1 绑定',
    r1.status === 503 && d1.ok === false && d1.db === false && /D1/.test(d1.msg), d1);

  const r2 = await worker.fetch(req('GET', '/api/rank?limit=10', { origin: GH }), bare);
  const d2 = await r2.json();
  check('榜单返回 503 而不是含糊的 500',
    r2.status === 503 && d2.ok === false && /D1|数据库/.test(d2.msg), { s: r2.status, d: d2 });

  const r3 = await worker.fetch(req('POST', '/api/submit', {
    origin: GH, body: { nick: '奶蛙', score: 1 },
  }), bare);
  check('提交同样返回 503 而不是 500', r3.status === 503, r3.status);
}

/* Pages Functions 入口那层壳看着没什么内容，但恰恰是最容易出「本地完全看不出来」
 * 问题的地方：env 忘了往下传、request 传错，都会让线上 /api/* 全部 404，
 * 而本地跑 worker 模块本身一切正常。所以这里把入口也真跑一遍。 */
console.log('\n### Pages Functions 入口桥接 ###');
{
  const { onRequest } = await import('../functions/api/[[path]].js');
  check('入口导出了 onRequest', typeof onRequest === 'function', typeof onRequest);

  if (typeof onRequest === 'function') {
    /* Pages 上请求 URL 就是自己的域名，Origin 也是同一个 —— 走同域那条规则 */
    const pagesReq = (path, origin) =>
      new Request('https://naiwa-jump.pages.dev' + path, {
        headers: origin ? { origin } : {},
      });

    const r1 = await onRequest({ request: pagesReq('/api/health', ''), env });
    const d1 = await r1.json();
    check('经 Pages 入口访问 /api/health 正常',
      r1.status === 200 && d1.ok === true && d1.db === true, { s: r1.status, d: d1 });

    const r2 = await onRequest({
      request: pagesReq('/api/health', 'https://naiwa-jump.pages.dev'), env,
    });
    check('同域（Pages 自己的域名）请求被放行', r2.status === 200, r2.status);

    const r3 = await onRequest({ request: pagesReq('/api/rank?limit=5', ''), env });
    const d3 = await r3.json();
    check('经 Pages 入口能读榜单',
      r3.status === 200 && Array.isArray(d3.list), { s: r3.status, d: d3 });

    /* 入口漏传 env 的后果 = 线上所有接口 503，这里把它固定住 */
    const r4 = await onRequest({ request: pagesReq('/api/health', ''), env: {} });
    check('入口把 env 透传下去了（没绑库时应当报 503 而不是崩）',
      r4.status === 503, r4.status);
  }
}

/* ------------------------------------------------------------------ */

console.log(`\n${fail === 0 ? '✅ 全绿' : '❌ 有失败项'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
