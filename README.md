# 奶蛙一跳

<img src="https://jump3d.app.workbuddy.host/assets/hero.png" width="150" align="right" alt="经典奶蛙">

一个用 three.js 写的 3D 跳一跳小游戏。按住蓄力、松开起跳，落在方块正中拿完美连击。

在线玩：<https://jump3d.app.workbuddy.host>

- 36 只「奶系」角色（35 只静态纸片人 + 1 只雪碧图动图），用 billboard 建模
- 25 套纯色 / 渐变背景，默认奶油黄，UI 明暗跟着背景自动翻
- 不注册、不要密码、不要手机号邮箱：填个昵称就能上榜，昵称和最高成绩存在本机
- 全服排行榜，展示所有玩家的最好成绩
- 奶币 + 商店 + 公告赠礼 + 头饰装饰（所有角色通用）
- 特色砖：脆砖、×2 砖、弹簧、粘液块、冰冰冰、磁铁砖、圣光砖、奶块
- 单文件离线版：`奶蛙一跳.html` 双击就能玩，不需要联网

<br clear="right">

## 怎么玩

按住屏幕（或鼠标）蓄力，松手起跳。落在方块正中会累计「完美连击」，连击有额外奖励分。

## 目录结构

```
index.html          页面骨架 + 全部样式（主题变量集中在 :root 与 body.tone-light）
js/game.js          主逻辑：状态机、镜头、输入、计分、各类面板、砖块与特效
js/character.js     纸片人角色：单位方片 + mesh.scale，换角色只换贴图；动图角色手动推帧
js/acc.js           装饰注册表（分类 / 清单 / 商店上架过滤）
js/acc_data.js      装饰 + 奶币贴图的 WebP base64（由 dev/build_acc_data.py 生成）
js/anim_data.js     动图角色（大笑奶蛙）的雪碧图与帧时序（由 dev/extract_laugh.py 生成）
js/media_data.js    奶块音效 mp3 + 两张收款码的 base64（由 dev/extract_media.py 生成）
js/theme.js         背景主题表（25 套，含雾色）
js/api.js           昵称 + 排行榜适配层（同域 / 跨域 / 云服务 / 本地，按优先级自动选）
js/hit.js           落点判定（圆砖、方块、八棱柱、弹簧砖、迷你砖、移动砖）
js/audio.js         WebAudio 音效（含 master 音量总线、奶块大笑采样）
js/sprite_data.js   35 角色的 WebP base64（由 dev/extract_chars.py 生成）
js/vendor/          three.js r160（本地化，不依赖 CDN）
functions/api/      Cloudflare Pages Functions 入口（/api/* 桥接到 worker/src/index.js）
worker/             排行榜后端真源 + D1 表结构留档（部署说明见 worker/README.md）
wrangler.toml       Cloudflare Pages 部署配置（pages_build_output_dir = "."）
dev/                开发脚本（打包、抠图、无头截图、探针、回归测试）
```

`assets/chars/`（角色原始立绘）**不在仓库里** —— 版权归各原作者、体积也有 4MB。
缺了它们只是跑不了 `dev/extract_chars.py`；玩游戏、打包单文件版、跑回归测试都不受影响，
因为成品已经内联在 `js/sprite_data.js` / `js/anim_data.js` / `js/acc_data.js` 里了。

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

# 从原始立绘重新抠出角色贴图 / 生成动图角色 / 内联音效与收款码
python dev/extract_chars.py      # 静态纸片人 → js/sprite_data.js
python dev/extract_laugh.py      # 大笑奶蛙.gif → js/anim_data.js（雪碧图 + 帧时序）
python dev/extract_media.py      # 奶龙大笑 mp3 + 两张收款码 → js/media_data.js
python dev/extract_acc.py        # 单件装饰 → assets/acc/<id>_256.webp
python dev/build_acc_data.py     # 装饰 + 奶币贴图 → js/acc_data.js
python dev/extract_naiwa_coin.py # 奶币三视图 → 单枚抠图（投影法定位）
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
| `shop` `notice` `settings` `support=mail\|pay` | 分别掀开商店 / 公告 / 设置 / 支持作者（后两者带子页） |
| `coin=<n>` `coins=1` | 直接给余额 / 让每块砖都挂币（抽签固定住，跑可复现的拾取用例） |
| `seenotice` | 先标成"公告已读"，免得它中途弹出来打断别的用例 |
| `acc=<id>` `buyacc=<id>` `ownchar=<key>` | 直接戴上某件装饰 / 直接拥有它 / 直接拥有某只收费角色（都不装备） |
| `api=<地址>` | 把排行榜后端指到别的地址（本地回归、排查线上问题用） |

