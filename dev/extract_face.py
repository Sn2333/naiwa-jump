"""从角色立绘里裁出"脸部"，给奶块当顶面图案用。

为什么不直接拿整张立绘：奶块是"砖面上印着奶蛙的脸"，要的是脸，不是全身。
整张贴上去会缩成一根竖条，脸上什么都看不清。

定位方式：**按 alpha 剪影现算，不写死像素坐标**。
   1) 先取整张立绘的不透明包围盒（抠图时四周留了透明边，不能按画布算）
   2) 头 = 包围盒顶部往下 `HEAD_K` 那一段
   3) 在这一段里重新量左右边界 —— 头未必在身体的水平中心（奶蛙就是偏的）
   4) 以这段的包围盒为中心补成正方形（多出来的填透明），再缩到 256

★ 为什么不用"宽度骤缩处 = 下巴"这类自动规则：奶蛙这种 Q 版体型**根本没有脖子**，
  剪影宽度从头顶一路单调变宽到肚子，任何"找最窄处"的启发式都会一路滑到腹部，
  把整个胸腹都框进"脸"里（第一版就是这样，脸只占上半张）。
  所以这里用固定比例 + 可覆盖；`--profile` 能把逐行宽度打出来，方便换角色时校准。

用法：
    python dev/extract_face.py [角色key] [输出名] [头部比例]
    python dev/extract_face.py                     # frog -> assets/milk/frog_face
    python dev/extract_face.py frog frog_face 0.20 --profile
"""
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent

PAD = 0.05         # 四周留一点余量，免得贴边被切
X_BAND = 0.80      # 量头部左右边界时只用上面这 80% 的行
OUT_SIZE = 256
DEFAULT_K = 0.20   # 头占整只角色高度的比例（奶蛙实测：下巴在 0.20 处）


def alpha_bbox(im, box=None):
    """在 box 范围内找不透明像素的包围盒（box 用像素坐标，None = 全图）"""
    a = im.getchannel('A')
    if box:
        a = a.crop(box)
    bb = a.point(lambda v: 255 if v >= 128 else 0).getbbox()
    if not bb:
        return None
    x0, y0, x1, y1 = bb
    if box:
        x0 += box[0]; x1 += box[0]
        y0 += box[1]; y1 += box[1]
    return (x0, y0, x1, y1)


def profile(im, body, step=6):
    """打印逐行宽度剖面，换角色校准 HEAD_K 时用"""
    a = im.getchannel('A')
    bx0, by0, bx1, by1 = body
    print('   逐行剪影宽度（每 %d px 一行，只到 55%% 高度）：' % step)
    for y in range(by0, by0 + round((by1 - by0) * 0.55), step):
        s = alpha_bbox(a, (bx0, y, bx1, y + 1))
        if not s:
            continue
        print(f'     y={y:4d}  x {s[0]:3d}..{s[2]:3d}  宽 {s[2] - s[0]:3d}'
              f'   ({(y - by0) / (by1 - by0):.2f} 身高)')
    print(f'   整只角色高度 {by1 - by0}px')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    show_profile = '--profile' in sys.argv
    key = args[0] if len(args) > 0 else 'frog'
    name = args[1] if len(args) > 1 else 'frog_face'
    head_k = float(args[2]) if len(args) > 2 else DEFAULT_K

    src = ROOT / 'assets' / 'chars' / f'{key}.png'
    assert src.exists(), f'找不到立绘：{src}'

    im = Image.open(src).convert('RGBA')
    W, H = im.size
    body = alpha_bbox(im)
    assert body, '这张立绘全透明？'
    bx0, by0, bx1, by1 = body
    bodyH = by1 - by0

    if show_profile:
        profile(im, body)

    # 1) 头部那一段
    band = (bx0, by0, bx1, min(by1, by0 + max(4, round(bodyH * head_k))))
    head = alpha_bbox(im, band)
    assert head, '头部那一段量不到东西'
    hx0, hy0, hx1, hy1 = head

    # 左右边界只在上半段量：下巴往下肩膀会斜着探出去，用它定中心会把脸推歪
    upper = (bx0, hy0, bx1, hy0 + max(2, round((hy1 - hy0) * X_BAND)))
    ub = alpha_bbox(im, upper)
    if ub:
        hx0, hx1 = ub[0], ub[2]           # 以"纯头部"的左右界为准

    # 2) 补成正方形（中心 = 头部包围盒中心，边长 = 更宽的那条 + 余量）
    hw, hh = hx1 - hx0, hy1 - hy0
    side = round(max(hw, hh) * (1 + PAD * 2))
    cx, cy = (hx0 + hx1) / 2, (hy0 + hy1) / 2
    left = round(cx - side / 2)
    top = round(cy - side / 2)

    # 3) 出界的部分用透明补 —— 直接裁会把头顶切平
    pad_im = Image.new('RGBA', (im.width + 2 * side, im.height + 2 * side), (0, 0, 0, 0))
    pad_im.paste(im, (side, side))
    box = (left + side, top + side, left + side + side, top + side + side)
    face = pad_im.crop(box).resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)

    outdir = ROOT / 'assets' / 'milk'
    outdir.mkdir(parents=True, exist_ok=True)
    out = outdir / f'{name}_{OUT_SIZE}.webp'
    face.save(out, 'WEBP', quality=92, method=6)
    face.save(outdir / f'{name}_{128}.webp', 'WEBP', quality=90, method=6)

    # 预览：左浅底 / 右深底，一次就能看出毛刺、留边、有没有把身体框进来
    pv = Image.new('RGB', (OUT_SIZE * 2 + 12, OUT_SIZE + 8), (255, 255, 255))
    for bg, x in [((246, 243, 236), 0), ((38, 40, 52), OUT_SIZE + 12)]:
        tile = Image.new('RGBA', (OUT_SIZE, OUT_SIZE), bg + (255,))
        tile.alpha_composite(face)
        pv.paste(tile.convert('RGB'), (x, 4))
    pv.save(outdir / f'_preview_{name}.png')

    print(f'OK -> {out}')
    print(f'   立绘 {W}x{H}，剪影 {body}，头占 {head_k:.2f} 身高')
    print(f'   头部框 {head}（{hw}x{hh}）→ 正方形边长 {side}px，裁切框 {box}')


if __name__ == '__main__':
    main()
