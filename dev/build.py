"""把多文件工程打包成单文件 HTML（可直接双击打开，无需本地服务器）

用法：
    python dev/build.py                     # 离线单文件版：不接后端，榜单走本地模式
    python dev/build.py --out dist/x.html   # 指定输出路径

注意：模块之间靠 __M 命名空间传递符号。这份映射是**自动生成**的 —— 早先
手工维护过一份注入清单，结果它恰好补上了 game.js 缺失的一个 import，
把 "ReferenceError: DEFAULT_CHAR is not defined" 一直藏在单文件版里，
只有部署用的 module 形态才炸。所以现在一律从源码里解析。
"""
import re
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
JS = ROOT / "js"


def strip_imports(src):
    """剥掉所有 import 语句。

    必须支持跨行写法（`import {\\n a, b,\\n} from './x.js';`）—— 之前用
    `^import .*?;$` 只能匹配单行，多行 import 会整条残留在产物里，
    在非 module 的 <script> 中直接抛 SyntaxError。
    """
    return re.sub(r"^import\b[\s\S]*?;\s*$", "", src, flags=re.M)


def exports_of(src):
    """解析一个模块导出的顶层符号名。

    覆盖 export const/let/var/function/class（含 async function），
    以及 export { a, b }。
    """
    names = []
    for m in re.finditer(
        r"^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)",
        src, flags=re.M
    ):
        names.append(m.group(1))
    for m in re.finditer(r"^export\s*\{([^}]*)\}", src, flags=re.M):
        for part in m.group(1).split(","):
            part = part.strip()
            if part:
                names.append(part.split(" as ")[-1].strip())
    return names


def imports_from(src, module):
    """找出 `import { a, b } from '<module>';` 里的符号名（支持跨行）"""
    names = []
    for m in re.finditer(
        r"^import\s*\{([^}]*)\}\s*from\s*['\"]([^'\"]+)['\"];", src, flags=re.M
    ):
        if m.group(2).endswith(module):
            for part in m.group(1).split(","):
                part = part.strip()
                if part:
                    names.append(part.split(" as ")[-1].strip())
    return names


def decls_for(names):
    """生成 `const X = __M.X;` 形式的解构声明"""
    return "".join(f"const {n} = __M.{n};\n" for n in names)


def expose_for(names):
    """生成 `__M.X = X;` 形式的导出赋值"""
    return "".join(f"__M.{n} = {n};\n" for n in names)


three_src = (JS / "vendor" / "three.module.js").read_text(encoding="utf-8")
m = re.search(r"\nexport \{([^}]*)\};\s*$", three_src)
assert m, "未找到 three.js 的导出语句"
names = [n.strip() for n in m.group(1).split(",") if n.strip()]
three_body = three_src[: m.start()]

three_wrapped = (
    "const __THREE = (function(){\n"
    + three_body
    + "\nreturn {" + ", ".join(names) + "};\n})();\n"
)

sprite_src = (JS / "sprite_data.js").read_text(encoding="utf-8")
sprite_src = sprite_src.replace("export const ", "const ")

char_src = (JS / "character.js").read_text(encoding="utf-8")
char_src = strip_imports(char_src)
char_src = re.sub(r"^export ", "", char_src, flags=re.M)

# 背景主题模块。和 character.js 同处一个 IIFE，所以两边都不能有同名顶层常量
theme_src = (JS / "theme.js").read_text(encoding="utf-8")
theme_src = strip_imports(theme_src)
theme_src = re.sub(r"^export ", "", theme_src, flags=re.M)

audio_src = (JS / "audio.js").read_text(encoding="utf-8")
audio_src = audio_src.replace("export class Sound", "class Sound")
audio_src = audio_src.replace("export const sound", "const sound")

hit_src = (JS / "hit.js").read_text(encoding="utf-8")
hit_src = re.sub(r"^export ", "", hit_src, flags=re.M)

