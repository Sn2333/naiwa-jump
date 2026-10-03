"""把 assets/ 下的奶币、装饰与奶块素材内联成 js/acc_data.js。

为什么内联而不是运行时 fetch：单文件版（奶蛙一跳.html）是双击直接打开的，
file:// 下 fetch 本地文件会被浏览器拦掉；sprite_data.js 早就是这么干的。
另外在线版也少几个请求，首屏更稳。

用法：
    python dev/build_acc_data.py
"""
import base64
import io
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'js' / 'acc_data.js'


def uri(p):
    return 'data:image/webp;base64,' + base64.b64encode(p.read_bytes()).decode('ascii')


def content_box(p):
    """素材在正方形画布里的实际内容框（归一化，y 从顶部数）。

    抠图阶段会把主体补成正方形，四周留了透明边距 —— 一顶帽子实际只占画布
    宽度的六成多。摆放时如果按整张画布算，帽子就会偏小、还会往上飘。
    所以把内容框一起交给前端：按"内容"而不是"画布"来定尺寸和锚点。"""
    im = Image.open(io.BytesIO(p.read_bytes())).convert('RGBA')
    W, H = im.size
    bb = im.getbbox()
    if not bb:
        return {'x': 0.0, 'y': 0.0, 'w': 1.0, 'h': 1.0}
    x0, y0, x1, y1 = bb
    return {
        'x': round(x0 / W, 4), 'y': round(y0 / H, 4),
        'w': round((x1 - x0) / W, 4), 'h': round((y1 - y0) / H, 4),
    }


def main():
    coin = ROOT / 'assets' / 'coin' / 'naiwa_coin_256.webp'
    assert coin.exists(), f'缺奶币素材：{coin}（先跑 dev/extract_naiwa_coin.py）'

    # 奶块顶面的蛙脸（可缺省：没跑 extract_face.py 就不内联，游戏那边会退回纯色顶面）
    face = ROOT / 'assets' / 'milk' / 'frog_face_256.webp'

    accs = sorted((ROOT / 'assets' / 'acc').glob('*.webp'))
    # 同名只取最大的那一档：小尺寸是给 UI 缩略图用的，3D 里要清晰度
    best = {}
    for p in accs:
        name, size = p.stem.rsplit('_', 1)
        if not size.isdigit():
            continue
        if name not in best or int(size) > int(best[name].stem.rsplit('_', 1)[1]):
            best[name] = p
    assert best, 'assets/acc 下没有素材（先跑 dev/extract_acc.py）'

    lines = [
        '/* 自动生成，勿手改：由 dev/build_acc_data.py 生成。',
        ' * 奶币、装饰、奶块顶面图案都内联成 data URI —— 单文件版走 file:// 时 fetch 会被拦，',
        ' * 内联是唯一在"双击即玩"和"在线部署"两种形态下都稳的做法。',
        ' * 改素材的流程：dev/extract_naiwa_coin.py / extract_acc.py / extract_face.py → 再跑本脚本。 */',
        f'export const COIN_URI = {uri(coin)!r};',
        '',
    ]
    if face.exists():
        lines += [
            '/* 奶块顶面：经典奶蛙的脸（dev/extract_face.py 从立绘上裁下来的） */',
            f'export const MILK_FACE_URI = {uri(face)!r};',
            '',
        ]
    else:
        lines += ['/* 奶块顶面：素材缺失（先跑 dev/extract_face.py），前端会退回纯色顶面 */',
                  'export const MILK_FACE_URI = null;', '']

    lines += [
        '/* 装饰贴图：键名即装饰 id（与 js/acc.js 里的装饰表对应） */',
        'export const ACC_IMG = {',
    ]
    for name, p in sorted(best.items()):
        lines.append(f'  {name!r}: {uri(p)!r},')
    lines.append('};')
    lines.append('')
    lines.append('/* 各素材内容在正方形画布里的实际范围（归一化，y 从顶部数）。')
    lines.append(' * 抠图会把主体补成正方形、四周留透明边距，所以摆放必须按内容框而不是')
    lines.append(' * 整张画布来算 —— 否则帽子会凭空缩小一圈、还往上飘。 */')
    lines.append('export const ACC_BOX = {')
    for name, p in sorted(best.items()):
        b = content_box(p)
        lines.append(f'  {name!r}: {{ x: {b["x"]}, y: {b["y"]}, w: {b["w"]}, h: {b["h"]} }},')
    lines.append('};')
    OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    kb = OUT.stat().st_size / 1024
    print(f'OK -> {OUT}  ({kb:.0f} KB)')
    print(f'   奶币 1 张，奶块脸 {"有" if face.exists() else "无"}，'
          f'装饰 {len(best)} 张：{", ".join(sorted(best))}')
    for name, p in sorted(best.items()):
        print(f'   {name} 内容框 {content_box(p)}')


if __name__ == '__main__':
    main()
