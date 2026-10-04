"""程序化生成装饰素材（没有现成参考图的那几件）。

和 extract_acc.py 的区别：那份是"从参考图里抠出主体"，这份是"直接画"。
输出规格与 extract_acc.py 完全一致（正方形画布 + 主体居中 + 透明边距 +
assets/acc/<id>_256.webp / _160 / _96 三档），这样 build_acc_data.py 与
前端的 ACC_IMG / ACC_BOX 管线一行都不用改。

用法：
    python dev/gen_acc.py            # 生成全部
    python dev/gen_acc.py halo       # 只生成某一件
"""
import sys
import pathlib

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets" / "acc"
OUT_SIZES = (256, 160, 96)

S = 512          # 先在 512 上画，再降采样到 256（超采样，边缘更干净）
# 内容占画布的比例。和 extract_acc.py 的产出对齐：主体约占画布六成多。
# 这里留的是透明边距，前端按 ACC_BOX 内容框摆放，所以边距一致就够了。
MARGIN = 0.16    # 四周留白占画布比例


def _canvas():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def _finish(im, name):
    """降采样 + 导出三档 webp（与 extract_acc.py 的输出规格一致）。"""
    small = im.resize((256, 256), Image.LANCZOS)
    for sz in OUT_SIZES:
        out = small if sz == 256 else small.resize((sz, sz), Image.LANCZOS)
        p = OUT_DIR / f"{name}_{sz}.webp"
        out.save(p, "WEBP", quality=88, method=6)
        print(f"  -> {p.relative_to(ROOT)}  ({p.stat().st_size // 1024} KB)")


def glow_layer(shape_fn, color, blur, alpha=200, scale=1.0):
    """画一层发光：在单独的画布上画实心形状，再高斯模糊。

    分开画的理由是 PIL 没有原生发光 —— 先出实心图、模糊、再叠回去是最稳的做法。
    """
    g = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    shape_fn(d, color + (alpha,), scale)
    return g.filter(ImageFilter.GaussianBlur(blur))


# ---------------- 光环（头饰） ----------------
def gen_halo():
    """金色天使光环：一个椭圆环 + 外发光 + 顶面高光。

    做**椭圆**而不是正圆 —— 光环是水平套在头顶的，透视上就该是扁的，
    画成正圆在 3D 里看着像立起来的盘子。
    """
    im, d = _canvas()
    cx, cy = S / 2, S / 2
    pad = S * MARGIN
    rx = (S - pad * 2) / 2          # 长半轴
    ry = rx * 0.34                  # 短半轴（扁平）
    lw = S * 0.055                  # 环线宽

    def ring(dr, color, k=1.0):
        dr.ellipse([cx - rx * k, cy - ry * k, cx + rx * k, cy + ry * k],
                   outline=color, width=int(lw * k))

    # 三层：外层大发光 → 中层暖金 → 内层亮白高光
    im.alpha_composite(glow_layer(ring, (255, 205, 90), blur=26, alpha=170))
    im.alpha_composite(glow_layer(ring, (255, 225, 150), blur=11, alpha=210))
    ring(d, (214, 160, 46, 255))                     # 环主体（深金，压出厚度）
    ring(d, (255, 236, 170, 255), k=1.0)
    # 环本身再收细一圈画亮金，做出"金属反光"
    d.ellipse([cx - rx * 0.94, cy - ry * 0.94, cx + rx * 0.94, cy + ry * 0.94],
              outline=(255, 248, 214, 255), width=int(lw * 0.42))
    # 顶面高光：沿环上半部分点几个亮点
    import math
    for t in (0.12, 0.25, 0.38):
        ang = math.pi * (0.5 - t) if t < 0.5 else 0
        ang = math.pi * (0.75 + t * 0.5)
        x = cx + rx * math.cos(ang) * 0.97
        y = cy - ry * math.sin(ang) * 0.97
        r = lw * 0.34
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 240, 235))
    _finish(im, "halo")


# ---------------- 冰锥翅膀（背饰，琪露诺造型） ----------------
"""《东方Project》琪露诺的翅膀：**每侧三根冰锥菱形晶体**，从翼根向外上呈扇形张开。

造型要点（和"羽翼"完全不同的读法）：
  · 不是羽毛，是**透明的冰棱**——六边形/菱形长条，末端收成尖
  · 每侧固定 **三根**，长度"外侧最长、内侧最短"，沿一条弧线扇开
  · 冰是**半透明浅蓝**，内部有更亮的芯（折射感），边缘一圈亮白高光
  · 根部聚成一束（翼根），整体比羽翼更"硬"、更有棱角

画法：每根冰锥是个细长六边形（近根端留一点宽度、往末端收尖），
而不是三角形——三角形读成"箭头"，六边形才有"冰晶"的体积感。
"""


