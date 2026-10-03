/**
 * game.js —— 3D 跳一跳（WeChat Jump 风格）
 * 按住蓄力，松开起跳；落在方块正中可获得连击奖励
 */
import * as THREE from './vendor/three.module.js';
import { Character3D, charList, charDef } from './character.js';
import { DEFAULT_CHAR } from './sprite_data.js';
import { bgList, bgDef, DEFAULT_BG } from './theme.js';
import { api, profile, loadProfile, setNick, clearNick, submitScore, leaderboard, fetchPid } from './api.js';
import { sound } from './audio.js';
import { edgeOver, perfectTol } from './hit.js';
import { accList, accDef, accCat, ACC_CATS, shopAccList } from './acc.js';
import { COIN_URI, ACC_IMG, MILK_FACE_URI } from './acc_data.js';
import { LAUGH_URI, DING_URI, PAY_URI } from './media_data.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);
/* 昵称是玩家自己填的，插进 innerHTML 前一律转义 */
const escapeHTML = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CFG = {
  camOffset: new THREE.Vector3(5.4, 7.4, 5.4),
  camLookY: 0.35,
  fov: 34,
  gapMin: 1.90,
  gapMax: 3.60,
  jumpMin: 0.95,
  jumpRange: 3.85,
  chargeTime: 1.15,
  specialChance: 0.22,

  /* 难度爬升：跳得越远，砖越远、迷你砖越多。
   * 用"跳了几次"而不是"多少分"来推进 —— 完美连击一次能拿十几分，
   * 用分数做进度会让会玩的人几跳就把难度顶到头。
   * 上限刻意留了余量：gap 最大 4.25 时只需蓄到 86%，不会出现"必须满蓄"的死局 */
  rampJumps: 40,
  gapMinRamp: 0.20,
  gapMaxRamp: 0.65,
  miniChance: 0.11,
  miniChanceRamp: 0.17,

  /* 特色砖出现率（迷你砖由上面的曲线单独控制）
   * fragile 脆砖   —— 站上去倒计时，到点碎裂，逼玩家别恋战
   * double  ×2 砖  —— 落上这一跳的收益全部翻倍
   * spring  弹簧    —— 站上它，下一跳射程 +92%（**只有这一跳**，离开就没了），弧线也更高
   * slime   粘液块  —— 踩过之后射程被压住（每层 -30%，最多 2 层），越踩越跳不远
   * freeze  冰冰冰  —— 落上直接把角色冻住 1.5 秒，人动不了、蓄不了力（三块真冰块）
   * holy    圣光砖  —— 把场上已有的脆砖全部"净化"回普通砖（可救命的清场）
   * lure    磁铁砖  —— 下一跳自动吸向准星，闭眼也能落正中（完美连击）
   * milk    奶块    —— 砖面上印着经典奶蛙的脸，纯装饰，没有任何效果 */
  movingChance: 0.15,
  springChance: 0.09,
  peachChance: 0.05,
  fragileChance: 0.075,
  doubleChance: 0.06,
  /* 负面效果砖（粘液削射程 / 冰冰冰冻住人）刻意比正面砖低一档：
   * 现在 0.035，比正面的 0.05~0.06 都低 —— 玩家掉分主要该怪自己没踩准，
   * 不是怪抽签抽到一块不让你好好玩的砖。 */
  slimeChance: 0.035,
  freezeChance: 0.035,
  holyChance: 0.035,
  lureChance: 0.05,
  milkChance: 0.05,

  /* 脆砖：落上后这么多秒碎裂。要留够反应时间，也不能久到能喝口茶 */
  crackTime: 1.4,

  /* —— 特殊效果砖的参数 —— */
  boostRange: 0.92,     // 弹簧助推：从弹簧起跳的那一跳射程 ×1.92。**不叠层、不跨砖**
  slimeK: 0.25,         // 粘液块：每层把能跳的最大距离砍掉两成半（0.40→0.30→0.25，一路按玩家反馈放软）
  slimeMax: 2,          // 粘液最多叠几层（再砍就跳不动了，得留活路）
  freezeMs: 1500,       // 冰冰冰：把角色冻住多少毫秒（期间不能蓄力起跳）
  /* 磁铁砖：只管"对准"，不管"够远"。蓄力差一点点它把你拽回砖心；
   * 蓄力差一整个砖，它也只能拽 lureMaxPull 这么远，照样掉下去。
   * 之前给过 lureRange（额外吸近），结果落点被推过砖心、误差反而变大 —— 砍掉。 */
  lurePull: 0.92,       // 把落点拉向砖心多少（1 = 正中）
  lureMaxPull: 0.55,    // 单次最多拽回多远（≈ 一个砖半径，救急不救穷）
  lureCapMul: 1.6,      // 拽回上限按目标砖半径放大：大砖多拽一点，小砖少拽一点

  /* —— 奶币 ——
   * 奶币不再是"踩到幸运方块掉出来的贴纸"，而是**砖面上的实体**：随机某几块砖
   * 上悬着一枚绕竖轴自转的奶币（地铁跑酷那种），跳过去碰到就收下，
   * 屏幕左上角累计本局枚数；结算按"捡到的枚数"给钱，和分数完全脱钩。 */
  coinChance: 0.30,       // 每块新砖带上一枚奶币的概率
  coinPerPick: 10,        // 结算：每捡到 1 枚奶币入账多少
  coinY: 0.70,            // 奶币悬在砖面上多高（要看得出来是"浮"着的）
  coinR: 0.20,            // 奶币半径（砖半径约 0.7，差不多是四分之一砖宽）
  coinSpin: 4.4,          // 自转角速度（弧度/秒）。转快一点：币转到"正侧面"时
                          // 只剩一条金边，转得快就只是闪一下，不会看着像消失了
  coinBob: 0.055,         // 上下轻浮动幅度
  coinPickR: 0.72,        // 拾取半径（从"角色胸口"量到奶币中心）
  coinChest: 0.42,        // 角色胸口相对脚底的高度

  /* 从弹簧砖起跳的弧线抬高比例。只抬高不改变落点 —— 蓄力多少还是跳多远，
   * 所以不会因为"弹过头"而越过目标砖，纯粹是看得见的手感差异 */
  springLift: 1.55,

  /* 落脚判定：全部以"看得见的轮廓"为准
   *   footR    —— 角色自己的脚底接触半径（剪影实测，见 character.js）
   *   footSupport —— 要求"多大部分的脚还在砖上才算站"。0.25 = 脚心越出砖缘
   *               超过 footR 的四分之一就摔，此刻支撑面积只剩三成左右。
   *               不设这条的话，宽脚角色整个脚心探出砖外还挂着一点边不掉，
   *               实测就是"只有小部分站在边缘也不会掉"，太简单。
   *   edgeGrace —— 在这条线之外再送一点脚趾搭边的宽容
   *   tipBand   —— 超出能站住的范围这么多以内，算"踩空翻下去"，再多就是直接落空 */
  edgeGrace: 0.03,
  footSupport: 0.25,
  tipBand: 0.30,
};

const PALETTE = [
  0x6C7BF5, 0x4FB3A6, 0xE4739A, 0xF0A93C, 0x7C6FE0,
  0x3FA9F5, 0xE0705C, 0x5EC9A8, 0xC98BEE, 0xEFC84A,
];

/* 落在不同砖上的收益：普通 1、迷你砖风险补偿、脆砖"赶紧跑"奖励、特殊图案、彩蛋 */
const POINTS = { base: 1, mini: 2, fragile: 2, spring: 3, special: 5, peach: 10, holy: 5 };

/* 会给玩家上"状态"的砖（起跳时读取，落上时生效）。
 * 效果都**只属于脚下方块**：spring 的助推只活一跳（落地自动清），
 * slime 的削减离开粘液砖也自动清；freeze 是即时的"冻住 1.5 秒"（时间到自动解），
 * lure 只作用于下一跳。没有任何效果能被带去别的砖。 */
const EFFECT_TRAITS = ['spring', 'slime', 'freeze', 'lure'];

const MINI_SCALE = 0.62;          // 迷你砖相对正常砖的半径比例
/* 幸运方块的图案池。**没有 coin** —— 奶币现在是砖面上的 3D 实体，
 * 再留一个"画着奶币的平面图案"只会让玩家以为那块砖上有币。 */
const SPECIALS = ['note', 'gift', 'star', 'spiral', 'heart', 'diamond', 'clover'];
/* 特殊砖块的玩法提示：1.9 秒 + 底色胶囊。
 * 原来是和普通加分共用 1.1 秒的轻飘字，玩家反馈"特殊砖的提示一闪就没了，
 * 根本来不及看清"—— 这类提示是判断下一步的依据，不是装饰，值得占屏久一点。
 * 后来又嫌 2.4 秒挡视线（胶囊现在已经收得很小，1.9 秒足够看清）。
 * 普通加分飘字保持 1.1 秒，屏幕才不至于糊满字条。 */
const TIP = { ms: 1900, strong: true };

const PEACH_COLOR = 0xDE9A22;     // 黄桃块：琥珀金的砖身（顶面另配奶油色）

/* 公告版本号：想发新公告时把内容填进 NOTICE_ITEMS 并把 version +1，
 * 所有玩家的公告栏会在下次打开游戏时自动弹出来（比对 localStorage 已读标记）。
 *
 * 每一条是结构化的：date 日期 / title 标题 / body 正文 / gift 附赠。
 * gift 是个"附件"：
 *   id    要发放的装饰 id（会写进 jump3d_acc_owned）
 *   name  附件名字（按钮上显示）
 *   once  同一个公告只发一次（靠把公告版本号记进 jump3d_gift_<id> 来判重）
 * 领过一次之后按钮变成"已领取"，重启也还是已领取 —— 判重的键是**公告版本号**，
 * 所以以后发新公告、附件换新，玩家又能领一次新东西。 */
const NOTICE_VERSION = '4';
/* 新的排前面。**赠礼判重键绑定在公告条目上（date|附件id）**，与 NOTICE_VERSION 无关 ——
 * 不然每发一条新公告，旧公告里的生日帽就能再领一次。 */
const NOTICE_ITEMS = [
  {
    date: '2026-10-03',
    title: '紧急通知',
    body: '由于游戏数据（昵称、奶币、分数记录）存储在浏览器缓存中，更新后重进可能会丢失数据，目前正在考虑解决方案。另外，下次更新时间不定。特此通知，请各位玩家理解。',
  },
  {
    date: '2026-10-03',
    title: '版本 v1.1 更新说明',
    body: '1.优化了游戏机制\n2.新增了更多奶蛙\n3.新增了更多砖块\n4.新增了装扮机制\n5.新增奶币和商店',
  },
  {
    date: '2026-10-02',
    title: '奶蛙两岁啦！',
    /* 正文等用户自己写；body 不填就不渲染正文段（模板里 if (it.body) 才出） */
    gift: { id: 'hat_birthday', name: '生日帽' },
  },
];

/* 设置项注册表：**全是"本机偏好"**（跟账号、跟成绩都无关），各存各的键。
 * 面板的行由这张表生成 —— 以后加一项只改这里，UI 与存档自动跟上。
 *   key      程序里用的名字（settingOn / buzz 会读）
 *   store    localStorage 键，值就是 '1' / '0'（range 类型则是那个数字）
 *   def      没存过时的默认值
 *   type     'switch'（默认）或 'range'
 *   min/max/step  range 用
 *   supported() 可选：本设备能不能用这一项。不能用的行会压暗并禁用开关，
 *              但**不隐藏** —— 玩家看得见"有这项、只是这机器没有"，
 *              比忽然少一行好解释。 */
const SETTINGS = [
  {
    key: 'sound', name: '🎵 音效', store: 'jump3d_sfx', def: true,
    note: '跳跃、连击、弹簧、冰冰冰的音效',
  },
  {
    key: 'laugh', name: '😂 奶块大笑', store: 'jump3d_laugh', def: true,
    note: '跳到奶块时放一声大笑',
  },
  {
    key: 'volume', name: '🔊 音效音量', store: 'jump3d_volume', def: 0.7,
    type: 'range', min: 0, max: 1, step: 0.05,
    note: '所有音效的总音量',
  },
  {
    key: 'vibrate', name: '📳 震动', store: 'jump3d_vibrate', def: true,
    note: '完美落地、弹簧、被冻住时轻震一下',
    /* ★ 桌面浏览器里 navigator.vibrate 常常**存在但无效**（调用不报错、也不振），
     *   光看 `typeof navigator.vibrate === 'function'` 会把台式机也判成支持。
     *   再要求"粗指针"（触屏设备）才认为可用。 */
    supported: () => typeof navigator !== 'undefined'
      && typeof navigator.vibrate === 'function'
      && (!window.matchMedia || window.matchMedia('(pointer: coarse)').matches),
    naNote: '本设备不支持震动',
  },
];

/* ------------------------------------------------------------------ */
/* 方块顶面图案                                                        */
/* ------------------------------------------------------------------ */
/* 图案纹理按种类缓存复用：方块来来去去，没必要每块都重画一遍 canvas */
const ICON_CACHE = new Map();

/* 奶币贴图预解码。
 * Image 解码是异步的，第一帧可能还没好 —— 好了之后把缓存里两张奶币贴图都清掉，
 * 后面新生成的（方块图案 / 局内奶币实体）就会用上真图案。 */
const COIN_IMG = new Image();
let coinImgReady = false;
COIN_IMG.onload = () => {
  coinImgReady = true;
  ICON_CACHE.delete('coinFace');
};
COIN_IMG.src = COIN_URI;

/* 奶块顶面的蛙脸，同样要预解码；好了之后清掉缓存里那张合成贴图。
 * 素材缺失（没跑 dev/extract_face.py）时 MILK_FACE_URI 是 null，
 * 奶块就退回"纯奶油顶面"，不至于开天窗。 */
const MILK_IMG = new Image();
let milkImgReady = false;
MILK_IMG.onload = () => {
  milkImgReady = true;
  ICON_CACHE.delete('milkFace');
};
if (MILK_FACE_URI) MILK_IMG.src = MILK_FACE_URI;

/** 奶币图标的内联 HTML（HUD 徽章 / 商店余额 / 结算页共用）。
 *  用 <img> 而不是 emoji：奶币是这只蛙的正面压印，emoji 表达不出来。 */
const coinIco = (size) => `<img class="coinIco" src="${COIN_URI}" alt=""`
  + (size ? ` style="width:${size}px;height:${size}px"` : '') + '>';

