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
# 端口不能写死：8899 常被别的进程占着，抢占失败后 http.server 会直接退出，
# 后面的探针就全打在空气上（表现为 ERR_CONNECTION_REFUSED）。
# 这里从 8899 起找一个"真的能起服务"的端口，起完还要探活，成功才往下走。
: "${PY:=python}"
start_http() {
  for p in 8899 8900 8901 8902 8903 8904; do
    "$PY" -m http.server "$p" --bind 127.0.0.1 >/dev/null 2>&1 &
    local pid=$!
    for i in $(seq 1 20); do
      if "$NODE" -e "fetch('http://127.0.0.1:$p/index.html').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        PORT=$p; HTTPD=$pid; return 0
      fi
      sleep 0.2
    done
    kill $pid 2>/dev/null
  done
  return 1
}
if ! start_http; then echo "✗ 找不到可用端口起本地服务"; exit 1; fi
MOCK_PORT=8787
"$PY" -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
HTTPD=$!
"$NODE" dev/mock_worker.mjs "$MOCK_PORT" >/dev/null 2>&1 &
MOCK=$!
trap 'kill $HTTPD $MOCK 2>/dev/null' EXIT
echo "本地服务: http://127.0.0.1:$PORT"
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

# 暂停 / 返回标题实测：五条链路（暂停→继续 / 蓄力中暂停的松手坑 /
# 暂停面板回标题 / 结算页回标题）。这是唯一一条"页面内部状态 + 视觉"都要
# 同时对上的链路，所以和点击探针一样走真实点击 + computed style。
echo "### 暂停 / 返回标题实测 ###"
PAUSE_OUT=$(PROBE_RUN="$(cat dev/pause_probe.js)" \
  "$NODE" dev/probe.mjs "http://127.0.0.1:$PORT/index.html" "$SHOT_DIR/_check_pause.png" 4000 2>&1)
if echo "$PAUSE_OUT" | grep -q '"ok":true'; then
  echo "  ✓ 暂停/继续/蓄力中暂停/回标题 全链路通过"
else
  echo "  ✗ 暂停或返回标题链路失败："
  echo "$PAUSE_OUT" | grep -A2 "PROBE_RUN 结果" || echo "$PAUSE_OUT" | tail -20
  rc=1
fi
echo

# 碰撞体积实测：落脚判定用每只角色剪影实测的脚底接触半径（def.foot），
# 不再是"所有角色一个点"。同一个超缘落点，宽脚掌的蛙站得住、单脚的虎摔下去。
echo "### 碰撞体积（按角色建模）实测 ###"
FOOT_OUT=$(PROBE_RUN="$(cat dev/foot_probe.js)" \
  "$NODE" dev/probe.mjs "http://127.0.0.1:$PORT/index.html?plain&kind=round&r=0.8&gap=2.6" \
  "$SHOT_DIR/_check_foot.png" 4000 2>&1)
if echo "$FOOT_OUT" | grep -q '"ok":true'; then
  echo "  ✓ foot 数据链路 + 同点虎摔/蛙站 行为差异 全过"
else
  echo "  ✗ 碰撞体积回归失败："
  echo "$FOOT_OUT" | grep -A3 "PROBE_RUN 结果" || echo "$FOOT_OUT" | tail -20
  rc=1
fi
echo

# 货币 / 商店 / 公告(含赠礼) / 新砖种 / 冰冰冰 / 角色买卖 / 动图角色 / 装饰 / 设置 / 渲染循环防异常实测。
# 其中"渲染循环防异常"是「标题界面有概率卡住」的根因回归：vendor 的
# WebGLAnimation 先回调后调度，tick 抛一次异常就会让 rAF 链断掉、画面永久定格。
# 装饰部分验的是「公告领赠品 → 装备 → 3D 真的挂上 → 换角色不掉 → 卸下」，
# 角色部分验的是「买不起拒绝 / 买下扣款 → 选中后雪碧图动图真的在推帧」。
echo "### 奶币/商店/公告赠礼/脆砖/特殊砖/冰冰冰/奶块大笑/角色/装饰/循环防异常 实测 ###"
COIN_OUT=$(PROBE_RUN="$(cat dev/coin_probe.js)" \
  "$NODE" dev/probe.mjs "http://127.0.0.1:$PORT/index.html?coin=7&coins=1&plain&seenotice&kind=round&r=0.8&gap=2.6" \
  "$SHOT_DIR/_check_coin.png" 3000 2>&1)
