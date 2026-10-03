# 静态站 + 排行榜后端部署（Cloudflare Pages）

一个平台、一个域名、零费用。免费套餐**不绑卡**，超额只会报错、不会产生费用。

## 为什么是 Pages，不是 Workers

一开始用的就是 Workers，部署也确实成功了 —— 但**在国内访问不到**。

`*.workers.dev` 这个域名段被 DNS 污染（解析出来是 Twitter / Facebook 的 IP），
TCP 443 直连也被挡，浏览器只会显示「无法访问此网站」。反倒是同一家 Cloudflare 的
Pages（`*.pages.dev`）实测畅通。

两者底层是同一套运行时（Pages Functions 就是 Workers），所以换过来代价极小：
**后端业务代码一个字没改**，只是多了一层入口。顺带还白赚一条 —— 网页和 API 落在
同一个域名下，跨域（CORS）整个问题都不存在了，前端也不用填什么后端地址。

| | Workers | Pages |
|---|---|---|
| 默认域名 | `*.workers.dev` ❌ 国内打不开 | `*.pages.dev` ✅ 可达 |
| 能不能跑后端 | 能 | 能（Pages Functions，同一套运行时） |
| 静态文件和 API | 要两个域名，得配跨域 | **同一个域名，零跨域** |
| 免费额度 | 10 万次请求 / 天 | 10 万次请求 / 天 + 无限静态请求 |

## 为什么存 D1 而不是 KV

原本想用 KV（键值存储），实际算下来不合适：

| | KV 免费档 | D1 免费档 |
|---|---|---|
| 每天写 | **1,000 次** | 100,000 行 |
| 每天读 | 100,000 次 | 5,000,000 行 |
| 事务 / 原子更新 | 没有 | 有（SQL） |
| 排序 | 得自己把整张榜塞进一个值里 | 原生 `ORDER BY` |

排行榜恰好是「很多人反复写同一张表」的形态，正中 KV 的短处：**没有事务**，两个人
同时提交会变成读-改-写竞态，后到的把先到的整个覆盖掉。D1 的
`INSERT ... ON CONFLICT DO UPDATE SET best = MAX(...)` 是一条原子语句，不存在这个问题。
两边都是 0 元，没理由选弱的那个。

---

## 仓库里有哪几个文件

| 文件 | 作用 |
|---|---|
| `worker/src/index.js` | **业务逻辑真源**。两个入口共用这一份，不存在两份代码要同步 |
| `functions/api/[[path]].js` | Pages Functions 入口。只有一行桥接，不复制任何业务逻辑 |
| `wrangler.toml` | Pages 部署配置（在**仓库根目录**）。含 `pages_build_output_dir = "."`，Cloudflare 读了就不用你手填构建设置 |
| `worker/schema.sql` | 表结构留档。实际建表由后端自己做，这份用于查字段、手动清库 |

`worker/src/index.js` 同时导出 `export default { fetch }`，所以**随时可以部署回 Worker**
（比如以后有了自己的域名，想换个入口）。

---

## 线上现状（已经部署好了）

| 项 | 值 |
|---|---|
| 站点 | <https://naiwa-jump.pages.dev/> |
| Pages 项目 | `naiwa-jump` —— 连着仓库 `Sn2333/naiwa-jump`，推 `main` 自动构建 |
| D1 库 | `naiwa-board`，绑定名 `DB`，id 在根目录 `wrangler.toml` 里 |
| 一条命令自检 | `node dev/verify_deploy.mjs https://naiwa-jump.pages.dev --write` |

**两条部署路线，任选：**

1. **推 GitHub（默认）** —— push 到 `main`，Cloudflare 自己构建，几十秒出结果。
2. **本机直传（GitHub 推不动时用）**：

   ```bash
   # 发布目录里必须同时有网站文件和 worker/src/ —— functions 会
   # import 它，缺了会报 Could not resolve "../../worker/src/index.js"
   CLOUDFLARE_API_TOKEN=xxx npx wrangler pages deploy . \
     --project-name=naiwa-jump --branch=main --commit-dirty=true
   ```

   `--branch=main` 才会成为生产部署；不带就会只进 Preview，线上域名看不到。

> ⚠️ **绑定只能写在配置文件里。** 项目连了 Git 仓库之后，Cloudflare 以根目录
> `wrangler.toml` 为唯一权威来源：控制台里 Settings → Bindings 的「Add」是灰的，
> **用 API 改项目的 `deployment_configs` 也不生效**（实测过，重新部署后
> `/api/health` 仍报 `db:false`）。绑定必须写进 `wrangler.toml`。

---

## 部署步骤

### 第 1 步：建 D1 数据库

左侧 **Storage & Databases → D1 → Create database**，名字填 `naiwa-board`。

表结构**不用管** —— 后端第一次收到请求时会自己建（`ensureSchema`）。

### 第 2 步：建 Pages 项目并连接仓库

**Workers & Pages → Create → Pages → Connect to Git** → 选 `Sn2333/naiwa-jump`

| 设置项 | 填什么 |
|---|---|
| 项目名 | `naiwa-jump`（决定最终域名 `naiwa-jump.pages.dev`） |
| 生产分支 | `main` |
| 框架预设 | None |
| 构建命令 | **留空**（这里没有构建步骤，文件直接发） |
| 输出目录 | `/`（`wrangler.toml` 里已经写了 `.`，通常会自动填好） |

保存后它立刻开始构建，几十秒出结果。

> ⚠️ **项目名必须和根目录 `wrangler.toml` 里的 `name` 一字不差**（两边都是
> `naiwa-jump`），否则部署会报 name mismatch。
>
> 顺带一提：Cloudflare 把 Workers 和 Pages 放在**同一个命名空间**里，名字不能
> 重复。所以如果之前建过一个同名的 Worker，得先把它删掉才能建这个 Pages 项目
> —— 这也是这个项目实际踩到的一步。