function iconTexture(kind) {
  if (ICON_CACHE.has(kind)) return ICON_CACHE.get(kind);
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  ctx.translate(s / 2, s / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (kind === 'note') {
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(-18, 62); ctx.lineTo(-18, -58);
    ctx.moveTo(-18, -58); ctx.lineTo(58, -78);
    ctx.moveTo(58, -78); ctx.lineTo(58, 42);
    ctx.stroke();
    ctx.beginPath(); ctx.ellipse(-42, 66, 26, 20, -0.25, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(34, 46, 26, 20, -0.25, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'gift') {
    ctx.lineWidth = 16;
    ctx.strokeRect(-62, -30, 124, 96);
    ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(0, 66); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-62, -30);
    ctx.bezierCurveTo(-70, -84, -8, -86, 0, -34);
    ctx.bezierCurveTo(8, -86, 70, -84, 62, -30);
    ctx.stroke();
  } else if (kind === 'star') {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const r = i % 2 ? 34 : 80;
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
  } else if (kind === 'spiral') {
    ctx.lineWidth = 13;
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 6; a += 0.08) {
      const r = a * 6.4;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      ctx[a ? 'lineTo' : 'moveTo'](x, y);
    }
    ctx.stroke();
  } else if (kind === 'heart') {
    ctx.beginPath();
    ctx.moveTo(0, 72);
    ctx.bezierCurveTo(-120, -6, -52, -96, 0, -34);
    ctx.bezierCurveTo(52, -96, 120, -6, 0, 72);
    ctx.fill();
  } else if (kind === 'clover') {
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * 40, Math.sin(a) * 40, 40, 30, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.lineWidth = 12;
    ctx.beginPath(); ctx.moveTo(6, 62); ctx.quadraticCurveTo(40, 96, 62, 108); ctx.stroke();
  } else if (kind === 'move') {
    /* 双向箭头：告诉玩家"这块砖会来回跑"（画在 canvas 上默认指向世界 X 轴） */
    const head = (sx) => {
      ctx.beginPath();
      ctx.moveTo(sx * 94, 0);
      ctx.lineTo(sx * 46, -46);
      ctx.lineTo(sx * 46, -18);
      ctx.lineTo(sx * 30, -18);
      ctx.lineTo(sx * 30, 18);
      ctx.lineTo(sx * 46, 18);
      ctx.lineTo(sx * 46, 46);
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillRect(-30, -15, 60, 30);
    head(1); head(-1);
  } else if (kind === 'peach') {
    /* 黄桃：两瓣饱满的果身 + 中间一道缝 + 右上角一片叶（白色画在金色砖面上） */
    ctx.beginPath();
    ctx.moveTo(0, 78);
    ctx.bezierCurveTo(-108, 66, -112, -26, -44, -54);
    ctx.bezierCurveTo(-18, -64, -7, -50, 0, -44);
    ctx.bezierCurveTo(7, -50, 18, -64, 44, -54);
    ctx.bezierCurveTo(112, -26, 108, 66, 0, 78);
    ctx.fill();
    // 中缝：用 destination-out 挖掉一条弧，才有"桃子的沟"
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(0, -40);
    ctx.quadraticCurveTo(19, 12, 0, 72);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    // 叶子 + 梗
    ctx.beginPath();
    ctx.ellipse(52, -74, 36, 18, -0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 11;
    ctx.beginPath(); ctx.moveTo(4, -50); ctx.lineTo(30, -84); ctx.stroke();
  } else if (kind === 'crack') {
    /* 脆砖裂纹：从中心炸开的一把折线 + 几点碎屑。
     * 落上之后靠 opacity 快速闪烁倒计时，这里只管把形状画好。
     * ★ 必须用深色 —— 砖身是浅灰蓝的，白裂纹画上去几乎看不见（实测踩过）。 */
    ctx.strokeStyle = 'rgba(44,52,68,0.90)';
    ctx.fillStyle = 'rgba(44,52,68,0.50)';
    ctx.lineWidth = 13;
    const crack = (...pts) => {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.stroke();
    };
    crack(0, 0, -30, -26, -44, -58, -30, -84);
    crack(0, 0, 34, -18, 66, -34, 84, -66);
    crack(0, 0, 18, 30, 44, 48, 80, 56);
    crack(0, 0, -22, 34, -34, 66, -24, 90);
    crack(0, 0, -58, 6, -82, 18);
    crack(0, 0, 10, -40, 18, -72);
    ctx.fillStyle = 'rgba(44,52,68,0.42)';
    for (const [x, y, r] of [[-60, -30, 7], [52, -52, 6], [64, 30, 7], [-38, 62, 6], [8, -88, 5]]) {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  } else if (kind === 'x2') {
    /* ×2 砖：粗壮的双倍字样。用深棕 —— 砖身是亮金的，白字糊在上面看不清 */
    ctx.fillStyle = 'rgba(86,48,6,0.92)';
    ctx.font = '900 168px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×2', 0, 10);
  } else if (kind === 'slime') {
    /* 粘液块：一大坨正在滴落的黏液 + 几个浮在里面的气泡。
     * 砖身本身就是半透明胶体，图案只负责"一眼认出是黏液"，
     * 所以画得简单、留白多 —— 糊满细节反而读不出形状。 */
    ctx.beginPath();                       // 主液滴：上圆下尖
    ctx.moveTo(0, -96);
    ctx.bezierCurveTo(58, -96, 78, -24, 46, 22);
    ctx.bezierCurveTo(24, 54, 18, 74, 0, 92);
    ctx.bezierCurveTo(-18, 74, -24, 54, -46, 22);
    ctx.bezierCurveTo(-78, -24, -58, -96, 0, -96);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';   // 挖空 = 气泡
    for (const [x, y, r] of [[-20, -30, 15], [22, -6, 11], [-6, 34, 8]]) {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  } else if (kind === 'holy') {
    /* 圣光砖：同心光环 + 光芒，配合砖身的柔光就是"神圣"。
     * ★ 用暖金 —— 砖身是象牙白的，白图案糊在上面根本看不出（实测踩过）。 */
    ctx.strokeStyle = 'rgba(206,158,52,0.94)';
    ctx.fillStyle = 'rgba(206,158,52,0.94)';
    for (const [r, w] of [[78, 11], [50, 9], [24, 12]]) {
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4 + Math.PI / 8;
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 92, Math.sin(a) * 92);
      ctx.lineTo(Math.cos(a) * 108, Math.sin(a) * 108);
      ctx.stroke();
    }
    // 中央一点实心（让光环中心不空）
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'lure') {
    /* 磁铁砖：双极磁铁 + 左侧吸入的短线 */
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(6, 4, 54, Math.PI * 0.82, Math.PI * 2.18);
    ctx.stroke();
    ctx.lineWidth = 0;
    ctx.fillRect(-48, -34, 32, 34);   // 左极靴
    ctx.fillRect(28, -34, 32, 34);    // 右极靴
    ctx.lineWidth = 12;
    for (const [y, w] of [[-52, 30], [0, 46], [52, 30]]) {
      ctx.beginPath(); ctx.moveTo(-108, y); ctx.lineTo(-108 + w, y); ctx.stroke();
    }
  } else {
    ctx.beginPath();
    ctx.moveTo(0, -82); ctx.lineTo(70, 0); ctx.lineTo(0, 82); ctx.lineTo(-70, 0);
    ctx.closePath(); ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.__icon = true;
  ICON_CACHE.set(kind, t);
  return t;
}

/* ------------------------------------------------------------------ */
/* 局内奶币实体（砖面上那枚会转的币）                                    */
/* ------------------------------------------------------------------ */
/**
 * 圆柱端面用的奶币贴图。
 *
 * **不能直接拿 `iconTexture('coin')`**：那张图四周留了透明边（贴砖面时好看），
 * 而圆柱端面是把方形贴图**内切成圆**，边上一圈透明会被 alphaTest 打成洞 ——
 * 直接看穿整枚币。所以这里按圆形裁剪，先用侧圈同色的金铺满整圆，
 * 再把奶币按 1.04 倍铺上去（实测剪影占画布 95%×100%，放大一点点正好铺满）。
 */
function coinFaceTexture() {
  if (ICON_CACHE.has('coinFace')) return ICON_CACHE.get('coinFace');
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const R = s / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(R, R, R - 1, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#D9A22E';            // 露出来的那一圈 = 币的厚边
  ctx.fillRect(0, 0, s, s);
  if (coinImgReady) {
    const k = 1.04;
    const off = s * (1 - k) / 2;
    ctx.drawImage(COIN_IMG, off, off, s * k, s * k);
  } else {
    /* 贴图还没解码完（开局头几帧）：画个同心圆环顶上，反正第一帧看不清 */
    ctx.fillStyle = '#F0C258';
    ctx.beginPath(); ctx.arc(R, R, R * 0.72, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = R * 0.13;
    ctx.beginPath(); ctx.arc(R, R, R * 0.50, 0, Math.PI * 2); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.arc(R, R, R * 0.24, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.__icon = true;
  ICON_CACHE.set('coinFace', t);
  return t;
}

/** 一枚立着的奶币：圆柱体，端面贴奶币、侧圈用暖金金属。
 *  轴转到水平（绕 X 转 90°），所以币是"立"在砖面上的；
 *  父级 group 再绕 Y 自转，看过去就是地铁跑酷那种转着的币。 */
function makeCoinMesh(r) {
  const face = new THREE.MeshStandardMaterial({
    map: coinFaceTexture(), roughness: 0.36, metalness: 0.42,
  });
  /* 侧圈加一点自发光：币转到侧面几乎只剩一条边，不给点亮度就"消失"了，
   * 玩家会以为砖上没东西可捡 */
  const side = new THREE.MeshStandardMaterial({
    color: 0xE0A62C, roughness: 0.26, metalness: 0.80,
    emissive: 0x4A2C05, emissiveIntensity: 1,
  });
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, r * 0.18, 26), [side, face, face]
  );
  m.rotation.x = Math.PI / 2;
  m.castShadow = true;
  return m;
}

/* ------------------------------------------------------------------ */
/* 特殊砖的"真材质"                                                    */
/* ------------------------------------------------------------------ */
/* 脆砖 / 冰冰冰 / 粘液块 / 奶块 都不再用"素色圆柱 + 一张贴纸图案"来表达 ——
 * 那样一眼就看得出是"贴上去的图标"，玩家反馈"不够真实"。
 * 改成给砖体本身做材质：
 *   脆砖   —— 风化水泥：斑驳底 + 竖向水渍 + 直接长在砖上的裂缝
 *   冰冰冰 —— 三块真冰块堆一起：MeshPhysicalMaterial（ior 1.31 / clearcoat / flatShading）
 *   粘液块 —— 真的胶体：半透明果冻壳 + 内芯 + 轻微"果冻抖"
 *   奶块   —— 奶油砖身，顶面整面印经典奶蛙的脸
 * 纹理都是开局算一次的 CanvasTexture，进 ICON_CACHE，同种砖共用一份。 */

/** 脆砖侧面：水泥底 + 颗粒斑驳 + 竖向水渍 + 两道裂缝 */
function fragileSideTexture() {
  if (ICON_CACHE.has('fragileSide')) return ICON_CACHE.get('fragileSide');
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#9AA3AD';
  ctx.fillRect(0, 0, s, s);
  /* 颗粒斑驳：900 个深浅不一的小点。半径小、透明度低 —— 是"水泥质感"，
   * 不是"撒了一把芝麻"，所以别画大。 */
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * s, y = Math.random() * s;
    ctx.fillStyle = Math.random() < 0.5
      ? `rgba(255,255,255,${0.03 + Math.random() * 0.06})`
      : `rgba(40,46,56,${0.03 + Math.random() * 0.07})`;
    ctx.beginPath();
    ctx.arc(x, y, 1 + Math.random() * 4, 0, Math.PI * 2);
    ctx.fill();
  }
  /* 竖向水渍/流痕 —— 水泥墙的招牌特征，加上它立刻"旧"起来 */
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(60,66,78,${0.03 + Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * s, Math.random() * s * 0.5,
      2 + Math.random() * 6, s * (0.35 + Math.random() * 0.6));
  }
  /* 两道横向裂缝（绕柱一圈，看不出起点终点） */
  ctx.strokeStyle = 'rgba(38,44,54,0.70)';
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.4;
  for (const [y0, amp] of [[s * 0.30, 12], [s * 0.72, 9]]) {
    ctx.beginPath();
    ctx.moveTo(-10, y0);
    for (let x = -10; x < s + 10; x += 14 + Math.random() * 16) {
      ctx.lineTo(x, y0 + (Math.random() - 0.5) * amp * 2);
    }
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.__icon = true;
  ICON_CACHE.set('fragileSide', t);
  return t;
}


/** 奶块顶面：整面奶油 + 经典奶蛙的脸（脸从立绘上裁下来，见 dev/extract_face.py） */
function milkFaceTexture() {
  if (ICON_CACHE.has('milkFace')) return ICON_CACHE.get('milkFace');
  const s = 256, R = s / 2;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.beginPath(); ctx.arc(R, R, R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#FFF6E2';                  // 奶油底
  ctx.fillRect(0, 0, s, s);
  if (milkImgReady) {
    /* ★ 脸的缩放是 0.82，不是 1 或更大。
     *   裁出来的脸部素材基本占满正方形画布，而顶面是**圆**：
     *   正方形内切进圆的极限是 1/√2 ≈ 0.71，超过就会被圆边切掉脸颊。
     *   第一版给到 1.10，结果整张顶面只剩一只眼睛 + 一条嘴线（截图一眼就看出来了）。
     *   0.82 正好让整颗头落在圆里、四周还留一圈奶油边，像"印上去"的。 */
    const k = 0.82;
    const off = s * (1 - k) / 2;
    ctx.drawImage(MILK_IMG, off, off, s * k, s * k);
  }
  /* 外圈一道淡奶黄细环：把脸"框"住，看着是印上去的，不是贴歪的 */
  ctx.strokeStyle = 'rgba(214,182,120,0.55)';
  ctx.lineWidth = s * 0.045;
  ctx.beginPath(); ctx.arc(R, R, R * 0.94, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.__icon = true;
  ICON_CACHE.set('milkFace', t);
  return t;
}

/* ------------------------------------------------------------------ */
/* 黄桃块的材质                                                        */
/* ------------------------------------------------------------------ */
/* 之前只是个琥珀金圆柱 + 一张白色的桃子图标，太抽象，看不出是黄桃。
 * 改成真正的"半切黄桃"：桃皮果身 + 金色果肉切面 + 中间的果核 + 一片叶子。
 * 半切是黄桃最经典的形态（罐头里就长这样），而且切面天然平整，
 * 落脚判定和看到的顶面完全对得上，不用为了"能站人"去妥协造型。
 *
 * （补记：这套贴图第一版就照着上面画了，但造型没跟上 —— 生成的四张图里
 *   只引用了 skin 和 leaf，切面图从头到尾没被用过，渲染出来还是"压扁的球 +
 *   一条横缝"，看着像一只刷了糖浆的面包。所以现在 face 才是主角，
 *   skin 只负责下半颗的果皮。） */
let PEACH_TEX = null;

function peachTextures() {
  if (PEACH_TEX) return PEACH_TEX;
  const S = 256;
  const mk = (draw) => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    draw(ctx, S);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* 桃皮：球面 UV 的 v 从顶（1）到底（0），切成半颗之后只剩 v≈0.65 以下那一段
   * 露在外面（切口在 θ=acos(0.44) 处）。所以渐变只按"露得出来的区间"调色，
   * 上面那截纯粹是给贴图补全，看不到。 */
  const skin = mk((ctx, s) => {
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0.00, '#F7C25E');
    g.addColorStop(0.36, '#F8BE55');   // ← 肩部（切口边缘）就在这一带
    g.addColorStop(0.62, '#F2AC3C');
    g.addColorStop(0.82, '#E89B2C');
    g.addColorStop(1.00, '#D2821E');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);

    /* 红晕：黄桃受光那面会泛一片橘红。画在 u≈0.5（也就是中缝转过 90° 的那侧），
     * 免得红晕正好压在中缝上，把沟衬没了。 */
    const blush = ctx.createRadialGradient(s * 0.50, s * 0.66, s * 0.02, s * 0.50, s * 0.66, s * 0.30);
    blush.addColorStop(0, 'rgba(228,102,44,0.30)');
    blush.addColorStop(0.6, 'rgba(230,116,50,0.13)');
    blush.addColorStop(1, 'rgba(230,116,50,0)');
    ctx.fillStyle = blush;
    ctx.fillRect(0, 0, s, s);

    // 桃毛：一层极淡的细点，避免大面积纯色塑料感
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = `rgba(255,252,235,${rnd(0.025, 0.075)})`;
      ctx.beginPath();
      ctx.arc(Math.random() * s, Math.random() * s, rnd(0.8, 2.6), 0, 6.3);
      ctx.fill();
    }
  });

  /* 切面：一整张图，从外到内依次是"果皮内缘的深橙圈 → 果肉放射渐变 + 纤维 →
   * 中心偏心的果核"。
   * 画成一张而不是三层圆盘叠着贴：切面本身就是个圆盘，CircleGeometry 的 UV
   * 刚好把这张正圆的图原样铺上去，一张图既省两个 draw call，也不会在斜视角下
   * 露出层与层之间的缝。 */
  const face = mk((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const c = s / 2;

    /* 果肉：贴着果核那一圈最亮，向外转橙。
     * 第一版中心给到 #FFF4CC，渲染出来整张切面白得像瓷盘，完全没有"这是果肉"
     * 的汁水感。现在整体压深一档、提高彩度。 */
    const g = ctx.createRadialGradient(c, c - s * 0.03, s * 0.04, c, c, s * 0.50);
    g.addColorStop(0.00, '#FFE79B');
    g.addColorStop(0.20, '#FCDC72');
    g.addColorStop(0.48, '#F7C64A');
    g.addColorStop(0.76, '#EEAC2C');
    g.addColorStop(1.00, '#DC9020');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c, c, s * 0.5, 0, 6.3); ctx.fill();

    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, s * 0.5, 0, 6.3); ctx.clip();
    ctx.lineCap = 'round';

    // 放射状纤维：很浅，只做"果肉是丝丝缕缕的"这层质感
    for (let i = 0; i < 170; i++) {
      const a = (i / 170) * Math.PI * 2 + rnd(-0.04, 0.04);
      const r0 = s * rnd(0.09, 0.15);
      const r1 = s * rnd(0.26, 0.50);
      ctx.strokeStyle = `rgba(255,255,255,${rnd(0.05, 0.13)})`;
      ctx.lineWidth = rnd(0.7, 2.2);
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
      ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
      ctx.stroke();
    }

    // 外缘那一圈：果皮正下方的果肉偏红偏深，把圆盘"收"住
    const ring = ctx.createRadialGradient(c, c, s * 0.34, c, c, s * 0.5);
    ring.addColorStop(0, 'rgba(214,124,24,0)');
    ring.addColorStop(1, 'rgba(186,92,18,0.95)');
    ctx.strokeStyle = ring;
    ctx.lineWidth = s * 0.075;
    ctx.beginPath(); ctx.arc(c, c, s * 0.5 - s * 0.0375, 0, 6.3); ctx.stroke();
    ctx.restore();

    // 果核：偏心一点的深褐椭圆，横向几道纵沟，外面一圈浅凹
    ctx.save();
    ctx.translate(c + s * 0.012, c - s * 0.016);
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.112, s * 0.150, 0.10, 0, 6.3);
    const pg = ctx.createRadialGradient(-s * 0.035, -s * 0.045, s * 0.01, 0, 0, s * 0.17);
    pg.addColorStop(0.00, '#CE905A');
    pg.addColorStop(0.45, '#A06433');
    pg.addColorStop(1.00, '#6E3A19');
    ctx.fillStyle = pg;
    ctx.fill();
    ctx.lineWidth = s * 0.014;
    ctx.strokeStyle = 'rgba(158,94,32,0.55)';
    ctx.stroke();
    for (let i = -2; i <= 2; i++) {
      const x = i * s * 0.048;
      ctx.strokeStyle = `rgba(74,34,12,${rnd(0.18, 0.42)})`;
      ctx.lineWidth = rnd(0.9, 2.0);
      ctx.beginPath();
      ctx.moveTo(x - s * 0.008, -s * 0.145);
      ctx.quadraticCurveTo(x + s * 0.022, 0, x - s * 0.008, s * 0.145);
      ctx.stroke();
    }
    ctx.restore();
  });

  /* 叶子：一片嫩绿的桃叶，中间一道主脉 */
  const leaf = mk((ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.translate(s / 2, s / 2);
    const g = ctx.createLinearGradient(-s * 0.45, 0, s * 0.45, 0);
    g.addColorStop(0, '#6AA93A');
    g.addColorStop(0.55, '#8FCB52');
    g.addColorStop(1, '#A9DC6A');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-s * 0.44, 0);
    ctx.bezierCurveTo(-s * 0.20, -s * 0.33, s * 0.17, -s * 0.29, s * 0.44, 0);
    ctx.bezierCurveTo(s * 0.17, s * 0.29, -s * 0.20, s * 0.33, -s * 0.44, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(-s * 0.38, 0); ctx.lineTo(s * 0.38, 0); ctx.stroke();
    ctx.lineWidth = 1.2;
    for (let i = -3; i <= 3; i++) {
      if (!i) continue;
      const x = i * s * 0.10;
      const dir = i < 0 ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + dir * s * 0.055, dir * s * 0.085);
      ctx.stroke();
    }
  });

  PEACH_TEX = { skin, face, leaf };
  return PEACH_TEX;
}

/* ------------------------------------------------------------------ */
/* 平台                                                                */
/* ------------------------------------------------------------------ */
class Platform {
  constructor(game, x, z, opts = {}) {
    this.game = game;                      // 脆砖碎裂时要回调 game.onCrack
    this.kind = opts.kind || 'round';       // round / twoTier / box / oct
    this.trait = opts.trait || null;        // null / moving / spring / peach / fragile / double
    this.special = opts.special || null;
    this.mini = !!opts.mini;
    this.radius = opts.radius;
    this.height = opts.height;
    this.center = new THREE.Vector3(x, 0, z);
    this.base = new THREE.Vector3(x, 0, z);  // 移动砖的"家里"位置
    this.squash = 0;     // 落地冲击的弹簧位移（方块被踩得压一下）
    this.squashV = 0;
    this.spring = 0;     // 弹簧砖踏板的压缩量（独立通道，弹得更慢更久）
    this.springV = 0;
    /* 脆砖状态：crackT 非 null = 倒计时进行中；sinking = 已碎正在下沉 */
    this.crackT = null;
    this.sinking = false;
    this.sinkT = 0;
    this.dead = false;   // 下沉动画放完，由 game 从 platforms 里清走

    /* 落脚面必须和看得见的轮廓一致，否则会出现"看着还在砖上却掉下去" */
    this.halfW = this.kind === 'box' ? this.radius * 1.22 : 0;   // 方块的半边长
    /* 八棱柱用外接圆半径的话，正对棱边的地方会有约 7% 的"悬空砖面"，
     * 所以判定缩到 0.95r —— 落在可见轮廓里就一定站得住 */
    this.hitRadius = this.kind === 'box' ? this.halfW
      : (this.kind === 'oct' ? this.radius * 0.95
        : (this.trait === 'spring' ? this.radius * 0.85 : this.radius));

    /* 移动砖：沿"垂直于跳跃方向"的那条轴来回滑，需要玩家掐时机 */
    this.moveAxis = opts.moveAxis || 'z';
    this.moveAmp = opts.moveAmp || 0;
    this.moveSpeed = opts.moveSpeed || 0;
    this.movePhase = opts.movePhase || 0;
    this.moveOff = Math.sin(this.movePhase) * this.moveAmp;
    this.moveDelta = 0;
    if (this.moveAmp) {
      if (this.moveAxis === 'x') this.center.x = this.base.x + this.moveOff;
      else this.center.z = this.base.z + this.moveOff;
    }

    const group = new THREE.Group();
    group.position.set(this.center.x, 0, this.center.z);
    this.group = group;

    const color = new THREE.Color(opts.color);
    /* 黄桃块：侧面琥珀金、顶面奶油色，一眼能从普通砖里认出来 */
    const top = this.trait === 'peach'
      ? new THREE.Color(0xFFD98A)
      : color.clone().offsetHSL(0, -0.04, 0.11);
    let sideMat = new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.05 });
    let topMat = new THREE.MeshStandardMaterial({ color: top, roughness: 0.55, metalness: 0.05 });
    let iceMat = null;      // 冰冰冰专用：三块冰共用一份物理材质

    /* —— 特殊砖的"真材质"：不走上面那套通用素色 —— */
    if (this.trait === 'fragile') {
      /* 脆砖：侧面贴风化水泥纹理。粗糙度拉到 0.95、零金属度 —— 水泥完全没有高光 */
      sideMat = new THREE.MeshStandardMaterial({
        map: fragileSideTexture(), roughness: 0.95, metalness: 0.0,
      });
      topMat = new THREE.MeshStandardMaterial({
        color: 0xAFA9A0, roughness: 0.95, metalness: 0.0,
      });
    } else if (this.trait === 'freeze') {
      /* 冰冰冰：三块真冰块。
       *
       * 材质必须用 MeshPhysicalMaterial —— "冰"靠的是三件事，Standard 一件都给不了：
       *   roughness 0.05 ：表面几乎光滑，高光收成一个紧凑亮点（不是一片糊光）
       *   ior 1.31       ：这是**冰**的真实折射率。填玻璃的 1.5 会显得太"实"、
       *                    像一块有机玻璃
       *   clearcoat 1    ：再罩一层清漆，模拟冰面那层薄水膜
       * 另加 flatShading：切面硬边。冰是晶体，圆滚滚的才不像。
       *
       * ★ depthWrite 必须关：三块叠在一起时，先画的那块若写深度，后面的块就被
       *   整块剔掉（看着像实心塑料）。关了之后三块互相透出后面的棱，才有"堆"。
       *
       * ★★ 千万别再传 reflectivity：three.js 里 Reflectivity 和 IOR 是**同一个旋钮**
       *   （`set reflectivity(r)` 会反算 `ior = (1+0.4r)/(1-0.4r)`），而 setValues()
       *   按对象字面量顺序赋值 —— 同时给两个的话，写在后面的把前面的整段顶掉。
       *   实测 `reflectivity: 0.58` 把 ior 顶成 1.604，正好退回"玻璃"，白写这段注释。
       *   要冰的折射率就**只写 ior**。 */
      iceMat = new THREE.MeshPhysicalMaterial({
        color: 0xCFEAFB, transparent: true, opacity: 0.60,
        roughness: 0.05, metalness: 0.0, ior: 1.31,
        clearcoat: 1.0, clearcoatRoughness: 0.06,
        emissive: 0x1B4E6E, emissiveIntensity: 0.42,
        depthWrite: false, flatShading: true,
      });
      sideMat = iceMat;
      topMat = iceMat;
    } else if (this.trait === 'slime') {
      /* 粘液块：果冻壳——半透明 + 低粗糙度（高光要"湿"）。
       * depthWrite 关掉，内芯和背后景物才能透出来，才像胶体而不是磨砂塑料。
       * ★ 绿色要**饱和**：第一版给了很浅的绿 + 高自发光，叠上半透明之后
       *   直接被奶白色的背景冲成"透明塑料杯"，完全不像黏液（截图踩过）。 */
      sideMat = new THREE.MeshStandardMaterial({
        color: 0x35C24E, transparent: true, opacity: 0.86,
        roughness: 0.13, metalness: 0.0, depthWrite: false,
        emissive: 0x1B6B28, emissiveIntensity: 0.55,
      });
      topMat = new THREE.MeshStandardMaterial({
        color: 0x5CDA72, transparent: true, opacity: 0.92,
        roughness: 0.09, metalness: 0.0, depthWrite: false,
        emissive: 0x237C31, emissiveIntensity: 0.55,
      });
    } else if (this.trait === 'milk') {
      /* 奶块：奶油砖身。顶面另铺一张整面蛙脸（见下面的顶面图案段） */
      sideMat = new THREE.MeshStandardMaterial({
        color: 0xF0DFBC, roughness: 0.86, metalness: 0.0,
      });
      topMat = new THREE.MeshStandardMaterial({
        color: 0xFFF6E6, roughness: 0.80, metalness: 0.0,
      });
    }
    const h = this.height;

    const makeCyl = (r, hh, y, material, seg = 44, parent) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hh, seg), material);
      m.position.y = y;
      m.castShadow = true;
      m.receiveShadow = true;
      (parent || group).add(m);
      return m;
    };

    if (this.kind === 'box') {
      const w = this.halfW;
      const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(w * 2, h, w * 2), sideMat);
      bodyMesh.position.y = -h / 2;
      bodyMesh.castShadow = true;
      bodyMesh.receiveShadow = true;
      group.add(bodyMesh);

      const capMesh = new THREE.Mesh(new THREE.BoxGeometry(w * 2.04, 0.12, w * 2.04), topMat);
      capMesh.position.y = -0.054;
      capMesh.castShadow = true;
      capMesh.receiveShadow = true;
      group.add(capMesh);
    } else if (this.kind === 'twoTier') {
      makeCyl(this.radius, h * 0.66, -h * 0.33, sideMat, 44);
      makeCyl(this.radius * 0.72, h * 0.40, -h * 0.80, sideMat, 44);
      makeCyl(this.radius * 0.74, 0.10, -0.044, topMat, 44);
    } else if (this.kind === 'oct') {
      /* 八棱柱：切面材质要显棱，用 flatShading */
      const octMat = new THREE.MeshStandardMaterial({
        color, roughness: 0.62, metalness: 0.10, flatShading: true,
      });
      const octTop = new THREE.MeshStandardMaterial({
        color: top, roughness: 0.52, metalness: 0.10, flatShading: true,
      });
      makeCyl(this.radius, h, -h / 2, octMat, 8);
      makeCyl(this.radius * 1.005, 0.12, -0.055, octTop, 8);
    } else if (this.trait === 'spring') {
      /* 弹簧砖：踏板 + 一根露在外面的弹簧柱。
       *
       * 相机是 44° 俯视，凡是"藏在更宽的圆盘下面"的东西都会被挡住 —— 所以弹簧柱
       * 必须做窄（0.34r），踏板也不能太大，线圈才有露出来的机会。第一次做的时候
       * 线圈半径 0.58r、踏板 0.88r，结果整圈弹簧全被踏板盖住，看着就是块扁圆盘。
       *
       * 踏板是落脚面，判定半径跟它一致（0.85r）。 */
      const steel = new THREE.MeshStandardMaterial({
        color: 0xC3D0E6, roughness: 0.26, metalness: 0.82,
      });
      const darkSteel = new THREE.MeshStandardMaterial({
        color: 0x59657F, roughness: 0.5, metalness: 0.5,
      });
      const padMat = new THREE.MeshStandardMaterial({
        color: 0x8FE3C8, roughness: 0.42, metalness: 0.12,
      });
      makeCyl(this.radius * 0.72, 0.12, -1.31, darkSteel, 32);        // 底盘（固定不动）

      /* 弹簧主体（柱 + 线圈 + 踏板）单独成一组，原点落在底盘上。
       * 压缩时整根按 scale.y 变矮：踏板下沉、线圈间距收窄、底盘不动 ——
       * 这才是"弹簧被压实"。一开始想只让踏板平移，结果踏板一抬就脱离了柱顶，
       * 中间露出一道缝。 */
      const rig = new THREE.Group();
      rig.position.y = -1.31;
      group.add(rig);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(this.radius * 0.34, this.radius * 0.34, 1.10, 20), darkSteel
      );
      stem.position.y = 0.61;
      stem.castShadow = true;
      stem.receiveShadow = true;
      rig.add(stem);
      for (let i = 0; i < 4; i++) {
        const coil = new THREE.Mesh(
          new THREE.TorusGeometry(this.radius * 0.46, 0.048, 8, 28), steel
        );
        coil.rotation.x = Math.PI / 2;
        coil.position.y = 0.89 - i * 0.21;
        coil.castShadow = true;
        rig.add(coil);
      }
      const pad = makeCyl(this.radius * 0.85, 0.15, 1.235, padMat, 40);   // 踏板
      rig.add(pad);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(this.radius * 0.79, 0.032, 8, 40),
        new THREE.MeshStandardMaterial({ color: 0xFFF0B8, roughness: 0.35, metalness: 0.25 })
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 1.318;
      rig.add(rim);
      this.springRig = rig;
    } else if (this.trait === 'peach') {
      /* 彩蛋砖 —— 半颗切开的黄桃（罐头里就长这样）。
       *
       * 造型要同时满足两件互相拉扯的事：一眼看出是黄桃，以及"顶上能站人"。
       * 之前走的是"整颗压扁的球 + 顶部指数收敛成平面"，虽然也能站，但渲染出来
       * 就是一只刷了糖浆的面包 —— 圆滚滚的球体加一条横向渐变色带，唯一像桃子的
       * 线索只有旁边那片叶子。
       *
       * 现在直接切：球壳只保留 θ > acos(CUT) 的下半部分，切口天然是一个正圆平面。
       *   · 果身：中缝收成一条纵向浅沟（靠近切口处收到 0，免得把切口捏成椭圆）；
       *     肚腹比肩部略鼓，侧影才不是一颗呆球
       *   · 切面：单独铺一张果肉 + 果核的圆盘，平整得可以直接站人
       *   · 纵向拉长到铺满砖高，横向不动
       *
       * 切口半径必须和落脚判定一致，否则会出现"站在半空"或者"明明在砖上却掉
       * 下去"。上面这些变形之后切口未必还是正圆（中缝会把前后各收一点），
       * 所以半径是扫一遍顶点量出来的，不是按 sqrt(1-CUT²) 估的。 */
      const T = peachTextures();
      const R = this.radius;
      const CUT = 0.44;                    // 切口高度（球半径的比例）
      /* 竖向拉伸系数。切掉上半只剩 (1+CUT)·R 高的球缺，比方块的 1.65 矮一大截，
       * 整颗果会明显浮在地面之上。横向不动、只把纵向拉到正好铺满砖高，
       * 得到的是一颗略呈长圆的桃子 —— 比"悬空"正常得多。 */
      const k = this.height / (R * (1 + CUT));
      const thetaCut = Math.acos(CUT);
      const geo = new THREE.SphereGeometry(
        R, 64, 40, 0, Math.PI * 2, thetaCut, Math.PI - thetaCut);
      const pos = geo.attributes.position;
      const v = new THREE.Vector3();
      let maxY = -Infinity;
      let rimR = 0;
      const rimY = CUT * R * k;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const ty = v.y / R;                // -1（底极点） … CUT（切口）
        const ny = v.y * k;
        // 中缝：沿 x≈0 的一条纵向浅沟；靠近切口处收敛到 0
        const seam = Math.max(0, 1 - Math.pow(Math.max(0, ty) / 0.40, 2));
        const groove = Math.exp(-Math.pow(v.x / (R * 0.32), 2)) * seam;
        // 肚腹外鼓、肩部收窄 —— 幅度刻意压得小，免得整颗果比砖还宽
        const belly = 1 + 0.06 * Math.max(0, 1 - Math.pow((ty + 0.30) / 1.15, 2))
          * (1 - Math.max(0, ty) * 1.9);
        const s = belly * (1 - groove * 0.10);
        pos.setXYZ(i, v.x * s, ny, v.z * s);
        if (ny > maxY) maxY = ny;
        if (ny >= rimY - 1e-4) rimR = Math.max(rimR, Math.hypot(v.x * s, v.z * s));
      }
      geo.computeVertexNormals();

      const peach = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: T.skin, roughness: 0.64, metalness: 0.02,
      }));
      peach.position.y = -maxY;         // 让切口正好落在 y=0（落脚面）
      peach.castShadow = true;
      peach.receiveShadow = true;
      group.add(peach);

      /* 切面圆盘：略大千分之一、抬高 1.5mm，正好盖住球壳的开口，
       * 不会在斜视角下露出一条缝，也不会从侧面鼓出来。 */
      const faceMesh = new THREE.Mesh(
        new THREE.CircleGeometry(rimR * 1.001, 64),
        new THREE.MeshStandardMaterial({
          map: T.face, roughness: 0.48, metalness: 0.0, toneMapped: true,
        })
      );
      faceMesh.rotation.x = -Math.PI / 2;
      faceMesh.position.y = 0.0015;
      faceMesh.receiveShadow = true;
      group.add(faceMesh);

      /* 落脚面就是这张切面 —— 判定跟它对齐，不是跟整颗果的半径对齐 */
      this.hitRadius = rimR;

      /* 叶子：平摊在切面上，从果核旁边斜着探出去。
       * 之前是浮在果顶边缘外面当"顶面图案"，俯视看着像贴纸；现在放在切面上，
       * 既盖住圆盘一点边、又不会挡到果核。 */
      const leaf = new THREE.Mesh(
        new THREE.PlaneGeometry(rimR * 1.05, rimR * 0.48),
        new THREE.MeshStandardMaterial({
          map: T.leaf, transparent: true, roughness: 0.62, metalness: 0.0,
          alphaTest: 0.35, side: THREE.DoubleSide,
        })
      );
      leaf.rotation.x = -Math.PI / 2;
      leaf.rotation.z = 0.42;
      leaf.position.set(rimR * 0.30, 0.0045, -rimR * 0.56);
      leaf.renderOrder = 2;
      group.add(leaf);
    } else if (this.trait === 'freeze') {
      /* 冰冰冰：三块大小不一的冰块堆成一小堆。
       *
       * ★ 摆放必须让**最高那块的顶面正好落在 y=0** —— 所有砖的落脚面都是 y=0，
       *   冰块堆的顶面要是矮一截，人就悬在冰上方飘着（踩着空）。
       *   所以是"从顶往下定"：先定最上面那块（半边长 t，块心 y=-t），
       *   下面两块再往上顶住它（半边长 b，块心 y=-h+b），三个数锁死关系
       *   2b + 2t = h，任意砖高都能自动铺满。
       *
       * ★ 三块尺寸/角度刻意都不一样，而且底部两块彼此错开一点 ——
       *   三块一样大、摆正对齐的话，从 44° 俯视看下去就只是一片蓝色方块，
       *   完全没有"堆"的体积感。
       *
       * ★ 冰块不投影：半透明的东西投一团实心黑影子最假（跟粘液壳同样的道理）。 */
      const hh = this.height;
      const t = hh * 0.23;             // 顶上那块的半边长
      const b = hh * 0.5 - t;          // 底下两块的半边长（= 0.27h）
      const R = this.radius;
      const rig = new THREE.Group();   // 原点 = 砖底，位置用"离地多高"表达更直观
      group.add(rig);
      const put = (half, x, y, z, rx, ry, rz) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(half * 2, half * 2, half * 2), iceMat);
        m.position.set(x, y, z);
        m.rotation.set(rx, ry, rz);
        m.castShadow = false;
        m.receiveShadow = false;
        rig.add(m);
        return m;
      };
      put(b, -b * 0.86, -hh + b, hh * 0.05, 0.05, 0.32, 0.03);
      put(b, b * 0.86, -hh + b, -hh * 0.06, -0.04, -0.46, 0.06);
      put(t, 0.02 * R, -t, 0.0, 0.34, 0.84, -0.22);
    } else if (this.trait === 'slime') {
      /* 粘液块：更深的"黏液核" + 半透明果冻壳，整组挂在一个 rig 上，
       * 方便做"果冻被踩/自己呼吸"的那种轻微变形（见 update 里的 jelly 段）。 */
      const coreMat = new THREE.MeshStandardMaterial({
        color: 0x3FA650, roughness: 0.35, metalness: 0.0,
        emissive: 0x1B4A22, emissiveIntensity: 0.9,
      });
      const rig = new THREE.Group();
      group.add(rig);
      const core = new THREE.Mesh(
        new THREE.CylinderGeometry(this.radius * 0.60, this.radius * 0.70, h * 0.74, 32), coreMat);
      core.position.y = -h * 0.5 + 0.12;
      core.castShadow = true;
      rig.add(core);
      const shell = makeCyl(this.radius * 1.03, h * 0.99, -h * 0.5 + 0.02, sideMat, 44, rig);
      shell.castShadow = false;
      makeCyl(this.radius * 1.035, 0.10, -0.046, topMat, 44, rig);
      this.jelly = rig;
      this.jellyPhase = Math.random() * Math.PI * 2;
    } else {
      makeCyl(this.radius, h, -h / 2, sideMat, 48);
      makeCyl(this.radius * 1.005, 0.11, -0.049, topMat, 48);
    }

    // 顶面图案
    if (this.special) {
      const iconMat = new THREE.MeshBasicMaterial({
        map: iconTexture(this.special), transparent: true, depthWrite: false,
      });
      const icon = new THREE.Mesh(new THREE.CircleGeometry(this.radius * 0.72, 40), iconMat);
      icon.rotation.x = -Math.PI / 2;
      icon.position.y = 0.012;
      icon.renderOrder = 2;
      group.add(icon);
      this.icon = icon;
      this.iconSpin = 0.5;
    } else if (this.trait === 'moving') {
      const iconMat = new THREE.MeshBasicMaterial({
        map: iconTexture('move'), transparent: true, depthWrite: false, opacity: 0.95,
      });
      const icon = new THREE.Mesh(new THREE.CircleGeometry(this.radius * 0.62, 40), iconMat);
      icon.rotation.x = -Math.PI / 2;
      // 箭头在 canvas 上指向世界 X 轴；改为沿 Z 轴滑动时整体转 90°
      icon.rotation.z = this.moveAxis === 'x' ? 0 : Math.PI / 2;
      icon.position.y = 0.012;
      icon.renderOrder = 2;
      group.add(icon);
      this.icon = icon;
      this.iconSpin = 0;   // 箭头不能转，一转就看不出方向了
    } else if (this.trait === 'fragile') {
      /* 脆砖裂纹：铺满整个顶面（原来只占中间 66%，四周留出一圈"完好的边"，
       * 看着像贴了张裂纹贴纸）。现在是"整块砖都裂了"，落上后 opacity 闪烁倒计时。 */
      const iconMat = new THREE.MeshBasicMaterial({
        map: iconTexture('crack'), transparent: true, depthWrite: false,
      });
      const icon = new THREE.Mesh(new THREE.CircleGeometry(this.radius * 0.94, 48), iconMat);
      icon.rotation.x = -Math.PI / 2;
      icon.position.y = 0.012;
      icon.renderOrder = 2;
      group.add(icon);
      this.icon = icon;
      this.iconSpin = 0;   // 裂纹不能转，一转就不像"裂了"
    } else if (this.trait === 'double') {
      /* ×2 砖：金灿灿的双倍字样慢慢转，远处一眼认出来 */
      const iconMat = new THREE.MeshBasicMaterial({
        map: iconTexture('x2'), transparent: true, depthWrite: false,
      });
      const icon = new THREE.Mesh(new THREE.CircleGeometry(this.radius * 0.62, 40), iconMat);
      icon.rotation.x = -Math.PI / 2;
      icon.position.y = 0.012;
      icon.renderOrder = 2;
      group.add(icon);
      this.icon = icon;
      this.iconSpin = 0.5;
    } else if (this.trait === 'milk') {
      /* 奶块：顶面整面铺经典奶蛙的脸。同样单独铺圆片，不贴圆柱。 */
      const iconMat = new THREE.MeshBasicMaterial({
        map: milkFaceTexture(), transparent: true, depthWrite: false,
      });
      const icon = new THREE.Mesh(new THREE.CircleGeometry(this.radius * 0.98, 56), iconMat);
      icon.rotation.x = -Math.PI / 2;
      icon.position.y = 0.013;
      icon.renderOrder = 2;
      group.add(icon);
      this.icon = icon;
      this.iconSpin = 0;
    } else if (this.trait === 'slime' || this.trait === 'holy' || this.trait === 'lure') {
      /* 效果砖共用一套图案装配，只是换素材。
       * 磁铁不转（有方向含义），圣光慢慢转，粘液不转（滴落是有上下之分的） */
      const iconMat = new THREE.MeshBasicMaterial({
        map: iconTexture(this.trait), transparent: true, depthWrite: false, opacity: 0.95,
      });
      const icon = new THREE.Mesh(new THREE.CircleGeometry(this.radius * 0.66, 40), iconMat);
      icon.rotation.x = -Math.PI / 2;
      icon.position.y = 0.012;
      icon.renderOrder = 2;
      group.add(icon);
      this.icon = icon;
      this.iconSpin = (this.trait === 'holy') ? 0.35 : 0;
      if (this.trait === 'holy') {
        /* 圣光砖外加一圈柔和金环（写法和黄桃一样，只是色更白） */
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(this.hitRadius * 0.90, this.hitRadius * 1.0, 64),
          new THREE.MeshBasicMaterial({
            color: 0xFFF6D0, transparent: true, opacity: 0.22,
            side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
          })
        );
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.0035;
        halo.renderOrder = 1;
        group.add(halo);
        this.halo = halo;
      }
    } else if (this.trait === 'peach') {
      /* 顶面不用再贴图标了 —— 整块砖已经是一颗切开的黄桃 */
      /* 彩蛋砖的专属光环。
       * 之前套在 radius*1.18~1.38 上，比整颗果还大一圈：它是平放在 y=0.02 的
       * 一个悬空圆环，而果身在那里早就低于这个高度了，于是变成一圈浮在半空的
       * 塑料圈。现在收到切面里侧（hitRadius 就是切面半径），贴着果肉发光。 */
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(this.hitRadius * 0.88, this.hitRadius * 0.99, 64),
        new THREE.MeshBasicMaterial({
          color: 0xFFC24D, transparent: true, opacity: 0.22,
          side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        })
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.0035;
      halo.renderOrder = 1;
      group.add(halo);
      this.halo = halo;
    }

    // 顶面高光圈（黄桃是圆滚滚的果顶，这个悬空的圈会浮在斜坡上方，跳过）
    if (this.trait !== 'peach') {
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(this.radius * 0.86, this.radius * 0.98, 44), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.008;
      group.add(ring);
    }

    /* 砖面上的奶币实体（随机出现在某几块砖上，见 spawnNext 的抽签）。
     * 挂在 group 上而不是场景里：移动砖带着它一起走、砖被踩压扁时它也跟一下，
     * 天然同步，不用额外写一套跟随逻辑。 */
    this.coin = null;
    this.coinTaken = false;
    this.coinPhase = 0;
    if (opts.coin) {
      const cg = new THREE.Group();
      cg.position.y = CFG.coinY;
      cg.add(makeCoinMesh(CFG.coinR));
      group.add(cg);
      this.coin = cg;
      // 相位错开：几枚币同时在画面里时，不会整齐划一地一起上下动
      this.coinPhase = Math.random() * Math.PI * 2;
    }

    game.scene.add(group);
  }

  /**
   * 落点相对"看得见的轮廓"的越过量：
   *   ≤ 0 —— 还在砖面上（绝对值 = 离边缘还有多远）
   *   > 0 —— 已经出去了多少
   * 具体几何在 hit.js（纯函数，另配了单测）
   */
  edgeOver(x, z) {
    return edgeOver(this.kind, this.hitRadius, this.halfW, this.center.x, this.center.z, x, z);
  }

  distToCenter(x, z) {
    return Math.hypot(x - this.center.x, z - this.center.z);
  }

  /** 被踩了一下的弹簧：方块纵向压一下再弹回来。只动 scale.y，落脚面不会变 */
  kick(s) {
    const k = clamp(s, 0, 1.4);
    this.squash = Math.max(this.squash, k);
    this.squashV = -1.8 * k;
  }

  /** 脆砖开始倒计时（落上那一刻调用；只 arm 一次，重复落不重置 —— 给玩家的
   *  时间只会更紧不会更松，也让"跳走再跳回来拖时间"没有意义） */
  armCrack() {
    if (this.trait !== 'fragile' || this.crackT != null) return;
    this.crackT = CFG.crackTime;
  }

  /** 圣光净化：脆砖变回普通砖。
   *  倒计时归零、裂纹图标撤掉、颜色回暖 —— 玩家看到的就是"这块砖被救回来了"。 */
  purify() {
    if (this.trait !== 'fragile') return false;
    this.trait = null;
    this.crackT = null;
    this.sinking = false;
    if (this.icon) {
      this.group.remove(this.icon);
      this.icon.geometry.dispose();
      this.icon.material.dispose();
      this.icon = null;
    }
    return true;
  }

  /** 碎裂：整个人/砖的处理交给 game.onCrack，砖本体在这里开始下沉消失 */
  sink() {
    if (this.sinking) return;
    this.sinking = true;
    this.sinkT = 0;
  }

  /** 每帧：移动砖更新实时位置，顺便把弹簧回弹推进一帧 */
  update(dt, time) {
    this.moveDelta = 0;
    if (this.moveAmp) {
      const off = Math.sin(time * this.moveSpeed + this.movePhase) * this.moveAmp;
      this.moveDelta = off - this.moveOff;
      this.moveOff = off;
      if (this.moveAxis === 'x') {
        this.center.x = this.base.x + off;
        this.group.position.x = this.center.x;
      } else {
        this.center.z = this.base.z + off;
        this.group.position.z = this.center.z;
      }
    }
    /* 脆砖倒计时：落上那一刻 arm，每帧在这里扣。
     * 前半程慢呼吸预告，最后半秒狂闪催人跑。 */
    if (this.crackT != null) {
      this.crackT -= dt;
      if (this.icon) {
        const blink = this.crackT < 0.5
          ? (Math.sin(time * 36) * 0.5 + 0.5)
          : (0.55 + 0.45 * Math.sin(time * 8));
        this.icon.material.opacity = 0.30 + 0.70 * blink;
      }
      if (this.crackT <= 0) {
        this.crackT = null;
        if (this.game && this.game.onCrack) this.game.onCrack(this);
      }
    }
    /* 碎裂下沉：快速掉出画面，然后由 game 把它从 platforms 里清走 */
    if (this.sinking) {
      this.sinkT += dt;
      this.group.position.y = -this.sinkT * 7.5;
      this.group.scale.setScalar(Math.max(0.05, 1 - this.sinkT * 1.6));
      if (this.sinkT > 0.55) this.dead = true;
    }
    if (this.halo) {
      // 只做很轻的呼吸。之前 0.40±0.22 太亮，那圈加色金环把切面压成了"瓷盘边"
      const pulse = 0.15 + 0.09 * Math.sin(time * 2.6);
      this.halo.material.opacity = pulse;
      const s = 1 + 0.05 * Math.sin(time * 2.6);
      this.halo.scale.setScalar(s);
    }
    /* 奶币：绕竖轴自转 + 很轻的上下浮动（浮动让它在静止画面里也"活着"，
     * 玩家一眼能认出这是个能捡的东西，而不是贴在砖上的图案） */
    if (this.coin && !this.coinTaken) {
      this.coin.rotation.y = time * CFG.coinSpin;
      this.coin.position.y = CFG.coinY
        + Math.sin(time * 2.4 + this.coinPhase) * CFG.coinBob;
    }
    /* 粘液块：果冻似的轻微呼吸。
     * 只改内层 rig 的 scale —— 外层 group.scale.y 是"落地压扁"用的，
     * 两条通道各管各的，互相覆盖就会出现"落地之后不弹回来"。
     * 另外要补一个 position 偏移把**底部钉住**：rig 的原点在砖顶，
     * 直接缩放的话整块砖会朝着顶面收缩、底边跟着抬起来，像被剪短了一截。 */
    if (this.jelly) {
      const w = Math.sin(time * 2.1 + this.jellyPhase) * 0.035;
      const sy = 1 - w;
      this.jelly.scale.set(1 + w * 0.55, sy, 1 + w * 0.55);
      this.jelly.position.y = -this.height * (1 - sy);
    }
    this.updateSquash(dt);
  }

  /** 弹簧砖被踩：踏板压下去再弹回来。低频欠阻尼 → 连弹好几下，看得清 */
  trampoline() {
    this.spring = Math.max(this.spring, 1);
    this.springV = -4.4;
  }

  updateSquash(dt) {
    /* 弹簧砖：整根弹簧的伸缩走独立通道。刚度/阻尼和角色那条蹦床通道一致
     * （100 / 3.6），相位对得上 —— 看起来才是"踩在弹簧上被弹出去"，
     * 而不是两块各弹各的 */
    if (this.springRig) {
      this.springV += (-100 * this.spring - 3.6 * this.springV) * dt;
      this.spring += this.springV * dt;
      if (Math.abs(this.spring) < 0.002 && Math.abs(this.springV) < 0.02) {
        this.spring = 0; this.springV = 0;
      }
      this.springRig.scale.y = 1 - this.spring * 0.14;
    }

    if (this.squash === 0 && this.squashV === 0) return;
    this.squashV += (-520 * this.squash - 17 * this.squashV) * dt;
    this.squash += this.squashV * dt;
    if (Math.abs(this.squash) < 0.001 && Math.abs(this.squashV) < 0.01) {
      this.squash = 0; this.squashV = 0;
      this.group.scale.y = 1;
      return;
    }
    this.group.scale.y = 1 - this.squash * 0.16;
  }

  get perfectTol() { return perfectTol(this.hitRadius); }

  dispose(game) {
    game.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      /* material 可能是**数组** —— 奶币那个圆柱就是 [侧圈, 端面, 端面] 三份。
       * 直接 `o.material.dispose()` 会抛 "is not a function"，把调用方
       * （resetWorld → beginRun）整个打断，表现为"点开始没反应、状态卡在 start"。
       * 图案贴图在 ICON_CACHE 里共享，谁都不能单独 dispose，否则别的砖会变成空白。 */
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) m.dispose();
    });
  }
}

