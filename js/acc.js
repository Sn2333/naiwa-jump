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

/** 装饰分类。先只做头饰，将来加"面饰/手持"直接往这里加。 */
export const ACC_CATS = [
  { key: 'head', name: '头饰', store: 'jump3d_acc_head' },
];

/** 装饰清单。
 *  price  : 商店售价（奶币）；0 = 一开始就有
 *  img    : acc_data.js 里的贴图键（内容框由生成脚本自动量出并一起写入）
 *  hK     : 本体高度相对**角色高度**的倍率（所有人一样高 → 帽子一样大）
 *  dy     : 本体中心相对"头顶"的竖直偏移，单位是本体高度（正 = 往上）
 *           0.5 = 底边正好落在头顶；比 0.5 小就是往下压进头里一点
 *  dx     : 水平偏移，单位是本体宽度（一般 0，歪戴的帽子可以给个值）
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
