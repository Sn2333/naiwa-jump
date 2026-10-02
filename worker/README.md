# 排行榜后端部署（Cloudflare Workers + D1）

一个文件、两个接口、零费用。免费套餐**不绑卡**，超额只会报错、不会产生费用。

## 为什么是 Worker + D1，不是 KV

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
| `worker/src/index.js` | Worker 本体。自包含，不 import 任何东西，粘到控制台也能跑 |
| `wrangler.toml` | **在仓库根目录**（不是这一层）。Cloudflare 自动构建默认在根目录执行 `wrangler deploy`，配置放根目录才找得到 |
| `worker/schema.sql` | 表结构的留档。实际建表由 Worker 自己做，这份用于查字段、手动清库 |

---

## 路线 A：连接 GitHub 仓库自动构建（推荐，push 即部署）

1. **建库**：左侧 **Storage & Databases → D1 SQL database → Create**，名字 `naiwa-board`。
   建好后进详情页，把 **Database ID** 复制出来（一串 `8-4-4-4-12` 的十六进制）。

2. **把这行填进仓库根目录的 `wrangler.toml`**，取消注释：

   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "naiwa-board"
   database_id = "刚才复制的 Database ID"
   ```

3. **连仓库**：**Workers & Pages → Create → Import a repository** → 选 GitHub 账号 →
   选 `naiwa-jump` → 保存并部署。

4. **构建设置全部保持默认**：

   | 设置项 | 填什么 |
   |---|---|
   | 构建命令 | 留空 |
   | 部署命令 | `npx wrangler deploy`（默认值） |
   | 根目录 | **留空** |

5. **Worker 名字必须对得上**。控制台里这个 Worker 的名字要和 `wrangler.toml` 里的
   `name = "naiwa-jump-api"` 一字不差，否则构建直接失败并报
   `The name in your Wrangler configuration file must match the name of your Worker`。
   建项目时名字就填 `naiwa-jump-api` 最省事。

6. **验证**：浏览器打开
   `https://naiwa-jump-api.<你的子域>.workers.dev/api/health`

---

## 路线 B：不连仓库，浏览器里手点（约 5 分钟）

1. 建库同上（`naiwa-board`）。
2. **Workers & Pages → Create → Workers → Create Worker**，名字填 `naiwa-jump-api`，Deploy。
3. 点 **Edit code**，把示例代码全选删掉，粘进 `worker/src/index.js` 全文，Deploy。
4. 进这个 Worker 的 **Settings → Bindings → Add binding → D1 database**：
   - Variable name：`DB`（**必须一字不差**，代码里用的是 `env.DB`）
   - D1 database：`naiwa-board`
5. 保存后再 Deploy 一次。

> 这条路线下绑定来自控制台。**路线 A 下以 `wrangler.toml` 为准** —— 构建时配置文件是
> 权威来源，所以在仓库里跑自动构建时，绑定请写进 `wrangler.toml`。

---

## 卡住了就看 `/api/health`

部署完第一次排查时，「Worker 没起来」和「Worker 起来了但没绑数据库」在浏览器里
长得一模一样。所以健康检查故意多做了一件事，把这两种情况分开报：

| 返回 | 含义 | 怎么办 |
|---|---|---|
| `200 {"ok":true,"db":true,...}` | 全通了 | 继续 |
| `503 {"ok":false,"db":false,"msg":"...没有绑定 D1..."}` | Worker 正常，缺 Bindings | 按上面的步骤 4 加绑定 |
| `503 {"ok":false,"db":false,"msg":"D1 绑上了，但建表失败：..."}` | 绑定了但库不对 | 看 msg 里 D1 的原始报错 |
| 502 / 页面打不开 / 构建日志报错 | Worker 没部署上去 | 看 **Deployments → View build history** |

构建失败的三种典型报错：

- `Missing entry-point: ...` —— 根目录没找到 `wrangler.toml`，把「根目录」留空
- `The name in your Wrangler configuration file must match ...` —— Worker 名字对不上
- `Could not route to /client/v4/accounts//workers/services/` —— 配置里多了 `account_id`，删掉

---

## 命令行部署（可选）

装了 Node 的话，在**仓库根目录**：

```bash
npx wrangler login
npx wrangler d1 create naiwa-board     # 把输出的 database_id 填进 wrangler.toml
npx wrangler deploy                    # 首次会自动建表
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

## 来源白名单

`worker/src/index.js` 顶部的 `ORIGIN_PATTERNS` 决定哪些网站可以调用这个后端。现在放行：

```
https://sn2333.github.io                  ← GitHub Pages
https://jump3d.app.workbuddy.host         ← 原来的域名
http://localhost:* / http://127.0.0.1:*   ← 本地开发
```

**给 GitHub Pages 配了自定义域名、或者换了部署域名，记得往这个数组里加一行**
（Origin 不带路径、不带结尾斜杠），加完重新 Deploy。没加的话浏览器会直接报 CORS。

## 免费额度够不够用

| 项目 | 免费额度 | 换算到本游戏 |
|---|---|---|
| Worker 请求 | 100,000 次 / 天 | 每次提交或拉榜算一次 |
| D1 行写入 | 100,000 行 / 天 | 每次提交写 1 行 |
| D1 行读取 | 5,000,000 行 / 天 | 拉榜扫的行数（有索引，约等于榜的长度） |
| D1 存储 | 5 GB | 一个昵称几十字节 |

也就是**每天 10 万次提交、拉榜基本不设限**，比腾讯云那份免费额度的量级大得多。
额度按天重置（UTC 零点），用完接口报错、不会产生费用。

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
node dev/mock_worker.mjs                 # 内存版后端，接口与真 Worker 一致
node dev/test_worker.mjs                 # 用 node:sqlite 假装成 D1，把真 SQL 跑一遍
```

然后浏览器打开 `index.html?api=http://127.0.0.1:8787` 就能本地上榜。
`bash dev/check.sh` 已经把这两项都包含了。