# 昵称 / 排行榜的后端适配层（api.js，单独一个 IIFE）
api_raw = (JS / "api.js").read_text(encoding="utf-8")
api_names = exports_of(api_raw)
api_src = strip_imports(api_raw)
api_src = re.sub(r"^export ", "", api_src, flags=re.M)

game_raw = (JS / "game.js").read_text(encoding="utf-8")
# game.js 从 api.js 拿了哪些符号，就往下注入哪些 —— 不再手写清单
game_needs = [n for n in imports_from(game_raw, "api.js") if n in api_names]
missing_api = set(imports_from(game_raw, "api.js")) - set(api_names)
assert not missing_api, f"game.js 引用了 api.js 没导出的符号：{sorted(missing_api)}"
game_src = strip_imports(game_raw)

bundle = (
    three_wrapped
    + "const __M = {};\n"
    + "(function(){\n" + sprite_src
    + "\n__M.CHARS = CHARS;\n__M.DEFAULT_CHAR = DEFAULT_CHAR;\n})();\n"
    + "(function(THREE){\nconst CHARS = __M.CHARS;\nconst DEFAULT_CHAR = __M.DEFAULT_CHAR;\n"
    + char_src + "\n" + theme_src
    + "\n__M.Character3D = Character3D;\n__M.charList = charList;\n__M.charDef = charDef;\n"
    + "__M.bgList = bgList;\n__M.bgDef = bgDef;\n__M.DEFAULT_BG = DEFAULT_BG;\n})(__THREE);\n"
    + "(function(){\n" + audio_src + "\n__M.sound = sound;\n})();\n"
    + "(function(){\n" + api_src + "\n" + expose_for(api_names) + "})();\n"
    + "(function(THREE){\nconst Character3D = __M.Character3D;\nconst sound = __M.sound;\n"
    + "const charList = __M.charList;\nconst DEFAULT_CHAR = __M.DEFAULT_CHAR;\n"
    + "const bgList = __M.bgList;\nconst bgDef = __M.bgDef;\nconst DEFAULT_BG = __M.DEFAULT_BG;\n"
    + decls_for(game_needs)
    + hit_src + "\n"
    + game_src + "\n})(__THREE);\n"
)

# 防御：每个被读取的 __M.x 都必须先被赋值过。手写清单的年代就是在这里失守的。
_used = set(re.findall(r"=\s*__M\.(\w+);", bundle))
_defined = set(re.findall(r"__M\.(\w+)\s*=", bundle))
assert not (_used - _defined), f"打包产物缺少注入：{sorted(_used - _defined)}"

out_name = "奶蛙一跳.html"
argv = sys.argv[1:]
for i, a in enumerate(argv):
    if a == "--out" and i + 1 < len(argv):
        out_name = argv[i + 1]

html = (ROOT / "index.html").read_text(encoding="utf-8")

# 单文件版是给"双击就能玩"的离线场景的：把 cloud:begin..cloud:end 整段删掉，
# 于是不会去拉 CDN、也没有云配置，api.js 直接落到本地模式，零网络请求。
# （在线版是直接把工程目录部署上去，index.html 原样保留这一段。）
html, n = re.subn(r"<!-- cloud:begin[\s\S]*?<!-- cloud:end -->\n?", "", html, count=1)
assert n == 1, "没找到 cloud:begin / cloud:end 标记"

html = html.replace(
    '<script type="module" src="./js/game.js"></script>',
    "<script>\n/* 单文件版：内联 three.js r160 + 游戏代码，可直接双击运行 */\n"
    + bundle
    + "\n</script>",
)
assert "<script>\n/* 单文件版" in html, "脚本替换失败"

# 角色换成整套奶系角色之后，"黄豆仔"不再对应任何角色，输出名一并改掉
out = ROOT / out_name
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"OK -> {out}  ({len(html)/1024:.0f} KB, 离线单文件版（本地模式）)")
