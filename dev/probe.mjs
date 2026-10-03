/**
 * 浏览器探针 —— 驱动 Edge/Chrome 的 CDP 调试端口，一次拿到三样东西：
 *   1) 真正的控制台输出与未捕获异常（这是 --screenshot 拿不到的）
 *   2) 页面的真实运行状态（window.__game 有没有建起来、canvas 有没有画、面板开没开）
 *   3) 截图
 *
 * 为什么不用 `--screenshot`：它遇到线上页面（有真实网络请求）时会提前触发，
 * 拍下一张"脚本还没跑完"的空白照，看起来像游戏坏了。这个坑上次把我们带偏过一次。
 *
 * 用法：
 *   node dev/probe.mjs <url> [outPng] [waitMs]
 *   PROBE=rank node dev/probe.mjs <url> ...      # 注入调试参数（等价于 ?rank）
 *   PROBE_Q='bg=navy&rank' node dev/probe.mjs    # 注入多个参数
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2];
const outPng = process.argv[3] ? path.resolve(process.argv[3]) : null;
const waitMs = Number(process.argv[4] || 6000);
const probeQ = process.env.PROBE_Q || process.env.PROBE || '';

if (!url) {
  console.error('用法: node dev/probe.mjs <url> [outPng] [waitMs]');
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* 找浏览器                                                            */
/* ------------------------------------------------------------------ */
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Edge / Chrome');
  process.exit(2);
}

const PROFILE = path.join(os.tmpdir(), `j3d_probe_${Date.now()}_${Math.floor(Math.random() * 1e6)}`);
mkdirSync(PROFILE, { recursive: true });

const port = 9200 + Math.floor(Math.random() * 300);

