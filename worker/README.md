# 排行榜后端部署（Cloudflare Workers + D1）

一个文件、两个接口、零费用。全程在浏览器里点，不用装任何东西。

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

## 部署（浏览器操作，约 5 分钟）

### 1. 注册 Cloudflare

<https://dash.cloudflare.com/sign-up> —— 邮箱 + 密码就行，**不需要信用卡**。

### 2. 建数据库

左侧 **Storage & Databases → D1 SQL database → Create**，名字填 `naiwa-board`。

> 不用手动建表。Worker 第一次收到请求时会自己执行 `CREATE TABLE IF NOT EXISTS`
> （见 `src/index.js` 的 `ensureSchema`）。`schema.sql` 只是同一份结构的留档。

### 3. 建 Worker

左侧 **Workers & Pages → Create → Workers → Create Worker**，名字填 `naiwa-jump-api`，
点 **Deploy**。

### 4. 粘代码

点 **Edit code**，把编辑器里的示例代码全选删掉，然后把 **`src/index.js` 的全文**
粘进去，点右上角 **Deploy**。

### 5. 绑定数据库

回到这个 Worker 的详情页 → **Settings → Bindings → Add binding → D1 database**：

- Variable name：`DB`（**必须一字不差**，代码里用的是 `env.DB`）
- D1 database：`naiwa-board`

保存后重新 Deploy 一次。

### 6. 验证

浏览器打开这两条：

```
https://naiwa-jump-api.<你的子域>.workers.dev/api/health
https://naiwa-jump-api.<你的子域>.workers.dev/api/rank?limit=10
```

第一条返回 `{"ok":true,"ts":...}` 就成了；第二条返回 `{"ok":true,"list":[],"me":null}`
说明表和接口都通了。

### 7. 接到前端

把这个地址（**结尾不带斜杠**）填进 `index.html` 里的 `window.__API_BASE`：

```js
window.__API_BASE = 'https://naiwa-jump-api.xxxx.workers.dev';
```

填完之后前端会自动切到 Worker，腾讯云那套 CloudBase 回退代码就不再生效了。

---

## 部署（命令行，可选）

装了 Node 的话：

```bash
cd worker
npx wrangler login
npx wrangler d1 create naiwa-board     # 把输出的 database_id 填进 wrangler.toml
npx wrangler deploy
```

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/submit` | body `{nick, score}`，按昵称 upsert 更高分，返回 `{ok, nick, best, rank}` |
| `GET` | `/api/rank?limit=100&nick=xxx` | 返回 `{ok, list:[{rank,nick,best}], me:{rank,best}\|null}` |
| `GET` | `/api/health` | 存活探针 |

昵称规则（前端和这里各校验一遍，服务端不信任客户端）：

- 2~12 个字
- 只允许中英文、数字、下划线、短横线
- 分数 0 ~ 1,000,000，越大越可疑，超出直接拒

## 来源白名单

`src/index.js` 顶部的 `ORIGIN_PATTERNS` 决定哪些网站可以调用这个后端。现在放行：

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
额度按天重置（UTC 零点），用完接口报错、不会产生费用 —— 免费套餐根本不绑卡。

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