def _shard(cx, cy, ang, length, halfw, taper=0.20):
    """一根冰锥的多边形顶点。

    cx, cy  : 翼根位置
    ang     : 从翼根往外指的仰角（弧度，0=正右，正=朝上）
    length  : 冰锥长度
    halfw   : 根部半宽
    taper   : 越过中段后开始收尖的位置比例

    形状：根端平截（有厚度）→ 中段最宽 → 末端收成尖。
    用 6 个点描出"细长六边形"，尖头用两条斜边收拢而不是一个瘦三角形。
    """
    import math
    ca, sa = math.cos(ang), math.sin(ang)
    # 沿轴前进 t、垂直偏移 o（o 正 = 轴上方）
    def P(t, o):
        return (cx + ca * length * t - sa * o, cy - sa * length * t - ca * o)
    return [
        P(0.00, -halfw * 0.55),      # 根端下角（略窄，做出束根感）
        P(0.22, -halfw),             # 下侧最宽处
        P(taper + 0.30, -halfw * 0.62),
        P(1.00, 0.0),                # 末端尖
        P(taper + 0.30, halfw * 0.62),
        P(0.22, halfw),              # 上侧最宽处
        P(0.00, halfw * 0.55),       # 根端上角
    ]


# 每侧三根：仰角、长度、根部半宽。角度都落在 55°~105°（朝上、略往外），
# 中轴偏外那一根最长。★ 冰锥是"细长"的——halfw 一给大就变叶子/花瓣。
_SHARDS = [
    (0.95, 1.00, 0.030),   # 最外侧：最长，约 54°（往外斜上）
    (1.30, 0.86, 0.027),   # 中间：约 74°
    (1.62, 0.66, 0.024),   # 最内侧：最短，约 93°（略往内倾）
]


def _shard_pts(cx, cy, scale, flip, idx):
    import math
    ang, ln, hw = _SHARDS[idx]
    # 镜像：右翼用 ang，左翼用 pi - ang
    a = ang if not flip else math.pi - ang
    pad = S * 0.12
    span = (S - pad * 2) / 2
    L = span * ln * scale
    return _shard(cx, cy, a, L, S * hw * scale)


def gen_wing():
    """冰锥翅膀：左右各三根细长半透明冰棱，朝上呈扇形张开 + 冷光外发光 + 内部亮芯。

    背饰锚点在背后中上部（见 character.js 的 _layoutSlot），内容框铺满画布。
    ★ 翼根放在画布下方 2/3 处：冰锥从背中间往**上**长，尖端朝天，
      这样贴在角色背后是"一对竖起来的冰翅膀"。
    """
    im, d = _canvas()
    cx = S * 0.50
    cy = S * 0.70          # 翼根（偏下）：三根冰锥往上扇形张开

    def all_shards(dr, color, scale=1.0):
        for flip in (False, True):
            for i in range(len(_SHARDS)):
                dr.polygon(_shard_pts(cx, cy, scale, flip, i), fill=color)

    # 三层发光：冷蓝大光晕 → 青白中光 → 主体冰蓝
    im.alpha_composite(glow_layer(all_shards, (120, 200, 255), blur=26, alpha=125))
    im.alpha_composite(glow_layer(all_shards, (190, 238, 255), blur=11, alpha=140))
    # 主体：半透明冰蓝（能透出背后的角色）
    all_shards(d, (176, 228, 253, 185))
    # 内部亮芯：沿中轴缩一圈、偏亮偏白，做出"冰里有芯"的折射感
    all_shards(d, (238, 252, 255, 165), scale=0.45)
    # 轮廓：亮白描边（浅色砖上也看得见）
    lw = max(2, int(S * 0.007))
    for flip in (False, True):
        for i in range(len(_SHARDS)):
            pts = _shard_pts(cx, cy, 1.0, flip, i)
            d.line(pts + [pts[0]], fill=(242, 253, 255, 245), width=lw, joint="curve")
    # 碎钻高光：每根锥身上点两点闪光
    import math
    for flip in (False, True):
        for i, (ang, ln, hw) in enumerate(_SHARDS):
            a = ang if not flip else math.pi - ang
            pad = S * 0.12
            span = (S - pad * 2) / 2
            L = span * ln
            for t, r in ((0.36, 4), (0.58, 3)):
                x = cx + math.cos(a) * L * t - math.sin(a) * S * 0.006
                y = cy - math.sin(a) * L * t - math.cos(a) * S * 0.006
                d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 225))
    _finish(im, "wing")


GENS = {"halo": gen_halo, "wing": gen_wing}


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for name, fn in GENS.items():
        if only and only != name:
            continue
        print(f"{name}:")
        fn()
    print("OK")


if __name__ == "__main__":
    main()