### 第 3 步：绑定 D1（改配置文件，**别去点控制台**）

> ⚠️ **控制台里那个「Add」是灰的，点不动 —— 这是设计，不是故障。**
>
> 这个项目连着 Git 仓库、根目录又有 `wrangler.toml`，Cloudflare 就把配置文件
> 当成**唯一权威来源**（source of truth）。既然每次部署读的都是配置文件，界面
> 就不让改绑定了，免得两处配置打架。所以别在界面上找按钮了，直接改文件。

把仓库根目录 `wrangler.toml` 里这三行**取消注释**并填上 id：

```toml
[[d1_databases]]
binding = "DB"                      # 必须叫 DB，代码里读的是 env.DB
database_name = "naiwa-board"
database_id = "第 1 步建库后拿到的那串 id"
```

**database_id 在哪拿**：控制台 → **Workers & Pages** → 左侧 **D1**（有的界面在
**Storage & Databases → D1**）→ 点 `naiwa-board` → 详情页上的 **Database ID**，
是一串 `8-4-4-4-12` 的十六进制。

改完提交（或网页上传）`wrangler.toml`，Cloudflare 会自动重新构建，绑定时生效 ——
**不需要**再去点 Retry deployment。

> 反过来也成立：**任何一次「在控制台加绑定」的操作都不会生效**，因为构建时以
> 配置文件为准。

### 第 4 步：验证

浏览器打开：

```
https://naiwa-jump.pages.dev/api/health
```

看到 `{"ok":true,"db":true,"ts":...}` 就全通了。

---

## 卡住了就看 `/api/health`

部署完第一次排查时，「后端没起来」和「起来了但没绑数据库」在浏览器里长得一模一样。
所以健康检查故意多做了一件事，把这两种情况分开报：

| 返回 | 含义 | 怎么办 |
|---|---|---|
| `200 {"ok":true,"db":true,...}` | 全通了 | 继续 |
| `503 {"ok":false,"db":false,"msg":"...没有绑定 D1..."}` | 后端正常，缺绑定 | 回到第 3 步 |
| `503 {"ok":false,"db":false,"msg":"D1 绑上了，但建表失败：..."}` | 绑了但库不对 | 看 msg 里的原始报错 |
| 404 / 页面打不开 | 项目没部署上 | 看 **Deployments** 里的构建日志 |

一条命令全查一遍（含站点、CORS、写入回读）：

```bash
node dev/verify_deploy.mjs https://naiwa-jump.pages.dev --write
```

---

## 命令行部署（可选）

装了 Node 的话，在**仓库根目录**：

```bash
npx wrangler login
npx wrangler pages deploy . --project-name=naiwa-jump
```

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/submit` | body `{nick, score}`，按昵称 upsert 更高分，返回 `{ok, nick, best, rank}` |
| `GET` | `/api/rank?limit=100&nick=xxx` | 返回 `{ok, list:[{rank,nick,best}], me:{rank,best}\|null}` |
| `GET` | `/api/health` | 存活探针 + 数据库绑定自检（见上一节） |

昵称规则（前端和这里各校验一遍，服务端不信任客户端）：

- 2~12 个字
- 只允许中英文、数字、下划线、短横线
- 分数 0 ~ 1,000,000，越大越可疑，超出直接拒

## 来源放行

`worker/src/index.js` 顶部有 `ORIGIN_PATTERNS` 白名单，但**部署在 Pages 上时基本用不到** ——
网页和 API 同域，走的是「与请求同域名 → 放行」那条规则，域名是平台分配的、
不用维护。现在白名单里放行的是：

```
https://sn2333.github.io                  ← GitHub Pages（如果也部署一份）
https://jump3d.app.workbuddy.host         ← 原来的域名
http://localhost:* / http://127.0.0.1:*   ← 本地开发
```

**只有当网页和后端不在同一个域名下**（比如网页放 github.io、后端放 pages.dev），
才需要把网页的 Origin 加进这个数组（不带路径、不带结尾斜杠），加完重新部署。
没加的话浏览器会直接报 CORS。

## 免费额度够不够用

| 项目 | 免费额度 | 换算到本游戏 |
|---|---|---|
| Pages 请求（Functions） | 100,000 次 / 天 | 每次提交或拉榜算一次 |
| Pages 静态请求 | 不限 | 网页、JS、角色图都走这条 |
| D1 行写入 | 100,000 行 / 天 | 每次提交写 1 行 |
| D1 行读取 | 5,000,000 行 / 天 | 拉榜扫的行数（有索引，约等于榜的长度） |
| D1 存储 | 5 GB | 一个昵称几十字节 |

也就是**每天 10 万次提交、拉榜基本不设限**。额度按天重置（UTC 零点），
用完接口报错、不会产生费用。

## 运维小抄

在 **D1 → naiwa-board → Console** 里直接敲 SQL：

```sql
-- 看前 20 名
SELECT nick, best FROM board ORDER BY best DESC LIMIT 20;

-- 有人占了不雅的名字
DELETE FROM board WHERE nick = '要删的昵称';

-- 测试期清空
DELETE FROM board;
```

## 本地验证

不用部署也能把整条链路跑通：

```bash
node dev/mock_worker.mjs    # 内存版后端，接口与线上那份一致
node dev/test_worker.mjs    # 用 node:sqlite 假装成 D1，把真 SQL 跑一遍（含 Pages 入口桥接）
```

然后浏览器打开 `index.html?api=http://127.0.0.1:8787` 就能本地上榜。
`bash dev/check.sh` 已经把这两项都包含了。