## 后端

后端只干一件事：让「最好成绩」这张榜是全网的。**没有账号系统** —— 不注册、不登录、
不存密码，昵称和最高成绩都存在玩家的浏览器里（`localStorage`）。

跑在 **Cloudflare Pages** 上：静态文件和 Pages Functions 同一个域名，前端不需要
知道后端地址，也没有跨域这回事。

- 业务逻辑真源是 `worker/src/index.js`，两个入口共用同一份，不存在「两份代码要同步」：
  - `functions/api/[[path]].js` —— Pages Functions，**现在的主力**
  - `export default { fetch }` —— Worker 形态，保留着，随时可以部署回去
- 存储用 **D1（SQLite）**：免费档每天 100,000 行写 / 5,000,000 行读，而且
  `INSERT ... ON CONFLICT DO UPDATE SET best = MAX(...)` 是一条**原子**语句。
  换成 KV 的话每天只有 1,000 次写、还没有事务，两个人同时提交会互相覆盖。
- 一张表 `board`（`nick` 主键 / `best` / `updated_at`），索引建在 `best DESC` 上；
- `POST /api/submit` 按昵称 upsert，只保留更高分，返回我的名次；
- `GET /api/rank` 返回全服榜 + 我的名次；
- `GET /api/health` 除了报存活，还会报**数据库有没有绑上** —— 「后端没起来」和
  「起来了但没绑 D1」在浏览器里长得一样，这个接口把两种状态分开报（503 + 原因）；
- 昵称字符集、长度、分数上限在服务端**再校验一遍**（不信客户端），比前端更严；
- 来源放行三条规则：没有 Origin（curl / 服务端调用）→ 放行；在域名白名单里 → 放行；
  与请求同域名 → 放行。最后一条是专门为 Pages 这种「网页和 API 同域」的形态准备的。

**为什么不是 Workers**：一开始用的就是 Workers，部署也确实成功了，但 `*.workers.dev`
在国内整段打不开（DNS 被解析成假 IP，TLS 握手也被挡），玩家根本访问不到。
而同一家 Cloudflare 的 `*.pages.dev` 实测畅通。两者底层是同一套运行时，
所以换过来只是多了一层入口，业务代码一个字没改。

**线上地址：<https://naiwa-jump.pages.dev/>** —— 网页和 `/api/*` 都在这个域名下，
国内实测直连可用（`*.workers.dev` 不行，见下）。

**D1 绑定写在 `wrangler.toml` 里，不要在控制台点。** 这个项目连了 Git 仓库、根目录又有
配置文件，Cloudflare 就以配置文件为唯一权威来源 —— 控制台里 Settings → Bindings 的
「Add」直接是灰的。所以那三行 `[[d1_databases]]` 必须一直留在仓库根目录的
`wrangler.toml` 里；**把它删掉再 push，构建出来的部署就没有绑定，排行榜会退化成 503。**

部署步骤见 [`worker/README.md`](worker/README.md)。

`js/api.js` 按优先级自动选后端，三种形态界面完全一样：

| 形态 | 触发条件 | 榜单范围 |
|---|---|---|
| `http` | `__API_BASE` 是 `'same'`（同域）或一个 http(s) 地址（跨域） | 全服 |
| `cloud` | 没配自家后端，但 CloudBase SDK 与配置在 | 全服（回退路径） |
| `local` | 双击单文件版、离线、断网 | 只统计本机，界面上会明确标出来 |

这个设计有个明确的取舍：**昵称就是身份**。所以同一个人换个浏览器、或者另一个人用了
同样的昵称，成绩会并到同一行（取更高的那个）。对一个休闲小游戏来说，这比「注册登录」
划算得多。

## 许可

角色立绘来自各自的原始素材，仅供学习交流使用。
