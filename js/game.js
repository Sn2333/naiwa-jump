/**
 * game.js —— 3D 跳一跳（WeChat Jump 风格）
 * 按住蓄力，松开起跳；落在方块正中可获得连击奖励
 */
import * as THREE from './vendor/three.module.js';
import { Character3D, charList } from './character.js';
import { DEFAULT_CHAR } from './sprite_data.js';
import { bgList, bgDef, DEFAULT_BG } from './theme.js';
import { api, session, loadSession, isLoggedIn, logout, register, login, submitScore, leaderboard } from './api.js';
import { sound } from './audio.js';
import { edgeOver, perfectTol } from './hit.js';

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
  chargeTime: 0.98,
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

  /* 特色砖出现率（迷你砖由上面的曲线单独控制） */
  movingChance: 0.15,
  springChance: 0.09,
  peachChance: 0.05,

  /* 从弹簧砖起跳的弧线抬高比例。只抬高不改变落点 —— 蓄力多少还是跳多远，
   * 所以不会因为"弹过头"而越过目标砖，纯粹是看得见的手感差异 */
  springLift: 1.55,

  /* 落脚判定：全部以"看得见的轮廓"为准
   *   edgeGrace —— 中心越过边缘这么多以内，仍算站住（踩边不算掉）
   *   tipBand   —— 越过边缘这么多以内算"踩空翻下去"，再多就是直接落空 */
  edgeGrace: 0.05,
  tipBand: 0.30,
};

const PALETTE = [
  0x6C7BF5, 0x4FB3A6, 0xE4739A, 0xF0A93C, 0x7C6FE0,
  0x3FA9F5, 0xE0705C, 0x5EC9A8, 0xC98BEE, 0xEFC84A,
];

/* 落在不同砖上的收益：普通 1、迷你砖风险补偿、特殊图案、彩蛋 */
const POINTS = { base: 1, mini: 2, spring: 3, special: 5, peach: 10 };

const MINI_SCALE = 0.62;          // 迷你砖相对正常砖的半径比例
const SPECIALS = ['note', 'gift', 'star', 'spiral', 'heart', 'diamond', 'coin', 'clover'];
const PEACH_COLOR = 0xDE9A22;     // 黄桃块：琥珀金的砖身（顶面另配奶油色）

