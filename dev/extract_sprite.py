# -*- coding: utf-8 -*-
"""从原图抠出角色，生成带透明通道的立绘 PNG（纸片人素材）。

自给自足：不依赖任何中间产物，直接读参考图 ->
    颜色判据切出主体 -> 形态学清理 + 填孔 -> 羽化 alpha -> 边缘去底色污染 -> 缩放导出

判据说明：参考图背景是中性灰（含投影），R-B <= 9；角色整体偏黄，
所有部位（含青绿色眼睛、深褐色手脚）R-B 都 >= 37。所以用亮度的
黄度差 R-B 就能把角色和背景干净地分开。
"""
import base64
import json
import pathlib

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(r"C:/Users/张/Downloads/1785056436529.webp")
OUT_PNG = ROOT / "assets" / "hero.png"
OUT_JS = ROOT / "js" / "sprite_data.js"

TARGET_H = 560          # 输出贴图高度（像素）
PAD = 6                 # 裁切留边
RB_MIN = 30             # 黄度差阈值（角色 >= 37，背景 <= 9）

img = np.asarray(Image.open(SRC).convert("RGB")).astype(np.float32)
H, W, _ = img.shape

# ---------- 1. 颜色判据 + 形态学清理 + 填孔 ----------
rb = img[..., 0] - img[..., 2]
m = rb >= RB_MIN
m = ndimage.binary_opening(m, structure=np.ones((3, 3), bool))
m = ndimage.binary_closing(m, structure=np.ones((5, 5), bool), iterations=2)
m = ndimage.binary_fill_holes(m)

lab, n = ndimage.label(m, structure=np.ones((3, 3), int))
sizes = ndimage.sum(m, lab, range(1, n + 1))
keep = int(np.argmax(sizes)) + 1
if n > 1:
    print("连通域 %d 个 -> 保留最大 %d px，丢弃其余 %s px"
          % (n, int(sizes[keep - 1]), int(sizes.sum() - sizes[keep - 1])))
m = lab == keep

# ---------- 2. alpha：先软后锐，得到 ~1.5px 羽化边 ----------
soft = ndimage.gaussian_filter(m.astype(np.float32), 0.9)
alpha = np.clip((soft - 0.34) / 0.46, 0.0, 1.0)

# ---------- 3. 边缘去底色污染（把混进去的灰底反解出去） ----------
border = np.zeros_like(m)
border[:6, :] = border[-6:, :] = border[:, :6] = border[:, -6:] = True
bg = img[border & ~m].mean(axis=0)
print("背景均值 rgb =", np.round(bg, 1))

a3 = alpha[..., None]
clean = np.where(a3 > 0.02, (img - (1.0 - a3) * bg) / np.maximum(a3, 0.02), img)
clean = np.clip(clean, 0, 255)

# ---------- 4. 裁切到包围盒并缩放 ----------
ys, xs = np.nonzero(alpha > 0.5)
y0, y1 = max(0, ys.min() - PAD), min(H, ys.max() + 1 + PAD)
x0, x1 = max(0, xs.min() - PAD), min(W, xs.max() + 1 + PAD)
print("包围盒 x %d..%d  y %d..%d  (w=%d h=%d)" % (x0, x1, y0, y1, x1 - x0, y1 - y0))

rgba = np.dstack([clean[y0:y1, x0:x1], alpha[y0:y1, x0:x1] * 255.0]).astype(np.uint8)
im = Image.fromarray(rgba, "RGBA")
scale = TARGET_H / im.height
im = im.resize((max(1, round(im.width * scale)), TARGET_H), Image.LANCZOS)

# 缩放后清掉一圈极淡的残留
px = np.asarray(im).copy()
px[..., 3] = np.where(px[..., 3] < 12, 0, px[..., 3])
im = Image.fromarray(px, "RGBA")

OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
im.save(OUT_PNG, optimize=True)

# 脚底在贴图中的归一化位置：游戏里靠它把角色正好踩在方块上
baseline = ((ys.max() + PAD - y0) * scale) / im.height

# ---------- 5. 生成内嵌模块（保证 file:// 双击可用） ----------
b64 = base64.b64encode(OUT_PNG.read_bytes()).decode("ascii")
meta = {
    "w": im.width,
    "h": im.height,
    "aspect": round(im.width / im.height, 5),
    "baseline": round(float(baseline), 5),
}
OUT_JS.write_text(
    "/* 自动生成，勿手改：由 dev/extract_sprite.py 从参考图抠出的角色立绘 */\n"
    "export const SPRITE_META = " + json.dumps(meta, separators=(",", ":")) + ";\n"
    "export const SPRITE_URI = 'data:image/png;base64," + b64 + "';\n",
    encoding="utf-8",
)
print("输出 %s (%.0f KB) / %s (%.0f KB)"
      % (OUT_PNG.name, OUT_PNG.stat().st_size / 1024, OUT_JS.name, OUT_JS.stat().st_size / 1024))
print(json.dumps(meta, ensure_ascii=False))