/* ------------------------------------------------------------------ */
/* 主游戏                                                              */
/* ------------------------------------------------------------------ */
class Game {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.dom = {
      score: document.getElementById('score'),
      best: document.getElementById('best'),
      bar: document.getElementById('barWrap'),
      barFill: document.getElementById('barFill'),
      start: document.getElementById('startScreen'),
      over: document.getElementById('overScreen'),
      overScore: document.getElementById('overScore'),
      overBest: document.getElementById('overBest'),
      overPeach: document.getElementById('overPeach'),
      overTitle: document.getElementById('overTitle'),
      combo: document.getElementById('comboTag'),
      hint: document.getElementById('hint'),
      popLayer: document.getElementById('popLayer'),
      mute: document.getElementById('muteBtn'),
      charBtn: document.getElementById('charBtn'),
      charPanel: document.getElementById('charPanel'),
      charGrid: document.getElementById('charGrid'),
      charClose: document.getElementById('charClose'),
      bgBtn: document.getElementById('bgBtn'),
      bgPanel: document.getElementById('bgPanel'),
      bgGrid: document.getElementById('bgGrid'),
      bgClose: document.getElementById('bgClose'),

      overRank: document.getElementById('overRank'),
      userTag: document.getElementById('userTag'),
      accountBtn: document.getElementById('accountBtn'),
      accountPanel: document.getElementById('accountPanel'),
      accountClose: document.getElementById('accountClose'),
      acctWho: document.getElementById('acctWho'),
      acctMsg: document.getElementById('acctMsg'),
      nickInput: document.getElementById('nickInput'),
      nickGo: document.getElementById('nickGo'),
      nickClear: document.getElementById('nickClear'),
      rankBtn: document.getElementById('rankBtn'),
      rankPanel: document.getElementById('rankPanel'),
      rankClose: document.getElementById('rankClose'),
      rankMe: document.getElementById('rankMe'),
      rankList: document.getElementById('rankList'),
      pauseBtn: document.getElementById('pauseBtn'),
      buffTag: document.getElementById('buffTag'),
      pause: document.getElementById('pausePanel'),
      pauseScore: document.getElementById('pauseScore'),
      pauseBest: document.getElementById('pauseBest'),
      titleBtn: document.getElementById('titleBtn'),

