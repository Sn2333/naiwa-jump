"""把"白底/浅底 + 单个主体"的图抠成透明 PNG/WebP —— 用于装饰素材。

和抠奶币那份的区别：这张图是 AI 生成的产品图，右下角带一个浅灰水印。
浅灰水印的色距和帽子上的奶油白条纹是同一量级，靠阈值根本分不开 ——
所以这里用**最大连通块**（按 alpha 掩膜做 CCL）把帽子单独拎出来，
水印连同其它零碎一起丢掉。

用法：
    python dev/extract_acc.py <输入图> <输出名> [--bg auto|white]
        <输出名> 例如 hat_birthday → assets/acc/hat_birthday_*.webp

参数（一般不用改）：
    LO/HI 色距软阈值；主体内部还有近白像素时把 HI 调大
"""
import sys
from collections import deque
from pathlib import Path
from PIL import Image, ImageFilter

LO, HI = 10.0, 30.0
BG_CUT = 22.0          # 与背景色距小于它 → 候选背景（再由洪水填充确认）
OUT_SIZES = (256, 160, 96)


def color_dist(p, bg):
    return ((p[0] - bg[0]) ** 2 + (p[1] - bg[1]) ** 2 + (p[2] - bg[2]) ** 2) ** 0.5


def outside_set(ip, W, H, bg):
    """从图像四边洪水填充，找出"与画面边缘连通的背景"。

    比"按色距直接判背景"稳得多：帽子内部的白色高光和奶油条纹色距和背景
    几乎一样，用阈值判会把它们挖成透明洞（深色底上就是一片黑斑）；
    但它们被主体包着、和画面边缘不连通，洪水填充天然把它们算作主体。
    同理，右下角那个浅灰水印是连通到边缘的，会被正确判成背景丢掉。
    """
    is_bg = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            is_bg[y * W + x] = 1 if color_dist(ip[x, y], bg) <= BG_CUT else 0
    out = bytearray(W * H)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            i = y * W + x
            if is_bg[i] and not out[i]:
                out[i] = 1
                q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            i = y * W + x
            if is_bg[i] and not out[i]:
                out[i] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H:
                    i = ny * W + nx
                    if is_bg[i] and not out[i]:
                        out[i] = 1
                        q.append((nx, ny))
    return out


def largest_component(mask, w, h):
    """在二值掩膜上找最大连通块，返回它的像素集合（8 邻域）。"""
    seen = bytearray(w * h)
    best = None
    for sy in range(h):
        for sx in range(w):
            i0 = sy * w + sx
            if not mask[i0] or seen[i0]:
                continue
            comp = []
            q = deque([(sx, sy)])
            seen[i0] = 1
            while q:
                x, y = q.popleft()
                comp.append((x, y))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h:
                            ni = ny * w + nx
                            if mask[ni] and not seen[ni]:
                                seen[ni] = 1
                                q.append((nx, ny))
            if best is None or len(comp) > len(best):
                best = comp
    return best or []


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        print('用法: python dev/extract_acc.py <输入图> <输出名>')
        return 1
    src = Path(args[0])
    name = args[1]
    out_dir = Path('assets/acc')
    out_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(src).convert('RGB')
    W, H = img.size
    corners = [img.getpixel(p) for p in ((2, 2), (W - 3, 2), (2, H - 3), (W - 3, H - 3))]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    print(f'输入 {src.name}  {W}×{H}  背景采样 RGB{bg}')

    ip = img.load()
    outside = outside_set(ip, W, H, bg)
    # 主体掩膜 = 非外部。再取最大连通块，把零散噪点（JPEG 鬼影、边缘碎屑）丢掉。
    hard = bytearray(1 if not o else 0 for o in outside)
    comp = largest_component(hard, W, H)
    if not comp:
        print('✗ 没找到任何主体'); return 1
    xs = [p[0] for p in comp]
    ys = [p[1] for p in comp]
    box = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
    inside = set(comp)
    print(f'最大连通块 {len(comp)} px，外框 {box}'
          f'（占全图 {len(comp) / (W * H) * 100:.1f}%）')

    rgba = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    rp = rgba.load()
    for y in range(H):
        for x in range(W):
            if (x, y) in inside:
                rp[x, y] = (*ip[x, y], 255)
    rgba = rgba.crop(box)
    # 羽化 0.8px：主体内部一律不透明（高光不会再被挖成洞），
    # 只把轮廓那一圈做软，避免锯齿
    rgba.putalpha(rgba.getchannel('A').filter(ImageFilter.GaussianBlur(0.8)))

    bbox = rgba.getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    s = max(rgba.size)
    sq = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    sq.paste(rgba, ((s - rgba.width) // 2, (s - rgba.height) // 2))
    rgba = sq
    print(f'抠出并补成正方形：{rgba.size}')

    for size in OUT_SIZES:
        p = out_dir / f'{name}_{size}.webp'
        rgba.resize((size, size), Image.LANCZOS).save(p, quality=92, method=6)
        print(f'  → {p}  {p.stat().st_size // 1024} KB')

    prev = Image.new('RGB', (2 * 260 + 20, 260), (255, 255, 255))
    prev.paste((24, 28, 40), (270, 0, 540, 260))
    icon = rgba.resize((240, 240), Image.LANCZOS)
    prev.paste(icon, (10, 10), icon)
    prev.paste(icon, (280, 10), icon)
    prev.save(out_dir / f'_preview_{name}.png')
    print(f'  → {out_dir / f"_preview_{name}.png"}（左浅底 / 右深底）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
