# -*- coding: utf-8 -*-
"""批量抠出全部奶系角色 -> assets/chars/<key>.webp，并生成 js/sprite_data.js。

和第一版只服务单张图的 extract_sprite.py 不同，这批图背景不统一：
  · 多数是白底棚拍（背景 R-B ≈ 0，角色偏黄 R-B 大）
  · 奶双鱼 / 奶双子 是深蓝星空，还带光晕与星点
  · 几乎所有图右下角都有小红书水印，奶蛋左下角还有"内容含 AI 生成"
所以判据从"黄度差 R-B"换成"与背景色的最大通道差 + Otsu 自适应阈值"，
再用连通域面积过滤掉水印/星点这类零碎前景。

用法：
    python dev/extract_chars.py            # 全量
    python dev/extract_chars.py --sheet    # 顺便拼一张联系表方便肉眼检查
"""
import argparse
import base64
import json
import pathlib
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(r"C:/Users/张/Downloads")
OUT_DIR = ROOT / "assets" / "chars"
OUT_JS = ROOT / "js" / "sprite_data.js"
META_JSON = ROOT / "dev" / "chars_meta.json"    # 抠图元数据缓存，支撑 --only 增量重抠
SHEET = ROOT / "assets" / "_contact.png"

TARGET_H = 420          # 输出贴图高度。游戏里角色约 200px 高，420 已有 2x 余量
PAD = 8                 # 裁切留边
MIN_KEEP = 0.035        # 连通域面积占比下限（过滤水印、星点）
WEBP_Q = 88

# ---- 脚底接触面（碰撞体积）测量 ----
# 落脚判定要求"碰撞体积由实际建模定义"：每个角色真正踩在地上的那一圈有多宽，
# 从剪影里量出来，写进 sprite_data 的 foot 字段（半宽占贴图宽的比例，0~0.5）。
# 贴图在 mesh 里以几何中心对齐 charRoot，所以从图像水平中心量 |dx| 即可。
FOOT_BAND = 0.13        # 接触带高度（占贴图高的比例）。取值是折中：
                        #  · 奶羊是趴姿，肚皮（真支撑）底沿在 6% 上下 —— 带太窄只扫到
                        #    垂得最低的前蹄，把"整条肚皮着地"量成"一只蹄着地"；
                        #  · 奶虎抬起的脚底沿在 13%~20% 之间 —— 带再宽就把悬空的脚
                        #    也当支撑（奶天秤的秤盘本来就垂到近地，收进来反而是对的）。
FOOT_ALPHA = 96         # 判"实心"的 alpha 门槛（避开羽化边缘）
FOOT_FALLBACK = 0.15    # 接触带里找不到实心像素时的兜底（悬空造型的角色）


def measure_foot(im, baseline):
    """脚底接触半宽 / 贴图宽。

    只扫 baseline 上方 FOOT_BAND 这一条带 —— 再高就会扫到裙摆、钳子这类
    悬空部件（奶天秤的秤盘在带高 0.12 时被扫进来，半宽虚大一倍）。
    返回的是"比例"而不是世界单位：世界半径 = 贴图宽的世界尺寸 × 本值，
    由 character.js 在 applyDef 里算，这样换角色缩放后依然成立。"""
    w, h = im.size
    a = np.asarray(im)[..., 3]
    base_row = min(int(round(baseline * h)), h - 1)
    top = max(0, int(round(base_row - FOOT_BAND * h)))
    xs = np.nonzero((a[top:base_row + 1] > FOOT_ALPHA).any(axis=0))[0]
    if xs.size == 0:
        return FOOT_FALLBACK
    return float(max(abs(xs - w / 2.0).max() / w, 0.0))

