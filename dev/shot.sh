#!/bin/bash
# shot.sh "<调试参数>" <outPath> [budget] [w] [h]
#   <调试参数> 直接写 auto&trait=peach&adv=1.3 就行，不用带 ? 或 #。留空 = 干净开局。
#
# Edge 无头截图的三个坑，都踩过，写在这里：
#   1) file:// 路径只要带 ?query 或 #hash，--screenshot 就静默失败：退出码 0、
#      日志空白、文件就是不落盘。所以参数改成注入一份临时副本（见 inject.mjs）。
#   2) msedge 退出之后 PNG 还要过一会儿才落盘。原来只 sleep 1.2 就检查，
#      机器一忙就误判失败。现在改成轮询等文件出现。
#   3) 不能用 rm -rf 清 profile —— 会撞上沙箱的"安全删除"拦截，脚本直接判失败。
#      改成每次重试都开一个全新的 profile 目录（名字带 $$ / 序号 / $RANDOM）。
PARAMS="$1"; OUT="$2"; BUDGET="${3:-4000}"; W="${4:-1280}"; H="${5:-780}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
NODE="/c/Users/张/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
PAGE="$ROOT/奶蛙一跳.html"
TMP="$ROOT/dev/_shot.html"

if [ -n "$PARAMS" ]; then
  "$NODE" "$ROOT/dev/inject.mjs" "$PAGE" "$TMP" "$PARAMS" >/dev/null || exit 1
  TARGET="$TMP"
else
  TARGET="$PAGE"
fi

mkdir -p "$(dirname "$OUT")"
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"   # 必须绝对路径：
# 交给 msedge 的相对 Windows 路径（dev\shots\x.png）它并不认，静默不写文件。
OUTWIN="$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
[ -f "$OUT" ] && mv -f "$OUT" "$OUT.old" 2>/dev/null

wait_for_file() {                 # $1=路径  $2=最多等多少秒
  for _ in $(seq 1 $(( $2 * 2 ))); do
    [ -s "$1" ] && return 0
    sleep 0.5
  done
  return 1
}

TMPDIR_BASE="${TEMP:-${TMPDIR:-/tmp}}"
for i in 1 2 3; do
  # profile 丢到系统临时目录：不污染工程目录，也不会积一堆删不掉的 Edge 用户数据
  PROF="$TMPDIR_BASE/j3d_shot_$$_${i}_$RANDOM"
  "$EDGE" --headless=old --disable-gpu --no-sandbox --no-first-run \
    --user-data-dir="$(cygpath -w "$PROF")" --enable-unsafe-swiftshader --hide-scrollbars \
    --window-size="$W,$H" --virtual-time-budget="$BUDGET" --screenshot="$OUTWIN" "$TARGET" \
    >/dev/null 2>&1
  wait_for_file "$OUT" 20 && { echo "OK($i): $OUT"; exit 0; }
  echo "  第 $i 次没出图，重试…"
done
echo "FAIL: $OUT"; exit 1