if echo "$COIN_OUT" | grep -q '"ok":true'; then
  echo "  ✓ 公告自动弹+附赠领取(幂等·落盘)、紧急公告置顶、商店余额、"
  echo "    砖上奶币实体(拾取累加·结算×10·每枚+5分)、脆砖碎裂、×2 翻倍、"
  echo "    弹簧/粘液/冰冰冰/磁铁/MJ砖 效果砖（含弹簧助推只活一跳）、"
  echo "    蜘蛛奶抓人(drop→grab→rise→land·退3砖·旧链清干净·计时跳走作废)、"
  echo "    奶块顶面蛙脸+大笑+大笑GIF(独立纹理·播完自清)、MJ砖无砖身字母卧倒、FOV40、"
  echo "    角色买卖与雪碧图动图推帧、设置开关/音量滑条落盘、装饰装载、循环防异常 全过"
  # 音源与背饰的量化指标直接打出来：这几项是"感觉"最容易骗人的地方
  echo "$COIN_OUT" | grep -o '"clip":{[^}]*}' | sed 's/^/    · 音源 /'
  echo "$COIN_OUT" | grep -o '"wing":{"eq":{[^}]*}' | sed 's/^/    · 背饰 /'
  echo "$COIN_OUT" | grep -o '"one":{"count":[0-9]*[^}]*}' | sed 's/^/    · 魔法阵 /'
  echo "$COIN_OUT" | grep -o '"e2e":{"off":[0-9]*,"peak":[0-9]*[^}]*}' | sed 's/^/    · 魔法阵落地 /'
  echo "$COIN_OUT" | grep -o '"fov":[0-9]*' | sed 's/^/    · 视野 /'
  echo "$COIN_OUT" | grep -o '"gifGone":{"left":[0-9]*}' | sed 's/^/    · 奶块GIF /'
  echo "$COIN_OUT" | grep -o '"backOk":[a-z]*,"nextIsMj":[a-z]*,"charVisible":[a-z]*,"blobVisible":[a-z]*,"mjCleared":[a-z]*,"tailCut":[a-z]*' | sed 's/^/    · 蜘蛛抓人 /'
  echo "$COIN_OUT" | grep -o '"grow":{[^}]*}' | sed 's/^/    · 抓回不堆积 /'
  echo "$COIN_OUT" | grep -o '"noBody":[a-z]*,"flat":{[^}]*}' | sed 's/^/    · MJ卧倒 /'
else
  echo "  ✗ 货币/公告赠礼/新砖种/角色/装饰链路失败："
  echo "$COIN_OUT" | grep -A3 "PROBE_RUN 结果" || echo "$COIN_OUT" | tail -25
  rc=1
fi
echo

# 排行榜后端回归：用 Node 内置的 node:sqlite 假装成 D1，把 worker/src/index.js
# 里那段真正的 SQL 跑一遍。Cloudflare 上的错误只在 wrangler tail 里露头，
# 改一句 SQL 上线试错的代价太大 —— 能本地验的就在这里验掉。
echo "### worker 后端回归（含 SQL） ###"
"$NODE" --no-warnings dev/test_worker.mjs || rc=1
echo

# 排行榜维护模式链路实测（2026-10-05 关停）：按钮拦截 → 零网络请求 → api 全走本地。
# ?api= 仍指到 dev/mock_worker.mjs —— 恰好用来证明「就算有后端可达，页面也不会发请求」。
echo "### 排行榜维护模式链路实测 ###"
RANK_OUT=$(PROBE_RUN="$(cat dev/rank_probe.js)" \
  "$NODE" dev/probe.mjs "http://127.0.0.1:$PORT/index.html?api=http://127.0.0.1:$MOCK_PORT" \
  "$SHOT_DIR/_check_rank.png" 4000 2>&1)
if echo "$RANK_OUT" | grep -q '"ok":true'; then
  echo "  ✓ 维护模式：榜单/昵称按钮被拦 + 零网络请求（netCalls=0）"
else
  echo "  ✗ 维护模式链路失败："
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
  echo "  ✓ 站点 / 后端地址 / Worker / D1 绑定 / CORS / 预检 全通；读榜/写榜 = 维护关停(503)"
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
