# -*- coding: utf-8 -*-
"""大笑奶蛙（动图角色）-> js/anim_data.js

和其它 35 只角色不同，这只是**动图**：素材本来就是透明背景的 GIF，
不用抠图，但要让它"动起来"。

★ 为什么不用"把动画 WebP 内联进 <img>、每帧 needsUpdate"那条路：
  浏览器确实会在 <img> 里自己播动画，但**无头 Chrome 不播**（合成器不跑），
  于是这条链在回归里根本验证不了 —— 一个只能靠人眼确认、探针断言不到的
  机制，等于没测。改用**雪碧图 + 手动推进帧**：帧号由我们自己的计时器算，
  UV 偏移由我们设，任何渲染环境都一样，探针还能直接断言"两秒后帧号变了"。

做法：
  1) 逐帧解出 GIF，按**所有帧的并集包围盒**统一裁切 ——
     不能每帧各裁各的，否则角色会随呼吸上下跳。实测并集 x[10..140] y[15..193]，
     头顶在 15~53 之间浮动、脚底稳定在 193，以脚底对齐是安全的。
  2) 所有帧拼成一张雪碧图（格子之间留 4px 透明缝，免得相邻帧在 UV 边界上串色）。
  3) 连同**每帧的原始时长**一起写进 js/anim_data.js —— GIF 的帧长不是均匀的
     （大部分 50ms、少数 100ms），照抄下来动画节奏才和原图一致。

用法：
    python dev/extract_laugh.py
"""
import base64
import io
import json
import math
import pathlib
import sys

import numpy as np
from PIL import Image, ImageSequence

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from extract_chars import measure_foot, PAD   # noqa: E402  复用脚底量法，别写第二份

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(r"C:/Users/张/Downloads/大笑奶蛙.gif")
OUT_SHEET = ROOT / "assets" / "chars" / "laugh_sheet.webp"
OUT_THUMB = ROOT / "assets" / "chars" / "laugh_thumb.webp"
PREVIEW = ROOT / "assets" / "_laugh_preview.png"
OUT_JS = ROOT / "js" / "anim_data.js"

GUT = 4            # 格子间距（像素）。UV 取格子**内圈**，留出半像素余量防串色
QUALITY = 82
COLS = 10          # 79 帧 -> 10×8 = 80 格
NAME = "大笑奶蛙"
KEY = "laugh"
PRICE = 50         # 商店售价（奶币）。2026-10-03 玩家反馈 500 太贵，降到 50


def main():
    im = Image.open(SRC)
    frames = [f.convert("RGBA") for f in ImageSequence.Iterator(im)]
    durs = [f.info.get("duration", 60) for f in ImageSequence.Iterator(Image.open(SRC))]
    W, H = frames[0].size

    x0, y0, x1, y1 = W, H, -1, -1
    for f in frames:
        a = np.asarray(f)[..., 3]
        ys, xs = np.nonzero(a > 20)
        if not ys.size:
            continue
        x0, y0 = min(x0, xs.min()), min(y0, ys.min())
        x1, y1 = max(x1, xs.max()), max(y1, ys.max())
    x0, y0 = max(0, x0 - PAD), max(0, y0 - PAD)
    x1, y1 = min(W - 1, x1 + PAD), min(H - 1, y1 + PAD)
    box = (int(x0), int(y0), int(x1) + 1, int(y1) + 1)
    cut = [f.crop(box) for f in frames]
    cw, ch = cut[0].size
    print("并集包围盒 %s -> 每帧 %dx%d，共 %d 帧" % (box, cw, ch, len(cut)))

    rows = math.ceil(len(cut) / COLS)
    pitchX, pitchY = cw + GUT, ch + GUT
    sheet = Image.new("RGBA", (COLS * pitchX, rows * pitchY), (0, 0, 0, 0))
    for i, f in enumerate(cut):
        c, r = i % COLS, i // COLS
        sheet.paste(f, (c * pitchX, r * pitchY))

    OUT_SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(OUT_SHEET, format="WEBP", quality=QUALITY, method=6)
    cut[0].save(OUT_THUMB, format="WEBP", quality=90, method=6)
    sheet_kb = OUT_SHEET.stat().st_size / 1024
    print("雪碧图 %dx%d (%d×%d 格)  %.0f KB" % (sheet.width, sheet.height, COLS, rows, sheet_kb))

    # 基线（脚底归一化位置）与脚底接触半宽：都在裁切后的坐标系里量
    a = np.asarray(cut[0])[..., 3]
    ys = np.nonzero((a > 96).any(axis=1))[0]
    baseline = round(min((int(ys.max()) + 1) / ch, 1.0), 5)
    foot = round(measure_foot(cut[0], baseline), 4)

    tile = Image.new("RGB", (cw * 4, ch), (110, 116, 130))
    for i, k in enumerate([0, len(cut) // 4, len(cut) // 2, 3 * len(cut) // 4]):
        tile.paste(cut[k], (i * cw, 0), cut[k])
    tile.save(PREVIEW)

    sheet_uri = "data:image/webp;base64," + base64.b64encode(OUT_SHEET.read_bytes()).decode("ascii")
    thumb_uri = "data:image/webp;base64," + base64.b64encode(OUT_THUMB.read_bytes()).decode("ascii")

    item = {
        "key": KEY, "name": NAME, "anim": True, "price": PRICE,
        "uri": sheet_uri, "thumb": thumb_uri,
        "w": cw, "h": ch, "gw": sheet.width, "gh": sheet.height,
        "cols": COLS, "rows": rows, "frames": len(cut),
        "durs": ",".join(str(int(d)) for d in durs),
        "aspect": round(cw / ch, 5), "baseline": baseline, "foot": foot,
        "desc": "捂腹腹",
    }
    js = (
        "/* 自动生成，勿手改：由 dev/extract_laugh.py 从 大笑奶蛙.gif 生成。\n"
        " *\n"
        " * 这只角色是**动图**：uri 指向一张雪碧图（所有帧拼成网格），\n"
        " * 运行时按 durs 里的时长推进帧号，改纹理的 offset/repeat 切到对应格子。\n"
        " * gw/gh 是雪碧图总尺寸，w/h 是单帧尺寸，cols/rows 是网格行列数。\n"
        " * thumb 是单帧缩略图 —— 角色列表 / 商店货架里显示的是它，不是整张雪碧图。\n"
        " * price 非 0 表示要靠奶币买（在商店的\"角色\"区）。*/\n"
        "export const ANIM_CHARS = [" + json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "];\n"
    )
    OUT_JS.write_text(js, encoding="utf-8")
    print("-> %s (%.0f KB)  baseline=%.5f foot=%.4f aspect=%.5f"
          % (OUT_JS.name, OUT_JS.stat().st_size / 1024, baseline, foot, item["aspect"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
