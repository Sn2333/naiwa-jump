#!/usr/bin/env node
/**
 * 部署自检：一条命令验证「静态站点 → Cloudflare Worker → D1」这条链真的通了。
 *
 * 用法：
 *   node dev/verify_deploy.mjs <站点地址> [Worker地址] [--write]
 *
 *   <站点地址>    GitHub Pages / 自定义域名，例如
 *                 https://sn2333.github.io/naiwa-jump/
 *   [Worker地址]  省略时会从站点 HTML 里的 window.__API_BASE 自动解析
 *   --write       额外做一次真实提交（会在榜上留一条 0 分的记录）。
 *                 默认只读，不写任何数据。
 *
 * 为什么需要这个：Worker 有三层独立的坏法，在浏览器里长得一模一样 ——
 *   ① 站点拿到了旧的 HTML（__API_BASE 还是空的）→ 悄悄退回本地模式，榜单是本机榜
 *   ② Worker 起来了但没绑 D1 → /api/health 503
 *   ③ Worker 和 D1 都好，但 CORS 没放行这个域名 → 浏览器拦下响应，控制台报 CORS
 * 这三件事在这里被拆成三个独立断言，一眼能看出卡在哪。
 *
 * 退出码 0 = 全通过；1 = 有失败项。
 */

import { readFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const pos = argv.filter((a) => !a.startsWith('--'));
const siteUrl = pos[0];
let apiBase = pos[1];

if (!siteUrl) {
  console.error('用法: node dev/verify_deploy.mjs <站点地址> [Worker地址] [--write]');
  process.exit(2);
}

const stripSlash = (u) => String(u).replace(/\/+$/, '');
const TIMEOUT = 15000;

const results = [];
const ok = (name, detail = '') => results.push({ pass: true, name, detail });
const bad = (name, detail = '') => results.push({ pass: false, name, detail });

async function tryFetch(url, init = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/* 1. 站点本体                                                         */
/* ------------------------------------------------------------------ */

let siteHtml = null;
const isRemote = /^https?:/i.test(siteUrl);
if (isRemote) {
  try {
    const res = await tryFetch(siteUrl);
    if (res.status !== 200) {
      bad('站点可访问', `${siteUrl} → HTTP ${res.status}`);
    } else {
      siteHtml = await res.text();
      ok('站点可访问', `${siteUrl} → HTTP 200, ${siteHtml.length} 字节`);
    }
  } catch (e) {
    bad('站点可访问', `${siteUrl} → ${e.name === 'AbortError' ? '超时' : e.message}`);
  }
} else {
  // file:// —— 直接读盘，双击打开的单文件版就是这种
  try {
    siteHtml = await readFile(siteUrl.replace(/^file:\/\//, ''), 'utf8');
    ok('站点可访问', `${siteUrl} → 本地文件, ${siteHtml.length} 字节`);
  } catch (e) {
    bad('站点可访问', `${siteUrl} → ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. 从站点里解析出后端地址（这是最容易悄悄错的一环）                  */
/* ------------------------------------------------------------------ */

let siteOrigin = null;
if (/^https?:/i.test(siteUrl)) siteOrigin = new URL(siteUrl).origin;

if (siteHtml) {
  const m = siteHtml.match(/window\.__API_BASE\s*=\s*['"]([^'"]*)['"]/);
  if (!m) {
    bad('站点已接入后端', 'HTML 里找不到 window.__API_BASE —— 推上去的可能不是这一版');
  } else if (!m[1]) {
    bad(
      '站点已接入后端',
      'window.__API_BASE 是空的 → 站点会退回本地模式，榜单只统计本机（这正是「排行榜没生效」的典型原因）'
    );
  } else if (m[1] === 'same') {
    // 同域模式：网页和后端在同一个域名下（Cloudflare Pages 就是这么部署的）。
    // 后端地址就是站点自己的源，不用另配 —— 但得从站点地址推出来。
    ok('站点已接入后端', 'window.__API_BASE = same（同域：网页与 /api 同一个域名）');
    if (!apiBase && siteOrigin) apiBase = siteOrigin;
    else if (!apiBase) bad('站点已接入后端', '同域模式要求站点地址是 http(s)，才能推出后端地址');
  } else {
    ok('站点已接入后端', `window.__API_BASE = ${m[1]}`);
    if (!apiBase) apiBase = m[1];
    else if (stripSlash(apiBase) !== stripSlash(m[1])) {
      // 命令行传的和站点里写的不一致 —— 以命令行为准，但要说出来
      ok('后端地址一致性', `命令行给的 ${apiBase} 与站点内嵌的 ${m[1]} 不同（按命令行继续检查）`);
    }
  }
}

if (!apiBase) {
  console.log('\n拿不到后端地址，后面的链路检查跳过。');
  report();
  process.exit(1);
}

apiBase = stripSlash(apiBase);

/* ------------------------------------------------------------------ */
/* 3. Worker 存活 + D1 绑定                                            */
/* ------------------------------------------------------------------ */

let workerAlive = false;
try {
  const res = await tryFetch(`${apiBase}/api/health`);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON，当成坏响应 */ }

  if (!data || typeof data !== 'object') {
    bad('Worker 存活', `${apiBase}/api/health → HTTP ${res.status}，响应不是 JSON：${text.slice(0, 120)}`);
  } else if (res.status === 200 && data.ok === true && data.db === true) {
    workerAlive = true;
    ok(
      'Worker 存活 + 已绑 D1',
      data.n !== undefined ? `数据库可用，榜上现有 ${data.n} 条` : '数据库绑定正常'
    );
  } else if (res.status === 503 || data.db === false) {
    workerAlive = true;
    bad(
      'Worker 绑定的 D1',
      `Worker 起来了但数据库不可用：${data.msg || '未说明'}。` +
      '绑定要写在仓库根目录 wrangler.toml 的 [[d1_databases]] 里（变量名必须是 DB）；' +
      '控制台那个 Add 按钮是灰的，因为连了仓库后以配置文件为准'
    );
  } else {
    bad('Worker 存活', `HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
} catch (e) {
  bad(
    'Worker 存活',
    `${apiBase}/api/health → ${e.name === 'AbortError' ? '超时' : e.message}。` +
    '常见原因：地址写错 / Worker 还没部署 / 被防火墙挡了'
  );
}

/* ------------------------------------------------------------------ */
/* 4. CORS：必须放行站点所在的域名                                     */
/* ------------------------------------------------------------------ */

if (workerAlive && siteOrigin) {
  try {
    const res = await tryFetch(`${apiBase}/api/rank?limit=1`, {
      headers: { Origin: siteOrigin },
    });
    const allow = res.headers.get('access-control-allow-origin');
    if (allow === siteOrigin || allow === '*') {
      ok('CORS 放行', `Origin: ${siteOrigin} → allow-origin: ${allow}`);
    } else {
      bad(
        'CORS 放行',
        `Origin: ${siteOrigin} 没被放行（响应头 access-control-allow-origin = ${allow ?? '缺失'}）。` +
        '浏览器会直接拦掉响应，页面表现为「排行榜一直转圈 / 上报失败」。' +
        `去 worker/src/index.js 的 ALLOW_ORIGINS 里加上 ${siteOrigin}`
      );
    }

    // 顺手确认预检也过（带自定义 header 的 POST 会先发 OPTIONS）
    const pre = await tryFetch(`${apiBase}/api/submit`, {
      method: 'OPTIONS',
      headers: {
        Origin: siteOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const preAllow = pre.headers.get('access-control-allow-origin');
    if (preAllow === siteOrigin || preAllow === '*') {
      ok('CORS 预检', `OPTIONS /api/submit → ${pre.status}, allow-origin: ${preAllow}`);
    } else {
      bad('CORS 预检', `OPTIONS /api/submit → ${pre.status}, allow-origin: ${preAllow ?? '缺失'}`);
    }
  } catch (e) {
    bad('CORS 检查', e.name === 'AbortError' ? '请求超时' : e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 5. 读榜（只读，不动数据）                                            */
/* ------------------------------------------------------------------ */

if (workerAlive) {
  try {
    const res = await tryFetch(`${apiBase}/api/rank?limit=5`);
    const data = await res.json().catch(() => null);
    if (res.status === 200 && data && Array.isArray(data.list)) {
      ok(
        '读排行榜',
        `HTTP 200，返回 ${data.list.length} 条` +
          (data.total != null ? `，共 ${data.total} 位玩家` : '')
      );
    } else {
      bad('读排行榜', `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 150)}`);
    }
  } catch (e) {
    bad('读排行榜', e.name === 'AbortError' ? '请求超时' : e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 6. 可选：真写一次（默认不写，避免污染榜单）                          */
/* ------------------------------------------------------------------ */

if (WRITE && workerAlive) {
  const nick = `自检-${Date.now().toString(36).slice(-4)}`;
  try {
    const res = await tryFetch(`${apiBase}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(siteOrigin ? { Origin: siteOrigin } : {}) },
      body: JSON.stringify({ nick, score: 0 }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 200 && data && data.ok) {
      ok('写入排行榜', `提交昵称「${nick}」→ 名次 #${data.rank}，当前最高 ${data.best} 分`);
      const back = await tryFetch(`${apiBase}/api/rank?limit=100&nick=${encodeURIComponent(nick)}`);
      const rb = await back.json().catch(() => null);
      const found = rb?.list?.some((r) => r.nick === nick);
      if (found) ok('回读确认', '刚提交的昵称能在榜上查到');
      else bad('回读确认', '提交成功但榜上查不到（可能是分页/查询参数问题）');
    } else {
      bad('写入排行榜', `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 150)}`);
    }
  } catch (e) {
    bad('写入排行榜', e.name === 'AbortError' ? '请求超时' : e.message);
  }
}

report();

function report() {
  console.log('\n────────── 部署自检 ──────────');
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? '\n     ' + r.detail : ''}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log('──────────────────────────────');
  if (failed.length === 0) {
    console.log(`全部通过（${results.length} 项）`);
    if (!WRITE) console.log('提示：加 --write 可以做一次真实的写入验证。');
  } else {
    console.log(`${failed.length} 项失败 / 共 ${results.length} 项`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}
