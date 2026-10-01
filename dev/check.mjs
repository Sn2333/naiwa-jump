/**
 * 打包产物体检 —— 比逐个文件语法检查更狠的一层。
 *
 * 背景：之前只对 js/*.js 逐个 `new Function` 检查，但 build.py 会把这些
 * 模块塞进同一个 IIFE，任何「剥离不干净」的残留（例如多行 import）都只会
 * 在产物里爆炸，单文件检查是看不见的。
 *
 * 这个脚本做的事：
 *   1) 逐个模块语法检查（跳过 vendor）
 *   2) 跑一遍 build.py
 *   3) 从产物 HTML 里抠出内联 <script>，整体 parse 一遍
 *   4) 静态扫描残留的 import/export 关键字
 *
 * 用法： node dev/check.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'js');

let fail = 0;
const bad = (msg) => { console.log(msg); fail++; };

/** 和 build.py 的 strip_imports 保持同一条规律（含跨行） */
const stripImports = (s) => s.replace(/^import\b[\s\S]*?;\s*$/gm, '');

/** 用 Function 构造器做语法检查（不执行），能绕过 ESM 的 import 限制 */
function parseAsScript(src) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(src);
    return null;
  } catch (e) {
    return e.message;
  }
}

console.log('== 0) 跨模块依赖检查 ==');
/* 这是踩过的坑：game.js 用了 DEFAULT_CHAR，但那是 sprite_data.js 的导出，
 * game.js 从没 import 过。单文件打包版因为所有模块共处一个 IIFE、作用域共享，
 * 所以照跑不误；只有真正的 module 形态（= 部署上线的那一份）会当场 ReferenceError。
 * 也就是说"打包能跑"根本不能说明代码是对的，必须在源码这一层把依赖补全。 */
{
  const srcOf = new Map();
  for (const f of readdirSync(JS).filter((x) => x.endsWith('.js'))) {
    srcOf.set(f, readFileSync(path.join(JS, f), 'utf8'));
  }
  const own = new Map();     // 文件 -> 本地绑定的名字
  for (const [f, src] of srcOf) {
    const names = new Set();
    const add = (s) => String(s).split(',').forEach((n) => {
      const t = n.trim().split(/\bas\b/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    });
    for (const m of src.matchAll(/^import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?\s*$/gm)) {
      const clause = m[1];
      if (/^\*\s+as\s/.test(clause)) add(clause.replace(/^\*\s+as\s+/, ''));
      else if (clause.startsWith('{')) add(clause.replace(/[{}]/g, ''));
      else {
        add(clause.split(',')[0]);                       // default 绑定
        if (clause.includes('{')) add(clause.replace(/^[^{]*\{/, '').replace(/[{}]/g, ''));
      }
    }
    for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
    own.set(f, names);
  }
  /* 谁导出了什么 —— 只关心跨文件引用的那些 */
  const exported = new Map();
  for (const [f, src] of srcOf) {
    for (const m of src.matchAll(/^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (!exported.has(m[1])) exported.set(m[1], f);
    }
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\bas\b/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(n) && !exported.has(n)) exported.set(n, f);
      }
    }
  }
  let missing = 0;
  for (const [f, src] of srcOf) {
    if (f === 'sprite_data.js') continue;              // 生成文件，不引用别的模块
    const body = stripImports(src).replace(/^export\s+/gm, '');
    const local = own.get(f);
    for (const [name, from] of exported) {
      if (from === f || local.has(name)) continue;
      if (!new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(body)) continue;
      /* 只报"确实当成变量在用"的：排除 `foo: name` 这种当对象键、以及函数名声明 */
      const lines = body.split('\n');
      const hit = lines.findIndex((ln) => new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(ln));
      if (hit < 0) continue;
      if (new RegExp(`^\\s*${name}\\s*:`).test(lines[hit])) continue;
      bad(`  ✗ js/${f}:${hit + 1} 用了 ${name}，但它来自 js/${from}，本文件没有 import`);
      missing++;
    }
  }
  if (!missing) console.log('  ✓ 没有跨模块的漏 import');
}

console.log('\n== 1) 单文件语法检查（剥掉 import/export 后） ==');
const files = readdirSync(JS).filter((f) => f.endsWith('.js') && f !== 'sprite_data.js');
for (const f of files) {
  const raw = readFileSync(path.join(JS, f), 'utf8');
  const src = stripImports(raw).replace(/^export\s+/gm, '');
  const err = parseAsScript(src);
  /* 顺带报一下这个文件里有没有跨行 import —— 就是上次踩的坑。
   * 判据：某行以 import 开头，但直到行尾都没出现分号，说明语句跨行了 */
  const multi = raw.split('\n').some((ln) => /^\s*import\b/.test(ln) && !ln.includes(';'));
  const tag = multi ? '（含跨行 import）' : '';
  if (err) bad(`  ✗ js/${f}${tag}  ${err}`);
  else console.log(`  ✓ js/${f}${tag}`);
}

console.log('\n== 2) 产物新鲜度 ==');
const htmlPath = path.join(ROOT, '奶蛙一跳.html');
if (!existsSync(htmlPath)) {
  bad('  ✗ 产物不存在，先跑 python dev/build.py');
  console.log(fail ? `\n❌ 共 ${fail} 处问题` : '');
  process.exit(1);
}
const htmlMtime = statSync(htmlPath).mtimeMs;
const newer = files
  .map((f) => ({ f, t: statSync(path.join(JS, f)).mtimeMs }))
  .filter((x) => x.t > htmlMtime)
  .map((x) => x.f);
const idxMtime = statSync(path.join(ROOT, 'index.html')).mtimeMs;
if (idxMtime > htmlMtime) newer.push('index.html');
if (newer.length) bad(`  ✗ 产物比这些源文件旧，需要重新打包：${newer.join(', ')}`);
else console.log('  ✓ 产物是最新的');

const html = readFileSync(htmlPath, 'utf8');

console.log('\n== 3) 产物内联脚本整体检查 ==');
/* 取最后一个不含 src 属性的 <script> —— 就是内联 bundle */
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) bad('  ✗ 产物里找不到内联脚本');
for (const [i, m] of scripts.entries()) {
  const body = m[1];
  if (body.trim().length < 50) continue;  // 忽略 window.__API_BASE 这类小片段
  const err = parseAsScript(body);
  if (err) bad(`  ✗ 内联脚本 #${i}（${(body.length / 1024).toFixed(0)} KB） ${err}`);
  else console.log(`  ✓ 内联脚本 #${i}（${(body.length / 1024).toFixed(0)} KB）`);

  /* 静态扫描：非 module 的 <script> 里出现 import/export 就是死 */
  const lines = body.split('\n');
  lines.forEach((ln, n) => {
    if (/^\s*import\b/.test(ln) || /^\s*export\b/.test(ln)) {
      bad(`  ✗ 残留 ${/^\s*import\b/.test(ln) ? 'import' : 'export'} → 第 ${n + 1} 行：${ln.trim().slice(0, 90)}`);
    }
  });
}

console.log(fail ? `\n❌ 共 ${fail} 处问题` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
