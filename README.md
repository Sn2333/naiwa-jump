# 奶蛙一跳

<img src="https://jump3d.app.workbuddy.host/assets/hero.png" width="150" align="right" alt="经典奶蛙">

一个用 three.js 写的 3D 跳一跳小游戏。按住蓄力、松开起跳，落在方块正中拿完美连击。

在线玩：<https://jump3d.app.workbuddy.host>

- 30 只「奶系」角色，全部自由选择，用纸片人 billboard 建模
- 25 套纯色 / 渐变背景，默认奶油黄，UI 明暗跟着背景自动翻
- 不注册、不要密码、不要手机号邮箱：填个昵称就能上榜，昵称和最高成绩存在本机
- 全服排行榜，展示所有玩家的最好成绩
- 单文件离线版：`奶蛙一跳.html` 双击就能玩，不需要联网

<br clear="right">

## 怎么玩

按住屏幕（或鼠标）蓄力，松手起跳。落在方块正中会累计「完美连击」，连击有额外奖励分。

## 目录结构

```
index.html          页面骨架 + 全部样式（主题变量集中在 :root 与 body.tone-light）
js/game.js          主逻辑：状态机、镜头、输入、计分、各类面板
js/character.js     纸片人角色：单位方片 + mesh.scale，换角色只换贴图
js/theme.js         背景主题表（25 套，含雾色）
js/api.js           昵称 + 排行榜适配层（Worker / 云服务 / 本地 三选一）
js/hit.js           落点判定（圆砖、方块、八棱柱、弹簧砖、迷你砖、移动砖）
js/audio.js         WebAudio 音效
js/sprite_data.js   30 角色的 WebP base64（由 dev/extract_chars.py 生成）
js/vendor/          three.js r160（本地化，不依赖 CDN）
worker/             排行榜后端源码 + D1 表结构留档（部署说明见 worker/README.md）
wrangler.toml       Worker 部署配置。**在仓库根目录**是必须的：Cloudflare 自动构建
                    默认在根目录跑 `wrangler deploy`，放子目录会报 Missing entry-point
dev/                开发脚本（打包、抠图、无头截图、探针、回归测试）
```

`assets/chars/`（30 只角色的原始立绘，60 个 PNG/WebP）**不在仓库里** —— 版权归各原作者、
体积也有 4MB。缺了它们只是跑不了 `dev/extract_chars.py`；玩游戏、打包单文件版、
跑回归测试都不受影响，因为成品已经内联在 `js/sprite_data.js` 里了。

## 开发

```bash
# 打包单文件离线版
python dev/build.py

# 静态检查 + 打包 + 产物体检 + module 形态实测 + 排行榜链路 + 落点判定回归
# （一条命令全绿才算过；含用 node:sqlite 假扮 D1 跑真 SQL 的后端回归）
bash dev/check.sh

# 只跑后端：把 worker/src/index.js 里真正的 SQL 在本机跑一遍
node dev/test_worker.mjs

# 起一个内存版后端，页面用 ?api= 指过来就能本地上榜（不用注册任何云服务）
node dev/mock_worker.mjs

# 无头截图（调试参数走注入，不走 ?query —— Edge 对 file:// 带查询串会静默失败）
bash dev/shot.sh "bgpanel" /tmp/a.png

# 浏览器探针：拿控制台报错 + 页面真实状态 + 截图（线上页面也能用）
node dev/probe.mjs "https://jump3d.app.workbuddy.host/" /tmp/b.png
PROBE=rank node dev/probe.mjs "http://127.0.0.1:8899/index.html" /tmp/c.png

# 部署后自检：一条命令验证「站点 → Worker → D1」整条链是否真通
# （站点里的后端地址、Worker 存活、D1 绑定、CORS 放行、预检、读榜、写榜）
# 不传 Worker 地址时会从站点 HTML 里自己解析；默认只读，加 --write 才写入
node dev/verify_deploy.mjs "https://sn2333.github.io/naiwa-jump/" --write

# 从原始立绘重新抠出 30 个角色
python dev/extract_chars.py
```

