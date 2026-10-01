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
"$PY" -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
HTTPD=$!
trap 'kill $HTTPD 2>/dev/null' EXIT
sleep 2
"$NODE" dev/probe.mjs "http://127.0.0.1:$PORT/index.html" "$SHOT_DIR/_check_module.png" 3500 || rc=1
echo

echo "### hit regression ###"
"$NODE" dev/test_hit.mjs || rc=1
echo

if [ "$rc" -eq 0 ]; then echo "✅ 全绿"; else echo "❌ 有失败项"; fi
exit "$rc"
