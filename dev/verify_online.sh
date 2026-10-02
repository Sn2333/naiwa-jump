#!/bin/bash
# 线上验收：拿真实发布域名跑无头浏览器，把结果截下来。
#
# 注意：这条路径只适合"看静态画面"。想验证云端请求（昵称上榜、拉全服榜）
# 或者看控制台报错，一律用 dev/probe.mjs —— --virtual-time-budget 遇到真实
# 网络请求会提前触发，拍下的可能是脚本还没跑完的空白照。
#
# 用法： bash dev/verify_online.sh "<查询串，如 rank 或 account>" <outPath> [budget]
# 更推荐：PROBE_Q="nick=测试&rank" node dev/probe.mjs https://jump3d.app.workbuddy.host/ out.png
PARAMS="$1"; OUT="$2"; BUDGET="${3:-9000}"
BASE="https://jump3d.app.workbuddy.host/"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"

URL="$BASE"
[ -n "$PARAMS" ] && URL="$BASE?$PARAMS"

mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
OUTWIN="$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
[ -f "$OUT" ] && mv -f "$OUT" "$OUT.old" 2>/dev/null

wait_for_file() {
  for _ in $(seq 1 $(( $2 * 2 ))); do
    [ -s "$1" ] && return 0
    sleep 0.5
  done
  return 1
}

TMPDIR_BASE="${TEMP:-${TMPDIR:-/tmp}}"
for i in 1 2 3; do
  PROF="$TMPDIR_BASE/j3d_online_$$_${i}_$RANDOM"
  "$EDGE" --headless=old --disable-gpu --no-sandbox --no-first-run \
    --user-data-dir="$(cygpath -w "$PROF")" --enable-unsafe-swiftshader --hide-scrollbars \
    --window-size=1280,780 --virtual-time-budget="$BUDGET" --screenshot="$OUTWIN" "$URL" \
    >/dev/null 2>&1
  wait_for_file "$OUT" 30 && { echo "OK($i): $OUT  <- $URL"; exit 0; }
  echo "  第 $i 次没出图，重试…"
done
echo "FAIL: $URL"; exit 1
