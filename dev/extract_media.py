# -*- coding: utf-8 -*-
"""把"外部素材"内联成 js/media_data.js：奶龙大笑音效 + 两张收款码。

这两个都属于"玩家给的原图"，跟角色/装饰不一样 —— 不需要抠图，只需要
压到合适的尺寸再转成 data URI，好让单文件版（双击即玩）也能带上它们。

  · 奶龙大笑.mp3   —— 直接内联。没有 ffmpeg 可以转码，138KB 的 mp3 就 138KB；
                       好在 WebAudio 的 decodeAudioData 原生吃得下 mp3。
  · 两张收款码      —— 原图 1118×1524 / 1080×1620，PNG/JPG 合计 254KB。
                       转 WebP、宽度收到 640（二维码本身仍有 ~300px，
                       扫得动），两张合计降到 62KB。

用法：
    python dev/extract_media.py
"""
import base64
import json
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
DL = pathlib.Path(r"C:/Users/张/Downloads")
OUT_JS = ROOT / "js" / "media_data.js"
PREVIEW = ROOT / "assets" / "_pay_preview.png"

SFX = [
    # 2026-10-03 修复：Downloads 里那份"奶龙大笑.mp3"其实是**套着 mp3 扩展名的 WMA**
    # （文件头 30 26 B2 75 = ASF 魔数），Chrome 的 decodeAudioData 不支持 WMA，
    # 一直解码失败、奶块落地永远无声。已用 ffmpeg 转成真 mp3 收进项目资源目录。
    # 2026-10-04：用户要求**只要前四秒**（原 9.98s 太长，落到奶块上一直在笑）。
    # 已用 ffmpeg -t 4 裁好存成 奶龙大笑_4s.mp3（4.05s / 48KB，原来 117KB）。
    ("LAUGH_URI", ROOT / "dev" / "assets" / "奶龙大笑_4s.mp3"),
    # 2026-10-03：跳到冰冰冰时放的"叮叮叮"（用户音源，在 GameViewer 下载目录）
    ("DING_URI", pathlib.Path(r"C:/Program Files/Netease/GameViewer/Download/叮叮叮.mp3")),
]
# 2026-10-03：微信/支付宝双码换成**一张**收款码（用户指定 sn收款.png）。
# 路径不在 Downloads，直接写绝对路径。
PAY = [("pay", pathlib.Path(r"C:/Program Files/Netease/GameViewer/Download/sn收款.png"))]
PAY_W = 640        # 收款码输出宽度。二维码本体仍有 ~400px，
                   # 微信/支付宝都能顺畅扫出来
PAY_Q = 88


def data_uri(path, mime):
    return "data:%s;base64,%s" % (mime, base64.b64encode(path.read_bytes()).decode("ascii"))


def main():
    lines = [
        "/* 自动生成，勿手改：由 dev/extract_media.py 把外部素材压成 data URI。\n"
        " * LAUGH_URI —— 跳到奶块时放的那声大笑（mp3，WebAudio 直接解码播放）\n"
        " * PAY_URI   —— 支持作者面板里那张收款码（2026-10-03 起只此一张）\n"
        " */",
    ]
    total = 0

    for name, p in SFX:
        if not p.exists():
            print("缺失: %s" % p)
            lines.append("export const %s = null;" % name)
            continue
        uri = data_uri(p, "audio/mpeg")
        total += len(uri)
        lines.append("export const %s = %s;" % (name, json.dumps(uri)))
        print("%-10s %-22s -> 内联 %5.0f KB" % (name, p.name, len(uri) / 1024))

    tiles = []
    for key, p in PAY:
        if not p.exists():
            print("缺失: %s" % p)
            continue
        im = Image.open(p).convert("RGB")
        im = im.resize((PAY_W, round(im.height * PAY_W / im.width)), Image.LANCZOS)
        buf = ROOT / "assets" / ("pay_%s.webp" % key)
        buf.parent.mkdir(parents=True, exist_ok=True)
        im.save(buf, format="WEBP", quality=PAY_Q, method=6)
        tiles.append(im)
        uri = "data:image/webp;base64," + base64.b64encode(buf.read_bytes()).decode("ascii")
        total += len(uri)
        lines.append("export const PAY_URI = %s;" % json.dumps(uri))
        print("%-10s %-22s -> %s 内联 %5.0f KB" % ("pay_" + key, p.name, im.size, len(uri) / 1024))

    OUT_JS.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("-> %s (%.0f KB)" % (OUT_JS.name, OUT_JS.stat().st_size / 1024))

    if tiles:
        w = sum(t.width for t in tiles) + 16
        h = max(t.height for t in tiles) + 16
        sheet = Image.new("RGB", (w, h), (110, 116, 130))
        x = 8
        for t in tiles:
            sheet.paste(t, (x, 8))
            x += t.width + 8
        sheet.save(PREVIEW)
    return 0


if __name__ == "__main__":
    sys.exit(main())