**为什么一定要跑 `check.sh` 里的「module 形态实测」**：单文件打包版会把所有模块塞进
同一个 IIFE，作用域共享会掩盖「漏 import」这类错误 —— 曾经 `game.js` 用了
`DEFAULT_CHAR`（`sprite_data.js` 的导出）却没 import，打包版照跑不误，而部署用的
module 形态一加载就 `ReferenceError`，整个游戏白屏。所以「打包能跑」不能说明代码是对的。

同理，`--screenshot` 拍线上页面不可信：`--virtual-time-budget` 遇到真实网络请求会提前
触发，拍下的是一张脚本还没跑完的空白照。要看线上真实情况用 `dev/probe.mjs`（走 CDP）。

`dev/shot.sh` 支持的调试参数（都写在 `js/game.js` 的 `debugHooks()` 里）：

| 参数 | 作用 |
|---|---|
| `auto` | 直接开局 |
| `adv=<秒>` | 用固定步长把模拟推进到指定时刻，便于截任意瞬间 |
| `gap=` `kind=` `r=` `trait=` `plain` | 固定砖块类型 / 半径 / 特色，跑可复现的落点用例 |
| `char=<key>` `panel` | 换角色 / 掀开角色面板 |
| `bg=<key>` `bgpanel` | 换背景 / 掀开背景面板 |
| `account` `nick=<名字>` | 掀开昵称面板 / 直接保存昵称（截图与线上验证用） |
| `rank` `seedrank=<n>` | 掀开排行榜 / 往本地榜单塞假数据 |
| `api=<地址>` | 把排行榜后端指到别的地址（本地回归、排查线上问题用） |

## 后端

后端只干一件事：让「最好成绩」这张榜是全网的。**没有账号系统** —— 不注册、不登录、
不存密码，昵称和最高成绩都存在玩家的浏览器里（`localStorage`）。

主力是 **Cloudflare Worker + D1**（`worker/`），原因见 [`worker/README.md`](worker/README.md)：
免费档每天 10 万次写、500 万行读，且 `ON CONFLICT ... MAX()` 是一条原子语句 —— 换成
KV 的话每天只有 1000 次写、还没有事务，两人同时提交会互相覆盖。

- 一张表 `board`（`nick` 主键 / `best` / `updated_at`），建在 `best DESC` 上；
- `POST /api/submit` 按昵称 upsert，只保留更高分，返回我的名次；
- `GET /api/rank` 返回全服榜 + 我的名次；
- `GET /api/health` 除了报存活，还会报**数据库有没有绑上** —— 「Worker 没起来」和
  「起来了但没绑 D1」在浏览器里长得一样，这个接口把两种状态分开报（503 + 原因）；
- 昵称字符集、长度、分数上限在服务端**再校验一遍**（不信客户端），比前端更严；
- 服务端按 `Origin` 放行，所以前端不需要任何密钥 —— 换域名只是往白名单加一行。

部署走 GitHub 自动构建：**构建设置全部保持默认**（部署命令 `npx wrangler deploy`、
根目录留空），只要 Worker 名字和根目录 `wrangler.toml` 里的 `name` 一致就行。
绑定写在 `wrangler.toml` 里（构建时配置文件是权威来源），没有 id 时那一段保持注释，
部署照样成功。

`js/api.js` 按优先级自动选后端，三种形态界面完全一样：

| 形态 | 触发条件 | 榜单范围 |
|---|---|---|
| `http` | 配了 `window.__API_BASE`（或网址带 `?api=`） | 全服 |
| `cloud` | 没配 Worker，但 CloudBase SDK 与配置在 | 全服（回退路径） |
| `local` | 双击单文件版、离线、断网 | 只统计本机，界面上会明确标出来 |

这个设计有个明确的取舍：**昵称就是身份**。所以同一个人换个浏览器、或者另一个人用了
同样的昵称，成绩会并到同一行（取更高的那个）。对一个休闲小游戏来说，这比「注册登录」
划算得多。

## 许可

角色立绘来自各自的原始素材，仅供学习交流使用。