# ---- 小红书水印的"就地抹平" ----
# 后加的这几张（奶绷 / 大奶 / 格斗准备奶蛙 / 奶豪）水印是**压在角色身上**的，
# 不再像前一批那样孤零零贴在角上 —— 于是 drop_edge_specks / strictSat 那套
# "当零碎前景剔掉"的招数全失效（水印和角色连成一块，一剔就是半个身子）。
# 水印只有两种像素：半透明的白字，和那枚浅色小徽标。两者都比**局部背景**亮，
# 所以拿大核中值当"局部背景"，把明显更亮的那撮替换回去就行 —— 相当于一次
# 只作用于水印框的简易 inpaint。角色本体的高光也可能超过阈值，所以额外要求
# "比局部背景更亮"（水印永远在"更亮"那一侧，剪影边缘不是）。
WM_BOX = (0.70, 0.85, 1.0, 1.0)   # 归一化 (x0, y0, x1, y1)。水印总在右下角
WM_K = 71                          # 局部背景的中值核。必须**大于徽标本身**，
                                   # 否则徽标内部的窗口全是徽标色，中值 = 徽标，
                                   # 差值算出来是 0，整枚徽标活下来。
                                   # 徽标实测 73×22（小红书那枚小圆角牌），窗口里
                                   # 徽标像素占比 = 22/k；要让它当"少数派"（<50%），
                                   # k 得大于 44。第一版给 41，刚好踩在线上（54%），
                                   # 文字抹掉了、底板却残留一小片，所以抬到 71（31%）。
WM_DIFF = 30                       # 与局部背景的通道差达到这个值才判成水印
WM_BRIGHT = 10                     # 还要"比局部背景亮这么多"才动手
# 哪些角色要过这道工序。前面那 30 张的水印都乖乖待在角色外面，靠连通域过滤
# 就够了，跑一遍反而有可能把角色的高光误抹；所以只对**水印压在角色身上**的这几张开。
WM_KEYS = {"beng", "bigmilk", "fight", "hao"}


