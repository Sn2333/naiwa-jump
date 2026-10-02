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
}

console.log('\n### 提交成绩 ###');
{
  const { data } = await call('POST', '/api/submit', { body: { nick: '奶蛙', score: 120 } });
  check('首次提交 120 分，名次 #1',
    data.ok === true && data.best === 120 && data.rank === 1, data);

  const { data: d2 } = await call('POST', '/api/submit', { body: { nick: '奶蛙', score: 80 } });
  check('低分不覆盖高分（只升不降）',
    d2.ok === true && d2.best === 120, d2);

  const { data: d3 } = await call('POST', '/api/submit', { body: { nick: '奶蛙', score: 300 } });
  check('高分正常刷新', d3.best === 300, d3);

  const { data: d4 } = await call('POST', '/api/submit', { body: { nick: '黄桃', score: 500 } });
  check('新玩家以 500 分拿到 #1', d4.rank === 1 && d4.best === 500, d4);
}

console.log('\n### 榜单 ###');
{
  const { data } = await call('GET', '/api/rank?limit=10&nick=' + encodeURIComponent('奶蛙'));
  check('按分数降序返回',
    data.list.length === 2
    && data.list[0].nick === '黄桃' && data.list[0].rank === 1
    && data.list[1].nick === '奶蛙' && data.list[1].rank === 2,
    data.list);
  check('带上我的名次', data.me && data.me.rank === 2 && data.me.best === 300, data.me);

  const { data: d2 } = await call('GET', '/api/rank?limit=1&nick=' + encodeURIComponent('奶蛙'));
  check('榜单被截断时仍能算出榜外的名次',
    d2.list.length === 1 && d2.me && d2.me.rank === 2, d2);

  const { data: d3 } = await call('GET', '/api/rank?limit=10');
  check('不传昵称时不返回 me', d3.me === null, d3.me);

  const { data: d4 } = await call('GET', '/api/rank?limit=1&nick=' + encodeURIComponent('查无此人'));
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

/* ------------------------------------------------------------------ */

console.log(`\n${fail === 0 ? '✅ 全绿' : '❌ 有失败项'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
