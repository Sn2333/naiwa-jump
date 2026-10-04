# -*- coding: utf-8 -*-
"""从参考图里抠出琪露诺的**四片冰晶翅膀**（左右各两片）→ assets/acc/wing_*.webp

和 extract_acc.py 的区别：那份假设"整张图只有一个主体"，取最大连通块。
这张图是**四个互不相连的冰晶**，取最大连通块只会剩下一片。所以这里：
  1) 按"蓝色程度 B-R"切出候选前景（白底 R=G=B=254，冰晶 B-R 常 >25）
  2) 连通域标号，**按面积**过滤掉发光碎点，保留四块大的
  3) 全部并进同一张画布，按整体外框裁切补方

用法：
    python dev/extract_wing.py
"""
import pathlib

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(r"C:/Users/张/Downloads/琪露诺翅膀.jpeg")
OUT_DIR = ROOT / "assets" / "acc"
OUT_SIZES = (256, 160, 96)

BLUE_T = 14        # B-R 超过它算"蓝色前景"。白底 0，冰晶主体 25+，光晕 8~20
MIN_AREA = 900     # 连通域面积下限：滤掉发光碎点（整图 1M px，四片冰晶各 1~4 万）
MARGIN = 0.04      # 抠完四周再留一点透明边（前端按 ACC_BOX 内容框摆放）


def main():
    img = Image.open(SRC).convert("RGB")
    a = np.asarray(img).astype(np.int16)
    H, W, _ = a.shape

    blue = a[:, :, 2] - a[:, :, 0]
    fg = blue > BLUE_T

    lab, n = ndimage.label(fg, structure=np.ones((3, 3)))
    sizes = ndimage.sum(fg, lab, range(1, n + 1))
    keep = [i + 1 for i, s in enumerate(sizes) if s >= MIN_AREA]
    keep.sort(key=lambda i: -sizes[i - 1])
    print(f"连通域 {n} 个，保留 {len(keep)} 个（面积 {[int(sizes[i-1]) for i in keep]}）")

    mask = np.isin(lab, keep)

    # 冰晶是半透明的：连光晕一起收进来会糊成一团，所以用"内部实心 + 外圈柔边"：
    # 对掩膜做一次轻微膨胀补掉主体内部的分数空隙，再高斯羽化外沿。
    solid = ndimage.binary_closing(mask, structure=np.ones((5, 5)))
    solid = ndimage.binary_fill_holes(solid)
    alpha = ndimage.gaussian_filter(solid.astype(np.float32), 1.1)
    alpha = np.clip(alpha * 1.35, 0, 1)          # 稍微拉一下，让主体更实

    rgba = np.dstack([a.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    im = Image.fromarray(rgba, "RGBA")

    box = im.getbbox()
    im = im.crop(box)
    print(f"抠出外框 {box} → {im.size}")

    # 补成正方形（与 extract_acc.py 的输出规格一致，前端 ACC_BOX 管线不用改）
    side = max(im.size)
    pad = int(side * MARGIN)
    side += pad * 2
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    print(f"补方 → {sq.size}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for sz in OUT_SIZES:
        out = sq if sz == side else sq.resize((sz, sz), Image.LANCZOS)
        p = OUT_DIR / f"wing_{sz}.webp"
        out.save(p, "WEBP", quality=92, method=6)
        print(f"  → {p.relative_to(ROOT)}  {p.stat().st_size // 1024} KB")

    # 浅底 / 深底对照预览，肉眼看边缘有没有留白
    prev = Image.new("RGB", (2 * 300 + 20, 300), (255, 255, 255))
    prev.paste((24, 28, 40), (310, 0, 620, 300))
    ico = sq.resize((280, 280), Image.LANCZOS)
    prev.paste(ico, (10, 10), ico)
    prev.paste(ico, (320, 10), ico)
    prev.save(OUT_DIR / "_preview_wing.png")
    print(f"  → {(OUT_DIR / '_preview_wing.png').relative_to(ROOT)}（左浅底 / 右深底）")


if __name__ == "__main__":
    main()