/* ------------------------------------------------------------------ */
/* 方块顶面图案                                                        */
/* ------------------------------------------------------------------ */
/* 图案纹理按种类缓存复用：方块来来去去，没必要每块都重画一遍 canvas */
const ICON_CACHE = new Map();

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
  } else if (kind === 'coin') {
    ctx.beginPath(); ctx.arc(0, 0, 74, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = 13;
    ctx.beginPath(); ctx.arc(0, 0, 50, 0, Math.PI * 2); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2); ctx.fill();
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
    this.kind = opts.kind || 'round';       // round / twoTier / box / oct
    this.trait = opts.trait || null;        // null / moving / spring / peach
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
    const sideMat = new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.05 });
    const topMat = new THREE.MeshStandardMaterial({ color: top, roughness: 0.55, metalness: 0.05 });
    const h = this.height;

    const makeCyl = (r, hh, y, material, seg = 44) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hh, seg), material);
      m.position.y = y;
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
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
    if (this.halo) {
      // 只做很轻的呼吸。之前 0.40±0.22 太亮，那圈加色金环把切面压成了"瓷盘边"
      const pulse = 0.15 + 0.09 * Math.sin(time * 2.6);
      this.halo.material.opacity = pulse;
      const s = 1 + 0.05 * Math.sin(time * 2.6);
      this.halo.scale.setScalar(s);
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
      // 图案贴图在 ICON_CACHE 里共享，谁都不能单独 dispose，否则别的砖会变成空白
      if (o.material) o.material.dispose();
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
      acctTabs: document.getElementById('acctTabs'),
      paneLogin: document.getElementById('paneLogin'),
      paneReg: document.getElementById('paneReg'),
      acctMsg: document.getElementById('acctMsg'),
      liNick: document.getElementById('liNick'),
      liPwd: document.getElementById('liPwd'),
      liGo: document.getElementById('liGo'),
      rgNick: document.getElementById('rgNick'),
      rgPwd: document.getElementById('rgPwd'),
      rgPwd2: document.getElementById('rgPwd2'),
      rgGo: document.getElementById('rgGo'),
      logoutBtn: document.getElementById('logoutBtn'),
      rankBtn: document.getElementById('rankBtn'),
      rankPanel: document.getElementById('rankPanel'),
      rankClose: document.getElementById('rankClose'),
      rankMe: document.getElementById('rankMe'),
      rankList: document.getElementById('rankList'),
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
    this.plainMode = this.q.has('plain');   // 只用基础砖：跑稳定的回归用例
    /* 角色：默认经典奶蛙，选择结果持久化，下次打开还是上次那只 */
    this.charKey = localStorage.getItem('jump3d_char') || DEFAULT_CHAR;
    /* 背景：默认奶油黄 */
    this.bgKey = localStorage.getItem('jump3d_bg') || DEFAULT_BG;
    /* 账号：读回上次的登录态；没登录就是游客，照样能玩，只是成绩不上榜 */
    loadSession();
    this.rankBusy = false;
    this.state = 'start';
    this.score = 0;
    this.steps = 0;
    this.peaches = 0;
    this.best = Number(localStorage.getItem('jump3d_best') || 0);
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
    this.watchPanels();
    this.applyBg(this.bgKey);     // 会顺带把雾色也对齐，必须在 setupScene 之后
    this.refreshAccountUI();
    this.resetWorld();
    this.dom.best.textContent = this.best;

    this.renderer.setAnimationLoop(() => this.tick());
    this.debugHooks();
    document.body.classList.add('intro');
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
    // ?bg=<key> 换背景、?bgpanel 直接掀开背景面板（都是为了无头截图能验到）
    if (q.has('bg')) {
      this.applyBg(q.get('bg'));
      this.buildBgGrid();
    }
    if (q.has('bgpanel')) setTimeout(() => this.openBgPanel(), 120);
    // ?account 掀开账号面板、?rank 掀开排行榜；?login=昵称:密码 直接登录（截图用）
    if (q.has('account')) setTimeout(() => this.openAccountPanel(), 120);
    if (q.has('rank')) setTimeout(() => this.openRankPanel(), 120);
    if (q.has('login')) {
      const [n, p] = String(q.get('login')).split(':');
      setTimeout(() => {
        this.dom.liNick.value = n; this.dom.liPwd.value = p || '';
        this.doLogin();
      }, 120);
    }
    /* ?reg=昵称:密码 直接注册 —— 和 ?login 对称，纯粹为了无头截图能一次性
     * 走到"已登录"状态（本地模式下注册结果只落在这台设备的 localStorage）。 */
    if (q.has('reg')) {
      const [n, p] = String(q.get('reg')).split(':');
      setTimeout(() => {
        this.switchAcctTab('reg');
        this.dom.rgNick.value = n;
        this.dom.rgPwd.value = p || '';
        this.dom.rgPwd2.value = p || '';
        this.doRegister();
      }, 120);
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
    const up = (e) => {
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

    document.getElementById('startBtn').addEventListener('click', () => { sound.ensure(); this.beginRun(); });
    document.getElementById('againBtn').addEventListener('click', () => this.beginRun());
    this.dom.mute.addEventListener('click', () => {
      sound.muted = !sound.muted;
      if (sound.muted) sound.stopCharge();
      this.dom.mute.classList.toggle('off', sound.muted);
      this.dom.mute.textContent = sound.muted ? '🔇' : '🔊';
    });
  }

  /* ---------------- 角色选择 ---------------- */
  /* 面板挂在开始界面上，背后就是 3D 场景，所以换角色时立绘的变化是即时可见的 */
  setupCharPanel() {
    this.buildCharGrid();
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
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'charCell' + (c.key === this.charKey ? ' on' : '');
      cell.dataset.key = c.key;
      const img = document.createElement('img');
      img.src = c.uri;
      img.alt = c.name;
      img.loading = 'lazy';
      img.draggable = false;
      const label = document.createElement('span');
      label.textContent = c.name;
      cell.append(img, label);
      cell.addEventListener('click', () => this.pickChar(c.key));
      frag.appendChild(cell);
    }
    grid.appendChild(frag);
  }

  openCharPanel() {
    this.dom.bgPanel.classList.add('hidden');
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
    this.dom.charPanel.classList.add('hidden');
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

  /* ---------------- 账号 / 排行榜 ---------------- */
  /* 游客也能完整玩，只是成绩不上传。注册只要昵称 + 密码：
   * 昵称就是唯一登录名，所以"昵称不可重复"由后端保证（本地模式由本地表保证）。 */
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

    for (const tab of d.acctTabs.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => this.switchAcctTab(tab.dataset.tab));
    }
    d.liGo.addEventListener('click', () => this.doLogin());
    d.rgGo.addEventListener('click', () => this.doRegister());
    d.logoutBtn.addEventListener('click', () => {
      logout();
      this.acctMsg('已经退出，现在是游客');
      this.refreshAccountUI();
    });
    // 回车直接提交，省得手机上还要去点按钮
    d.liPwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doLogin(); });
    d.rgPwd2.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.doRegister(); });
  }

  switchAcctTab(name) {
    for (const tab of this.dom.acctTabs.querySelectorAll('.tab')) {
      tab.classList.toggle('on', tab.dataset.tab === name);
    }
    this.dom.paneLogin.classList.toggle('hidden', name !== 'login');
    this.dom.paneReg.classList.toggle('hidden', name !== 'reg');
    this.acctMsg('');
  }

  acctMsg(text, kind = '') {
    const el = this.dom.acctMsg;
    el.textContent = text || '';
    el.className = kind;
  }

  /** 把登录态同步到三处界面：昵称标签、账号面板、结束页的提示 */
  refreshAccountUI() {
    const d = this.dom;
    const on = isLoggedIn();
    d.acctWho.innerHTML = on
      ? `当前登录：<b>${escapeHTML(session.nick)}</b>`
      : (api.online
        ? '现在是<b>游客</b>，成绩不会上榜'
        : '现在是<b>游客</b>（本地模式，榜单只在本机）');
    d.logoutBtn.classList.toggle('hidden', !on);
    d.accountBtn.textContent = on ? '我 的 账 号' : '登 录 / 注 册';

    d.userTag.classList.toggle('hidden', !on);
    if (on) d.userTag.innerHTML = `已登录 <b>${escapeHTML(session.nick)}</b>`;
  }

  openAccountPanel() {
    this.dom.charPanel.classList.add('hidden');
    this.dom.bgPanel.classList.add('hidden');
    this.dom.rankPanel.classList.add('hidden');
    this.dom.accountPanel.classList.remove('hidden');
    this.acctMsg('');
    this.refreshAccountUI();
  }

  closeAccountPanel() { this.dom.accountPanel.classList.add('hidden'); }

  async doRegister() {
    const d = this.dom;
    d.rgGo.disabled = true;
    this.acctMsg('注册中…');
    try {
      const r = await register(d.rgNick.value, d.rgPwd.value, d.rgPwd2.value);
      d.rgPwd.value = ''; d.rgPwd2.value = '';
      this.acctMsg(`注册成功，欢迎 ${r.nick}`, 'ok');
      this.refreshAccountUI();
      sound.pick();
      // 注册完顺手把这局的最佳成绩补交一次，别让人觉得白注册了
      this.pushBest();
    } catch (e) {
      this.acctMsg(e.message, 'err');
    } finally {
      d.rgGo.disabled = false;
    }
  }

  async doLogin() {
    const d = this.dom;
    d.liGo.disabled = true;
    this.acctMsg('登录中…');
    try {
      const r = await login(d.liNick.value, d.liPwd.value);
      d.liPwd.value = '';
      this.acctMsg(`登录成功，欢迎回来 ${r.nick}`, 'ok');
      this.refreshAccountUI();
      sound.pick();
      this.pushBest();
    } catch (e) {
      this.acctMsg(e.message, 'err');
    } finally {
      d.liGo.disabled = false;
    }
  }

  /** 把本机最佳成绩补交一次（登录时用；服务端只保留更高的那个） */
  pushBest() {
    if (!isLoggedIn() || this.best <= 0) return;
    submitScore(this.best).catch(() => { /* 补交失败不打扰玩家 */ });
  }

  async openRankPanel() {
    this.dom.charPanel.classList.add('hidden');
    this.dom.bgPanel.classList.add('hidden');
    this.dom.accountPanel.classList.add('hidden');
    this.dom.rankPanel.classList.remove('hidden');
    await this.refreshRank();
  }

  closeRankPanel() { this.dom.rankPanel.classList.add('hidden'); }

  /** 四个面板任意一个开着，就给 body 挂 has-panel —— 底下的开始页/HUD 靠这个淡掉。
   *  面板是半透明的（故意留出 3D 场景），不淡掉底下的按钮就会叠字、看不清。 */
  syncPanels() {
    const d = this.dom;
    const open = !d.charPanel.classList.contains('hidden')
      || !d.bgPanel.classList.contains('hidden')
      || !d.accountPanel.classList.contains('hidden')
      || !d.rankPanel.classList.contains('hidden');
    document.body.classList.toggle('has-panel', open);
  }

  /** 用 MutationObserver 统一盯着四个面板的 class，省得每加一个开关都去补一次调用 */
  watchPanels() {
    const panels = [this.dom.charPanel, this.dom.bgPanel,
      this.dom.accountPanel, this.dom.rankPanel];
    if (typeof MutationObserver !== 'function') return;
    const mo = new MutationObserver(() => this.syncPanels());
    for (const p of panels) mo.observe(p, { attributes: true, attributeFilter: ['class'] });
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
        : (isLoggedIn() ? '还没有成绩，先玩一局' : '登录之后成绩才能上榜');
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
          const sc = document.createElement('span');
          sc.className = 'sc';
          sc.textContent = e.best + ' 分';
          row.append(no, nk, sc);
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
    const def = this.character.setChar(key);
    if (def.key === this.charKey) return;
    this.charKey = def.key;
    localStorage.setItem('jump3d_char', def.key);
    for (const el of this.dom.charGrid.children) {
      el.classList.toggle('on', el.dataset.key === def.key);
    }
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
    this.fallTimer = 0;
    this.punch = 0;
    this.lastJump = { trait: null, dist: 0, h: 0 };
    this.spawnNext();

    this.updateScoreUI();
    this.setCombo(0);

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
    const gap = this.fixedGap != null
      ? this.fixedGap
      : gapMin + Math.random() * (gapMax - gapMin);
    const x = this.current.center.x + (axis === 'x' ? -gap : 0);
    const z = this.current.center.z + (axis === 'z' ? -gap : 0);

    /* 特色砖抽签。黄桃是彩蛋：开局几块不出现，不连着来两块，也不叠在移动砖上 */
    let trait = this.forceTrait || null;
    if (!trait && !this.plainMode) {
      if (this.steps >= 3 && this.current.trait !== 'peach'
        && Math.random() < CFG.peachChance) {
        trait = 'peach';
      } else if (Math.random() < CFG.springChance) {
        trait = 'spring';
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

    let kind;
    if (trait === 'spring' || trait === 'peach') {
      kind = 'round';                       // 这两种砖的外观自带造型，用圆底
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
    if (radius < 0.34) radius = 0.34;

    let height = 1.35 + Math.random() * 1.1;
    if (trait === 'spring') height = 1.05 + Math.random() * 0.5;

    const p = new Platform(this, x, z, {
      kind, radius, trait, mini, special, height,
      moveAxis: axis === 'x' ? 'z' : 'x',
      moveAmp: trait === 'moving' ? 0.50 + Math.random() * 0.45 : 0,
      moveSpeed: trait === 'moving' ? 0.75 + Math.random() * 0.55 : 0,
      movePhase: trait === 'moving' ? Math.random() * Math.PI * 2 : 0,
      color: trait === 'peach' ? PEACH_COLOR : PALETTE[(Math.random() * PALETTE.length) | 0],
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
    this.dom.start.classList.add('hidden');
    this.dom.over.classList.add('hidden');
    this.closeCharPanel();
    this.closeBgPanel();
    this.closeAccountPanel();
    this.closeRankPanel();
    this.dom.hint.classList.remove('hidden');
    this.resetWorld();
    this.state = 'ready';
    setTimeout(() => this.dom.hint.classList.add('hidden'), 3200);
  }

  press() {
    if (this.state === 'start') { sound.ensure(); this.beginRun(); return; }
    if (this.state !== 'ready') return;
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
    const dist = CFG.jumpMin + this.power * CFG.jumpRange;
    const dir = new THREE.Vector3(
      this.next.center.x - this.current.center.x, 0,
      this.next.center.z - this.current.center.z
    ).normalize();
    this.dir.copy(dir);
    this.steps++;

    this.faceCamera(dir);

    this.jump.from.copy(this.charRoot.position);
    this.jump.to.set(
      this.charRoot.position.x + dir.x * dist, 0,
      this.charRoot.position.z + dir.z * dist
    );
    this.jump.t = 0;
    // 跳跃时长：短距离 0.34s、最远 0.60s，整体比之前快约三成
    this.jump.dur = 0.28 + dist * 0.067;
    /* 从弹簧砖起跳：弧线抬高五成 —— 收益不变、落点不变（不破坏平衡），
     * 但画面上就是"被弹簧弹出去"，和普通砖一眼分得出 */
    const lift = this.current.trait === 'spring' ? CFG.springLift : 1;
    this.jump.h = (0.95 + dist * 0.34) * lift;
    // 供调试状态栏读取：验证"从弹簧砖起跳弧线更高"是否真的生效
    this.lastJump = { trait: this.current.trait, dist, h: this.jump.h };
    // 纸片人：翻转方向按"前进方向在屏幕上的左右"决定，正着翻
    this.jump.spinSign = dir.dot(this.screenRight(this._tmpV)) >= 0 ? -1 : 1;

    this.state = 'jumping';
    this.character.setCharge(0);
    // 起跳扬尘
    this.burst(new THREE.Vector3(this.jump.from.x, 0.06, this.jump.from.z),
      0xE4EDFF, 8, 0.8, 0.045, 1.3);
    sound.jump();
    this.updateScoreUI();
  }

  finishJump() {
    const land = this.charRoot.position.clone();

    // 1) 还站在起跳方块上：原地跳，不计分
    if (this.current.edgeOver(land.x, land.z) <= CFG.edgeGrace) {
      this.settle(0.5);
      this.current.kick(0.5);
      this.ripple(land, 0xFFFFFF, 0.7);
      this.dust(land, 0xD8E2FF, 6, 0.55);
      sound.land();
      this.popText('原地跳', land, '#B9C4E8');
      this.combo = 0;
      this.setCombo(0);
      this.state = 'ready';
      return;
    }

    const target = this.next;
    const over = target.edgeOver(land.x, land.z);

    // 2) 落在目标方块上（含踩边的一点点宽容）
    if (over <= CFG.edgeGrace) {
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
        this.popText(`黄桃  +${POINTS.peach}`, target.center, '#FFD36E', 0.80);
        this.perfectBurst(target.center, 0xFFD36E);
        this.peachRain(target.center);
        sound.peach();
        this.camPunch();
      } else if (target.trait === 'spring') {
        gain += POINTS.spring;
        this.popText(`弹簧  +${POINTS.spring}`, target.center, '#9BE8D8', 0.80);
        this.perfectBurst(target.center, 0x9BE8D8);
        sound.spring();
      } else if (target.mini) {
        gain += POINTS.mini;
        this.popText(`迷你砖  +${POINTS.mini}`, target.center, '#BFE3FF', 0.80);
      }
      if (target.special) {
        gain += POINTS.special;
        this.popText(`幸运方块  +${POINTS.special}`, target.center, '#9BE8D8', 1.55);
        sound.bonus();
        this.perfectBurst(target.center, 0x9BE8D8);
      }

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
    if (over <= CFG.tipBand) {
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
    /* 上报成绩：只有登录用户才传，游客的成绩留在本机。
     * 先清空上一局的提示，避免网络慢的时候还挂着旧名次。 */
    const rk = this.dom.overRank;
    if (rk) {
      rk.textContent = '';
      if (!isLoggedIn()) {
        rk.innerHTML = '登录后成绩可以上全网排行榜';
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

  popText(text, worldPos, color, lift = 0) {
    const v = worldPos.clone();
    v.y += 1.5 + lift;
    v.project(this.camera);
    const x = (v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
    const el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.color = color;
    this.dom.popLayer.appendChild(el);
    setTimeout(() => el.remove(), 1100);
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
    let dt;
    if (stepDt) {
      dt = stepDt;
      this.clock.elapsedTime += stepDt;
    } else {
      dt = clamp(this.clock.getDelta(), 0.0001, 0.1);
    }
    const time = this.clock.elapsedTime;

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

    // 方块：图案缓转、移动砖实时走位、彩蛋光环呼吸、被踩后的回弹
    for (const p of this.platforms) {
      if (p.icon && p.iconSpin) p.icon.rotation.z = time * p.iconSpin;
      p.update(dt, time);
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
  /* 调试探针靠这两个全局判断"页面到底跑起来没有、走的是云端还是本地模式" */
  window.__api = api;
  window.__game = new Game();
});
