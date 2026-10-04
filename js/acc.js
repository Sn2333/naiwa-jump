/* 装饰系统 —— 所有角色通用。
 *
 * 设计取向：装饰不挑角色，谁都能戴。因为角色是 30 张抠好的纸片人立绘，
 * 体型从"矮胖的奶猪"到"带长耳朵的奶兔"都有，所以头饰的位置不能写死 ——
 * 运行时按每张立绘的 alpha 剪影算出"头顶"在哪（见 character.js 的
 * computeHeadAnchor），帽子再按头部宽度等比缩放。这样一套装饰就能通用。
 *
 * 新增装饰的步骤：
 *   1) dev/extract_acc.py <图> <id>      抠成 assets/acc/<id>_256.webp
 *   2) dev/build_acc_data.py             内联进 js/acc_data.js
 *   3) 在下面 ACC_DECOS 里加一条（img 写 <id>）
 * 贴图不在这里 import，由 character.js 从 acc_data.js 按 img 键取。
 */

/** 装饰分类。
 *  head = 头顶（按立绘剪影算出的头顶锚点）
 *  back = 背后（挂在中脊偏上，比头饰大、可以盖住身体一部分）
 *  fx   = 特效（**没有 3D 贴图**，不是挂在身上的装饰，而是"落地时额外播一段
 *         粒子"这类行为开关）。单独占一个槽位，就为了复用整套
 *         拥有 / 装备 / 商店 / 仓库 流程；渲染层不认识它（不在 ACC_SLOTS 里），
 *         由 game.js 读 accEquip.fx 决定要不要放特效。 */
export const ACC_CATS = [
  { key: 'head', name: '头饰', store: 'jump3d_acc_head' },
  { key: 'back', name: '背饰', store: 'jump3d_acc_back' },
  { key: 'fx', name: '特效', store: 'jump3d_acc_fx' },
];

/** 有 3D 贴图的槽位（= 需要建 mesh 的那几个）。fx 不在此列。 */
export const ACC_MESH_SLOTS = ['head', 'back'];

/** 装饰清单。
 *  price  : 商店售价（奶币）；0 = 一开始就有
 *  img    : acc_data.js 里的贴图键（内容框由生成脚本自动量出并一起写入）。
 *           **fx 类没有贴图**，img 缺省 —— 前端按 "没有 img 就不建 mesh" 处理。
 *  hK     : 本体高度相对**角色高度**的倍率（所有人一样高 → 帽子一样大）
 *  dy     : 本体中心相对"头顶"的竖直偏移，单位是本体高度（正 = 往上）
 *           0.5 = 底边正好落在头顶；比 0.5 小就是往下压进头里一点
 *  dx     : 水平偏移，单位是本体宽度（一般 0，歪戴的帽子可以给个值）
 *  fx     : 特效类型标识（仅 cat='fx' 用）。game.js 按它决定播哪种落地特效。
 *  notice : 只从**公告赠礼**发放，商店不上架。
 *           商店货架读的是 shopAccList()，它把这类过滤掉；
 *           角色面板里的装饰行读 accList()，**仍然显示**（否则玩家不知道该去哪儿拿），
 *           只是点了会提示"去公告里领"。
 */
export const ACC_DECOS = [
  {
    id: 'hat_birthday', cat: 'head', name: '生日帽', price: 500,
    img: 'hat_birthday', hK: 0.46, dy: 0.38, dx: 0,
    desc: '我只有两岁',
    notice: true,
  },
  {
    /* 光环：头顶的扁平金环。dy 压到 0.5 以下 —— 光环是"套"在头顶上的，
     * 中心要略低于头顶，不然会浮在空中像个项圈。 */
    id: 'halo', cat: 'head', name: '光环', price: 10,
    img: 'halo', hK: 0.30, dy: 0.30, dx: 0,
    desc: '',
  },
  {
    /* 很冷的翅膀（琪露诺冰晶）：贴图由参考图直接抠出（四片独立冰晶，
     * 见 dev/extract_wing.py），不再走程序画。
     * ★ 尺寸按**内容框**算：抠出来的四片冰晶内容框是 w0.945 × h0.578（宽高比 1.63，
     *   很扁）—— 所以 hK 给一点点，内容宽度就翻倍。hK=1.24 时内容宽达 3.0 世界单位
     *   （3.7 倍体宽），整组读成"横着摊开的冰环"而不是背上的翅膀（用户反馈
     *   "根本就不在角色的背部"）。收到 0.68 后位置对了，但**宽体型的角色（大奶 /
     *   奶霸）身体会把冰晶挡住**（用户反馈）—— 抬到 1.05 露出来了，但用户上线
     *   实测连续两轮嫌大 —— 收到 **0.82**：内容 ≈ 2.0 宽 × 1.2 高（角色高 1.48），
     *   宽体型还能露边、不再横摊。
     * dy 正 = 往上：压到 **-0.02**，内容中心基本落在背饰锚点上（头顶下方 0.42 角色高），
     *   四片冰晶从肩后展开、不飘过头顶。
     * 锚点见 character.js 的 _layoutSlot：从头顶往下 backDropK 落在上背。 */
    id: 'wing', cat: 'back', name: '很冷的翅膀', price: 10,
    img: 'wing', hK: 0.82, dy: -0.02, dx: 0,
    desc: 'Baka baka~',
  },
  {
    /* 魔法阵：**落地特效**（cat='fx'）—— 不是戴在身上的东西，而是"每次落地
     * 脚下浮现一圈魔法阵"的行为开关。所以没有贴图（img 缺省），
     * 逻辑在 game.js 的 landmagic()，由 accEquip.fx === 'fx_magic' 触发。
     * 占一个独立槽位是为了复用整套买/戴/存/商店流程。
     * （原「水花」已按用户要求删除，位置由魔法阵接替。） */
    id: 'fx_magic', cat: 'fx', name: '魔法阵', price: 10,
    fx: 'magic',
    desc: '落地时脚下浮现一圈魔法阵',
  },
];

const BY_ID = new Map(ACC_DECOS.map((d) => [d.id, d]));

/** 某一类下的全部装饰（按价格从低到高，免费的在最前） */
export function accList(cat) {
  return ACC_DECOS
    .filter((d) => !cat || d.cat === cat)
    .slice()
    .sort((a, b) => a.price - b.price);
}

/** 商店货架上架的装饰：公告赠品不在这儿卖。 */
export function shopAccList(cat) {
  return accList(cat).filter((d) => !d.notice);
}

/** 取装饰定义；找不到返回 null（null 就是"不戴"） */
export function accDef(id) { return id ? (BY_ID.get(id) || null) : null; }
export function accCat(key) { return ACC_CATS.find((c) => c.key === key) || null; }
