#!/bin/bash
# 线上验收：拿真实发布域名跑无头浏览器，把结果截下来。
#
# 和 shot.sh 的区别：
#   1) 目标是 https 远程地址，不是 file://，所以查询串可以正常用，
#      不需要 inject.mjs 那套注入（那套是为了绕开 Edge 对 file:// + ?query 的静默失败）
#   2) 云端请求要等网络往返，虚拟时间预算给得比本地大
#
# 用法： bash dev/verify_online.sh "<查询串，如 rank 或 reg=昵称:密码>" <outPath> [budget]
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
