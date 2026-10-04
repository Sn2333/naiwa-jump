"""把「蜘蛛奶.jpg」抠成透明素材 —— 蜘蛛抓人动画用的立绘。

图是浅灰底 + 单个主体（穿蜘蛛侠战衣的奶蛙，抱臂），和 extract_acc.py
处理的是同一类问题：边缘洪水填充判背景 + 最大连通块拎主体，
零散噪点（JPEG 鬼影、水印碎屑）一起丢掉。

和装饰素材的两点不同：
  1) 只出一个尺寸（384px，DOM 覆盖层里大约占屏幕高 4 成，够清晰）；
  2) **不补正方形** —— 屏幕动画按 img 自然宽高比摆，紧裁剪的框就是内容框，
     倒吊/抓取的锚点直接按元素盒子算，不用再查内容框占比。

顺手生成 js/spider_data.js（内联 data URI，file:// 单文件版要用），
并把 master PNG 存到 assets/spider/ 里方便以后重切。

用法：
    python dev/extract_spider.py [输入图]
        默认输入 C:/Users/张/Downloads/蜘蛛奶.jpg
"""
import base64
import sys
from pathlib import Path

from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collections import deque

from extract_acc import largest_component   # 复用最大连通块


def gray_outside_set(ip, W, H):
    """从图像四边洪水填充，找出"与边缘连通的低饱和灰/白"作为背景。

    这张图的地面是**渐变灰**（170→240），和纯白背景（254）的色距一路变化，
    单一色距阈值分不开。改用两个判据取并集：
      · 色距 <= 30（贴近背景采样色）；或
      · 低饱和（max-min < 22，即任意亮度的灰/白）。
    主体全是高饱和（红蓝战衣、黄头），护得住；白蛛印被红色包住、
    不与边缘连通，洪水填充天然把它算作主体（同 extract_acc 的思路）。"""
    def is_bg(p):
        if max(p) - min(p) < 22:          # 低饱和：任意灰/白
            return True
        bg = (254, 254, 254)
        return ((p[0] - bg[0]) ** 2 + (p[1] - bg[1]) ** 2 + (p[2] - bg[2]) ** 2) ** 0.5 <= 30

    is_bgish = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            is_bgish[y * W + x] = 1 if is_bg(ip[x, y]) else 0
    out = bytearray(W * H)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            i = y * W + x
            if is_bgish[i] and not out[i]:
                out[i] = 1
                q.append((x, y))
    for y in range(H):
        for x in (0, W - 1):
            i = y * W + x
            if is_bgish[i] and not out[i]:
                out[i] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nx, ny = x + dx, y + dy
                if 0 <= nx < W and 0 <= ny < H:
                    i = ny * W + nx
                    if is_bgish[i] and not out[i]:
                        out[i] = 1
                        q.append((nx, ny))
    return out


DEFAULT_SRC = "C:/Users/张/Downloads/蜘蛛奶.jpg"
OUT_SIZE = 384
ROOT = Path(__file__).resolve().parent.parent


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    src = Path(args[0]) if args else Path(DEFAULT_SRC)
    if not src.exists():
        print(f"✗ 找不到输入图：{src}")
        return 1
    out_dir = ROOT / "assets" / "spider"
    out_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(src).convert("RGB")
    W, H = img.size
    corners = [img.getpixel(p) for p in ((2, 2), (W - 3, 2), (2, H - 3), (W - 3, H - 3))]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    print(f"输入 {src.name}  {W}×{H}  背景采样 RGB{bg}")

    ip = img.load()
    outside = gray_outside_set(ip, W, H)
    hard = bytearray(1 if not o else 0 for o in outside)
    comp = largest_component(hard, W, H)
    if not comp:
        print("✗ 没找到任何主体")
        return 1
    xs = [p[0] for p in comp]
    ys = [p[1] for p in comp]
    box = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
    inside = set(comp)
    print(f"最大连通块 {len(comp)} px，外框 {box}（占全图 {len(comp) / (W * H) * 100:.1f}%）")

    rgba = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rp = rgba.load()
    for y in range(H):
        for x in range(W):
            if (x, y) in inside:
                rp[x, y] = (*ip[x, y], 255)
    rgba = rgba.crop(box)
    # 轮廓羽化 0.8px，只软边不挖洞（同 extract_acc 的做法）
    rgba.putalpha(rgba.getchannel("A").filter(ImageFilter.GaussianBlur(0.8)))
    bbox = rgba.getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    print(f"抠出（紧裁剪）：{rgba.size}")

    # master 留档 + webp 产物
    rgba.save(out_dir / "spider_master.png")
    out = rgba.resize((OUT_SIZE, round(OUT_SIZE * rgba.height / rgba.width)), Image.LANCZOS)
    wp = out_dir / "spider.webp"
    out.save(wp, quality=92, method=6)
    print(f"  → {wp}  {wp.stat().st_size // 1024} KB  {out.size}")

    # 预览（浅底 / 深底各一张）
    ph = max(260, out.height + 20)
    prev = Image.new("RGB", (2 * (out.width + 20) + 20, ph), (255, 255, 255))
    prev.paste((24, 28, 40), (out.width + 30, 0, 2 * out.width + 50, ph))
    prev.paste(out, (10, 10), out)
    prev.paste(out, (out.width + 40, 10), out)
    prev.save(out_dir / "_preview_spider.png")
    print(f"  → {out_dir / '_preview_spider.png'}（左浅底 / 右深底）")

    # 内联成 js/spider_data.js —— 只有 game.js 用，走 media_data.js 同款注入
    uri = "data:image/webp;base64," + base64.b64encode(wp.read_bytes()).decode("ascii")
    js = (
        "/* 蜘蛛奶立绘（dev/extract_spider.py 从 蜘蛛奶.jpg 抠出）——\n"
        " * 蜘蛛抓人动画（MJ 砖）的 DOM 覆盖层用。内联 data URI 是为了\n"
        " * 单文件版 file:// 双击直接能开（sprite_data.js 同理）。\n"
        " * 紧裁剪无补边：img 盒子就是内容框，宽高比用 naturalWidth/Height。 */\n"
        f"export const SPIDER_IMG = \"{uri}\";\n"
    )
    (ROOT / "js" / "spider_data.js").write_text(js, encoding="utf-8")
    print(f"  → js/spider_data.js  {len(js) // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
