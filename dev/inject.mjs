/* inject.mjs <源 HTML> <目标 HTML> <调试参数串>
 *
 * 把调试参数塞成 window.__DBG_Q，供无头截图使用。
 * 之所以不用 ?query / #hash：file:// 路径只要带上这两样，Edge 的 --screenshot
 * 就会静默失败（退出码 0、日志空白、就是不落盘）。三种写法都试过，一样。
 * 于是改成"复制一份、把参数写死进去"，页面本身走的还是干净的 file:// 路径。
 */
import fs from 'node:fs';

const [src, dst, q] = process.argv.slice(2);
const html = fs.readFileSync(src, 'utf8');
const tag = `<script>window.__DBG_Q=${JSON.stringify(q)};</script>`;
const i = html.indexOf('</head>');
fs.writeFileSync(dst, i >= 0 ? html.slice(0, i) + tag + html.slice(i) : tag + html);
console.log(`注入 ${q} -> ${dst}`);
