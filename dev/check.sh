#!/usr/bin/env bash
# 一键：静态检查 + 打包 + 产物体检 + 多文件形态实测 + 命中判定回归
# 用法： bash dev/check.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

NODE="C:/Users/张/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PY="C:/Users/张/.workbuddy/binaries/python/versions/3.13.12/python.exe"
SHOT_DIR="../_shots"
rc=0

echo "### build ###"
"$PY" dev/build.py || exit 1
echo

echo "### check ###"
"$NODE" dev/check.mjs || rc=1
echo

# 关键一步：单文件打包版会掩盖"漏 import"这类 bug（各模块共处一个 IIFE，
# 作用域共享），只有真正的 module 形态才会暴露 —— 而部署上线的正是这一份。
echo "### module 形态实测（= 线上部署的那份） ###"
PORT=8899
MOCK_PORT=8787
"$PY" -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
HTTPD=$!
"$NODE" dev/mock_worker.mjs "$MOCK_PORT" >/dev/null 2>&1 &
MOCK=$!
trap 'kill $HTTPD $MOCK 2>/dev/null' EXIT
sleep 2
"$NODE" dev/probe.mjs "http://127.0.0.1:$PORT/index.html" "$SHOT_DIR/_check_module.png" 3500 || rc=1
echo

# 命中/蓄力实测：拦"看不见的透明层吃掉点击"（面板内部的 pointer-events:auto
# 会从父级 .hidden 的 none 里恢复命中，3D 画面正常但按哪儿都没反应）
echo "### 点击命中 / 蓄力实测 ###"
CLICK_OUT=$(PROBE_RUN="$(cat dev/click_probe.js)" \
  "$NODE" dev/probe.mjs "http://127.0.0.1:$PORT/index.html" "$SHOT_DIR/_check_click.png" 3500 2>&1)
if echo "$CLICK_OUT" | grep -q '"ok":true'; then
  echo "  ✓ 命中 canvas、蓄力生效、跳跃落地"
else
  echo "  ✗ 点击被遮挡或蓄力失效："
  echo "$CLICK_OUT" | grep -A2 "PROBE_RUN 结果" || echo "$CLICK_OUT" | tail -20
  rc=1
fi
echo

# 排行榜后端回归：用 Node 内置的 node:sqlite 假装成 D1，把 worker/src/index.js
# 里那段真正的 SQL 跑一遍。Cloudflare 上的错误只在 wrangler tail 里露头，
# 改一句 SQL 上线试错的代价太大 —— 能本地验的就在这里验掉。
echo "### worker 后端回归（含 SQL） ###"
"$NODE" --no-warnings dev/test_worker.mjs || rc=1
echo

# 排行榜 HTTP 链路实测：昵称 → 上报 → 拉榜 → 看见自己的名次。
# 后端是 dev/mock_worker.mjs（内存版，接口与真 Worker 一致），
# 页面用 ?api= 指过去 —— 这样不需要任何云端账号就能全自动跑。
echo "### 排行榜 HTTP 链路实测 ###"
RANK_OUT=$(PROBE_RUN="$(cat dev/rank_probe.js)" \
  "$NODE" dev/probe.mjs "http://127.0.0.1:$PORT/index.html?api=http://127.0.0.1:$MOCK_PORT" \
  "$SHOT_DIR/_check_rank.png" 4000 2>&1)
if echo "$RANK_OUT" | grep -q '"ok":true'; then
  echo "  ✓ 昵称→上报→榜单全链路（排序与我的名次都正确）"
else
  echo "  ✗ 排行榜链路失败："
  echo "$RANK_OUT" | grep -A3 "PROBE_RUN 结果" || echo "$RANK_OUT" | tail -20
  rc=1
fi
echo

# 部署自检脚本的回归：造一份「已配好后端地址」的 HTML 让它跑一遍。
# 它是留着部署那天在「真站点 + 真 Worker」上用的，别等那天才发现它坏了。
# 替换用「任意取值」的正则 —— 写死成某一个值的话，index.html 一改这里就静默失配。
echo "### 部署自检脚本（verify_deploy） ###"
sed -E "s|window\.__API_BASE = '[^']*';|window.__API_BASE = 'http://127.0.0.1:$MOCK_PORT';|" index.html > _vd_tmp.html
if ! grep -q "__API_BASE = 'http://127.0.0.1:$MOCK_PORT'" _vd_tmp.html; then
  echo "  ✗ 注入后端地址失败（index.html 里的 __API_BASE 写法变了？）"
  rc=1
fi
VD_OUT=$("$NODE" dev/verify_deploy.mjs "http://127.0.0.1:$PORT/_vd_tmp.html" --write 2>&1)
rm -f _vd_tmp.html
if echo "$VD_OUT" | grep -q "全部通过"; then
  echo "  ✓ 站点 / 后端地址 / Worker / D1 绑定 / CORS / 预检 / 读榜 / 写榜 全通"
else
  echo "  ✗ 部署自检脚本失败："
  echo "$VD_OUT" | tail -20
  rc=1
fi
echo

echo "### hit regression ###"
"$NODE" dev/test_hit.mjs || rc=1
echo

if [ "$rc" -eq 0 ]; then echo "✅ 全绿"; else echo "❌ 有失败项"; fi
exit "$rc"