      /* —— 货币 / 商店 / 公告 —— */
      coinTag: document.getElementById('coinTag'),
      shopBtn: document.getElementById('shopBtn'),
      shopPanel: document.getElementById('shopPanel'),
      shopClose: document.getElementById('shopClose'),
      shopCoins: document.getElementById('shopCoins'),
      shopShelf: document.getElementById('shopShelf'),
      noticeBtn: document.getElementById('noticeBtn'),
      noticeDot: document.getElementById('noticeDot'),
      noticePanel: document.getElementById('noticePanel'),
      noticeClose: document.getElementById('noticeClose'),
      supportBtn: document.getElementById('supportBtn'),
      supportPanel: document.getElementById('supportPanel'),
      supportClose: document.getElementById('supportClose'),
      supportBody: document.getElementById('supportBody'),
      settingsBtn: document.getElementById('settingsBtn'),
      settingsPanel: document.getElementById('settingsPanel'),
      settingsClose: document.getElementById('settingsClose'),
      settingsList: document.getElementById('settingsList'),
      overCoin: document.getElementById('overCoin'),
      runCoinTag: document.getElementById('runCoinTag'),
      /* —— 装饰 —— */
      accBar: document.getElementById('accBar'),
    };

    this.clock = new THREE.Clock();
    /* 调试参数有三种来源，优先级从高到低：
     *   window.__DBG_Q —— 无头截图时由 dev/shot.sh 注入
     *   ?a=1&b=2
     *   #a=1&b=2
     * 之所以要 __DBG_Q：file:// 路径只要带上 ? 或 #，Edge 的 --screenshot 就会
     * 静默失败（退出码 0、日志空白、就是不落盘），所以截图一律走注入。 */
    const qs = window.__DBG_Q || location.search || location.hash.replace(/^#/, '');
    this.q = new URLSearchParams(qs);
    this.fixedGap = this.q.has('gap') ? Number(this.q.get('gap')) : null;
    // 调试：固定砖的类型/半径/特色，用来跑"落脚边界"的可复现用例
    this.forceKind = this.q.get('kind') || null;
    this.forceRadius = this.q.has('r') ? Number(this.q.get('r')) : null;
    this.forceTrait = this.q.get('trait') || null;
    /* ?coins=0 / ?coins=1 强制"每块砖有没有奶币"，跑拾取相关的可复现用例用 */
    this.forceCoin = this.q.has('coins') ? Number(this.q.get('coins')) > 0 : null;
    this.plainMode = this.q.has('plain');   // 只用基础砖：跑稳定的回归用例
    /* 角色：默认经典奶蛙，选择结果持久化，下次打开还是上次那只 */
    this.charKey = localStorage.getItem('jump3d_char') || DEFAULT_CHAR;
    /* 背景：默认奶油黄 */
    this.bgKey = localStorage.getItem('jump3d_bg') || DEFAULT_BG;
    /* 昵称：存在本机，填了才会把成绩传到全服榜；没填就是纯本地玩。
     * 编号（#1001 起）是服务端发的，开机异步问一次，到了再刷 UI。 */
    loadProfile();
    fetchPid().then(() => this.refreshNickUI()).catch(() => { /* 静默 */ });
    this.rankBusy = false;
    this.state = 'start';
    this.pausedFrom = null;   // 暂停前的状态，继续时接回去
    this.score = 0;
    this.steps = 0;
    this.peaches = 0;
    this.best = Number(localStorage.getItem('jump3d_best') || 0);
    /* 奶币：本机持久化。runCoins 是"这一局攒的"，结算页展示用 */
    this.coins = Number(localStorage.getItem('jump3d_coins') || 0);
    if (!Number.isFinite(this.coins) || this.coins < 0) this.coins = 0;
    this.runCoins = 0;
    /* 装饰：拥有清单 + 各槽位装备状态。必须在 refreshCoinUI 之前读 ——
     * 刷新余额时会顺带重绘商店货架，那时要用到 accOwned。 */
    this.loadAcc();
    /* 角色：同样是"本机拥有清单"。默认角色（经典奶蛙）人人都有，
     * 商店里的角色要买了才能选。 */
    this.loadChars();
    /* 公告赠礼的领取记录 */
    this.loadGifts();
    /* 设置（音效 / 大笑 / 音量 / 震动）：本机偏好，同样是页面级的状态。
     * 必须在 setup 系列之前读 —— 建设置面板的行时要拿现值。
     * applySettingsToSound 已经在这里把 muted 与音量推给 audio 了。 */
    this.loadSettings();
    /* 长音效提前解码好：mp3 解码要几十毫秒，等玩家真踩到那块砖再解
     * 就来不及了（第一声一定哑）。laugh=奶块的大笑，ding=冰冰冰的"叮叮叮"。 */
    sound.prepareClip('laugh', LAUGH_URI);
    sound.prepareClip('ding', DING_URI);
    /* 常驻状态：弹簧助推（跳更远，只活一跳）/ 粘液层数（跳更短，离开粘液砖即清）。
     * 冻结是**即时**效果，不叠层 —— 只有一个倒计时 frozenT（秒） */
    this.boostLv = 0;
    this.slimeLv = 0;
    this.frozenT = 0;
    this.combo = 0;
    this.power = 0;
    this.platforms = [];
    this.fx = [];
    this.lastDir = null;
    this.dir = new THREE.Vector3(0, 0, -1);
    this._tmpV = new THREE.Vector3();

    this.jump = { t: 0, dur: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), h: 1, tip: 0 };
    this.fall = { vy: 0, spin: new THREE.Vector3(), delay: 0, mode: null, spinZ: 0, tipAmount: 0, tipDur: 0.26 };

    this.camLook = new THREE.Vector3(0, CFG.camLookY, 0);
    this.camLookTarget = new THREE.Vector3(0, CFG.camLookY, 0);
    this.camDistScale = 1;
    this.camDip = 0;     // 落地时镜头轻微下沉
    this.camKick = 0;    // 落地时镜头轻微横震

    this.setupRenderer();
    this.setupScene();
    this.setupInput();
    this.setupCharPanel();
    this.setupBgPanel();
    this.setupAccountPanel();
    this.setupShopPanel();
    this.setupNoticePanel();
    this.setupSupportPanel();
    this.setupSettingsPanel();
    this.watchPanels();
    this.applyBg(this.bgKey);     // 会顺带把雾色也对齐，必须在 setupScene 之后
    this.refreshNickUI();
    this.refreshCoinUI();
    this.resetWorld();
    this.dom.best.textContent = this.best;