const child = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderrBuf = '';
child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 连上 CDP                                                            */
/* ------------------------------------------------------------------ */
async function browserWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const j = await r.json();
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
    } catch (e) { /* 还没起来，继续等 */ }
    await sleep(150);
  }
  throw new Error(`CDP 端口 ${port} 起不来\n${stderrBuf.slice(-800)}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.sessions = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const h of this.handlers) h(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
}

const main = async () => {
  const wsUrl = await browserWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
  });
  const cdp = new CDP(ws);

  const logs = [];
  const errors = [];
  /* 这两种不是游戏的问题：favicon 缺失、Edge 的跟踪防护拦了 CDN 的存储访问 */
  const benign = (s) => /favicon\.ico|Tracking Prevention|Password field is not contained/.test(s);
  cdp.on((msg) => {
    const m = msg.method;
    const p = msg.params || {};
    if (m === 'Runtime.consoleAPICalled') {
      const text = (p.args || []).map((a) => {
        if (a.type === 'string') return a.value;
        if ('value' in a) return JSON.stringify(a.value);
        return a.description || a.type;
      }).join(' ');
      logs.push(`[${p.type}] ${text}`);
      if (p.type === 'error' && !benign(text)) errors.push(text);
    } else if (m === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      const desc = String((d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常');
      errors.push(desc);
      logs.push(`[exception] ${desc}`);
    } else if (m === 'Log.entryAdded') {
      const e = p.entry || {};
      const line = `[${e.level}] ${e.text}${e.url ? ' @ ' + e.url : ''}`;
      logs.push(line);
      if (e.level === 'error' && !benign(line)) errors.push(line);
    }
  });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = sessionId;

  await cdp.send('Runtime.enable', {}, S);
  await cdp.send('Log.enable', {}, S);
  await cdp.send('Page.enable', {}, S);
  await cdp.send('Network.enable', {}, S);
  /* 视口默认 460×880（奶蛙一跳的目标机型）。验窄屏布局用 PROBE_W / PROBE_H
   * 覆盖 —— 首页那排 emoji 图标钮就是靠 PROBE_W=360 量出来"第 6 个顶出屏幕"的，
   * 光看 460 一直是对的。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Number(process.env.PROBE_W || 460), height: Number(process.env.PROBE_H || 880),
    deviceScaleFactor: 1, mobile: false,
  }, S);

  /* 页面里没有 window.__DBG_Q 时 game.js 会退回 location.search，
     所以注入它是"带上调试参数"的唯一可靠办法（file:// 和线上都能用） */
  if (probeQ) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__DBG_Q = ${JSON.stringify(probeQ)};`,
    }, S);
  }

  const failed = [];
  cdp.on((msg) => {
    if (msg.method === 'Network.loadingFailed') {
      failed.push(`${msg.params.errorText} ${msg.params.type}`);
    }
  });

  await cdp.send('Page.navigate', { url }, S);

  /* 等 load，再额外等一会儿让 three.js 把首帧渲染出来 */
  await new Promise((resolve) => {
    const t = setTimeout(resolve, waitMs + 4000);
    const off = (msg) => {
      if (msg.method === 'Page.loadEventFired') { clearTimeout(t); resolve(); }
    };
    cdp.on(off);
  });
  await sleep(waitMs);

  /* PROBE_RUN：等页面稳定后再在页面里跑一段 JS，用来测异步链路
   * （注册 → 拉榜单 → 看名次），这些在固定等待里做不完 */
  const run = process.env.PROBE_RUN;
  if (run) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(async () => { ${run} })()`,
        returnByValue: true, awaitPromise: true,
      }, S);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        errors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text));
      } else {
        console.log('== PROBE_RUN 结果 ==');
        console.log('  ' + JSON.stringify(r.result && r.result.value));
      }
    } catch (e) {
      errors.push('PROBE_RUN 失败: ' + e.message);
    }
  }

  const probeExpr = `(() => {
    const g = window.__game;
    const c = document.querySelector('canvas');
    let px = null;
    try {
      const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
      px = gl ? gl.getParameter(gl.VERSION) : 'no-gl';
    } catch (e) { px = 'gl-error: ' + e.message; }
    return {
      sdk: typeof window.WorkBuddyCloud,
      cfg: !!window.__CLOUD_CONFIG,
      apiMode: (window.__api && window.__api.mode) || null,
      game: !!g,
      state: g ? g.state : null,
      bg: g ? g.bgKey : null,
      chars: g && g.dom && g.dom.charGrid ? g.dom.charGrid.children.length : null,
      canvas: c ? c.width + 'x' + c.height : null,
      gl: px,
      panels: ['startScreen','charPanel','bgPanel','accountPanel','rankPanel','overScreen','pausePanel']
        .map((id) => {
          const el = document.getElementById(id);
          return id + '=' + (el ? (el.classList.contains('hidden') ? 'hidden' : 'shown') : 'missing');
        }).join(','),
      title: document.title,
    };
  })()`;

  let state = null;
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression: probeExpr, returnByValue: true, awaitPromise: false,
    }, S);
    state = r.result && r.result.value;
  } catch (e) {
    state = { probeError: e.message };
  }

  console.log('== 控制台 ==');
  if (logs.length === 0) console.log('  （无输出）');
  else logs.slice(0, 40).forEach((l) => console.log('  ' + l));

  console.log('\n== 未捕获异常 ==');
  if (errors.length === 0) console.log('  （无）');
  else errors.slice(0, 12).forEach((l) => console.log('  ✗ ' + l.split('\n')[0]));

  if (failed.length) {
    console.log('\n== 请求失败 ==');
    [...new Set(failed)].slice(0, 12).forEach((l) => console.log('  ✗ ' + l));
  }

  console.log('\n== 页面状态 ==');
  console.log('  ' + JSON.stringify(state, null, 2).replace(/\n/g, '\n  '));

  /* 游戏没建起来 = 这一趟白跑，必须让调用方知道 */
  const dead = !state || state.game !== true;
  if (dead) console.log('\n✗ 游戏实例没建起来（window.__game 不存在）—— 脚本在初始化时就断了');

  if (outPng) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, S);
    mkdirSync(path.dirname(outPng), { recursive: true });
    writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
    console.log(`\n截图 -> ${outPng}`);
  }

  await cdp.send('Target.closeTarget', { targetId });
  ws.close();
  child.kill();
  if (!dead && !errors.length) console.log('\n✅ 无报错，游戏正常运行');
  process.exit(dead || errors.length ? 1 : 0);
};

main().catch((e) => {
  console.error('探针失败:', e.message);
  try { child.kill(); } catch (x) { /* ignore */ }
  process.exit(2);
});
