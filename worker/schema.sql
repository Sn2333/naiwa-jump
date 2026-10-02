-- 奶蛙一跳 · 排行榜表结构
--
-- Worker 自己会在第一次请求时执行同样的建表语句（见 worker/src/index.js 的
-- ensureSchema），正常情况下不需要手动跑这份文件。
-- 这里留档是为了：① 想看清楚字段含义；② 想手动建表 / 加索引 / 清空数据。
--
-- 在 Cloudflare 控制台执行：Storage & Databases → D1 → 选库 → Console → 粘贴 → Run

CREATE TABLE IF NOT EXISTS board (
  nick       TEXT    PRIMARY KEY,          -- 昵称，也是唯一身份（没有账号系统）
  best       INTEGER NOT NULL DEFAULT 0,   -- 该昵称的历史最高分
  updated_at INTEGER NOT NULL DEFAULT 0    -- 最近一次提高成绩的毫秒时间戳
);

-- 排行和「我第几名」都按 best 排序/比较，建索引让这两句走索引范围扫描，
-- 而不是全表扫。D1 免费额度按扫过的行数计，索引直接决定额度烧得多快。
CREATE INDEX IF NOT EXISTS board_best_idx ON board (best DESC);


-- ---------------------------------------------------------------
-- 常用运维语句
-- ---------------------------------------------------------------

-- 看前 20 名
-- SELECT nick, best, updated_at FROM board ORDER BY best DESC, updated_at ASC LIMIT 20;

-- 看总人数
-- SELECT COUNT(*) FROM board;

-- 删掉某个昵称（比如有人占了不雅的名字）
-- DELETE FROM board WHERE nick = '要删的昵称';

-- 清空全部（测试期用）
-- DELETE FROM board;
