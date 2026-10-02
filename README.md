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
js/api.js           昵称 + 排行榜适配层（云服务 / 本地双模式）
js/hit.js           落点判定（圆砖、方块、八棱柱、弹簧砖、迷你砖、移动砖）
js/audio.js         WebAudio 音效
js/sprite_data.js   30 角色的 WebP base64（由 dev/extract_chars.py 生成）
js/vendor/          three.js r160（本地化，不依赖 CDN）
dev/                开发脚本（打包、抠图、无头截图、探针、回归测试）
```

`assets/chars/`（30 只角色的原始立绘，60 个 PNG/WebP）**不在仓库里** —— 版权归各原作者、
体积也有 4MB。缺了它们只是跑不了 `dev/extract_chars.py`；玩游戏、打包单文件版、
跑回归测试都不受影响，因为成品已经内联在 `js/sprite_data.js` 里了。

## 开发

```bash
# 打包单文件离线版
python dev/build.py

# 静态检查 + 打包 + 产物体检 + module 形态实测 + 落点判定回归（一条命令全绿才算过）
bash dev/check.sh

# 无头截图（调试参数走注入，不走 ?query —— Edge 对 file:// 带查询串会静默失败）
bash dev/shot.sh "bgpanel" /tmp/a.png

# 浏览器探针：拿控制台报错 + 页面真实状态 + 截图（线上页面也能用）
node dev/probe.mjs "https://jump3d.app.workbuddy.host/" /tmp/b.png
PROBE=rank node dev/probe.mjs "http://127.0.0.1:8899/index.html" /tmp/c.png

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

## 后端

线上后端是 WorkBuddy 云服务（腾讯云托管）里的 PostgreSQL，只干一件事：让「最好成绩」
这张榜是全网的。**没有账号系统** —— 不注册、不登录、不存密码，昵称和最高成绩都存在
玩家的浏览器里（`localStorage`）。

- 一张表 `board`（`nick` 主键 / `best` / `updated_at`）**server-only**：开了 RLS 但一条
  策略都不建、也不给 `anon` / `authenticated` 授权，客户端连读都读不到；
- 两个 `SECURITY DEFINER` 函数承担全部校验与写入：
  - `jump_submit(nick, score)` —— 按昵称 upsert，只保留更高分，返回我的名次
  - `jump_rank(limit, nick)` —— 全服榜 + 我的名次
- 昵称的字符集和长度在服务端再校验一遍（不信客户端），分数上限也钳一次。

这个设计有个明确的取舍：**昵称就是身份**。所以同一个人换个浏览器、或者另一个人用了
同样的昵称，成绩会并到同一行（取更高的那个）。对一个休闲小游戏来说这比「注册登录」划算得多。

没有云配置时（双击单文件版、SDK 没加载出来、离线）自动落到本地模式：昵称和成绩写
`localStorage`，界面完全一样，只是榜单只统计本机 —— 界面上会明确标出来。

## 许可

角色立绘来自各自的原始素材，仅供学习交流使用。