    /* 渲染循环必须自己兜异常：vendor 的 WebGLAnimation 是「先调回调、
     * 后调度下一帧」—— tick 里只要抛一次异常，requestAnimationFrame 就再
     * 也不会被调，画面从此定格，玩家看到的就是"有概率卡住"。
     * 包一层之后循环永不死亡；?dbg 时把错误打到状态栏方便定位。 */
    this.renderer.setAnimationLoop(() => {
      try {
        this.tick();
      } catch (e) {
        /* warn 而不是 error：这是"已经兜住的异常"，不该被运行时报错统计
         * 当成未捕获异常（探针会因此误判），但排查时仍然看得到 */
        console.warn('[tick] 已兜住，渲染循环继续：', e && e.message);
        if (this.dbg) this.dbg.textContent = 'TICK ERROR: ' + (e && e.message);
      }
    });
    this.debugHooks();
    document.body.classList.add('intro');
    /* 公告：首次打开或公告版本更新时自动弹出（内部有 localStorage 比对） */
    this.maybeShowNotice();
  }

  /** 调试钩子：?auto 直接开局，?charge=0.55 蓄力到指定值起跳，?gap=2.8 固定间距，?dbg 状态 */
  debugHooks() {
    const q = this.q;
    if (q.has('dbg')) {
      this.dbg = document.createElement('div');
      this.dbg.id = 'dbg';
      this.dbg.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99;font:13px monospace;color:#9cff9c;background:rgba(0,0,0,.75);padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre';
      document.body.appendChild(this.dbg);
    }
    if (q.has('auto')) setTimeout(() => {
      this.beginRun();
      // 无头截图环境下 CSS 过渡不可靠，开局遮罩直接摘下
      if (this.dom.start) this.dom.start.style.display = 'none';
    }, 60);
    // ?char=<key> 换角色、?panel 直接掀开选择面板：两者都是为了无头截图能验证到
    if (q.has('char')) {
      this.charKey = q.get('char');
      this.character.setChar(this.charKey);
      this.buildCharGrid();
    }
    if (q.has('panel')) setTimeout(() => this.openCharPanel(), 120);
    /* ?acc=<id> 直接戴上某件装饰（无头截图/探针用）。
     * 顺带把它标成已拥有 —— 截图关心的是"戴上去长什么样"，
     * 不该被"还没买"挡住。?buyacc=<id> 则相反：只标记拥有，不装备。 */
    if (q.has('acc')) {
      const id = q.get('acc');
      if (accDef(id)) {
        this.accOwned.add(id);
        this.accEquip.head = id;
        this.saveAcc();
        setTimeout(() => { this.applyAcc(); this.refreshAccRows(); }, 80);
      }
    }
    if (q.has('buyacc')) {
      const id = q.get('buyacc');
      if (accDef(id)) { this.accOwned.add(id); this.saveAcc(); }
    }
    // ?bg=<key> 换背景、?bgpanel 直接掀开背景面板（都是为了无头截图能验到）
    if (q.has('bg')) {
      this.applyBg(q.get('bg'));
      this.buildBgGrid();
    }
    if (q.has('bgpanel')) setTimeout(() => this.openBgPanel(), 120);
    /* ?nick=名字 走一遍「填昵称 → 保存」的真实流程，纯粹为了无头截图和线上验证
     * 能一次性进到「有昵称」的状态（结果落在本机 localStorage）。
     * 必须排在 ?rank 前面：同一个延迟下按注册顺序执行，先有昵称，榜单里
     * 才认得出「我」是哪一行。 */
    if (q.has('nick')) {
      const n = String(q.get('nick'));
      setTimeout(() => {
        this.dom.nickInput.value = n;
        this.saveNick();
      }, 120);
    }
    // ?account 掀开昵称面板、?rank 掀开排行榜、?shop 商店、?notice 公告
    if (q.has('account')) setTimeout(() => this.openAccountPanel(), 160);
    if (q.has('rank')) setTimeout(() => this.openRankPanel(), 160);
    if (q.has('shop')) setTimeout(() => this.openShopPanel(), 160);
    if (q.has('notice')) setTimeout(() => this.openNoticePanel(), 160);
    if (q.has('support')) {
      /* ?support 开菜单页，?support=mail / ?support=pay 直接进子页
       *（子页里的收款码是无头截图唯一能验到的方式） */
      const v = q.get('support');
      setTimeout(() => this.openSupportPanel(v || null), 160);
    }
    /* ?ownchar=<key> 直接把某只收费角色标记成已拥有（不装备），
     * 给无头验证用 —— 跟 ?buyacc 一个道理，不该被"还没买"挡住。 */
    if (q.has('ownchar')) {
      const k = q.get('ownchar');
      if (charDef(k).key === k) {
        this.charOwned.add(k);
        this.saveChars();
        this.buildCharGrid();
      }
    }
    if (q.has('settings')) setTimeout(() => this.openSettingsPanel(), 160);
    /* ?coin=N 直接设定奶币余额（无头验证用）；?seenotice 把公告标记成已读，
     * 防止自动弹出干扰其他用例的截图 */
    if (q.has('coin')) {
      this.coins = Math.max(0, Number(q.get('coin')) || 0);
      localStorage.setItem('jump3d_coins', String(this.coins));
      this.refreshCoinUI();
    }
    if (q.has('seenotice')) {
      localStorage.setItem('jump3d_notice_seen', NOTICE_VERSION);
      this.dom.noticeDot.classList.add('hidden');
    }
    /* ?seedrank=N 往本地榜单塞 N 条假数据，只为截图验证榜单排版；
     * 云端模式下不生效（不碰任何网络请求）。 */
    if (q.has('seedrank') && !api.online) {
      const n = Math.max(1, Number(q.get('seedrank')) || 9);
      const pool = ['奶蛙本蛙', '黄桃小方块', '奶蛋仔', '芝士猫', '奶油双鱼',
        '焦糖布丁', '小奶狮', '抹茶丸子', '蜂蜜小熊', '椰奶兔'];
      const seeded = {};
      for (let i = 0; i < n; i++) {
        const nm = pool[i % pool.length] + (i >= pool.length ? String(i) : '');
        seeded[nm] = Math.max(12, Math.round(520 / (i + 1)) + i * 7);
      }
      try { localStorage.setItem('jump3d_local_scores', JSON.stringify(seeded)); } catch (e) { /* 忽略 */ }
    }
    if (q.has('charge') && !q.has('adv')) {
      this.chargeTarget = Number(q.get('charge'));
      setTimeout(() => this.press(), 300);
    }
    if (q.has('hold')) {
      const ms = Number(q.get('hold')) || 500;
      setTimeout(() => {
        this.press();
        setTimeout(() => this.release(), ms);
      }, Number(q.get('at')) || 300);
    }
    // ?adv=秒 用固定步长把模拟一次推进到位，便于截到任意瞬间
    if (q.has('adv')) setTimeout(() => {
      if (q.has('charge')) this.chargeTarget = Number(q.get('charge'));
      this.beginRun();
      if (this.dom.start) this.dom.start.style.display = 'none';
      this.fastForward(
        Number(q.get('adv')) || 1,
        Number(q.get('at')) || 200,
        Number(q.get('hold')) || 520,
        Number(q.get('bot')) || 0
      );
    }, 60);
  }

  /** 机器人跳下一块：按"当前砖到目标砖的真实距离"反算蓄力值 */
  botPress() {
    if (this.state !== 'ready') return false;
    const gap = Math.hypot(
      this.next.center.x - this.current.center.x,
      this.next.center.z - this.current.center.z
    );
    this.chargeTarget = clamp((gap - CFG.jumpMin) / CFG.jumpRange + 0.012, 0.02, 1);
    this.press();
    return true;
  }

  /** 固定步长快进：无头浏览器里 rAF 几乎不触发，靠它才能稳定截到空中/坠落画面 */
  fastForward(sec, pressAtMs, holdMs, botJumps = 0) {
    const dt = 1 / 60;
    const pStep = Math.max(1, Math.round(pressAtMs / 1000 / dt));
    const rStep = pStep + Math.max(1, Math.round(holdMs / 1000 / dt));
    const steps = Math.round(sec / dt);
    const byCharge = this.chargeTarget != null;
    let botLeft = botJumps;
    for (let i = 0; i < steps; i++) {
      if (botLeft > 0 && this.botPress()) botLeft--;
      else if (i === pStep) this.press();
      if (!byCharge && botJumps === 0 && i === rStep) this.release();
      this._noRender = i < steps - 1;   // 中间帧不渲染，只出最后一帧
      this.tick(dt);
    }
    this._noRender = false;
    // 定格：之后真实 rAF 帧只重画、不再推进时间，截图才可复现。
    // （不能停掉渲染循环 —— 关掉连续重绘后无头浏览器抓到的是空画布）
    this._frozen = true;
  }

  /* ---------------- 渲染 / 场景 ---------------- */
  setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
    });
    this.renderer.setClearAlpha(0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    window.addEventListener('resize', () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x2A3260, 26, 58);

    this.camera = new THREE.PerspectiveCamera(CFG.fov, window.innerWidth / window.innerHeight, 0.1, 200);
    this.camera.position.copy(CFG.camOffset);

    // 灯光
    this.scene.add(new THREE.HemisphereLight(0x9DBCFF, 0x2A2440, 0.85));

    this.key = new THREE.DirectionalLight(0xFFF3DA, 2.0);
    this.key.position.set(6, 13, 5);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const sc = this.key.shadow.camera;
    sc.left = -9; sc.right = 9; sc.top = 9; sc.bottom = -9; sc.near = 1; sc.far = 46;
    this.key.shadow.bias = -0.0012;
    this.key.shadow.radius = 3;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    const rim = new THREE.PointLight(0xFF9A4A, 26, 26, 2);
    rim.position.set(-6, 5, -7);
    this.scene.add(rim);

    const fill = new THREE.PointLight(0x66A8FF, 16, 26, 2);
    fill.position.set(7, 4, -6);
    this.scene.add(fill);

    // 角色
    this.character = new Character3D(this.charKey);
    this.charRoot = new THREE.Group();
    this.charFlip = new THREE.Group();
    this.charRoot.add(this.charFlip);
    this.charFlip.add(this.character.group);
    this.scene.add(this.charRoot);
    this.applyAcc();   // 把本机记住的头饰戴上（贴图解码完时 character 会自己摆好位置）

    // 接触阴影
    const shTex = (() => {
      const s = 128, c = document.createElement('canvas');
      c.width = c.height = s;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      return new THREE.CanvasTexture(c);
    })();
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, opacity: 0.9 })
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.02;
    this.blob.renderOrder = 3;
    this.scene.add(this.blob);
  }

  /* ---------------- 输入 ---------------- */
  setupInput() {
    const down = (e) => {
      if (e.target.closest && e.target.closest('.ui-block')) return;
      e.preventDefault();
      this.press();
    };
    /* up 必须和 down 用同一套 .ui-block 过滤 —— 否则点暂停/静音这些按钮时，
     * pointerup 会漏到游戏层，蓄力中点一下就把蛙弹出去了 */
    const up = (e) => {
      if (e.target.closest && e.target.closest('.ui-block')) return;
      e.preventDefault();
      this.release();
    };
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        if (!e.repeat) this.press();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); this.release(); }
    });

    /* 音频在某些环境（被系统禁了声音、iOS 静音开关）初始化会抛异常 ——
     * 决不能让它挡住开局，这也是"标题界面卡住"的一条候选链路 */
    document.getElementById('startBtn').addEventListener('click', () => {
      try { sound.ensure(); } catch (e) { /* 没声音就没声音吧 */ }
      this.beginRun();
    });
    document.getElementById('againBtn').addEventListener('click', () => this.beginRun());
    document.getElementById('titleBtn').addEventListener('click', () => this.backToTitle());
    this.dom.pauseBtn.addEventListener('click', () => this.pauseGame());
    document.getElementById('pauseResume').addEventListener('click', () => this.resumeGame());
    document.getElementById('pauseRestart').addEventListener('click', () => { sound.ensure(); this.beginRun(); });
    document.getElementById('pauseTitle').addEventListener('click', () => this.backToTitle());
    this.dom.mute.addEventListener('click', () => {
      sound.muted = !sound.muted;
      if (sound.muted) sound.stopCharge();
      this.dom.mute.classList.toggle('off', sound.muted);
      this.dom.mute.textContent = sound.muted ? '🔇' : '🔊';
    });

    /* 暂停键：Esc / P。输入框里打字时不抢 —— 否则昵称里打不出 p。
     * 别的面板（角色/背景/昵称/排行榜）开着时也不抢 Esc，那是它们的关闭键语义。 */
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' && e.code !== 'KeyP') return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      if (this.state === 'paused') { e.preventDefault(); this.resumeGame(); return; }
      if (!this.canPause() || document.body.classList.contains('has-panel')) return;
      e.preventDefault();
      this.pauseGame();
    });

    /* 切到别的标签页 / 最小化时自动暂停：不然回来人已经掉下去了。
     * 只在「进行中」暂停 —— 标题页和结算页本来就停着，别多此一举弹面板。 */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.canPause()) this.pauseGame();
    });
  }

  /* ---------------- 角色选择 ---------------- */
  /* 面板挂在开始界面上，背后就是 3D 场景，所以换角色时立绘的变化是即时可见的 */
  setupCharPanel() {
    this.buildCharGrid();
    this.buildAccRows();
    this.dom.charBtn.addEventListener('click', () => this.openCharPanel());
    this.dom.charClose.addEventListener('click', () => this.closeCharPanel());
    this.dom.charPanel.addEventListener('click', (e) => {
      if (e.target === this.dom.charPanel) this.closeCharPanel();
    });
  }

  buildCharGrid() {
    const grid = this.dom.charGrid;
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const c of charList()) {
      const owned = this.ownsChar(c.key);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'charCell' + (c.key === this.charKey ? ' on' : '')
        + (owned ? '' : ' locked');
      cell.dataset.key = c.key;
      const img = document.createElement('img');
      /* 动图角色要用**单帧缩略图**，不能直接给它 uri —— 那是一个雪碧图，
       * 塞进 <img> 里显示的会是 80 个小格子拼成的一大张。 */
      img.src = c.thumb || c.uri;
      img.alt = c.name;
      img.loading = 'lazy';
      img.draggable = false;
      const label = document.createElement('span');
      label.textContent = c.name;
      cell.append(img, label);
      if (!owned) {
        /* 没拥有的格子挂个价签。点了不是"选角色"而是"去商店" ——
         * 站在选择面板里看见一只想要的角色，最顺的下一步就是把它买下来。 */
        const tag = document.createElement('i');
        tag.className = 'charLock';
        tag.innerHTML = coinIco(14) + c.price;
        cell.appendChild(tag);
        cell.title = `${c.name}（${c.price} 奶币 · 点它去商店）`;
      }
      cell.addEventListener('click', () => this.pickChar(c.key));
      frag.appendChild(cell);
    }
    grid.appendChild(frag);
  }

  openCharPanel() {
    this.hidePanels();
    this.dom.charPanel.classList.remove('hidden');
    // 30 个格子里把当前那只滚进视野，免得一打开停在一片空白上
    const on = this.dom.charGrid.querySelector('.charCell.on');
    if (on) on.scrollIntoView({ block: 'center' });
  }
  closeCharPanel() { this.dom.charPanel.classList.add('hidden'); }

  /* ---------------- 背景选择 ---------------- */
  /* 底板用 CSS 画（不是 3D 网格），改一行变量就整屏生效；雾色另算 ——
   * 雾必须跟着底板走，不然远处方块会糊成和背景完全不同的另一块颜色。 */
  setupBgPanel() {
    this.buildBgGrid();
    this.dom.bgBtn.addEventListener('click', () => this.openBgPanel());
    this.dom.bgClose.addEventListener('click', () => this.closeBgPanel());
    this.dom.bgPanel.addEventListener('click', (e) => {
      if (e.target === this.dom.bgPanel) this.closeBgPanel();
    });
  }

  buildBgGrid() {
    const grid = this.dom.bgGrid;
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const b of bgList()) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'charCell swatch' + (b.key === this.bgKey ? ' on' : '');
      cell.dataset.key = b.key;
      const box = document.createElement('i');
      box.className = 'swatchBox';
      box.style.backgroundImage = b.image;
      box.style.backgroundColor = b.color;
      const label = document.createElement('span');
      label.textContent = b.name;
      cell.append(box, label);
      cell.addEventListener('click', () => this.pickBg(b.key));
      frag.appendChild(cell);
    }
    grid.appendChild(frag);
  }

  openBgPanel() {
    this.hidePanels();
    this.dom.bgPanel.classList.remove('hidden');
    const on = this.dom.bgGrid.querySelector('.charCell.on');
    if (on) on.scrollIntoView({ block: 'center' });
  }

  closeBgPanel() { this.dom.bgPanel.classList.add('hidden'); }

  /** 应用背景主题：底板、UI 明暗、雾色三件一起换 */
  applyBg(key) {
    const def = bgDef(key);
    const root = document.documentElement;
    root.style.setProperty('--bg-image', def.image);
    root.style.setProperty('--bg-color', def.color);
    /* 浅底必须有深字版本的 UI，否则分数、标签全是白字白底，直接看不见 */
    document.body.classList.toggle('tone-light', def.tone === 'light');
    if (this.scene && this.scene.fog) this.scene.fog.color.setHex(def.fog);
    this.bgKey = def.key;
    localStorage.setItem('jump3d_bg', def.key);
    if (this.renderer) this.renderer.setClearAlpha(0);
  }

  pickBg(key) {
    if (key === this.bgKey) return;
    this.applyBg(key);
    for (const el of this.dom.bgGrid.children) {
      el.classList.toggle('on', el.dataset.key === this.bgKey);
    }
    sound.pick();
  }

  /* ---------------- 昵称 / 排行榜 ---------------- */
  /* 没有账号系统：昵称和最高成绩都存在本机，填了昵称成绩才会上全服榜。
   * 不填也能完整玩，只是榜上没有你的名字。 */
  setupAccountPanel() {
    const d = this.dom;
    d.accountBtn.addEventListener('click', () => this.openAccountPanel());
    d.accountClose.addEventListener('click', () => this.closeAccountPanel());
    d.accountPanel.addEventListener('click', (e) => {
      if (e.target === d.accountPanel) this.closeAccountPanel();
    });
    d.rankBtn.addEventListener('click', () => this.openRankPanel());
    d.rankClose.addEventListener('click', () => this.closeRankPanel());
    d.rankPanel.addEventListener('click', (e) => {
      if (e.target === d.rankPanel) this.closeRankPanel();
    });

    d.nickGo.addEventListener('click', () => this.saveNick());
    /* 回车直接保存，省得手机上还要去点按钮 */
    d.nickInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveNick(); });
    d.nickClear.addEventListener('click', () => {
      clearNick();
      this.acctMsg('已清除昵称，成绩改成只存本机');
      this.refreshNickUI();
    });
  }

  acctMsg(text, kind = '') {
    const el = this.dom.acctMsg;
    el.textContent = text || '';
    el.className = kind;
  }

  /** 把昵称同步到界面：面板、主页标签、按钮文案。后面都缀一个半透明的
   *  固定编号（#1001 起，服务端发的、全网唯一）—— 昵称可以重名，编号不会。 */
  refreshNickUI() {
    const d = this.dom;
    const on = !!profile.nick;
    const tag = on && profile.pid != null
      ? ` <span class="pid">#${profile.pid}</span>`
      : '';
    d.acctWho.innerHTML = on
      ? `当前昵称 <b>${escapeHTML(profile.nick)}</b>${tag}`
      : '还没有设昵称';
    d.nickInput.value = profile.nick || '';
    d.nickClear.classList.toggle('hidden', !on);
    /* ★ 这里只能换 emoji，绝不能塞中文：图标钮只有 54px 宽，中文会被压成
     *   竖排四个字糊在按钮里（原来这行写的是 '我 的 昵 称' / '设 置 昵 称'，
     *   是文字按钮时代留下的，截图里第 5 个格子就是竖排的"设置昵称"）。
     *   图标统一用 🏷️（昵称=给这条记录贴个标签），两种状态只换 title 文案。 */
    d.accountBtn.textContent = '🏷️';
    d.accountBtn.title = on ? '修改昵称' : '设置昵称';
    d.accountBtn.setAttribute('aria-label', on ? '修改昵称' : '设置昵称');

    d.userTag.classList.toggle('hidden', !on);
    if (on) d.userTag.innerHTML = `昵称 <b>${escapeHTML(profile.nick)}</b>${tag}`;
  }

  openAccountPanel() {
    this.hidePanels();
    this.dom.accountPanel.classList.remove('hidden');
    this.acctMsg('');
    this.refreshNickUI();
  }

  closeAccountPanel() { this.dom.accountPanel.classList.add('hidden'); }

  /** 保存昵称。纯本机操作，不走网络；存完顺手把本机最高成绩补交一次，
   *  免得玩家刚填完昵称、榜单上却还没有自己的分数。 */
  saveNick() {
    try {
      const n = setNick(this.dom.nickInput.value);
      this.acctMsg(`昵称已保存：${n}`, 'ok');
      this.refreshNickUI();
      sound.pick();
      this.pushBest();
      /* 新昵称要问服务端领编号（老昵称则找回原来的号），到了再刷一次 UI */
      fetchPid().then(() => this.refreshNickUI()).catch(() => { /* 静默 */ });
    } catch (e) {
      this.acctMsg(e.message, 'err');
    }
  }

  /** 把本机最高成绩补交一次（刚设完昵称时用；服务端只保留更高的那个） */
  pushBest() {
    if (!profile.nick || this.best <= 0) return;
    submitScore(this.best).catch(() => { /* 补交失败不打扰玩家 */ });
  }

  async openRankPanel() {
    this.hidePanels();
    this.dom.rankPanel.classList.remove('hidden');
    await this.refreshRank();
  }

  closeRankPanel() { this.dom.rankPanel.classList.add('hidden'); }

  /* ---------------- 商店 / 公告 ---------------- */
  /* ---------------- 装饰（头饰） ----------------
   * 装饰不挑角色 —— 任何角色都能戴同一顶帽子。位置由 character.js 按
   * 每张立绘的剪影自动算（见 computeHeadAnchor），所以一套装饰通用全角色。
   * 拥有与装备状态都在本机：jump3d_acc_owned / jump3d_acc_head。
   */
  loadAcc() {
    let owned = [];
    try { owned = JSON.parse(localStorage.getItem('jump3d_acc_owned') || '[]'); } catch (e) { owned = []; }
    this.accOwned = new Set(Array.isArray(owned) ? owned : []);
    this.accEquip = {};
    for (const c of ACC_CATS) {
      let id = null;
      try { id = localStorage.getItem(c.store); } catch (e) { id = null; }
      // 装备的那件必须真的拥有：存档来自改过 localStorage 的情况就忽略掉
      this.accEquip[c.key] = (id && this.accOwned.has(id)) ? id : null;
    }
  }

  saveAcc() {
    try {
      localStorage.setItem('jump3d_acc_owned', JSON.stringify([...this.accOwned]));
      for (const c of ACC_CATS) {
        const v = this.accEquip[c.key];
        if (v) localStorage.setItem(c.store, v); else localStorage.removeItem(c.store);
      }
    } catch (e) { /* 存不下就算了，不影响这一局 */ }
  }

  /* ---------------- 角色拥有（商店里卖的角色） ----------------
   * 规则很朴素：**没有 price 的角色一律免费**，有 price 的必须买。
   * 这样加新角色时，"要不要卖"只体现在定义里那一个字段上，
   * 不用在商店、选择面板、存档三处各维护一份名单。 */
  loadChars() {
    let owned = [];
    try { owned = JSON.parse(localStorage.getItem('jump3d_chars_owned') || '[]'); } catch (e) { owned = []; }
    this.charOwned = new Set(Array.isArray(owned) ? owned : []);
    /* 存档里可能存着一只已经没有的角色（改过 localStorage / 以后删了角色），
     * 清一遍，免得列表里多出一个选不中的格子。 */
    const alive = new Set(charList().map((c) => c.key));
    for (const k of [...this.charOwned]) if (!alive.has(k)) this.charOwned.delete(k);
  }

  saveChars() {
    try { localStorage.setItem('jump3d_chars_owned', JSON.stringify([...this.charOwned])); }
    catch (e) { /* 忽略 */ }
  }

  /** 这只角色现在能不能用：免费的随时可用，要价的得买过 */
  ownsChar(key) {
    const def = charDef(key);
    return !def.price || this.charOwned.has(def.key);
  }

  /** 买角色。买不起返回原因字符串，成功返回 null。 */
  buyChar(key) {
    const def = charDef(key);
    if (!def || !def.price) return '这只不用买';
    if (this.charOwned.has(def.key)) return '已经拥有了';
    if (this.coins < def.price) return '奶币不够';
    this.coins -= def.price;
    this.charOwned.add(def.key);
    try { localStorage.setItem('jump3d_coins', String(this.coins)); } catch (e) { /* 忽略 */ }
    this.saveChars();
    this.refreshCoinUI();
    this.refreshCharGrid();
    sound.peach();
    return null;
  }

  /** 只更新选中/锁定态，不重建 DOM（重建会让列表滚回顶部） */
  refreshCharGrid() {
    const grid = this.dom.charGrid;
    if (!grid) return;
    for (const el of grid.children) {
      const key = el.dataset.key;
      el.classList.toggle('on', key === this.charKey);
      el.classList.toggle('locked', !this.ownsChar(key));
    }
  }

  ownsAcc(id) { return this.accOwned.has(id); }

  /** 买装饰。买不起返回原因字符串，成功返回 null。
   *  公告赠品（deco.notice）本来就不上架，这里再拦一道 —— 免得将来哪条路径
   *  绕过商店直接把赠品"买"出来（赠品的唯一来源必须只有公告按钮）。 */
  buyAcc(id) {
    const deco = accDef(id);
    if (!deco) return '没有这件装饰';
    if (deco.notice) return '这件要去公告里领';
    if (this.ownsAcc(id)) return '已经拥有了';
    if (this.coins < deco.price) return '奶币不够';
    this.coins -= deco.price;
    this.accOwned.add(id);
    try { localStorage.setItem('jump3d_coins', String(this.coins)); } catch (e) { /* 忽略 */ }
    this.saveAcc();
    this.refreshCoinUI();
    this.refreshAccRows();
    sound.peach();
    return null;
  }

  /** 装备 / 卸下装饰。id 传 null 就是"不戴"。 */
  equipAcc(catKey, id) {
    const cat = accCat(catKey);
    if (!cat) return;
    if (id && !this.ownsAcc(id)) return;
    this.accEquip[catKey] = id;
    this.saveAcc();
    this.applyAcc();
    this.refreshAccRows();
    sound.pick();
  }

  /** 把当前装备同步到 3D 角色身上 */
  applyAcc() {
    const id = this.accEquip.head || null;
    if (this.character) this.character.setAccessory(id);
  }

  setupShopPanel() {
    this.dom.shopBtn.addEventListener('click', () => this.openShopPanel());
    this.dom.shopClose.addEventListener('click', () => this.closeShopPanel());
    this.dom.shopPanel.addEventListener('click', (e) => {
      if (e.target === this.dom.shopPanel) this.closeShopPanel();
    });
  }

  openShopPanel() {
    this.hidePanels();
    this.dom.shopPanel.classList.remove('hidden');
    this.refreshCoinUI();
    this.refreshShopShelf();
  }

  closeShopPanel() { this.dom.shopPanel.classList.add('hidden'); }

  /** 商店货架，分两栏：
   *   角色 —— 只有带 price 的角色才上架（免费角色人人都有，摆出来没意义）；
   *           已拥有 → "用这个 / 使用中"；没买 → 价格按钮。
   *   头饰 —— 装饰系统现在只有这一类，且**公告赠品不上架**（shopAccList 过滤）。
   *  买得起的按钮亮色、买不起压暗。 */
  refreshShopShelf() {
    const shelf = this.dom.shopShelf;
    if (!shelf) return;
    const parts = [];

    const paid = charList().filter((c) => c.price > 0);
    if (paid.length) {
      parts.push('<div class="shelfHead">角色</div>');
      parts.push(paid.map((c) => {
        const owned = this.ownsChar(c.key);
        const on = this.charKey === c.key;
        const afford = this.coins >= c.price;
        const btn = owned
          ? `<button class="shopBtn2${on ? ' on' : ''}" data-charkey="${c.key}">`
            + `${on ? '使用中' : '用这个'}</button>`
          : `<button class="shopBtn2${afford ? '' : ' dim'}" data-buykey="${c.key}">`
            + `${coinIco(18)}${c.price}</button>`;
        return `<div class="shopItem">
          <img class="shopIco" src="${c.thumb || c.uri}" alt="">
          <div class="shopMeta"><b>${escapeHTML(c.name)}</b><span>${escapeHTML(c.desc || '')}</span></div>
          ${btn}
        </div>`;
      }).join(''));
    }

    const items = shopAccList();
    if (items.length) {
      parts.push('<div class="shelfHead">头饰</div>');
      parts.push(items.map((d) => {
        const owned = this.ownsAcc(d.id);
        const equipped = this.accEquip[d.cat] === d.id;
        const afford = this.coins >= d.price;
        const btn = owned
          ? `<button class="shopBtn2${equipped ? ' on' : ''}" data-equip="${d.id}" data-cat="${d.cat}">`
            + `${equipped ? '已戴上' : '戴 上'}</button>`
          : `<button class="shopBtn2${afford ? '' : ' dim'}" data-buy="${d.id}">`
            + `${coinIco(18)}${d.price}</button>`;
        return `<div class="shopItem">
          <img class="shopIco" src="${ACC_IMG[d.img] || ''}" alt="">
          <div class="shopMeta"><b>${escapeHTML(d.name)}</b><span>${escapeHTML(d.desc || '')}</span></div>
          ${btn}
        </div>`;
      }).join(''));
    }

    if (!parts.length) {
      shelf.innerHTML = '<div class="rankEmpty">货架还空着<br>掌柜的正在进货，马上就来</div>';
      return;
    }
    shelf.innerHTML = parts.join('');
    shelf.querySelectorAll('[data-buy]').forEach((b) => {
      b.addEventListener('click', () => {
        const err = this.buyAcc(b.dataset.buy);
        if (err) this.shopToast(err);
      });
    });
    shelf.querySelectorAll('[data-buykey]').forEach((b) => {
      b.addEventListener('click', () => {
        const err = this.buyChar(b.dataset.buykey);
        if (err) this.shopToast(err);
      });
    });
    shelf.querySelectorAll('[data-charkey]').forEach((b) => {
      b.addEventListener('click', () => {
        this.pickChar(b.dataset.charkey);
        this.refreshShopShelf();
      });
    });
    shelf.querySelectorAll('[data-equip]').forEach((b) => {
      b.addEventListener('click', () => {
        const cat = b.dataset.cat;
        const id = b.dataset.equip;
        // 已经戴着就再点一下卸掉，省一个额外的"卸下"按钮
        this.equipAcc(cat, this.accEquip[cat] === id ? null : id);
      });
    });
  }

  /** 商店里的小提示（买不起之类），2 秒后自己消失 */
  shopToast(msg) {
    const el = document.getElementById('shopToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), 2000);
  }

  /* ---------------- 角色面板里的装饰行 ---------------- */
  /** 每个分类一行：不戴 + 全部装饰。没买的压暗（**不显示价格**），
   *  点它直接跳去商店 —— 在"选角色"的地方顺手就能买，不用来回切面板。
   *  价格只出现在商店里：选择界面要看的是"有哪些、现在戴的是哪个"，
   *  价钱挤在缩略图上既挡脸又分心。 */
  buildAccRows() {
    const bar = this.dom.accBar;
    if (!bar) return;
    bar.innerHTML = ACC_CATS.map((cat) => {
      const items = accList(cat.key);
      const cells = [
        `<button class="accCell${this.accEquip[cat.key] ? '' : ' on'}" data-cat="${cat.key}" data-id="">`
        + '<i class="accThumb none">✕</i><span>不戴</span></button>',
      ];
      for (const d of items) {
        const owned = this.ownsAcc(d.id);
        const on = this.accEquip[cat.key] === d.id;
        const hint = d.notice ? '去公告领取' : '点它去商店';
        cells.push(`<button class="accCell${on ? ' on' : ''}${owned ? '' : ' locked'}"`
          + ` data-cat="${cat.key}" data-id="${d.id}"`
          + ` title="${escapeHTML(owned ? d.name : `${d.name}（未拥有 · ${hint}）`)}">`
          + `<i class="accThumb"><img src="${ACC_IMG[d.img] || ''}" alt=""></i>`
          + `<span>${escapeHTML(d.name)}</span></button>`);
      }
      return `<div class="accRow"><h4>${escapeHTML(cat.name)}</h4><div class="accGrid">${cells.join('')}</div></div>`;
    }).join('');
    bar.querySelectorAll('.accCell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const id = cell.dataset.id;
        if (!id) { this.equipAcc(cell.dataset.cat, null); return; }
        if (!this.ownsAcc(id)) {
          /* 公告赠品不在商店里 —— 把它送去商店是条死路，直接开公告 */
          const d = accDef(id);
          this.closeCharPanel();
          if (d && d.notice) this.openNoticePanel();
          else this.openShopPanel();
          return;
        }
        this.equipAcc(cell.dataset.cat, id);
      });
    });
  }

  /** 只更新选中态与锁态，不重建 DOM（重建会丢滚动位置） */
  refreshAccRows() {
    const bar = this.dom.accBar;
    if (!bar) return;
    bar.querySelectorAll('.accCell').forEach((cell) => {
      const id = cell.dataset.id || null;
      const owned = !id || this.ownsAcc(id);
      cell.classList.toggle('on', (this.accEquip[cell.dataset.cat] || null) === id);
      cell.classList.toggle('locked', !owned);
    });
    this.refreshShopShelf();
  }

  setupNoticePanel() {
    this.dom.noticeBtn.addEventListener('click', () => this.openNoticePanel());
    this.dom.noticeClose.addEventListener('click', () => this.closeNoticePanel());
    this.dom.noticePanel.addEventListener('click', (e) => {
      if (e.target === this.dom.noticePanel) this.closeNoticePanel();
    });
  }

  openNoticePanel() {
    this.hidePanels();
    this.dom.noticePanel.classList.remove('hidden');
    /* 打开就算读过：红点摘掉 + 记下版本，下次更新才再弹 */
    this.dom.noticeDot.classList.add('hidden');
    try { localStorage.setItem('jump3d_notice_seen', NOTICE_VERSION); } catch (e) { /* 忽略 */ }
    const body = document.getElementById('noticeBody');
    if (!body) return;
    if (!NOTICE_ITEMS.length) {
      body.innerHTML = '<div class="rankEmpty">暂无公告<br>有新消息会第一时间在这里告诉大家</div>';
      return;
    }
    body.innerHTML = NOTICE_ITEMS.map((it) => {
      const lines = [];
      if (it.date) lines.push(`<div class="noticeDate">${escapeHTML(it.date)}</div>`);
      if (it.title) lines.push(`<div class="noticeTitle">${escapeHTML(it.title)}</div>`);
      if (it.body) lines.push(`<div class="noticeBody">${escapeHTML(it.body)}</div>`);
      if (it.gift) {
        const got = this.giftClaimed(it.date, it.gift.id);
        lines.push(`<div class="noticeGift">`
          + `🎁 附赠「${escapeHTML(it.gift.name)}」`
          + (got
            ? '<button class="giftBtn got" disabled>已领取</button>'
            : `<button class="giftBtn" data-gift="${escapeHTML(it.date)}|${escapeHTML(it.gift.id)}">领 取</button>`)
          + '</div>');
      }
      return `<div class="noticeItem">${lines.join('')}</div>`;
    }).join('');
    body.querySelectorAll('[data-gift]').forEach((b) => {
      b.addEventListener('click', () => {
        this.claimGift(b.dataset.gift);
        this.openNoticePanel();     // 重画：按钮切成"已领取"
      });
    });
  }

  /* 赠礼：真正落到"装饰拥有清单"里，之后在角色面板的头饰行里就能戴上。
   * 判重键是「公告条目日期 + 附件 id」——
   *  · 重启、重开面板都不会重复触发（键不变）
   *  · 发新公告不会让旧公告的赠礼再领一次（键绑条目，不绑 NOTICE_VERSION）
   * 领过之后存档里也留痕，所以"已领取"是跨会话的。 */
  giftKey(date, id) { return date + ':' + id; }
  giftClaimed(date, id) { return this.gifts.has(this.giftKey(date, id)); }

  /** data 来自公告按钮的 data-gift（"日期|附件id"）。 */
  claimGift(data) {
    const sep = data.indexOf('|');
    if (sep < 0) return;
    const date = data.slice(0, sep), id = data.slice(sep + 1);
    if (!accDef(id)) return;
    const already = this.accOwned.has(id);
    this.accOwned.add(id);
    this.gifts.add(this.giftKey(date, id));
    this.saveAcc();
    this.saveGifts();
    this.refreshAccRows();
    this.refreshShopShelf();
    this.shopToast(already ? '这件已经有了，放你柜子里了' : '领到了！去「选择角色」里戴上');
    if (!already) sound.peach();
  }

  loadGifts() {
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem('jump3d_gifts') || '[]'); } catch (e) { arr = []; }
    this.gifts = new Set(Array.isArray(arr) ? arr : []);
  }

  saveGifts() {
    try { localStorage.setItem('jump3d_gifts', JSON.stringify([...this.gifts])); } catch (e) { /* 忽略 */ }
  }

  closeNoticePanel() { this.dom.noticePanel.classList.add('hidden'); }

  /* ---------------- 支持作者 ----------------
   * 一个菜单页 + 两个子页：联系作者（邮箱）、投喂作者一包辣条（收款码）。
   * 子页共用 body 容器，靠 this.supportView 记当前在哪一页 ——
   * 不新开面板，是为了不让 panels() 里再多几个互斥项，也让"返回"只是一次重画。 */
  setupSupportPanel() {
    this.supportView = null;
    this.dom.supportBtn.addEventListener('click', () => this.openSupportPanel());
    this.dom.supportClose.addEventListener('click', () => this.closeSupportPanel());
    this.dom.supportPanel.addEventListener('click', (e) => {
      if (e.target === this.dom.supportPanel) this.closeSupportPanel();
    });
  }

  openSupportPanel(view) {
    if (view === undefined) view = null;     // 不带参数 = 菜单页
    this.supportView = view;
    this.hidePanels();
    this.dom.supportPanel.classList.remove('hidden');
    this.renderSupport();
  }

  renderSupport() {
    const body = this.dom.supportBody;
    if (!body) return;
    /* 页面里不放任何描述文案（用户要求）：每一页就按钮 / 邮箱 / 收款码本身 */
    if (this.supportView === 'mail') {
      body.innerHTML = `
        <button class="supportBack ui-block" data-view="">← 返回</button>
        <div class="supportCard">
          <a class="mailAddr" href="mailto:snnn@163.com">snnn@163.com</a>
          <button class="supportBtn2 ui-block" data-copy="snnn@163.com">复 制 邮 箱</button>
        </div>`;
    } else if (this.supportView === 'pay') {
      body.innerHTML = `
        <button class="supportBack ui-block" data-view="">← 返回</button>
        <img class="qrSolo" src="${PAY_URI || ''}" alt="收款码" draggable="false">`;
    } else {
      body.innerHTML = `
        <button class="supportBtn2 ui-block" data-view="mail">✉️ 联系作者</button>
        <button class="supportBtn2 ui-block" data-view="pay">🌶️ 投喂作者一包辣条</button>`;
    }
    body.querySelectorAll('[data-view]').forEach((b) => {
      b.addEventListener('click', () => this.openSupportPanel(b.dataset.view || null));
    });
    body.querySelectorAll('[data-copy]').forEach((b) => {
      b.addEventListener('click', () => this.copyText(b.dataset.copy, b));
    });
    sound.pick();
  }

  /** 复制文本。navigator.clipboard 在 http 下不可用（非安全上下文），
   *  所以备一条 execCommand 的老路，再不行就告诉玩家手动选。 */
  copyText(text, btn) {
    const done = () => {
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '已 复 制 ✓';
        setTimeout(() => { btn.textContent = old; }, 1400);
      }
    };
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done();
        else if (btn) btn.textContent = text;   // 让玩家自己长按选
      } catch (e) { if (btn) btn.textContent = text; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }

  closeSupportPanel() {
    this.dom.supportPanel.classList.add('hidden');
    this.supportView = null;
  }

  /* ---------------- 设置 ----------------
   * 只放"本机偏好"：音效、震动。成绩、奶币、装饰那些是进度，不在这儿动。
   * 面板内容是 SETTINGS 注册表生成的，见文件顶部的注释。 */

  loadSettings() {
    this.set = {};
    for (const s of SETTINGS) {
      let v = null;
      try { v = localStorage.getItem(s.store); } catch (e) { /* 隐私模式读不到，用默认值 */ }
      if (v === null) this.set[s.key] = s.def;
      else if (s.type === 'range') {
        const n = Number(v);
        this.set[s.key] = Number.isFinite(n) ? clamp(n, s.min, s.max) : s.def;
      } else this.set[s.key] = v === '1';
    }
    this.applySettingsToSound();
  }

  /** 把和声音有关的设置推给 audio 模块。集中一处，免得"改了某个开关忘了同步"。 */
  applySettingsToSound() {
    sound.muted = !this.settingOn('sound');
    sound.setVolume(this.settingOn('sound') ? Number(this.set.volume) : 0);
  }

  settingOn(key) { return !!this.set[key]; }

  settingValue(key) {
    const s = SETTINGS.find((x) => x.key === key);
    return s ? this.set[key] : null;
  }

  settingAvailable(s) { return s.supported ? !!s.supported() : true; }

  /** 写一个设置项。range 传数字，switch 传布尔。 */
  setSetting(key, v) {
    const s = SETTINGS.find((x) => x.key === key);
    if (!s || !this.settingAvailable(s)) return;
    const val = s.type === 'range' ? clamp(Number(v), s.min, s.max) : !!v;
    this.set[key] = val;
    try { localStorage.setItem(s.store, s.type === 'range' ? String(val) : (val ? '1' : '0')); }
    catch (e) { /* 写不进就只在本次会话生效 */ }
    this.applySettingsToSound();
    if (key === 'vibrate' && val) this.buzz(18);   // 开了就当场震一下，让玩家知道生效了
    this.refreshSettingsRows();
    /* 音量本来就是"边拖边听"，每动一下都放一声会变成噪音；只在拖完（change）
     * 之后响一下。这里给个很轻的确认音即可。 */
    if (key !== 'volume' || s.type !== 'range') sound.pick();
  }

  /** 震动反馈：设置开着、且设备真的支持时才发。
   *  可用性判断统一收在 SETTINGS 的 supported() 里，别在调用点各写一套。 */
  buzz(ms) {
    if (!this.settingOn('vibrate')) return;
    const s = SETTINGS.find((x) => x.key === 'vibrate');
    if (!s || !this.settingAvailable(s)) return;
    try { navigator.vibrate(ms); } catch (e) { /* 忽略 */ }
  }

  setupSettingsPanel() {
    this.dom.settingsBtn.addEventListener('click', () => this.openSettingsPanel());
    this.dom.settingsClose.addEventListener('click', () => this.closeSettingsPanel());
    this.dom.settingsPanel.addEventListener('click', (e) => {
      if (e.target === this.dom.settingsPanel) this.closeSettingsPanel();
    });
    this.buildSettingsRows();
  }

  /** 按 SETTINGS 注册表把行一次性建好；之后只切 class / 赋值，不重建 DOM */
  buildSettingsRows() {
    const list = this.dom.settingsList;
    if (!list) return;
    list.innerHTML = '';
    for (const s of SETTINGS) {
      const row = document.createElement('div');
      row.className = 'setRow';
      row.dataset.key = s.key;
      if (s.type === 'range') row.classList.add('setRowRange');
      const txt = document.createElement('div');
      const nm = document.createElement('div');
      nm.className = 'setName';
      nm.textContent = s.name;
      const note = document.createElement('div');
      note.className = 'setNote';
      note.textContent = s.note;
      txt.append(nm, note);
      if (s.type === 'range') {
        /* 滑条 + 右侧百分比。用 input[type=range] 而不是自绘 —— 手机上
         * 原生的拖动/点按命中区都是现成的，自绘要么改不动要么点不准。
         * input 事件（拖动中）实时生效但不写档；change 事件（松手）才落盘，
         * 免得拖一下往 localStorage 里写几十次。 */
        const val = document.createElement('b');
        val.className = 'setRangeVal';
        const range = document.createElement('input');
        range.type = 'range';
        range.className = 'setRange';
        range.min = String(s.min);
        range.max = String(s.max);
        range.step = String(s.step);
        range.title = s.name;
        range.setAttribute('aria-label', s.name);
        range.addEventListener('input', () => {
          const v = clamp(Number(range.value), s.min, s.max);
          this.set[s.key] = v;
          this.applySettingsToSound();
          val.textContent = Math.round(v * 100) + '%';
        });
        range.addEventListener('change', () => {
          this.setSetting(s.key, range.value);
          sound.pick();
        });
        const wrapR = document.createElement('div');
        wrapR.className = 'setRangeWrap';
        wrapR.append(range, val);
        row.append(txt, wrapR);
        list.append(row);
        continue;
      }
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'setSwitch';
      sw.title = s.name;
      sw.setAttribute('aria-label', s.name);
      if (!this.settingAvailable(s)) {
        row.classList.add('na');
        sw.disabled = true;
        if (s.naNote) note.textContent = s.naNote;
      } else {
        sw.addEventListener('click', () => this.setSetting(s.key, !this.settingOn(s.key)));
      }
      row.append(txt, sw);
      list.append(row);
    }
    this.refreshSettingsRows();
  }

  refreshSettingsRows() {
    const list = this.dom.settingsList;
    if (!list) return;
    for (const row of list.children) {
      const s = SETTINGS.find((x) => x.key === row.dataset.key);
      if (!s || !this.settingAvailable(s)) continue;
      if (s.type === 'range') {
        const range = row.querySelector('.setRange');
        const val = row.querySelector('.setRangeVal');
        const v = Number(this.set[s.key]);
        if (range) range.value = String(v);
        if (val) val.textContent = Math.round(v * 100) + '%';
        continue;
      }
      const sw = row.querySelector('.setSwitch');
      if (sw) sw.classList.toggle('on', this.settingOn(s.key));
    }
  }

  openSettingsPanel() {
    this.hidePanels();
    this.dom.settingsPanel.classList.remove('hidden');
    this.refreshSettingsRows();
  }

  closeSettingsPanel() { this.dom.settingsPanel.classList.add('hidden'); }

  /** 首次打开游戏、或公告版本比本机已读的更新 → 自动弹出公告栏 */
  maybeShowNotice() {
    let seen = null;
    try { seen = localStorage.getItem('jump3d_notice_seen'); } catch (e) { /* 忽略 */ }
    if (seen === NOTICE_VERSION) return;
    this.dom.noticeDot.classList.remove('hidden');
    /* 稍等一拍再弹：让开始页先画出来，别跟首帧抢戏 */
    setTimeout(() => this.openNoticePanel(), 450);
  }

  /* ---------------- 货币（奶币） ---------------- */
  /**
   * 捡到砖面上的一枚奶币。
   *
   * **只记本局枚数，不动真账** —— 真账要等结算时按 `runCoins × coinPerPick` 一次入包。
   * 这样"本局捡了多少"和"我现在有多少"是两个清晰的数，中途关页面也不会算错账。
   */
  pickCoin(p) {
    if (p.coinTaken) return;
    p.coinTaken = true;
    if (p.coin) p.coin.visible = false;
    this.runCoins++;
    this.updateRunCoinUI(true);
    const at = new THREE.Vector3(p.center.x, CFG.coinY, p.center.z);
    this.popText('奶币 +1', new THREE.Vector3(p.center.x, 0.45, p.center.z),
      '#FFD36E', 0.9, { ms: 800 });
    this.ripple(new THREE.Vector3(p.center.x, 0.06, p.center.z), 0xFFD36E, 0.65);
    this.burst(at, 0xFFE9A8, 8, 1.3, 0.05, 1.9);
    sound.coin();
  }

  /** 左上角的本局奶币计数器。0 枚时整个收起来，不占着地方。
   *  pop=true 时弹一下 —— 捡到的即时反馈，一眼就知道数字动了。 */
  updateRunCoinUI(pop) {
    const el = this.dom.runCoinTag;
    if (!el) return;
    if (this.runCoins > 0) {
      el.innerHTML = `${coinIco(20)}<b>${this.runCoins}</b>`;
      el.classList.add('show');
      if (pop) {
        el.classList.remove('pop');
        void el.offsetWidth;      // 强制回流：不然连续捡到时动画不会重放
        el.classList.add('pop');
      }
    } else {
      el.classList.remove('show', 'pop');
      el.innerHTML = '';
    }
  }

  refreshCoinUI() {
    const c = `${coinIco(22)}<b>${this.coins}</b>`;
    if (this.dom.coinTag) this.dom.coinTag.innerHTML = c;
    if (this.dom.shopCoins) this.dom.shopCoins.innerHTML = `${coinIco(34)}<b>${this.coins}</b>`;
    this.refreshShopShelf();   // 余额变了，"买得起/买不起"要跟着变
  }

  /** 面板任意一个开着，就给 body 挂 has-panel —— 底下的开始页/HUD 靠这个淡掉。
   *  面板是半透明的（故意留出 3D 场景），不淡掉底下的按钮就会叠字、看不清。 */
  /** 所有"浮层"面板。加新面板只需要往这里加一个名字 ——
   *  syncPanels / watchPanels / 互斥关闭全都读这一个清单。
   *  （以前每个 openXxxPanel 里都手抄一遍 5~6 行 classList.add('hidden')，
   *   加第 7 个面板时必然漏一处，面板就会叠在一起。） */
  panels() {
    const d = this.dom;
    return [d.charPanel, d.bgPanel, d.accountPanel, d.rankPanel,
      d.shopPanel, d.noticePanel, d.supportPanel, d.settingsPanel].filter(Boolean);
  }

  /** 面板一次只开一个：开新的之前先把所有面板收起来 */
  hidePanels() {
    for (const p of this.panels()) p.classList.add('hidden');
  }

  syncPanels() {
    const open = this.panels().some((p) => !p.classList.contains('hidden'));
    document.body.classList.toggle('has-panel', open);
  }

  /** 用 MutationObserver 统一盯着面板的 class，省得每加一个开关都去补一次调用 */
  watchPanels() {
    if (typeof MutationObserver !== 'function') return;
    const mo = new MutationObserver(() => this.syncPanels());
    for (const p of this.panels()) mo.observe(p, { attributes: true, attributeFilter: ['class'] });
    this.syncPanels();
  }

  async refreshRank() {
    if (this.rankBusy) return;
    this.rankBusy = true;
    this.dom.rankMe.innerHTML = '正在拉取…';
    this.dom.rankList.innerHTML = '';
    try {
      const { list, me, local } = await leaderboard(100);
      this.dom.rankMe.innerHTML = me
        ? `我 的 名 次 <b>#${me.rank}</b> · 最佳 <b>${me.best}</b> 分`
        : (profile.nick ? '还没有成绩，先玩一局' : '设个昵称，成绩就能上榜');
      if (!list.length) {
        this.dom.rankList.innerHTML = '<div class="rankEmpty">榜单还是空的<br>快去打一个第一名出来</div>';
      } else {
        const frag = document.createDocumentFragment();
        for (const e of list) {
          const row = document.createElement('div');
          row.className = 'rankRow' + (e.me ? ' me' : '') + (e.rank <= 3 ? ' top' + e.rank : '');
          const no = document.createElement('span');
          no.className = 'no';
          no.textContent = '#' + e.rank;
          const nk = document.createElement('span');
          nk.className = 'nk';
          nk.textContent = e.nick;
          row.append(no, nk);
          /* 固定编号缀在昵称后面，半透明 —— 昵称会重名，编号不会 */
          if (e.pid != null) {
            const pd = document.createElement('span');
            pd.className = 'pid';
            pd.textContent = '#' + e.pid;
            row.append(pd);
          }
          const sc = document.createElement('span');
          sc.className = 'sc';
          sc.textContent = e.best + ' 分';
          row.append(sc);
          frag.appendChild(row);
        }
        this.dom.rankList.appendChild(frag);
      }
      if (local) {
        this.dom.rankMe.insertAdjacentHTML('beforeend',
          '<br><span style="opacity:.7">本地模式：只统计这台设备</span>');
      }
    } catch (e) {
      this.dom.rankMe.textContent = '';
      this.dom.rankList.innerHTML = `<div class="rankEmpty">${escapeHTML(e.message)}</div>`;
    } finally {
      this.rankBusy = false;
    }
  }

  pickChar(key) {
    /* 没拥有的先别切 —— 直接把人送去商店。买完回到这儿再点就换上了。 */
    if (!this.ownsChar(key)) {
      const def = charDef(key);
      this.closeCharPanel();
      this.openShopPanel();
      this.shopToast(`${def.name} 要 ${def.price} 奶币，先买下来`);
      return;
    }
    const def = this.character.setChar(key);
    if (def.key === this.charKey) return;
    this.charKey = def.key;
    localStorage.setItem('jump3d_char', def.key);
    this.refreshCharGrid();
    sound.pick();
  }

  /* ---------------- 世界 ---------------- */
  resetWorld() {
    for (const p of this.platforms) p.dispose(this);
    this.platforms.length = 0;
    for (const f of this.fx) { this.scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose(); }
    this.fx.length = 0;
    this.dom.popLayer.innerHTML = '';

    const first = new Platform(this, 0, 0, {
      kind: 'round', radius: 0.80, height: 1.65, color: PALETTE[3],
      special: null,
    });
    this.platforms.push(first);
    this.current = first;
    this.lastDir = null;

    /* 计数器必须先归零再铺砖 —— 否则重开一局时，新砖会按上一局的高分来算难度 */
    this.score = 0;
    this.combo = 0;
    this.power = 0;
    this.steps = 0;
    this.peaches = 0;
    this.runCoins = 0;   // 本局捡到的奶币枚数，结算时 ×coinPerPick 入账
    this.updateRunCoinUI(false);   // 顺便把左上角的计数器收起来
    this.boostLv = 0;    // 弹簧加成叠层
    this.slimeLv = 0;    // 粘液削减叠层
    this.frozenT = 0;    // 冻结剩余秒数（>0 = 人动不了）
    this.character.setFrozen(false);   // 上一局要是被冻着结束的，冰壳也别留到下局
    this.fallTimer = 0;
    this.punch = 0;
    this.lastJump = { trait: null, dist: 0, h: 0 };
    this.spawnNext();

    this.updateScoreUI();
    this.setCombo(0);
    this.refreshBuffUI();

    this.charRoot.position.set(0, 0, 0);
    this.charFlip.quaternion.identity();
    this.character.setSpin(0);
    this.character.group.rotation.set(0, 0, 0);
    this.character.group.position.set(0, 0, 0);
    this.character.chargeSquash = 0;
    this.character.airStretch = 0;
    this.character.chS = 0;
    this.character.airS = 0;
    this.character.imp = 0;
    this.character.impV = 0;
    this.faceCamera(new THREE.Vector3(
      this.next.center.x - this.current.center.x, 0,
      this.next.center.z - this.current.center.z
    ).normalize());

    this.camLook.set(0, CFG.camLookY, 0);
    this.camLookTarget.copy(this.camLook);
    this.camera.position.copy(this.camLook).add(CFG.camOffset);
    this.camDistScale = 1;
    this.camDip = 0;
    this.camKick = 0;
    this.blob.visible = true;
    this.blob.position.set(0, 0.02, 0);
    this.placeKeyLight();
  }

  spawnNext() {
    // 难度爬升：跳得越远，砖越远、迷你砖越多、特殊砖越密
    const prog = clamp(this.steps / CFG.rampJumps, 0, 1);

    // 方向：-X（屏幕左上）或 -Z（屏幕右上）
    let axis = Math.random() < 0.5 ? 'x' : 'z';
    if (this.lastDir === axis && Math.random() < 0.55) axis = axis === 'x' ? 'z' : 'x';
    this.lastDir = axis;

    const gapMin = CFG.gapMin + prog * CFG.gapMinRamp;
    const gapMax = CFG.gapMax + prog * CFG.gapMaxRamp;
    /* ★ 效果砖改变了"从脚下这块起跳"的可达区间，下一块的间距必须跟着收放，
     * 不然会摆出**物理上无解**的局：
     *   · 站在粘液上射程被砍（最多 ×0.5625），下一块照常摆 3.6 远就必然跳不过去；
     *   · 站在弹簧上最轻一跳也飞 0.95×1.92 ≈ 1.8 远，下一块摆近了必然直接跳过头。
     * 这里的 rangeMul() 是玩家**此刻**站在 current 上的真实倍率 —— spawnNext
     * 发生在落地状态更新之后，所以连排粘液/弹簧会逐块自动收紧，不用额外记链。
     * （?gap= 固定调试间距时不干预，探针用例要的是确定的布局。）
     * 2026-10-03 玩家反馈太难，两轮放宽：弹簧下限 1.30 → 1.15 → 1.08，
     * 粘液每层削减 0.40 → 0.30 → 0.25（见 CFG.slimeK）。 */
    let lo = gapMin, hi = gapMax;
    if (this.fixedGap == null) {
      const maxReach = (CFG.jumpMin + CFG.jumpRange) * this.rangeMul();
      hi = Math.min(hi, maxReach * 0.90);                       // 满蓄力也够得着（留 10% 余量）
      if (this.boostLv > 0) lo = Math.max(lo, CFG.jumpMin * this.rangeMul() * 1.08); // 轻蓄力也飞不过头
    }
    const gap = this.fixedGap != null
      ? this.fixedGap
      : (lo < hi ? lo + Math.random() * (hi - lo) : hi);        // lo≥hi 说明区间被压穿了，取上限贴着可达边缘
    const x = this.current.center.x + (axis === 'x' ? -gap : 0);
    const z = this.current.center.z + (axis === 'z' ? -gap : 0);

    /* 特色砖抽签。黄桃是彩蛋：开局几块不出现，不连着来两块，也不叠在移动砖上。
     * fragile / double / 效果砖走同一条互斥通道 —— 一次只给一种特色，规则才读得懂 */
    let trait = this.forceTrait || null;
    if (!trait && !this.plainMode) {
      if (this.steps >= 3 && this.current.trait !== 'peach'
        && Math.random() < CFG.peachChance) {
        trait = 'peach';
      } else if (Math.random() < CFG.springChance) {
        trait = 'spring';
      } else if (Math.random() < CFG.fragileChance) {
        trait = 'fragile';
      } else if (Math.random() < CFG.doubleChance) {
        trait = 'double';
      } else if (Math.random() < CFG.slimeChance) {
        trait = 'slime';
      } else if (Math.random() < CFG.freezeChance) {
        trait = 'freeze';
      } else if (Math.random() < CFG.holyChance) {
        trait = 'holy';
      } else if (Math.random() < CFG.lureChance) {
        trait = 'lure';
      } else if (Math.random() < CFG.milkChance) {
        trait = 'milk';
      } else if (Math.random() < CFG.movingChance) {
        trait = 'moving';
      }
    }

    const special = (trait || this.plainMode) ? null
      : (Math.random() < CFG.specialChance + prog * 0.10
        ? SPECIALS[(Math.random() * SPECIALS.length) | 0] : null);

    /* 迷你砖奖励的是"砖小"，所以会滑动的砖不参与 —— 否则玩家吃到"迷你砖"加分，
     * 实际面对的却是一块被撑大的移动砖，名不副实 */
    const mini = !trait && !this.plainMode
      && Math.random() < CFG.miniChance + prog * CFG.miniChanceRamp;

    /* 奶币：随机挂在某几块砖上。**和砖种不互斥** —— 币是额外奖励，
     * 不该因为这块砖恰好有特色就被挤掉。调试开关 ?coins=0 / ?coins=1 可强制。 */
    const coin = this.forceCoin != null ? this.forceCoin : Math.random() < CFG.coinChance;

    let kind;
    if (trait === 'spring' || trait === 'peach') {
      kind = 'round';                       // 这两种砖的外观自带造型，用圆底
    } else if (trait === 'fragile' || trait === 'double'
      || trait === 'slime' || trait === 'freeze' || trait === 'holy' || trait === 'lure') {
      kind = 'round';                       // 效果砖统一用圆底 + 顶面图案表达
    } else if (this.forceKind) {
      kind = this.forceKind;
    } else {
      const roll = Math.random();
      kind = roll < 0.46 ? 'round' : (roll < 0.70 ? 'twoTier' : (roll < 0.88 ? 'box' : 'oct'));
    }

    let radius;
    if (this.forceRadius != null) radius = this.forceRadius;
    else if (kind === 'box') radius = 0.56 + Math.random() * 0.18;
    else if (kind === 'twoTier') radius = 0.72 + Math.random() * 0.16;
    else if (kind === 'oct') radius = 0.66 + Math.random() * 0.18;
    else radius = 0.62 + Math.random() * 0.22;

    if (mini) radius *= MINI_SCALE;
    // 会跑的砖本身就要掐时机，再给它做小就太劝退了，兜一个下限
    if (trait === 'moving' && radius < 0.70) radius = 0.70;
    // 彩蛋砖落点要舒服，固定成一块偏大的圆砖
    if (trait === 'peach') radius = 0.80 + Math.random() * 0.08;
    // 脆砖别太小：已经够紧张了，再小就是纯刁难
    if (trait === 'fragile' && radius < 0.62) radius = 0.62;
    // 磁铁砖落点要舒服（它是奖励，不该再靠落点难为人）
    if (trait === 'lure' && radius < 0.72) radius = 0.72;
    // 粘液块是"惩罚砖"，落点反而要宽松些 —— 射程已经被压住了，别再叠"难落"
    if (trait === 'slime' && radius < 0.70) radius = 0.70;
    // 冰冰冰要冻住人 1.5 秒，落点同样给足余量，不去叠第二层惩罚
    if (trait === 'freeze' && radius < 0.70) radius = 0.70;
    if (radius < 0.34) radius = 0.34;

    let height = 1.35 + Math.random() * 1.1;
    if (trait === 'spring') height = 1.05 + Math.random() * 0.5;
    // 奶块是一整块"奶砖"：做矮胖一点，顶面才够大、脸才看得清
    if (trait === 'milk') height = 1.22 + Math.random() * 0.34;

    const p = new Platform(this, x, z, {
      kind, radius, trait, mini, special, height, coin,
      moveAxis: axis === 'x' ? 'z' : 'x',
      moveAmp: trait === 'moving' ? 0.50 + Math.random() * 0.45 : 0,
      moveSpeed: trait === 'moving' ? 0.75 + Math.random() * 0.55 : 0,
      movePhase: trait === 'moving' ? Math.random() * Math.PI * 2 : 0,
      color: trait === 'peach' ? PEACH_COLOR
        : trait === 'fragile' ? 0x9AA3AD      // 脆砖：风化水泥灰（材质另配裂纹，见 Platform）
        : trait === 'double' ? 0xE8B84B       // ×2 砖：金灿灿
        : trait === 'slime' ? 0x63CE72        // 粘液块：黏液绿
        : trait === 'freeze' ? 0x8FCBEF       // 冰冰冰：冰蓝（材质另配半透明，见 Platform）
        : trait === 'holy' ? 0xF3EDD6         // 圣光砖：象牙白（顶面另配更亮的米色）
        : trait === 'lure' ? 0xB47CE6         // 磁铁砖：紫（和"特殊图案"的紫区分开：更饱和）
        : trait === 'milk' ? 0xF2E3C4         // 奶块：奶油色砖身，顶面留白给蛙脸
        : PALETTE[(Math.random() * PALETTE.length) | 0],
    });
    this.platforms.push(p);
    this.next = p;

    // 清理远处方块
    while (this.platforms.length > 8) {
      const old = this.platforms.shift();
      if (old === this.current || old === this.next) { this.platforms.unshift(old); break; }
      old.dispose(this);
    }
  }

  placeKeyLight() {
    this.key.position.set(this.camLook.x + 6, 13, this.camLook.z + 5);
    this.key.target.position.set(this.camLook.x, 0, this.camLook.z);
    this.key.target.updateMatrixWorld();
  }

  /** 角色朝向：始终面向镜头，并略偏向跳跃方向 */
  /** 屏幕右方向（水平面内，与相机视线垂直） */
  screenRight(out) {
    const dx = this.camera.position.x - this.charRoot.position.x;
    const dz = this.camera.position.z - this.charRoot.position.z;
    const l = Math.hypot(dx, dz) || 1;
    return out.set(dz / l, 0, -dx / l);
  }

  /** 纸片人：立绘本身正面微侧（脸略偏画面左），按移动方向做左右镜像即可 */
  faceCamera(dir) {
    const r = this.screenRight(this._tmpV);
    this.character.setMirror(dir.dot(r) >= 0 ? -1 : 1);
    this.character.faceTo(dir.x, dir.z);
  }

  /* ---------------- 流程 ---------------- */
  beginRun() {
    document.body.classList.remove('intro');
    /* 上局可能正暂停着就点了重开（暂停面板的"重新开始"），把暂停痕迹清干净 */
    document.body.classList.remove('paused');
    this.pausedFrom = null;
    sound.stopCharge();
    this.dom.pause.classList.add('hidden');
    this.dom.pauseBtn.classList.remove('hidden');
    this.dom.start.classList.add('hidden');
    this.dom.over.classList.add('hidden');
    this.closeCharPanel();
    this.closeBgPanel();
    this.closeAccountPanel();
    this.closeRankPanel();
    this.closeShopPanel();
    this.closeNoticePanel();
    this.dom.hint.classList.remove('hidden');
    this.resetWorld();
    this.state = 'ready';
    setTimeout(() => this.dom.hint.classList.add('hidden'), 3200);
  }

  press() {
    if (this.state === 'start') { sound.ensure(); this.beginRun(); return; }
    if (this.state !== 'ready') return;
    /* 被冻住的时候点不动。**故意不弹提示** —— 冰壳 + 倒计时已经写在画面上，
     * 再叠一行"你被冻住了"只会更吵；而且玩家这时候是连点，弹字会刷屏。 */
    if (this.frozenT > 0) return;
    this.state = 'charging';
    this.power = 0;
    this.dom.bar.classList.add('show');
    sound.startCharge();
  }

  release() {
    if (this.state !== 'charging') return;
    sound.stopCharge();
    this.dom.bar.classList.remove('show');
    this.doJump();
  }

  doJump() {
    /* 蓄力能拉出的最大距离。弹簧加成 / 粘液削减都在这里生效 ——
     * 玩家按住的时间没变，但"能跳多远"变了，这是最直观的特殊效果。 */
    const maxDist = Math.max(
      0.8,
      (CFG.jumpMin + this.power * CFG.jumpRange) * this.rangeMul()
    );
    const fromTrait = this.current.trait;
    const dir = new THREE.Vector3(
      this.next.center.x - this.current.center.x, 0,
      this.next.center.z - this.current.center.z
    ).normalize();
    this.dir.copy(dir);
    this.steps++;

    this.faceCamera(dir);

    this.jump.from.copy(this.charRoot.position);
    const landX = this.charRoot.position.x + dir.x * maxDist;
    const landZ = this.charRoot.position.z + dir.z * maxDist;
    this.jump.to.set(landX, 0, landZ);
    this.jump.t = 0;
    // 跳跃时长：短距离 0.34s、最远 0.60s，整体比之前快约三成
    const flyDist = maxDist;
    this.jump.dur = 0.28 + flyDist * 0.067;
    /* 从弹簧砖起跳：弧线抬高五成 —— 收益不变、落点不变（不破坏平衡），
     * 但画面上就是"被弹簧弹出去"，和普通砖一眼分得出 */
    const lift = fromTrait === 'spring' ? CFG.springLift : 1;
    this.jump.h = (0.95 + flyDist * 0.34) * lift;
    /* 磁铁砖：把落点往砖心拽 —— 但只吃掉一部分误差（最多 lureMaxPull），
     * 所以"蓄力差一点点"它救你，"差一整个砖"照样够不着。
     * 注意别过头：拽到砖心就停，绝不越过 —— 越过了误差反而变大。 */
    if (fromTrait === 'lure') {
      const dx = this.next.center.x - this.jump.to.x;
      const dz = this.next.center.z - this.jump.to.z;
      const err = Math.hypot(dx, dz);
      if (err > 1e-4) {
        /* 上限 = max(固定值, 目标砖半径 × 系数)：这样"差半个砖"能救回来，
         * "差一整个砖"就超出上限、照样掉 —— 阈值跟着砖的大小走，玩家好预判。 */
        const cap = Math.max(CFG.lureMaxPull, this.next.hitRadius * CFG.lureCapMul);
        const eaten = Math.min(err * CFG.lurePull, cap, err);   // 封顶 = err，绝不过冲
        this.jump.to.x += (dx / err) * eaten;
        this.jump.to.z += (dz / err) * eaten;
      }
    }
    // 供调试状态栏读取：验证"从弹簧砖起跳弧线更高"是否真的生效
    this.lastJump = {
      trait: fromTrait, dist: maxDist, h: this.jump.h,
      boost: this.boostLv, slime: this.slimeLv,
    };
    // 纸片人：翻转方向按"前进方向在屏幕上的左右"决定，正着翻
    this.jump.spinSign = dir.dot(this.screenRight(this._tmpV)) >= 0 ? -1 : 1;

    this.state = 'jumping';
    this.character.setCharge(0);
    // 起跳扬尘；从粘液块起跳换成黏液绿，和普通起跳区分开
    this.burst(new THREE.Vector3(this.jump.from.x, 0.06, this.jump.from.z),
      fromTrait === 'slime' ? 0xBDF5C4 : 0xE4EDFF, 8, 0.8, 0.045, 1.3);
    sound.jump();
    this.updateScoreUI();
  }

  /** 站得住的判定半径：脚心最多越出砖缘这么多。
   *  footR 只负责把"点"放大成"这只有多大的脚"，真正卡松紧的是
   *  footSupport——必须大部分脚掌还在砖上，只搭一点边就算摔。 */
  standTol() {
    return this.character.footR * CFG.footSupport + CFG.edgeGrace;
  }

  /** 射程倍率：弹簧助推与粘液削减叠乘。
   *  两个效果都只属于脚下方块（离开即清）—— 都会上 HUD 状态条。 */
  rangeMul() {
    return (1 + this.boostLv * CFG.boostRange) * Math.pow(1 - CFG.slimeK, this.slimeLv);
  }

  /** 弹簧助推：只有"有 / 没有"两种，**不叠层**。
   *  它描述的是"下一跳能不能蹬一下"，天然是个一次性状态 ——
   *  原来是 0~3 层常驻叠乘，踩一连串弹簧就能越跳越远、再也掉不下去，
   *  那不叫跳一跳了。现在：站上弹簧 → 下一跳 ×1.92 → 落地清掉。
   *  （传布尔或数字都行，内部统一成 0 / 1。） */
  setBoost(on) {
    this.boostLv = on ? 1 : 0;
    this.refreshBuffUI();
  }

  /** 粘液块：射程削减 +1 层（封顶） */
  setSlime(n) {
    this.slimeLv = clamp(n, 0, CFG.slimeMax);
    this.refreshBuffUI();
  }

  /** 冰冰冰：把角色冻住 CFG.freezeMs 毫秒。
   *  **不叠时长**：连续两块冰冰冰不该冻 3 秒 —— 那是纯折磨，
   *  取"剩余时间和新时长里更长的那个"，等价于刷新而不是累加。
   *  冻结期间 press() 直接被挡掉，所以玩家是真的拿不回控制权。 */
  freezeChar() {
    const sec = CFG.freezeMs / 1000;
    this.frozenT = Math.max(this.frozenT, sec);
    this.character.setFrozen(true);
    this.state = 'ready';
    this.popText(`冰冰冰  冻住 ${sec.toFixed(1)} 秒`, this.current.center, '#A9E6FF', 1.05, TIP);
    this.perfectBurst(this.current.center, 0x8FD8FF);
    this.burst(new THREE.Vector3(this.current.center.x, 0.6, this.current.center.z),
      0xCDF1FF, 14, 1.5, 0.06, 2.4);
    sound.freeze();
    sound.ding();      // 冰冰冰专属音效"叮叮叮"（用户音源；只受全局静音管）
    /* 被冻住是负反馈，用"两短一长"的节奏和一记轻震提醒玩家"你现在动不了" */
    this.buzz([26, 46, 26]);
  }

  /** 解冻：清状态 + 抖落一层碎冰。倒计时走完和"中途重开一局"都调它，
   *  免得冻结状态跨局残留。 */
  thawChar() {
    if (this.frozenT <= 0 && !this.character.frozen) return;
    this.frozenT = 0;
    this.character.setFrozen(false);
    const at = this.charRoot.position;
    this.ripple(new THREE.Vector3(at.x, 0.05, at.z), 0xBEE9FF, 0.85);
    this.burst(new THREE.Vector3(at.x, 0.5, at.z), 0xE4F6FF, 10, 1.4, 0.05, 2.0);
  }

  /** HUD 上的常驻状态条：有没有弹簧助推、几层粘液削减。
   *  这两个数决定"你现在能跳多远"，不显示的话玩家会以为是游戏坏了。
   *  弹簧助推只有一层，所以不画 ◆ 计数，直接写名字。 */
  refreshBuffUI() {
    const el = this.dom.buffTag;
    if (!el) return;
    const parts = [];
    if (this.boostLv > 0) parts.push('↑ 弹簧助推');
    if (this.slimeLv > 0) parts.push(`◍ 粘液 ${'◆'.repeat(this.slimeLv)}`);
    el.textContent = parts.join('   ');
    el.classList.toggle('show', parts.length > 0);
  }

  finishJump() {
    const land = this.charRoot.position.clone();

    // 1) 还站在起跳方块上：原地跳，不计分
    if (this.current.edgeOver(land.x, land.z) <= this.standTol()) {
      this.settle(0.5);
      this.current.kick(0.5);
      this.ripple(land, 0xFFFFFF, 0.7);
      this.dust(land, 0xD8E2FF, 6, 0.55);
      sound.land();
      this.popText('原地跳', land, '#B9C4E8');
      this.combo = 0;
      this.setCombo(0);
      /* 人还站在弹簧上，所以助推照给；站在别的砖上就清掉 */
      this.setBoost(this.current.trait === 'spring');
      this.state = 'ready';
      return;
    }

    const target = this.next;
    const over = target.edgeOver(land.x, land.z);

    // 2) 落在目标方块上（脚底接触面还在砖上，含一点点踩边宽容）
    if (over <= this.standTol()) {
      const d = target.distToCenter(land.x, land.z);
      // 越靠边落得越"重"：压扁更明显、镜头下沉更多
      const hard = clamp(1 - Math.max(over, 0) / 0.6, 0.5, 1);
      const springy = target.trait === 'spring';
      this.settle(hard);
      if (springy) {
        /* 弹簧砖：踏板被压下去，同时把人"嘣"地弹起来。
         * 落地那道压扁照常走，弹跳叠在它上面 —— 所以看起来是"先沉一下、
         * 再连人带弹簧弹飞"，而不是两种形变互相抵消。 */
        target.trampoline();
        this.character.boing(1);
        this.camKick += 0.10;
      } else {
        target.kick(hard);
      }
      this.ripple(land, springy ? 0x9BE8D8 : 0xFFFFFF, 1);
      this.dust(land, 0xE8EEFF, 7, 0.7);
      this.camDip += 0.16 * hard;
      this.camKick += 0.05 * hard;

      const perfect = d <= target.perfectTol;
      let gain = POINTS.base;
      if (perfect) {
        this.combo++;
        const bonus = Math.min(2 + (this.combo - 1) * 2, 10);
        gain += bonus;
        this.setCombo(this.combo);
        this.popText(this.combo > 1 ? `完美 ×${this.combo}  +${gain}` : `完美  +${gain}`,
          target.center, '#FFE066');
        this.perfectBurst(target.center);
        sound.perfect();
        /* 震动放在"完美落地"而不是每次落地：完美是玩家主动追求的操作，
         * 震一下是奖励；每跳都震会变成背景噪音，还费电。 */
        this.buzz(this.combo > 1 ? 16 : 11);
        this.camPunch();
      } else {
        this.combo = 0;
        this.setCombo(0);
        this.popText(`+${gain}`, target.center, '#DCE6FF');
        sound.land();
      }

      /* 砖本身带来的额外收益：越稀有、越难踩的给得越多 */
      if (target.trait === 'peach') {
        gain += POINTS.peach;
        this.peaches++;
        this.popText(`黄桃  +${POINTS.peach}`, target.center, '#FFD36E', 0.80, TIP);
        this.perfectBurst(target.center, 0xFFD36E);
        this.peachRain(target.center);
        sound.peach();
        this.camPunch();
      } else if (target.trait === 'spring') {
        gain += POINTS.spring;
        /* 助推由落地后的统一处发放（见下面 setBoost），这里只报喜 */
        this.popText(`弹簧  下一跳射程 +${Math.round(CFG.boostRange * 100)}%`, target.center, '#9BE8D8', 0.80, TIP);
        this.perfectBurst(target.center, 0x9BE8D8);
        sound.spring();
        this.buzz(18);
      } else if (target.trait === 'fragile') {
        /* 脆砖：落上就开始倒计时（armCrack 只 arm 一次，不重置）。
         * 2 分是"必须马上走"的风险补偿 —— 赖着不走，连人带砖一起掉。 */
        gain += POINTS.fragile;
        target.armCrack();
        this.popText(`脆砖  1.4 秒后碎裂，快走`, target.center, '#D6DEE8', 0.80, TIP);
      } else if (target.trait === 'slime') {
        /* 粘液块：射程 -1 层。和弹簧正好相反 —— 一好一坏，玩家得掂量。
         * （这效果原来挂在冰冰冰上，现在整套搬到粘液块，语义更顺：
         *   被黏液黏住 → 跳不远。） */
        this.setSlime(this.slimeLv + 1);
        this.popText(`粘液块  射程 -1（${this.slimeLv}/${CFG.slimeMax}）`, target.center, '#A6F0B4', 0.80, TIP);
        this.perfectBurst(target.center, 0x63CE72);
        this.camPunch();
      } else if (target.trait === 'freeze') {
        /* 冰冰冰：把角色冻住 1.5 秒 —— 不是减射程，是"你根本动不了"。
         * 拿不回控制权的这 1.5 秒里，脚下要是有脆砖倒计时在跑，就特别难受。 */
        this.freezeChar();
      } else if (target.trait === 'milk') {
        /* 奶块：砖面上印着经典奶蛙的脸，不给分也不给状态。
         * 但会**放一声大笑** —— 这是玩家自己提供的音源，"跳到奶块就笑"。
         * 连 +0 的飘字都不弹，它就该是"路过一块可爱的砖"。 */
        this.perfectBurst(target.center, 0xFFF0CC);
        if (this.settingOn('laugh')) sound.laugh();
      } else if (target.trait === 'lure') {
        /* 磁铁砖：效果在下一次起跳（落点被拽向砖心），这里只报喜 */
        this.popText('磁铁砖  下一跳自动对准', target.center, '#D8B6FF', 0.80, TIP);
        this.perfectBurst(target.center, 0xB47CE6);
      } else if (target.trait === 'holy') {
        /* 圣光砖：净化场上所有脆砖。清掉的每一块都算一次小奖励，
         * 因为它可能正好救了玩家一命（下一块就是脆砖的那种局面）。 */
        gain += POINTS.holy;
        let cleared = 0;
        for (const p of this.platforms) {
          /* 跳过刚落上的这块（它本身就是圣光砖）和脚下这块 ——
           * 脚下的砖要是脆的，净化掉就等于"圣光把你自己站的地板变没了"。 */
          if (p === target || p === this.current) continue;
          if (p.purify()) {
            cleared++;
            this.ripple(p.center, 0xFFF3C4, 1.1);
            this.burst(new THREE.Vector3(p.center.x, 0.3, p.center.z), 0xFFF6D0, 8, 1.4, 0.05, 2.2);
          }
        }
        this.popText(cleared > 0 ? `圣光  净化脆砖 ×${cleared}` : '圣光  场上没有脆砖',
          target.center, '#FFF3C4', 0.80, TIP);
        this.perfectBurst(target.center, 0xFFF6D0);
        sound.peach();
        this.camPunch();
      } else if (target.mini) {
        gain += POINTS.mini;
        this.popText(`迷你砖  +${POINTS.mini}`, target.center, '#BFE3FF', 0.80, TIP);
      }
      if (target.special) {
        gain += POINTS.special;
        this.popText(`幸运方块  +${POINTS.special}`, target.center, '#9BE8D8', 1.55, TIP);
        sound.bonus();
        this.perfectBurst(target.center, 0x9BE8D8);
        /* 幸运方块只给分，不掉奶币了 —— 奶币改成砖面上的实体（随机挂币），
         * 再在这里掉一次就成了两套并存的规则，玩家算不清"这块砖到底有没有钱" */
      }
      /* ×2 砖放在最后结算：上面所有收益（完美连击、砖特色、幸运方块）
       * 一起翻倍，玩家看到的就是"这一跳拿了两倍" */
      if (target.trait === 'double') {
        gain *= 2;
        this.popText('双倍得分 ×2', target.center, '#FFD36E', 1.25, TIP);
        this.perfectBurst(target.center, 0xFFD36E);
        this.camPunch();
      }

      /* 落地就重算"弹簧助推"：站上弹簧才有，离开弹簧就结束。
       * ★ 放在**这一处**出口统一做，而不是塞进上面的砖种分支里 ——
       *   落地只有这一个出口，写在这儿谁也漏不掉（下次有人加砖种也不会忘）。
       *   这就是"射程加成离开弹簧就失效"的实现点。 */
      this.setBoost(target.trait === 'spring');

      /* 负面效果同理，**只属于脚下方块**：离开粘液块就全干掉了。
       * slime 分支在上面已经 +1（落在粘液上），这里只清"落到别的砖"的情况。
       * 以前粘液是常驻叠乘，玩家连续吃两层之后永远残废 —— 那不是惩罚，
       * 是判死刑；现在和弹簧对称：好效果离开就没了，坏效果离开也没了。 */
      if (target.trait !== 'slime' && this.slimeLv > 0) this.setSlime(0);

      this.score += gain;
      this.updateScoreUI();
      this.current = target;
      this.spawnNext();
      this.state = 'ready';
      return;
    }

    // 3) 失败：踩空翻下去 / 直接落空
    this.combo = 0;
    this.setCombo(0);
    sound.fail();
    this.blob.visible = false;
    if (over <= this.standTol() + CFG.tipBand) {
      // 踩在边上 -> 往越出去最多的那条边倾倒
      let ax = land.x - target.center.x;
      let az = land.z - target.center.z;
      if (target.kind === 'box' && Math.abs(ax) !== Math.abs(az)) {
        if (Math.abs(ax) > Math.abs(az)) az = 0; else ax = 0;
      }
      const away = new THREE.Vector3(ax, 0, az).normalize();
      this.fall.mode = 'tip';
      this.fall.delay = 0.26;
      this.fall.tipDur = 0.26;
      // 屏幕内倾倒角度：往哪边摔就往哪边倒
      let p = away.dot(this.screenRight(this._tmpV));
      if (Math.abs(p) < 0.3) p = p >= 0 ? 0.3 : -0.3;
      this.fall.tipAmount = -0.62 * p;
      this.fall.spinZ = 0;
      this.fall.tipDir = away;
      this.state = 'falling';
      this.character.impact(1);
      this.ripple(land, 0xFF8866, 0.8);
    } else {
      this.fall.mode = 'drop';
      this.fall.delay = 0.06;
      this.fall.vy = -1.2;
      this.fall.spin.set(
        (Math.random() - 0.5) * 3.2, (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 3.2
      );
      this.state = 'falling';
    }
  }

  /** 脆砖碎裂（由 Platform.update 在倒计时归零时回调）。
   *  人还站在上面就一起摔；砖本体开始下沉，最后由 tick 从 platforms 里清走。 */
  onCrack(p) {
    sound.fail();
    this.burst(new THREE.Vector3(p.center.x, 0.35, p.center.z), 0xC8CEDC, 16, 2.1, 0.06, 2.0);
    if (this.current === p && (this.state === 'ready' || this.state === 'charging')) {
      sound.stopCharge();
      this.combo = 0;
      this.setCombo(0);
      this.power = 0;
      this.dom.bar.classList.remove('show');
      this.blob.visible = false;
      this.fall.mode = 'drop';
      this.fall.delay = 0.02;
      this.fall.vy = -1.0;
      this.fall.spin.set(
        (Math.random() - 0.5) * 3.2, (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 3.2
      );
      this.state = 'falling';
    }
    p.sink();
  }

  settle(strength) {
    this.charRoot.position.y = 0;
    this.charFlip.quaternion.identity();
    this.character.setAir(0);
    this.character.setSpin(0);
    this.character.impact(strength);
  }

  gameOver() {
    this.state = 'over';
    this.platforms.forEach((p) => { p.group.visible = true; });
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem('jump3d_best', String(this.best));
      this.dom.overTitle.textContent = '新纪录！';
    } else {
      this.dom.overTitle.textContent = '游戏结束';
    }
    this.dom.best.textContent = this.best;
    this.dom.overScore.textContent = this.score;
    this.dom.overBest.textContent = this.best;
    if (this.dom.overPeach) {
      this.dom.overPeach.textContent = this.peaches > 0 ? `🍑 黄桃 ×${this.peaches}` : '';
    }
    /* 奶币结算：本局**捡到的枚数 × coinPerPick** 一次入账。
     * 和分数脱钩了 —— 分数衡量"跳得多好"，奶币衡量"捡了多少"，两件事各算各的。
     * 局内捡到的币不实时入库，账在本局结束时一次结清，中途关页面也不会算错。 */
    const settle = this.runCoins * CFG.coinPerPick;
    if (settle > 0) {
      this.coins += settle;
      try { localStorage.setItem('jump3d_coins', String(this.coins)); } catch (e) { /* 忽略 */ }
      this.refreshCoinUI();
    }
    if (this.dom.overCoin) {
      this.dom.overCoin.innerHTML = this.runCoins > 0
        ? `${coinIco(20)}捡到 ${this.runCoins} 枚 · 结算 +${settle} · 共 ${this.coins}` : '';
    }
    /* 上报成绩：填了昵称才会传，没填就只留在本机。
     * 先清空上一局的提示，避免网络慢的时候还挂着旧名次。 */
    const rk = this.dom.overRank;
    if (rk) {
      rk.textContent = '';
      if (!profile.nick) {
        rk.innerHTML = '设个昵称，成绩就能上全网排行榜';
      } else if (this.score > 0) {
        rk.textContent = '正在提交成绩…';
        submitScore(this.score).then((r) => {
          if (r && r.best != null) {
            rk.innerHTML = `已上榜 · 我的最佳 <b>${r.best}</b> 分`
              + (r.rank ? ` · 第 <b>${r.rank}</b> 名` : '');
          } else {
            rk.textContent = '成绩已提交';
          }
        }).catch((e) => { rk.textContent = '成绩没能提交：' + e.message; });
      }
    }
    this.dom.over.classList.remove('hidden');
    this.dom.hint.classList.add('hidden');
    this.dom.pauseBtn.classList.add('hidden');
  }

  /* ---------------- 暂停 / 返回标题 ---------------- */
  /** 只有"这一局正在打"的四个状态才允许暂停：标题页和结算页本来就停着 */
  canPause() {
    return this.state === 'ready' || this.state === 'charging'
      || this.state === 'jumping' || this.state === 'falling';
  }

  pauseGame() {
    if (!this.canPause()) return false;
    /* 记住从哪个状态暂停的，继续时原样接回去（空中暂停 → 空中继续） */
    this.pausedFrom = this.state;
    /* 蓄力中暂停有个坑：松手时 release() 会因为 state 已经是 paused 而被吃掉，
     * 恢复后就永远卡在 charging 没人推了。干脆把这次蓄力丢掉，回来重新按 ——
     * 简单、可预期，总比"恢复后蓄力条永远涨满不动"强。
     * ★ 这段必须放在 this.state = 'paused' 之前 —— 先改了状态这里就永远判不中 */
    if (this.state === 'charging') {
      this.pausedFrom = 'ready';
      this.power = 0;
      this.dom.bar.classList.remove('show');
    }
    this.state = 'paused';
    /* 蓄力音是靠 tick 每帧推频率的循环音，画面一停它就成了嗡嗡的白噪音 */
    sound.stopCharge();
    this.dom.pauseScore.textContent = this.score;
    this.dom.pauseBest.textContent = this.best;
    this.dom.pause.classList.remove('hidden');
    document.body.classList.add('paused');
    return true;
  }

  resumeGame() {
    if (this.state !== 'paused') return false;
    this.state = this.pausedFrom || 'ready';
    this.pausedFrom = null;
    this.dom.pause.classList.add('hidden');
    document.body.classList.remove('paused');
    return true;
  }

  /** 回标题：这一局整个丢掉，场景重建成开局前的样子（开始页的环绕镜头接管） */
  backToTitle() {
    this.state = 'start';
    this.pausedFrom = null;
    sound.stopCharge();
    this.dom.pause.classList.add('hidden');
    this.dom.over.classList.add('hidden');
    this.dom.start.classList.remove('hidden');
    this.dom.pauseBtn.classList.add('hidden');
    this.dom.hint.classList.add('hidden');
    this.dom.bar.classList.remove('show');
    document.body.classList.remove('paused');
    document.body.classList.add('intro');
    this.resetWorld();
  }

  /* ---------------- UI ---------------- */
  updateScoreUI() {
    this.dom.score.textContent = this.score;
    this.dom.score.classList.remove('bump');
    void this.dom.score.offsetWidth;
    this.dom.score.classList.add('bump');
  }

  setCombo(n) {
    if (n > 1) {
      this.dom.combo.textContent = `完美连击 ×${n}`;
      this.dom.combo.classList.add('show');
    } else {
      this.dom.combo.classList.remove('show');
    }
  }

  /** 砖上飘字。
   *  opts.ms     显示时长（毫秒），默认 1100
   *  opts.strong 带底色胶囊 + 更大字号 —— 给"特殊砖块玩法提示"用。
   *              这类提示是玩家判断下一步的依据，一闪而过等于没有；
   *              普通加分的飘字保持轻快，不然屏幕上全是方块字条。 */
  popText(text, worldPos, color, lift = 0, opts) {
    const o = opts || {};
    const ms = o.ms || 1100;
    const v = worldPos.clone();
    v.y += 1.5 + lift;
    v.project(this.camera);
    const x = (v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    const el = document.createElement('div');
    el.className = 'pop' + (o.strong ? ' pop-strong' : '');
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.color = color;
    // 动画时长和移除时机必须跟着 ms 走，否则字会中途被删或者僵在屏幕上
    el.style.animationDuration = `${ms}ms`;
    this.dom.popLayer.appendChild(el);
    setTimeout(() => el.remove(), ms + 60);
  }

  /* ---------------- 特效 ---------------- */
  ripple(pos, color, scale) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 48),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false,
      })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(pos.x, 0.02, pos.z);
    m.renderOrder = 4;
    this.scene.add(m);
    this.fx.push({ mesh: m, life: 0.62, max: 0.62, kind: 'ring', scale: scale || 1 });
  }

  burst(pos, color, count, speed, size, up) {
    const geo = new THREE.SphereGeometry(size, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.position.set(pos.x, pos.y + 0.1, pos.z);
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const v = speed * (0.6 + Math.random() * 0.7);
      this.scene.add(m);
      this.fx.push({
        mesh: m, life: 0.85, max: 0.85, kind: 'particle',
        vel: new THREE.Vector3(Math.cos(a) * v, (up || 2.2) * (0.6 + Math.random() * 0.8), Math.sin(a) * v),
      });
    }
  }

  perfectBurst(pos, color) {
    const c = color || 0xFFE066;
    this.burst(new THREE.Vector3(pos.x, 0.2, pos.z), c, 14, 1.9, 0.075, 3.2);
    this.ripple(pos, c, 1.6);
  }

  /** 黄桃彩蛋专属：从砖上方洒下一阵金粉，落满整块砖 */
  peachRain(pos) {
    const gold = [0xFFE39A, 0xFFC24D, 0xFFF3D0];
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.05 + Math.random() * 0.035, 8, 6),
        new THREE.MeshBasicMaterial({
          color: gold[i % gold.length], transparent: true, opacity: 1,
        })
      );
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.6;
      m.position.set(pos.x + Math.cos(a) * r, 1.1 + Math.random() * 1.5, pos.z + Math.sin(a) * r);
      this.scene.add(m);
      this.fx.push({
        mesh: m, life: 1.2, max: 1.2, kind: 'particle',
        vel: new THREE.Vector3(Math.cos(a) * 0.5, -0.5 - Math.random() * 0.9, Math.sin(a) * 0.5),
      });
    }
  }

  /** 贴地扬尘：低、散、快消，用来说明"这里有接触" */
  dust(pos, color, count, speed) {
    this.burst(new THREE.Vector3(pos.x, 0.05, pos.z), color, count, speed, 0.038, 0.75);
  }

  camPunch() { this.punch = 0.16; }

  /* ---------------- 主循环 ---------------- */
  tick(stepDt) {
    if (this._frozen) {   // ?adv 快进结束后定格：只重画，不推进时间
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.state === 'paused') {   // 暂停：画面定格，只重画
      /* 必须把 clock 排空 —— 否则恢复的第一帧拿到「暂停了多久」这个巨大的
       * delta（有 clamp 0.1 兜底，但蓄力/坠落还是会白跳一小截）。 */
      this.clock.getDelta();
      this.renderer.render(this.scene, this.camera);
      return;
    }
    let dt;
    if (stepDt) {
      dt = stepDt;
      this.clock.elapsedTime += stepDt;
    } else {
      dt = clamp(this.clock.getDelta(), 0.0001, 0.1);
    }
    const time = this.clock.elapsedTime;

    /* 冻结倒计时。这期间 press() 会被直接挡掉 —— 玩家是真的拿不回控制权，
     * 不是"能点但跳不远"。倒计时走完自己解冻，顺手抖落一层碎冰。 */
    if (this.frozenT > 0) {
      this.frozenT -= dt;
      if (this.frozenT <= 0) this.thawChar();
    }

    if (this.chargeTarget != null && this.state === 'charging' && this.power >= this.chargeTarget) {
      this.chargeTarget = null;
      this.release();
    }

    if (this.state === 'charging') {
      this.power = clamp(this.power + dt / CFG.chargeTime, 0, 1);
      sound.updateCharge(this.power);
      this.dom.barFill.style.width = `${this.power * 100}%`;
      this.dom.barFill.style.background = this.power > 0.86
        ? 'linear-gradient(90deg,#FFD166,#FF6B6B)'
        : 'linear-gradient(90deg,#5CE1C4,#6C8CF5)';
      this.camDistScale = lerp(this.camDistScale, 0.94 - this.power * 0.05, 1 - Math.pow(0.001, dt));
      // 高蓄力的抖动：写在 character.group 上（只影响画面），不污染 charRoot 的物理坐标。
      // 每帧重新赋值而不是累加 —— 否则角色会随机游走，起跳点也跟着漂。
      const amp = this.power > 0.5 ? (this.power - 0.5) / 0.5 * 0.028 : 0;
      this.character.group.position.set(
        (Math.random() - 0.5) * amp,
        (Math.random() - 0.5) * amp * 0.6,
        (Math.random() - 0.5) * amp
      );
    } else {
      this.character.group.position.set(0, 0, 0);
    }
    this.character.setCharge(this.state === 'charging' ? this.power : 0);

    if (this.state === 'jumping') {
      const j = this.jump;
      j.t = clamp(j.t + dt / j.dur, 0, 1);
      const t = j.t;
      // 水平带一点缓入缓出：起步有加速、落地有减速，比全程匀速"活"
      const ht = t + (smoothstep(t) - t) * 0.38;
      this.charRoot.position.x = lerp(j.from.x, j.to.x, ht);
      this.charRoot.position.z = lerp(j.from.z, j.to.z, ht);
      this.charRoot.position.y = 4 * j.h * t * (1 - t);
      this.character.setSpin(Math.PI * 2 * smoothstep(t) * j.spinSign);
      // 形变包络：起跳爆发拉伸 → 空中巡航 → 落地前收身
      const pop = 1.45 * Math.exp(-t * 11);
      const cruise = 0.34 * Math.sin(Math.PI * Math.pow(t, 0.85));
      this.character.setAir(pop + cruise);
      if (t >= 1) {
        this.charRoot.position.y = 0;
        this.finishJump();
      }
    }

    if (this.state === 'falling') {
      const f = this.fall;
      if (f.delay > 0) {
        f.delay -= dt;
        if (f.mode === 'tip') {
          const k = clamp(1 - f.delay / f.tipDur, 0, 1);
          this.character.setSpin(f.tipAmount * k);
          this.charRoot.position.y = -k * 0.05;
        }
      } else {
        if (f.mode === 'tip') {
          f.spinZ = lerp(f.spinZ, f.tipAmount, 1 - Math.pow(0.02, dt));
          this.character.setSpin(f.spinZ);
          this.fallTimer += dt;
          this.charRoot.position.y -= dt * (1 + this.fallTimer * 9);
          if (this.charRoot.position.y < -9) this.gameOver();
        } else {
          f.vy -= 26 * dt;
          this.charRoot.position.y += f.vy * dt;
          // 纸片人：在空中打转，转速取自原来的三轴随机翻滚
          f.spinZ += dt * (f.spin.z * 1.6 + (f.spin.x >= 0 ? 1.1 : -1.1));
          this.character.setSpin(f.spinZ);
          if (this.charRoot.position.y < -9) this.gameOver();
        }
      }
    }

    // 角色自身动画（纸片人需要相机朝向，用于对齐立绘平面）
    this.character.update(dt, this.camera);

    // 方块：图案缓转、移动砖实时走位、彩蛋光环呼吸、被踩后的回弹、脆砖倒计时
    /* 倒序遍历：脆砖下沉放完（dead）要就地摘掉，正序删会漏掉后面几块 */
    for (let i = this.platforms.length - 1; i >= 0; i--) {
      const p = this.platforms[i];
      if (p.icon && p.iconSpin) p.icon.rotation.z = time * p.iconSpin;
      p.update(dt, time);
      if (p.dead) {
        this.platforms.splice(i, 1);
        p.dispose(this);
      }
    }
    /* 站在会跑的砖上，人得跟着一起走（蓄力中也算，否则一蓄力砖就把人丢了） */
    if (this.current && this.current.moveAmp
      && (this.state === 'ready' || this.state === 'charging')) {
      const dm = this.current.moveDelta;
      if (dm) {
        if (this.current.moveAxis === 'x') this.charRoot.position.x += dm;
        else this.charRoot.position.z += dm;
      }
    }

    /* 奶币拾取：从"角色胸口"量到币心的球体判定。
     *   · 只用 ready / jumping 两个状态 —— 坠落下落中还能顺手捞币会很怪
     *   · 圆心在砖上、币悬在 coinY，所以"落得越准越能碰到"：落在砖正中间
     *     会连着币一起收下，只蹭到砖边就过去了。
     * 判定放在这里（而不是 finishJump）是因为跳跃途中就该收下 ——
     * 落地的瞬间币早在身后了。 */
    if (this.state === 'ready' || this.state === 'jumping') {
      const cx = this.charRoot.position.x;
      const cz = this.charRoot.position.z;
      const cy = this.charRoot.position.y + CFG.coinChest;
      const rr = CFG.coinPickR * CFG.coinPickR;
      for (let i = this.platforms.length - 1; i >= 0; i--) {
        const p = this.platforms[i];
        if (!p.coin || p.coinTaken) continue;
        const dx = cx - p.center.x;
        const dz = cz - p.center.z;
        const dy = cy - CFG.coinY;
        if (dx * dx + dz * dz + dy * dy <= rr) this.pickCoin(p);
      }
    }

    // 特效
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life -= dt;
      const k = 1 - f.life / f.max;
      if (f.kind === 'ring') {
        f.mesh.scale.setScalar(1 + k * 3.4 * (f.scale || 1));
        f.mesh.material.opacity = 0.75 * (1 - k);
      } else {
        f.vel.y -= 9 * dt;
        f.mesh.position.addScaledVector(f.vel, dt);
        f.mesh.material.opacity = 0.95 * (1 - k);
        f.mesh.scale.setScalar(1 - k * 0.4);
      }
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        f.mesh.material.dispose();
        this.fx.splice(i, 1);
      }
    }

    // 接触阴影
    if (this.blob.visible) {
      const y = this.charRoot.position.y;
      const groundY = this.state === 'jumping' || this.state === 'falling' ? -1.4 : 0;
      this.blob.position.set(this.charRoot.position.x, 0.02, this.charRoot.position.z);
      const h = Math.max(0, y - groundY);
      const s = clamp(1 - h * 0.30, 0.22, 1);
      this.blob.scale.setScalar(s);
      this.blob.material.opacity = 0.8 * s;
      this.blob.visible = this.state !== 'over';
      if (this.state === 'falling' || this.state === 'over') this.blob.visible = false;
    }

    // 相机
    if (this.state !== 'start') {
      const cx = (this.current.center.x + this.next.center.x) / 2;
      const cz = (this.current.center.z + this.next.center.z) / 2;
      const flying = this.state === 'jumping' || this.state === 'falling';
      if (flying) {
        this.camLookTarget.set(this.charRoot.position.x, CFG.camLookY, this.charRoot.position.z);
        this.camLookTarget.x = lerp(cx, this.charRoot.position.x, 0.45);
        this.camLookTarget.z = lerp(cz, this.charRoot.position.z, 0.45);
        // 跟住高度，否则跳到最高点会顶出画面（顺带把镜头拉远一点给腾空留位置）
        this.camLookTarget.y = CFG.camLookY + clamp(this.charRoot.position.y * 0.44, 0, 1.7);
      } else {
        this.camLookTarget.set(cx, CFG.camLookY, cz);
      }
      // 落地冲击：镜头先沉一下再弹回来，落地才有"重量感"
      if (this.camDip > 0.0002) this.camDip *= Math.pow(0.004, dt);
      else this.camDip = 0;
      if (this.camKick > 0.0002) this.camKick *= Math.pow(0.0002, dt);
      else this.camKick = 0;
      this.camLookTarget.y -= this.camDip;

      const k = 1 - Math.pow(0.0016, dt);
      this.camLook.lerp(this.camLookTarget, k);
      this.camDistScale = lerp(this.camDistScale, flying ? 1.12 : 1, 1 - Math.pow(0.05, dt));

      const off = CFG.camOffset.clone().multiplyScalar(this.camDistScale);
      if (this.punch > 0) {
        this.punch = Math.max(0, this.punch - dt * 0.9);
        off.multiplyScalar(1 - this.punch * 0.55);
      }
      const desired = this.camLook.clone().add(off);
      this.camera.position.lerp(desired, 1 - Math.pow(0.0009, dt));
      if (this.camKick > 0) {
        this.camera.position.x += (Math.random() - 0.5) * this.camKick;
        this.camera.position.z += (Math.random() - 0.5) * this.camKick;
      }
      this.camera.lookAt(this.camLook.x, this.camLook.y + 0.15, this.camLook.z);
      this.placeKeyLight();
    } else {
      // 开始界面：缓慢环绕
      const a = time * 0.16;
      const r = 8.2;
      this.camera.position.set(Math.cos(a) * r, 5.4, Math.sin(a) * r);
      this.camera.lookAt(0, -0.85, 0);
      this.camLook.set(0, CFG.camLookY, 0);
      this.placeKeyLight();
      this.charRoot.position.set(0, 0, 0);
      this.character.faceTo(Math.cos(a), Math.sin(a));
    }

    if (!this._noRender) this.renderer.render(this.scene, this.camera);

    if (this.dbg) {
      this.dbg.textContent = JSON.stringify({
        s: this.state, sc: this.score, p: +this.power.toFixed(2),
        x: +this.charRoot.position.x.toFixed(2),
        y: +this.charRoot.position.y.toFixed(2),
        z: +this.charRoot.position.z.toFixed(2),
        n: this.platforms.length,
        cur: [+this.current.center.x.toFixed(2), +this.current.center.z.toFixed(2)],
        nxt: [+this.next.center.x.toFixed(2), +this.next.center.z.toFixed(2)],
        // 角色到所站砖圆心的距离：站在会移动的砖上时，这个值应该保持不变
        dc: +this.current.distToCenter(this.charRoot.position.x, this.charRoot.position.z).toFixed(3),
        // 上一次起跳：起跳砖的特性和抛物线高度（弹簧砖的"弹飞"加成靠它对账）
        lk: this.lastJump.trait,
        lh: +this.lastJump.h.toFixed(2),
        sp: +this.current.spring.toFixed(2),
      });
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  /* 调试探针靠这几个全局判断"页面到底跑起来没有、走的是云端还是本地模式"；
   * __CFG 是只读引用，方便探针按真实常量做断言（而不是抄一份数字写死）。
   * __sound 同理：奶块音效这种"到底有没有真的去放"的事，只能靠包一层
   * laugh() 来数次数 —— 无头环境听不到声音。 */
  window.__api = api;
  window.__CFG = CFG;
  window.__game = new Game();
  window.__sound = sound;
});
