from PIL import Image, ImageDraw
import json, re, os
src = open("js/sprite_data.js", encoding="utf-8").read()
meta = re.findall(r'\{"key":"([a-z]+)","name":"([^"]+)","w":(\d+),"h":(\d+),"aspect":([\d.]+),"baseline":([\d.]+)', src)
COLS, CELL, PAD = 6, 190, 14
rows = (len(meta) + COLS - 1) // COLS
W = COLS * (CELL + PAD) + PAD
H = rows * (CELL + 46 + PAD) + PAD
sheet = Image.new("RGB", (W, H), (70, 74, 86))
d = ImageDraw.Draw(sheet)
for i, (key, name, w, h, asp, base) in enumerate(meta):
    cx = PAD + (i % COLS) * (CELL + PAD)
    cy = PAD + (i // COLS) * (CELL + 46 + PAD)
    # 格子底色用对比色，便于发现没抠干净的残留
    d.rectangle([cx, cy, cx + CELL, cy + CELL], fill=(232, 234, 240))
    im = Image.open(f"assets/chars/{key}.png").convert("RGBA")
    sc = min(CELL / im.width, CELL / im.height)
    im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.LANCZOS)
    sheet.paste(im, (cx + (CELL - im.width) // 2, cy + (CELL - im.height) // 2), im)
    # 脚底基准线
    fy = cy + im.height  # 近似（贴图底=脚底）
    d.line([cx, cy + CELL, cx + CELL, cy + CELL], fill=(255, 90, 90), width=2)
    d.text((cx + 4, cy + CELL + 6), f"{name} {key}", fill=(255, 255, 255))
    d.text((cx + 4, cy + CELL + 22), f"{w}x{h}  a={asp}", fill=(180, 186, 200))
sheet.save("dev/shots/sheet_all.png")
print("saved", sheet.size, len(meta), "chars")