def inpaint_watermark(img, box=WM_BOX, k=WM_K, diff=WM_DIFF):
    """把右下角水印就地抹平（原地修改 img）。"""
    H, W, _ = img.shape
    x0, y0, x1, y1 = (int(box[0] * W), int(box[1] * H), int(box[2] * W), int(box[3] * H))
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W, x1), min(H, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return
    # 中值在整幅图上算的话要跑 200 万像素 × 1681 窗口，太慢；
    # 只在水印框外扩一个核的范围内算，边界用 nearest 撑住。
    ys, xs = max(0, y0 - k), max(0, x0 - k)
    ye, xe = min(H, y1 + k), min(W, x1 + k)
    big = np.ascontiguousarray(img[ys:ye, xs:xe])
    med = ndimage.median_filter(big, size=(k, k, 1), mode='nearest')
    # 裁回水印框
    oy, ox = y0 - ys, x0 - xs
    med = med[oy:oy + (y1 - y0), ox:ox + (x1 - x0)]
    sub = img[y0:y1, x0:x1]
    d = np.abs(sub - med).max(axis=2)
    brighter = sub.min(axis=2) > med.min(axis=2) + WM_BRIGHT
    m = (d > diff) & brighter
    m = ndimage.binary_dilation(m, np.ones((3, 3), bool), iterations=2)
    img[y0:y1, x0:x1] = np.where(m[..., None], med, sub)


# 顺序沿用用户给的清单；经典奶蛙是初始角色
CHARS = [
    ("poop", "奶屎", "奶屎.jpg"),
    ("angry", "奶怒", "奶怒.jpg"),
    ("dolphin", "奶豚", "奶豚.jpg"),
    ("heart", "小奶比心", "小奶比心.jpg"),
    ("sphinx", "奶狮子", "奶狮子.jpg"),
    ("pisces", "奶双鱼", "奶双鱼.jpg"),
    ("taurus", "奶金牛", "奶金牛.jpg"),
    ("aries", "奶白羊", "奶白羊.jpg"),
    ("aquarius", "奶水瓶", "奶水瓶.jpg"),
    ("cancer", "奶巨蟹", "奶巨蟹.jpg"),
    ("gemini", "奶双子", "奶双子.jpg"),
    ("libra", "奶天秤", "奶天秤.jpg"),
    ("virgo", "奶处女", "奶处女.jpg"),
    ("capricorn", "奶摩羯", "奶摩羯.jpg"),
    ("sagittarius", "奶射手", "奶射手.jpg"),
    ("scorpio", "奶天蝎", "奶天蝎.jpg"),
    ("dog", "奶狗", "奶狗.jpg"),
    ("pig", "奶猪", "奶猪.jpg"),
    ("rooster", "奶鸡", "奶鸡.jpg"),
    ("monkey", "奶猴", "奶猴.jpg"),
    ("goat", "奶羊", "奶羊.jpg"),
    ("horse", "奶马", "奶马.jpg"),
    ("snake", "奶蛇", "奶蛇.jpg"),
    ("dragon", "奶loong", "奶loong.jpg"),
    ("tiger", "奶虎", "奶虎.jpg"),
    ("cow", "奶牛", "奶牛.jpg"),
    ("mouse", "奶鼠", "奶鼠.jpg"),
    ("rabbit", "奶兔", "奶兔.jpg"),
    ("egg", "奶蛋", "奶蛋.jpg"),
    ("frog", "经典奶蛙", "经典奶蛙.webp"),
    ("angry2", "奶怒2", "奶怒2.jpg"),
    ("beng", "奶绷", "奶绷.jpg"),
    ("bigmilk", "大奶", "大奶.jpg"),
    ("hao", "奶豪", "奶豪.jpg"),
    ("fight", "格斗准备奶蛙", "格斗准备奶蛙.jpg"),
]
DEFAULT_CHAR = "frog"

# 个别图要手工压阈值：光晕/白毛这类与背景对比弱或带大面积渐变的
OVERRIDE = {
    # 深蓝星空那两张：角色本体是亮黄，与深蓝的色差 200+；围绕角色的一圈蓝色
    # 光晕只有 60~90。所以阈值要往"高"调才能滤掉光晕 —— 一开始想反了，
    # 把阈值压低，结果整片光晕全被吃进来。
    #
    # 但光有阈值还不够：奶双鱼那圈光晕比背景还亮，调到 132 仍有整圈青蓝残影
    # 留在鱼身边（看着像穿了件塑料壳）。所以再叠一道暖色判据 —— 见 warmOnly。
    "pisces": {"tol": 132, "warmOnly": True},
    "gemini": {"tol": 112},
    # 白毛与白底对比极弱，阈值压到最小；同时关掉饱和度约束 ——
    # 羊毛本身就是低饱和的浅色，那道约束会把整只羊剃光。
    "aries": {"tol": 16, "noSat": True},
    # 角色本身就是纯黄 + 青绿眼睛，没有中性色部件，可以要求"必须有颜色"，
    # 把脚边那片深灰台面切干净。奶蛙的台面本身带一点暖调（sat≈0.13），
    # 所以它的门槛要比默认的 0.10 再抬一档。
    "frog": {"strictSat": True, "minSat": 0.18},
    # 奶蛋：脚下一整块浅灰台面 + 左下角"内容含 AI 生成"、右下角小红书号水印，
    # 三者都是中性灰白（sat 中位 0.05），蛋身则是高饱和黄 —— 同一个判据一次全切掉。
    # 台面角落有约两成像素被蛋身反射的暖光染到 0.10~0.14，所以门槛也得抬到 0.18。
    # 剩下贴着蛋底的那圈接触阴影色差是连续的：从蛋体的深棕 sat 0.70 一路滑到
    # 阴影的暖灰 sat 0.19，任何全局阈值都会要么留脏、要么啃掉蛋底。交给 trimShadow。
    "egg": {"strictSat": True, "minSat": 0.18, "trimShadow": (0.045, 0.36)},

    # ---- 后加的五张：背景不是干净的棚拍，逐张换判据 ----
    #
    # 奶怒2：背景是虚化的树叶 + 天空，四角分别是深橄榄、亮蓝、暖橙三种颜色，
    # 连 estimate_bg（取四角 + 边中点的中位数）都估不出一个像样的背景色。
    # 但角色是"红烊的"（R 恒大于 G：红头 R-G≈140、黄身 R-G≈45），
    # 树叶与天空则一律 G ≥ R —— 直接用"红度"这一个维度就切干净了。
    "angry2": {"warm": {"rb": 20, "rg": 15}},
    # 奶绷：墙是浅暖灰 (210,203,187)，R-B 只有 23，跟奶油肚皮的 87 差得远；
    # 但左下角有把绿椅子，是深橄榄色 (71,73,10)，R-B 竟有 61。
    # 光靠 R-B 会把椅子一起收进来，所以补一道 R-G：椅子 G ≈ R（-2），
    # 蛙身 R 远大于 G（黄 R-G≈80、奶油肚 R-G≈40）。两道一起卡，椅子就掉了。
    "beng": {"warm": {"rb": 45, "rg": 15}},
    # 大奶 / 格斗准备奶蛙：都是干净的白底棚拍，背景中性（R-B≈0~3）。
    # 不用 estimate_bg + Otsu 那套，是因为角色身上有大片**接近中性**的浅黄高光
    # （头顶那圈 R-G 只有 5 上下），Otsu 的阈值一压就把它啃掉 —— 第一版把大奶的
    # 头顶啃出一排锯口。改成只看 R-B：背景 0~3、蛙身 40 起步，中间空得很。
    "bigmilk": {"warm": {"rb": 20}, "unfillBg": {"from": 0.45}, "trimShadow": (0.12, 0.12)},
    "fight": {"warm": {"rb": 20}},
    # 奶豪：黑卫衣 + 白底 + 白 W 印花。白 W 和白底同色，色差法必然把它当背景，
    # 但它被卫衣整个包住 → 是个"孔"，后面的 fill_holes 会填回来（实测有效）。
    # 所以这里只需要"有颜色、或者非常暗"：卫衣黑（mx≈2）走暗那支，
    # 黄脸 / 绿眼走饱和那支，白底与白 W 两支都不沾 —— 让 W 当孔再填。
    "hao": {"strictSat": True, "minSat": 0.12, "darkOrColor": True},
}


def estimate_bg(img):
    """背景色：四角 + 左右边中点的中位数。比"整圈边框"稳 ——
    奶屎、奶蛋这类几乎占满画面的图，整圈边框会混进角色像素。"""
    H, W, _ = img.shape
    s = max(4, min(H, W) // 40)
    patches = []
    for y in (0, H - s):
        for x in (0, W - s):
            patches.append(img[y:y + s, x:x + s].reshape(-1, 3))
    cy = (H - s) // 2
    for x in (0, W - s):
        patches.append(img[cy:cy + s, x:x + s].reshape(-1, 3))
    return np.median(np.concatenate(patches), axis=0)


def otsu(x):
    x = np.clip(x, 0, 255)
    hist, _ = np.histogram(x, bins=256, range=(0, 256))
    total = hist.sum()
    idx = np.arange(256)
    wB = np.cumsum(hist).astype(np.float64)
    wF = total - wB
    sB = np.cumsum(idx * hist).astype(np.float64)
    sAll = sB[-1]
    valid = (wB > 0) & (wF > 0)
    mB = np.zeros(256)
    mF = np.zeros(256)
    mB[valid] = sB[valid] / wB[valid]
    mF[valid] = (sAll - sB[valid]) / wF[valid]
    var = wB * wF * (mB - mF) ** 2
    return int(np.argmax(var))


def drop_edge_specks(m):
    """去掉接触图像边界、但面积很小的连通域（贴边的水印、星空星点）。

    注意 keep[0] 必须恒为 False：标签 0 是背景。这里踩过一次坑 ——
    keep 一开始写成 np.ones，于是"没有任何域接触边界"时集合为空、
    一个都没被置 False，keep[lab] 连背景一起标成前景，整张图直接实心
    （奶鸡、奶狮子、奶白羊、奶蛋全是这么糊掉的，前景覆盖率算出 98%）。
    """
    lab, n = ndimage.label(m, np.ones((3, 3), int))
    if n <= 1:
        return m
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    total = sizes.sum()
    edge = set()
    for row in (lab[0], lab[-1]):
        edge.update(np.unique(row).tolist())
    for col in (lab[:, 0], lab[:, -1]):
        edge.update(np.unique(col).tolist())
    edge.discard(0)
    keep = np.zeros(n + 1, bool)
    keep[1:] = True
    for i in edge:
        if sizes[i - 1] < total * 0.25:
            keep[i] = False
    return keep[lab]


def drop_flat_bottom(m):
    """丢掉"贴着图像底边、又扁又宽"的长条。

    这批图是棚拍/合成图，角色脚下往往有一道台面或投影，颜色比白底深一截，
    靠色差阈值挡不住（奶蛋、奶鼠底下都留着这么一条）。特征是又扁又贴底，
    且不可能是角色本体，直接按形状剔掉。

    和 drop_edge_specks 一样，keep[0] 必须恒为 False —— 标签 0 是背景。
    这个 np.ones 的写法在两处都埋了同一个雷，改了一处忘了另一处，
    结果四张图（星空两张、奶射手、经典奶蛙）被整张填实。"""
    H, W = m.shape
    lab, n = ndimage.label(m, np.ones((3, 3), int))
    if n <= 1:
        return m
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    total = sizes.sum()
    keep = np.zeros(n + 1, bool)
    keep[1:] = True
    for i in range(1, n + 1):
        if sizes[i - 1] > total * 0.25:
            continue                      # 大块就是角色本身，别误伤
        ys, xs = np.nonzero(lab == i)
        h = ys.max() - ys.min() + 1
        w = xs.max() - xs.min() + 1
        if h < H * 0.10 and w > W * 0.35 and ys.max() >= H - 4:
            keep[i] = False
    return keep[lab]


def cutout(path, key):
    img = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    H, W, _ = img.shape

    ov = OVERRIDE.get(key, {})

    # 水印先抹平，再算一切。顺序不能反：水印压在身上时会被当成"角色的一部分"，
    # 后面的连通域过滤、Otsu 阈值都会把它算进去。
    if ov.get("watermark", True) and key in WM_KEYS:
        inpaint_watermark(img, ov.get("wmBox", WM_BOX))

    bg = estimate_bg(img)
    d = np.abs(img - bg).max(axis=2)

    t = ov.get("tol", int(np.clip(otsu(d.reshape(-1)), 14, 72)))

    if ov.get("warm"):
        # 整套"与背景色差"逻辑都绕开：背景太花（虚化树叶）或背景与角色亮度太近
        # （白底 + 浅黄高光），只有颜色倾向这一个维度是可靠的。
        w = ov["warm"]
        m = (img[..., 0] - img[..., 2]) > w["rb"]
        if "rg" in w:
            m &= (img[..., 0] - img[..., 1]) > w["rg"]
    else:
        m = d > t

    m = ndimage.binary_opening(m, np.ones((3, 3), bool))

    if ov.get("warmOnly"):
        # 奶双鱼：那一圈光晕比深蓝星空还亮，跟角色的色差甚至比背景更大，
        # 任何"与背景色差"的阈值都切不掉它。但光晕/星空与角色的差别在另一个
        # 维度上 —— 它们蓝远大于红，角色是黄白色系（黄身 R-B≈+60，头顶的
        # 银白小鱼 R-B≈0）。所以这里直接换成暖色判据。
        m &= (img[..., 0] - img[..., 2]) > -6.0

    if ov.get("darkOrColor"):
        # "有颜色"或者"够暗"。奶豪的白 W 印花与白底同色，两支都不沾 →
        # 它成了卫衣里的一个孔，交给后面的 fill_holes 填回来。
        mx = img.max(axis=2)
        mn = img.min(axis=2)
        sat = (mx - mn) / np.maximum(mx, 1.0)
        m &= (sat > ov.get("minSat", 0.10)) | (mx < 115.0)
    elif ov.get("strictSat"):
        # 只要"有颜色"。经典奶蛙脚边有一大片深灰台面、奶蛋脚下有浅灰台面
        # 加两处水印，它们虽然"和背景不一样"但几乎没有色彩，用严格判据一刀切掉。
        mx = img.max(axis=2)
        mn = img.min(axis=2)
        sat = (mx - mn) / np.maximum(mx, 1.0)
        m &= sat > ov.get("minSat", 0.10)
    elif not ov.get("noSat") and not ov.get("warm"):
        # 补一道"必须像角色"的约束：前景要么有颜色（黄系角色的饱和度很高），
        # 要么明显比背景暗（角色的深色手脚、尾尖）。纯靠色差 d 会误收两类东西：
        # 背景渐变（白底图下半截偏灰，d 直接顶到阈值）和脚下的台面/投影。
        mx = img.max(axis=2)
        mn = img.min(axis=2)
        sat = (mx - mn) / np.maximum(mx, 1.0)
        v_bg = float(bg.max() / 255.0)
        m &= (sat > 0.10) | (mx / 255.0 < v_bg - 0.10)

    # 先剔掉贴边的零碎前景（水印残渣、星空星点），再清最外 2px。
    # 顺序不能反：边框一旦清掉，就再也认不出"哪些域接触边界"了 ——
    # 第一版就是先清边框再判断，结果边界那圈全是背景、edge 集合为空、
    # keep 全 True，整张图被当成前景（奶白羊从 64% 跳到 100%）。
    m = drop_edge_specks(m)
    m[:2, :] = m[-2:, :] = m[:, :2] = m[:, -2:] = False

    m = ndimage.binary_closing(m, np.ones((5, 5), bool), iterations=2)

    # 填孔前沿边再切一刀。closing 会把边缘附近的星点/残渣连成一圈，中间那块
    # 背景于是成了"封闭孔"，紧接着的 fill_holes 就连人带图一起填实
    # （星空两张、奶射手、经典奶蛙都这样，覆盖率算出 100%）。6px 足够断环，
    # 又不会明显啃掉贴边角色的轮廓。
    m[:6, :] = m[-6:, :] = m[:, :6] = m[:, -6:] = False

    m = ndimage.binary_fill_holes(m)
    if ov.get("unfillBg"):
        # fill_holes 会把"闭合口袋里的背景"也填实 —— 大奶裆部那块白底被两条腿
        # 加肚皮包成了封闭区，填完成一坨不透明白（实测 4881 像素）。填完把
        # 颜色判据再收一遍：填进来的像素颜色不达标（白底 R-B≈0~3），退回去。
        # ★ 只在画面下半部生效（from = 高度比例）：大奶的眼睛也是白的，全图
        #   一刀切会把白眼球挖成两个洞（第一版就这么翻车的）。
        # 只对 warm 系判据开放 —— 白底图上角色没有纯白部件才敢用。
        w = ov["warm"]
        keep = (img[..., 0] - img[..., 2]) > w["rb"]
        if "rg" in w:
            keep &= (img[..., 0] - img[..., 1]) > w["rg"]
        frm = ov["unfillBg"]
        cut = int(H * (frm["from"] if isinstance(frm, dict) else 0.0))
        m[cut:, :] &= keep[cut:, :]
    m = drop_flat_bottom(m)

    if ov.get("trimShadow"):
        # 角色底下的接触阴影：颜色是被角色反射光染暖的灰，和角色本体的深色边缘
        # 在同一片区域里连续过渡，全局阈值切不干净。所以只在最底部那一条窄带里
        # 单独抬门槛 —— 角色本体再怎么暗也仍然"有颜色"，阴影则不饱和。
        band, smin = ov["trimShadow"]
        cut = int(H * (1.0 - band))
        mx = img.max(axis=2)
        mn = img.min(axis=2)
        sat = (mx - mn) / np.maximum(mx, 1.0)
        m[cut:, :] &= sat[cut:, :] >= smin
        # 只留仍然连着主体那一块，避免把轮廓切出飘浮的碎块
        lab, n = ndimage.label(m, np.ones((3, 3), int))
        if n > 1:
            sizes = ndimage.sum(m, lab, range(1, n + 1))
            m = lab == (int(np.argmax(sizes)) + 1)

    lab, n = ndimage.label(m, np.ones((3, 3), int))
    dropped = 0
    if n > 1:
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        big = sizes.max()
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= max(big * MIN_KEEP, 400)
        dropped = int(n - keep.sum() + (1 if n else 0))
        m = keep[lab]

    # alpha：先软后锐，约 1.5px 羽化
    soft = ndimage.gaussian_filter(m.astype(np.float32), 0.9)
    alpha = np.clip((soft - 0.34) / 0.46, 0.0, 1.0)

    # 边缘去底色污染：把混进去的背景色反解出去
    a3 = alpha[..., None]
    clean = np.where(a3 > 0.02, (img - (1.0 - a3) * bg) / np.maximum(a3, 0.02), img)
    clean = np.clip(clean, 0, 255)

    ys, xs = np.nonzero(alpha > 0.5)
    y0, y1 = max(0, ys.min() - PAD), min(H, ys.max() + 1 + PAD)
    x0, x1 = max(0, xs.min() - PAD), min(W, xs.max() + 1 + PAD)

    rgba = np.dstack([clean[y0:y1, x0:x1], alpha[y0:y1, x0:x1] * 255.0]).astype(np.uint8)
    im = Image.fromarray(rgba, "RGBA")
    scale = TARGET_H / im.height
    im = im.resize((max(1, round(im.width * scale)), TARGET_H), Image.LANCZOS)

    px = np.asarray(im).copy()
    px[..., 3] = np.where(px[..., 3] < 12, 0, px[..., 3])
    im = Image.fromarray(px, "RGBA")

    # 脚底在贴图里的归一化位置：游戏靠它把角色正好踩在砖面上。
    # 用缩放前的包围盒下沿换算，比缩放后重新找 alpha>0 更省事也更准。
    baseline = ((ys.max() + PAD - y0) * scale) / im.height
    meta = {
        "w": im.width,
        "h": im.height,
        "aspect": round(im.width / im.height, 5),
        "baseline": round(float(min(baseline, 1.0)), 5),
        "foot": round(measure_foot(im, min(baseline, 1.0)), 4),
    }
    return im, meta, dict(bg=[round(v, 1) for v in bg.tolist()], tol=t, otsu=otsu(d.reshape(-1)),
                          dropped=dropped, cover=round(float((alpha > 0.5).mean()) * 100, 1))


def write_sprite_data(cache):
    """按 CHARS 顺序把已有贴图全部内嵌，生成 sprite_data.js（--feet 与全量共用）"""
    body = []
    for key, name, _ in CHARS:
        e = cache.get(key)
        if not e:
            continue
        webp = OUT_DIR / (key + ".webp")
        if not webp.exists():
            continue
        raw = webp.read_bytes()
        item = dict(e, uri="data:image/webp;base64," + base64.b64encode(raw).decode("ascii"))
        body.append("\n  " + json.dumps(item, ensure_ascii=False, separators=(",", ":")))
    js = (
        "/* 自动生成，勿手改：由 dev/extract_chars.py 抠图并内嵌。\n"
        " * 每项含贴图 data URI、脚底基准线 baseline 与脚底接触半宽 foot\n"
        " * （都是 0~1 的贴图内归一化值；foot 是落脚判定的碰撞依据）。*/\n"
        "export const CHARS = [" + ",".join(body) + "\n];\n"
        "export const DEFAULT_CHAR = " + json.dumps(DEFAULT_CHAR) + ";\n"
    )
    OUT_JS.write_text(js, encoding="utf-8")
    print("\n共 %d 个角色 -> %s (%.0f KB)" % (len(body), OUT_JS.name, OUT_JS.stat().st_size / 1024))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--feet", action="store_true",
                    help="跳过抠图：只从现有 assets/chars/*.png 量脚底接触半宽，"
                         "回写 chars_meta.json 与 sprite_data.js（源头图不在也能跑）")
    args = ap.parse_args()

    only = set(x for x in args.only.split(",") if x)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 元数据存一份 sidecar：这样 --only 重抠几个角色时，其余角色的 w/h/aspect/
    # baseline 还在，可以照常拼出完整的 sprite_data.js。
    # （之前没有这个文件，--only 会把 sprite_data.js 直接覆盖成"只剩重抠的那几个"，
    #   游戏里于是 30 个角色掉了 27 个。踩过一次，别再踩。）
    cache = {}
    if META_JSON.exists():
        for e in json.loads(META_JSON.read_text(encoding="utf-8")):
            cache[e["key"]] = e

    if args.feet:
        tiles = []
        for key, name, _ in CHARS:
            e = cache.get(key)
            png = OUT_DIR / (key + ".png")
            if not e or not png.exists():
                print("跳过 %s（无元数据或无 PNG）" % key)
                continue
            im = Image.open(png)
            e["foot"] = round(measure_foot(im, e["baseline"]), 4)
            tiles.append((key, im))
            print("%-12s %-6s foot=%.4f（世界半径 ≈ %.2f）"
                  % (key, name, e["foot"], 1.62 * min(e["aspect"], 1.0) * e["foot"]))
        META_JSON.write_text(
            json.dumps([cache[k] for k, _, _ in CHARS if k in cache], ensure_ascii=False, indent=1),
            encoding="utf-8")
        write_sprite_data(cache)
        return 0

    tiles = []
    for key, name, fn in CHARS:
        if only and key not in only:
            continue
        p = SRC / fn
        if not p.exists():
            print("缺失: %s" % fn)
            continue
        im, meta, info = cutout(p, key)
        png = OUT_DIR / (key + ".png")
        webp = OUT_DIR / (key + ".webp")
        im.save(png, optimize=True)
        im.save(webp, quality=WEBP_Q, method=6)
        cache[key] = {"key": key, "name": name, **meta}
        tiles.append((key, im))
        print("%-12s %-6s tol=%-3d otsu=%-3d 覆盖 %5.1f%%  丢 %2d 块  %dx%d  %4.0fKB"
              % (key, name, info["tol"], info["otsu"], info["cover"], info["dropped"],
                 meta["w"], meta["h"], webp.stat().st_size / 1024))

    # 联系表：中灰底，白毛类角色的边缘才看得清
    if args.sheet and tiles:
        cols, th = 6, 170
        rows = (len(tiles) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (th + 16), rows * (th + 16)), (110, 116, 130))
        for i, (key, im) in enumerate(tiles):
            r, c = divmod(i, cols)
            s = im.resize((max(1, round(im.width * th / im.height)), th), Image.LANCZOS)
            sheet.paste(s, (c * (th + 16) + 8, r * (th + 16) + 8), s)
        sheet.save(SHEET)
        print("联系表 -> %s" % SHEET)

    META_JSON.write_text(
        json.dumps([cache[k] for k, _, _ in CHARS if k in cache], ensure_ascii=False, indent=1),
        encoding="utf-8")

    write_sprite_data(cache)
    return 0


if __name__ == "__main__":
    sys.exit(main())
