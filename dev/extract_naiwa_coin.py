"""从奶币三视图里抠出【正视图】，做成透明 PNG 图标。

难点不在抠图，在"定位"：三视图是横排的，但左中右的间距并不等分 ——
直接按 1/3 切会把左边那枚硬币切掉一截（硬币直径约 0.38 倍图宽）。
所以这里用投影法自动找：
  1) 统计每列的"前景像素数"，三枚硬币之间有明显的空白谷 → 按谷切成三段；
  2) 取最左那段（FRONT），再统计每行前景数：硬币中段几乎满行，下方
     "FRONT" 字样只有两三成宽，中间还隔着一条空白 → 从最密的那行
     向上下连续扩张，遇到空行就停，得到硬币的纵向范围。
   
抠图本身：按与背景色（取四角采样）的色距生成 alpha，再羽化 1px。
光晕（硬币外那圈柔和黄光）保留但压暗，避免在浅色底上糊成一坨。

用法：
    python dev/extract_naiwa_coin.py <三视图.png> [输出目录]
"""
import sys
from pathlib import Path
from PIL import Image, ImageFilter

LO, HI = 16.0, 58.0       # 色距 → alpha 的软阈值区间
GLOW_MUL = 0.62           # 高亮光晕的 alpha 折扣（压掉硬边光环）
FG_MIN = 0.03             # 某行/列前景占比超过它才算"有内容"


def seg_by_valleys(mask, size, axis_primary='x'):
    """按投影谷把 mask 切成若干段，返回 [(start, end), ...]"""
    w, h = mask.size
    if axis_primary == 'x':
        n, m = w, h
        cnt = [sum(1 for y in range(h) if mask.getpixel((i, y))) for i in range(w)]
    else:
        n, m = h, w
        cnt = [sum(1 for x in range(w) if mask.getpixel((x, i))) for i in range(h)]
    thr = max(1, int(m * FG_MIN))
    segs, start = [], None
    for i in range(n):
        if cnt[i] > thr and start is None:
            start = i
        elif cnt[i] <= thr and start is not None:
            if i - start > 4:
                segs.append((start, i - 1))
            start = None
    if start is not None and n - 1 - start > 4:
        segs.append((start, n - 1))
    return segs


def main():
    if len(sys.argv) < 2:
        print('用法: python dev/extract_naiwa_coin.py <三视图.png> [输出目录]')
        return 1
    src = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('assets/coin')
    out_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(src).convert('RGB')
    W, H = img.size

    # 背景色取四角平均
    corners = [img.getpixel(p) for p in ((2, 2), (W - 3, 2), (2, H - 3), (W - 3, H - 3))]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    print(f'原图 {W}×{H}，背景采样 RGB{bg}')

    # 先粗判前景掩膜（色距 > LO 即算），用于投影定位
    rough = Image.new('L', (W, H), 0)
    rp = rough.load()
    ip = img.load()
    for y in range(H):
        for x in range(W):
            r, g, b = ip[x, y]
            d = ((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2) ** 0.5
            rp[x, y] = 255 if d > LO else 0

    cols = seg_by_valleys(rough, W, 'x')
    print(f'横向段落：{cols}')
    if not cols:
        print('✗ 没找到任何内容'); return 1
    # 最左那段 = FRONT（也可能被"光晕"与硬币粘在一起，不影响）
    x0, x1 = cols[0]
    band = rough.crop((x0, 0, x1 + 1, H))
    rows = seg_by_valleys(band, H, 'y')
    print(f'FRONT 段内纵向段落：{rows}')
    if not rows:
        print('✗ FRONT 段里没有内容'); return 1
    # 最高的那段就是硬币；下方 "FRONT" 字样是另一段，天然被排除
    y0, y1 = max(rows, key=lambda r: r[1] - r[0])

    box = (x0, y0, x1 + 1, y1 + 1)
    print(f'硬币外框：{box}  尺寸 {x1 + 1 - x0}×{y1 + 1 - y0}')
    coin = img.crop(box).convert('RGBA')

    # alpha：与背景的色距过软阈值
    cw, ch = coin.size
    cp = coin.load()
    alpha = Image.new('L', (cw, ch), 0)
    ap = alpha.load()
    for y in range(ch):
        for x in range(cw):
            r, g, b, _ = cp[x, y]
            d = ((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2) ** 0.5
            a = (d - LO) / (HI - LO)
            a = 0.0 if a < 0 else (1.0 if a > 1 else a)
            # 接近纯白的像素是外层光晕：压暗，避免浅色底上糊出硬光环
            if min(r, g, b) > 226:
                a *= GLOW_MUL
            ap[x, y] = int(round(255 * a))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.8))
    coin.putalpha(alpha)

    bbox = coin.getbbox()
    if bbox:
        coin = coin.crop(bbox)
    # 补成正方形再缩放：硬币不是正圆（650×696），直接拉成正方形会横向胖 7%
    s = max(coin.size)
    sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    sq.paste(coin, ((s - coin.width) // 2, (s - coin.height) // 2))
    coin = sq
    print(f'去背景并补成正方形：{coin.size}')

    # WebP：其它素材也是 webp，单文件内联时 base64 体积能省一半以上
    for size in (256, 128, 96):
        p = out_dir / f'naiwa_coin_{size}.webp'
        coin.resize((size, size), Image.LANCZOS).save(p, quality=92, method=6)
        print(f'  → {p}  {p.stat().st_size // 1024} KB')
    # 留一份 PNG 给"需要无损/外部引用"的场合
    coin.resize((512, 512), Image.LANCZOS).save(out_dir / 'naiwa_coin_512.png', optimize=True)
    print(f'  → {out_dir / "naiwa_coin_512.png"}  '
          f'{(out_dir / "naiwa_coin_512.png").stat().st_size // 1024} KB')

    # 预览：一半浅色底、一半深色底，一次看清浅底会不会糊、深底会不会掉
    prev = Image.new('RGB', (560, 280), (255, 255, 255))
    for yy in range(280):
        for xx in range(0, 280, 20):
            for k in range(20):
                if (yy // 20 + xx // 20) % 2 == 0:
                    prev.putpixel((xx + k, yy), (226, 230, 238))
    prev.paste((24, 28, 40), (280, 0, 560, 280))
    icon = coin.resize((256, 256), Image.LANCZOS)
    prev.paste(icon, (12, 12), icon)
    prev.paste(icon, (292, 12), icon)
    prev.save(out_dir / '_preview.png')
    print(f'  → {out_dir / "_preview.png"}（左浅底 / 右深底）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
