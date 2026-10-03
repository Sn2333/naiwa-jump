import * as THREE from './vendor/three.module.js';
import { CHARS, DEFAULT_CHAR } from './sprite_data.js';
import { ANIM_CHARS } from './anim_data.js';
import { accDef } from './acc.js';
import { ACC_IMG, ACC_BOX } from './acc_data.js';

/* ------------------------------------------------------------------ */
/* 纸片人角色                                                          */
/*                                                                     */
/* 不使用程序化建模：直接把参考图里的角色抠成带透明通道的立绘，        */
/* 贴在一张永远正对相机的平面上（billboard），靠缩放/倾斜做动作。      */
/* 贴图与几何数据由 dev/extract_chars.py 从原图自动生成。             */
/*                                                                     */
/* 全套角色共用同一个几何体：PlaneGeometry(1,1) 只是单位方片，          */
/* 真实宽高由 mesh.scale 决定。这样换角色时只要换贴图 + 重算 scale     */
/* 与脚底位置，不用重建几何，也不会漏改某处尺寸。                      */
/*                                                                     */
/* 动作手感要点：                                                      */
/*   · 所有形变量都走"趋缓/弹簧"，没有一处是直接赋值 —— 数值不再瞬跳   */
/*   · 蓄力用对称趋缓（软）；起跳拉伸用非对称趋缓（快起慢落，有爆发感）*/
/*   · 落地用一个欠阻尼弹簧，压扁 → 回弹过冲成拉伸 → 收敛            */
/* ------------------------------------------------------------------ */

/* 角色 = 抠好的静态立绘（sprite_data）+ 动图角色（anim_data）。
 * 两者字段完全一致，只是动图那只多带了 cols/rows/frames/durs。
 * 逻辑上不必分两套：静态角色就是"只有一帧、且这一帧永远播不完"的动图。 */
const ALL_CHARS = CHARS.concat(ANIM_CHARS);
const BY_KEY = new Map(ALL_CHARS.map((c) => [c.key, c]));

/** 角色清单（给 UI 用） */
export function charList() { return ALL_CHARS; }
/** 按 key 取角色定义，找不到就退回默认角色 */
export function charDef(key) { return BY_KEY.get(key) || BY_KEY.get(DEFAULT_CHAR) || ALL_CHARS[0]; }

const CFG = {
  height: 1.62,        // 角色在世界里的高度（单位与方块一致）
  lift: 0.015,         // 略微抬离地面，避免与方块顶面共面闪烁
  outline: 0.035,      // 贴纸描边：在角色后面垫一层放大的深色剪影
  outlineColor: 0x2A1B08,

  chargeHL: 0.055,     // 蓄力形变的趋缓半衰期（秒）
  airUpHL: 0.030,      // 起跳拉伸的上升半衰期（越小越"弹"）
  airDownHL: 0.150,    // 拉伸回落半衰期

  squashK: 430,        // 落地弹簧刚度
  squashC: 14,         // 落地弹簧阻尼（欠阻尼 → 会过冲成拉伸）
  squashMax: 0.30,     // 满冲击时的压扁比例
  stretchMax: 0.26,    // 弹簧过冲到拉伸时的比例

  /* 弹簧砖的"蹦床"通道。和上面那条落地弹簧刻意分开：
   * 落地弹簧刚度 430、周期只有 0.3 秒，是"硌一下"的手感；
   * 蹦床刚度 100、阻尼比 ≈0.18，周期 0.63 秒、要来回弹三四下才停 —— 这才像弹簧。
   * 一开始用的是 150/5，周期 0.5 秒，截图发现高光时刻只有 0.15 秒，
   * 一晃就过去了，等于白做，所以往"软而慢"又调了一档。
   * 而且它是"整块人上下位移 + 形变"一起动，不像落地只压扁。 */
  boingK: 100,
  boingC: 3.6,
  boingLift: 0.50,     // 弹跳位移相对形变量的换算（1 个形变量 → 0.5 个世界单位）
  boingSquash: 0.40,   // 被压下去时的压扁比例
  boingStretch: 0.60,  // 弹起来时的拉长比例

  /* —— 装饰（头饰）—— */
  accHeadMinW: 0.30,   // 一行实心宽度达到"最宽行"的这个比例才算"头顶"（跳过呆毛/天线）
  accZ: 0.012,         // 头饰前移量：立绘在 z=0、描边在 z=-0.004，正 z 就是更靠镜头
};

/* 头顶锚点缓存：键是角色 key。
 * 30 只角色每只都要读一次贴图 alpha 去找头顶，换角色来回切时不必重算。
 * 缓存的是归一化值（相对贴图宽高），和缩放无关，改 CFG.height 也不会失效。 */
const HEAD_ANCHOR = new Map();

/** 从贴图剪影里找"头顶"：返回 { nx, ny, wRel }（都是 0~1 的归一化值）
 *  nx  = 头顶水平中心（相对贴图宽）
 *  ny  = 头顶纵坐标（相对贴图高，0 = 图顶）
 *  wRel= 头部实心宽度（相对贴图宽）—— 头饰按它等比缩放，大头的角色戴大帽子
 *
 *  为什么要算而不是写死：30 多只角色体型差得远，头顶在贴图里的高度从 0.02
 *  （圆滚滚的奶屎）到 0.2（长耳朵的奶兔）都有，写死一个数必然一半戴歪。
 *
 *  rect 是可选的"只看这一块"（图像像素坐标）。动图角色给的是雪碧图，
 *  整张图的剪影毫无意义 —— 必须只量第一帧那一格。 */
function computeHeadAnchor(img, key, rect) {
  if (HEAD_ANCHOR.has(key)) return HEAD_ANCHOR.get(key);
  const SW = 128;
  const rw = rect ? rect.w : (img.width || 1);
  const rh = rect ? rect.h : (img.height || 1);
  const sh = Math.max(1, Math.round(SW * rh / rw));
  const c = document.createElement('canvas');
  c.width = SW; c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  if (rect) ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, SW, sh);
  else ctx.drawImage(img, 0, 0, SW, sh);
  let data;
  try { data = ctx.getImageData(0, 0, SW, sh).data; } catch (e) { return null; }
  const rows = [];
  let maxN = 0;
  for (let y = 0; y < sh; y++) {
    let n = 0, sx = 0;
    for (let x = 0; x < SW; x++) {
      if (data[(y * SW + x) * 4 + 3] > 128) { n++; sx += x; }
    }
    rows.push({ n, sx });
    if (n > maxN) maxN = n;
  }
  if (maxN === 0) return null;
  /* 头顶 = 从上往下第一条"够宽"的行。按 0.30 倍最宽行来卡：
   * 呆毛、天线、单根耳朵尖这些细长结构会被跳过，取到的才是真正能放帽子的头顶。 */
  const need = Math.max(2, maxN * CFG.accHeadMinW);
  let top = -1;
  for (let y = 0; y < sh; y++) {
    if (rows[y].n >= need) { top = y; break; }
  }
  if (top < 0) top = 0;
  /* 水平中心取头顶往下几行的平均，单行容易受轮廓起伏影响 */
  let sx = 0, sn = 0;
  const bandEnd = Math.min(sh - 1, top + 3);
  for (let y = top; y <= bandEnd; y++) { sx += rows[y].sx; sn += rows[y].n; }
  const nx = sn > 0 ? (sx / sn) / SW : 0.5;
  /* 头宽取"顶部 22% 高度内最宽的一行"：最顶上那行必然窄（是个尖），
   * 用它算会把帽子做太小 */
  let headW = 0;
  const wEnd = Math.min(sh - 1, top + Math.round(sh * 0.22));
  for (let y = top; y <= wEnd; y++) headW = Math.max(headW, rows[y].n);
  const a = { nx, ny: top / sh, wRel: headW / SW };
  HEAD_ANCHOR.set(key, a);
  return a;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** 与帧率无关的指数趋缓 */
function damp(cur, target, halfLife, dt) {
  return cur + (target - cur) * (1 - Math.pow(2, -dt / halfLife));
}
/** 上升快、回落慢 —— 起跳那种"爆发 + 余韵"的手感 */
function dampAsym(cur, target, upHL, downHL, dt) {
  return damp(cur, target, target > cur ? upHL : downHL, dt);
}

export class Character3D {
  constructor(charKey) {
    this.group = new THREE.Group();        // 对外暴露：承载世界朝向
    this.billboard = new THREE.Group();    // 每帧对齐相机
    this.spinRoot = new THREE.Group();     // 空翻：绕身体中心转，不是绕脚底
    this.pivot = new THREE.Group();        // 挤压/拉伸（原点在脚底）
    this.group.add(this.billboard);
    this.billboard.add(this.spinRoot);
    /* 空翻必须绕身体中心。
     * 绕脚底转会把"翻跟斗"变成"原地跌倒"：脚钉在地上，整个人像根棍子甩出去。
     * 做法是在中间插一层，先把原点抬到身体中心，再绕它转。 */
    const cy = CFG.height * 0.5;
    this.spinRoot.position.y = cy;
    this.pivot.position.y = -cy;
    this.spinRoot.add(this.pivot);
    this.centerY = cy;

    const def = charDef(charKey);
    this.key = def.key;

    /* 单位方片，真实宽高交给 scale —— 换角色时只改 scale 与脚底位置 */
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    const tex = this._loadTex(def.uri, () => this._layoutAcc());
    /* 描边层：同一张贴图放大一点点、染成深色，垫在立绘后面当剪影 */
    this.edge = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex,
      color: CFG.outlineColor,
      transparent: true,
      alphaTest: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      opacity: 0.55,
    }));
    this.edge.frustumCulled = false;
    this.pivot.add(this.edge);

    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.pivot.add(this.mesh);

    this.geo = geo;
    this.tex = tex;

    /* 装饰层（头饰）。放在 pivot 里 —— pivot 承载挤压/拉伸与蹦床位移，
     * 所以帽子会跟着身体一起被压扁、弹起，不会像贴纸一样飘在旁边。
     * pivot 在 billboard 之下，天然保持正对相机，和自己的立绘同一套朝向。 */
    this.acc = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.acc.visible = false;
    this.acc.renderOrder = 3;
    this.pivot.add(this.acc);
    this.accId = null;
    this.headAnch = null;

    /* 冰冻外壳：拿同一张贴图放大一圈、染成冰蓝、半透明，罩在立绘外面。
     * 只做"轮廓外一层冰"就够读了 —— 真去做一层 3D 冰壳既贵又会挡脸。
     * 和描边层用同一个 alphaTest 技巧：只覆盖剪影，不会糊成一个蓝方块。 */
    this.ice = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: tex,
      color: 0xA9E6FF,
      transparent: true,
      opacity: 0,
      alphaTest: 0.4,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    this.ice.visible = false;
    this.ice.renderOrder = 4;
    this.pivot.add(this.ice);
    this.frozen = false;      // 逻辑上的"被冻住"
    this.frostK = 0;          // 冰壳显隐的平滑量（0~1），负责淡入淡出
    this.iceW = 1;
    this.iceH = 1;

    /* 动图角色（大笑奶蛙）：帧号由我们自己推。静态角色这三项一直保持原样，
     * 纹理的 repeat/offset 也一直是默认的 (1,1)/(0,0) —— 也就是"整张即一帧"。 */
    this.animDef = null;      // 有值 = 这只角色是雪碧图动图
    this.animIdx = 0;
    this.animT = 0;           // 当前帧已经播了多久（毫秒）
    this.animDurs = [50];     // 每帧时长，从定义里的逗号串解析出来

    this.applyDef(def);

    this.chargeSquash = 0;   // 由游戏直接写入
    this.airStretch = 0;
    this.faceYaw = 0;
    this.spin = 0;           // 屏幕内翻转角（弧度）
    this.mirror = 1;         // 1 原图朝向 / -1 左右镜像
    this.time = 0;

    /* 平滑后的实际形变量 */
    this.chS = 0;
    this.airS = 0;
    this.imp = 0;            // 落地弹簧位移：正=压扁，负=拉伸
    this.impV = 0;
    this.bounce = 0;         // 蹦床位移：正=被压下去，负=被弹起来
    this.bounceV = 0;

    this._q = new THREE.Quaternion();
  }

  /**
   * 载入贴图。onReady 在图片真正解码完之后才回调 —— 头顶锚点必须等贴图
   * 拿到像素才能算，所以头饰的定位挂在这个回调上，而不是构造完就摆。
   */
  _loadTex(uri, onReady) {
    const t = new THREE.TextureLoader().load(uri, (tex) => {
      if (onReady) onReady(tex);
    });
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    return t;
  }

  /**
   * 按角色定义重算宽高与脚底对齐。
   *
   * 尺寸规则：先按"高度统一"来定（所有角色一样高），但宽的角色要单独收一收。
   * 30 个角色的宽高比从 0.51（奶兔、经典奶蛙）一路到 1.34（奶巨蟹），
   * 高度统一意味着奶巨蟹有 2.18 个世界单位宽 —— 而方块直径只有 1.6。
   * 结果是两只钳子整只甩在砖外面悬空，一看就是贴图没对准。
   * 所以宽度封顶到 CFG.height（≈方块直径），超了就整体等比缩小：
   * 螃蟹于是变成"矮而宽"，本来也合理，比"宽得离谱"正常得多。
   *
   * 脚底对齐：def.baseline 是脚底在贴图里的归一化位置，据此把立绘往上抬，
   * 让脚正好踩在 y=0。注意这里必须用**缩放后**的高度算，否则会整体沉进砖里。
   */
  applyDef(def) {
    const s = def.aspect > 1 ? 1 / def.aspect : 1;   // 过宽 → 等比缩小
    const h = CFG.height * s;
    const w = h * def.aspect;                        // = min(原宽, CFG.height)
    const feet = h * (def.baseline - 0.5) + CFG.lift;
    const k = 1 + CFG.outline * 2;
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.set(0, feet, 0);
    this.edge.scale.set(w * k, h * k, 1);
    this.edge.position.set(0, feet, -0.004);
    this.width = w;
    this.height = h;
    this.def = def;
    /* 脚底接触半径 = 碰撞体积：由抠图脚本从每只角色的实际剪影量出来
     * （def.foot 是"脚底接触带里最远实心像素的半宽 / 贴图宽"），
     * 落脚判定用它代替"所有角色一个点"的旧算法 —— 奶虎单脚站的底盘
     * 就是比趴着的奶羊窄，跟眼睛看到的一致。
     * 上限 0.72：再宽的体型也留一点踩空的可能，不然宽角色永远摔不死。 */
    this.footR = clamp(w * (typeof def.foot === 'number' ? def.foot : 0.30), 0.10, 0.72);
    /* 冰壳比描边再大一圈（+6%）：罩在轮廓外面才有"冻了一层"的厚度感 */
    const ki = k + 0.06;
    this.iceW = w * ki;
    this.iceH = h * ki;
    this.ice.scale.set(this.iceW, this.iceH, 1);
    this.ice.position.set(0, feet, 0.004);
    this._setupAnim(def);
    this._layoutAcc();   // 尺寸变了，头饰的位置/大小要跟着重算
  }

  /** 切到动图 / 静态。动图要关掉 mipmap —— 雪碧图做 mipmap 时高层的采样
   *  会把隔壁格子的像素混进来，角色边缘会出现半透明的"重影"。 */
  _setupAnim(def) {
    if (!def.anim || !def.cols || !def.gw) {
      this.animDef = null;
      return;
    }
    this.animDef = def;
    this.animDurs = String(def.durs || '50').split(',').map((v) => Math.max(16, Number(v) || 50));
    this.animIdx = -1;
    this.animT = 0;
    this.tex.generateMipmaps = false;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this._setFrame(0);
  }

  /** 取（必要时现算）当前角色的头顶锚点。
   *  贴图必须"真的解码完"才算 —— TextureLoader 是先建 Image 再设 src，
   *  这中间 image 对象已经在、但一个像素都没有，此时算出来的是空剪影。 */
  headAnchor() {
    if (this.headAnch) return this.headAnch;
    const img = this.tex && this.tex.image;
    if (!img || !img.complete || !img.naturalWidth) return null;
    this.headAnch = computeHeadAnchor(img, this.key, this._cellRect(0));
    return this.headAnch;
  }

  /** 雪碧图里第 i 帧那一格的像素矩形；静态角色返回 null（整张贴图就是全部）。
   *  格子步距直接从 gw/cols、gh/rows 反推，不必再把"留了几像素缝"存一份。 */
  _cellRect(i) {
    const d = this.def;
    if (!d || !d.anim) return null;
    const cols = d.cols || 1, rows = d.rows || 1;
    const c = i % cols, r = Math.floor(i / cols) % rows;
    return { x: c * (d.gw / cols), y: r * (d.gh / rows), w: d.w, h: d.h };
  }

  /**
   * 动图：把纹理切到第 i 帧。
   *
   * 靠改 offset/repeat 选格子 —— 几何体、材质、三个图层（本体/描边/冰壳）
   * 全都共用同一个 this.tex，所以一次改动三层同时生效，不用逐个同步。
   *
   * ★ 往格子内缩 INSET 像素：UV 正好压在格子边界上时，双线性采样会把邻帧
   *   算进来（"两帧叠影"）。雪碧图格子之间本来就留了 4px 透明缝，再往里收
   *   1px 就彻底安全了。
   * ★ 纵向 offset 要按 flipY 反着数：贴图上传时会上下翻，UV 的 v=0 对应
   *   图片**最下面**一行，所以"从上面数第 r 行"的 v0 是 1-(r+1)/rows 那头。
   */
  _setFrame(i) {
    const d = this.def;
    if (!d || !d.anim || !this.tex || !d.gw) return;
    const cols = d.cols || 1, rows = d.rows || 1;
    const INSET = 1;
    const c = i % cols, r = Math.floor(i / cols) % rows;
    const u0 = (c * (d.gw / cols) + INSET) / d.gw;
    const v0 = (d.gh - (r * (d.gh / rows) + d.h) + INSET) / d.gh;
    this.tex.repeat.set((d.w - 2 * INSET) / d.gw, (d.h - 2 * INSET) / d.gh);
    this.tex.offset.set(u0, v0);
    this.animIdx = i;
  }

  /** 按动画自己的时间表推进帧。dt 是秒，durs 是每帧毫秒（GIF 里抄出来的，
   *  不是均匀的 —— 大部分 50ms、少数 100ms，照抄节奏才和原图一致）。 */
  _tickAnim(dt) {
    const d = this.animDef;
    if (!d) return;
    this.animT += dt * 1000;
    let guard = 0;
    while (guard++ < 8 && this.animT >= this.animDurs[this.animIdx]) {
      this.animT -= this.animDurs[this.animIdx];
      this._setFrame((this.animIdx + 1) % d.frames);
    }
  }

  /**
   * 把当前头饰摆到头顶。
   *
   * 坐标换算：立绘是一张 1×1 的方片，mesh.scale = (w, h)、mesh.position.y = feet，
   * 贴图默认 flipY，所以归一化的 (fx, fy)（fy 从图顶往下数）落在世界坐标
   *     x = -w/2 + fx·w
   *     y = feet + h/2 - fy·h
   *
   * 关键是**按内容框摆而不是按画布摆**：抠图会把主体补成正方形、四周留透明边距，
   * 帽子实际只占画布宽度的 66%。按画布算的话帽子会白缩一圈、还往上飘
   * （第一版就是这样，截图一看帽子悬在头顶外面）。
   */
  _layoutAcc() {
    const deco = accDef(this.accId);
    if (!deco) { this.acc.visible = false; return; }
    const a = this.headAnchor();
    if (!a) { this.acc.visible = false; return; }   // 贴图还没解码完，等 onReady 再摆
    const box = ACC_BOX[deco.img] || { x: 0, y: 0, w: 1, h: 1 };
    const w = this.width, h = this.height;
    const headTopX = -w / 2 + a.nx * w;
    const headTopY = this.mesh.position.y + h / 2 - a.ny * h;
    /* 尺寸按"内容高度 = 角色高度 × hK"定 —— 所有人一样高，帽子就一样大；
     * 过宽的角色会被等比缩小，帽子跟着小，比例不会失控。 */
    const chw = h * (deco.hK || 0.42);               // 内容（帽子本体）世界高度
    const cww = chw * (box.w / box.h || 1);          // 内容世界宽度
    const aw = cww / (box.w || 1);                   // 整张画布的世界宽度
    const ah = aw;                                   // 画布是正方形
    /* 内容框中心相对画布中心的偏移，得反向补偿掉 */
    const offX = ((box.x + box.w / 2) - 0.5) * aw;
    const offY = ((box.y + box.h / 2) - 0.5) * ah;
    const contentX = headTopX + (deco.dx || 0) * cww;
    const contentY = headTopY + (deco.dy || 0) * chw;   // dy 正 = 中心在头顶之上
    this.acc.scale.set(aw, ah, 1);
    this.acc.position.set(contentX - offX, contentY - offY, CFG.accZ);
    this.acc.visible = true;
  }

  /** 换头饰（null = 不戴）。贴图从 acc_data.js 里按装饰定义的 img 键取 */
  setAccessory(id) {
    const deco = accDef(id);
    this.accId = deco ? deco.id : null;
    if (!deco) {
      this.acc.visible = false;
      const m = this.acc.material;
      if (m.map) { m.map.dispose(); m.map = null; m.needsUpdate = true; }
      return null;
    }
    const uri = ACC_IMG[deco.img];
    if (!uri) { this.acc.visible = false; return null; }
    const tex = this._loadTex(uri, () => {
      this.acc.material.needsUpdate = true;
      this._layoutAcc();
    });
    const old = this.acc.material.map;
    this.acc.material.map = tex;
    this.acc.material.needsUpdate = true;
    this._layoutAcc();
    if (old) old.dispose();
    return deco;
  }

  /** 换角色：只换贴图与尺寸，几何体与材质都复用 */
  setChar(key) {
    const def = charDef(key);
    if (def.key === this.key) return def;
    const old = this.tex;
    this.headAnch = null;            // 新贴图 = 新剪影，头顶锚点作废重算
    const tex = this._loadTex(def.uri, () => this._layoutAcc());
    this.tex = tex;
    this.key = def.key;
    this.mesh.material.map = tex;
    this.edge.material.map = tex;
    this.ice.material.map = tex;
    this.mesh.material.needsUpdate = true;
    this.edge.material.needsUpdate = true;
    this.ice.material.needsUpdate = true;
    this.applyDef(def);
    this._layoutAcc();
    if (old) old.dispose();
    return def;
  }

  /* ---------------- 对外接口（与旧建模版保持一致） ---------------- */

  setCharge(t) { this.chargeSquash = clamp(t, 0, 1); }
  setAir(t) { this.airStretch = clamp(t, -1, 1.8); }
  setSpin(rad) { this.spin = rad || 0; }
  setMirror(sign) { this.mirror = sign < 0 ? -1 : 1; }

  /** 落地冲击：立刻压扁，并给弹簧一个向下初速，让它回弹时过冲成拉伸 */
  impact(s) {
    const k = clamp(s, 0.2, 1);
    this.imp = Math.max(this.imp, k);
    this.impV = -2.9 * k;
  }

  /**
   * 蹦床：踩上弹簧砖时调用。
   * 先把人压下去一截，再给一个向上的速度 —— 低频欠阻尼弹簧会让他"嘣"地
   * 弹高、拉长，然后来回衰减几下才站稳。和 impact() 走两条独立通道，
   * 所以两种手感不会互相抵消。
   */
  boing(power = 1) {
    const k = clamp(power, 0.2, 1.6);
    this.bounce = Math.max(this.bounce, 0.28 * k);
    this.bounceV = -5.2 * k;
  }

  faceTo(dx, dz) {
    this.faceYaw = Math.atan2(dx, dz);
    this.group.rotation.y = this.faceYaw;
  }
  setPosition(x, y, z) { this.group.position.set(x, y, z); }

  /** 冻住 / 解冻。冰壳的淡入淡出交给 update 里的 frostK 平滑处理，
   *  这里只翻逻辑开关 —— 效果中途被换角色/重开一局也不会留个蓝人。 */
  setFrozen(on) { this.frozen = !!on; }

  update(dt, camera) {
    this.time += dt;
    this._tickAnim(dt);

    /* 1. 对齐相机：整张立绘平移到视平面，保持画面不变形 */
    this.group.getWorldQuaternion(this._q).invert();
    if (camera) this._q.multiply(camera.quaternion);
    this.billboard.quaternion.copy(this._q);
    this.billboard.scale.x = this.mirror;
    /* 2. 翻转：纸片人在画面内转圈，不做真的空间翻滚（否则会侧到一条线） */
    this.spinRoot.rotation.z = this.spin;

    /* 3. 形变 —— 全部经过趋缓/弹簧，任何写入都不会造成视觉上的跳变 */
    this.chS = damp(this.chS, this.chargeSquash, CFG.chargeHL, dt);
    this.airS = dampAsym(this.airS, this.airStretch, CFG.airUpHL, CFG.airDownHL, dt);

    this.impV += (-CFG.squashK * this.imp - CFG.squashC * this.impV) * dt;
    this.imp += this.impV * dt;

    // 蹦床弹簧（独立通道，低频欠阻尼 → 弹得高、弹得久）
    this.bounceV += (-CFG.boingK * this.bounce - CFG.boingC * this.bounceV) * dt;
    this.bounce += this.bounceV * dt;
    if (Math.abs(this.bounce) < 0.0015 && Math.abs(this.bounceV) < 0.02) {
      this.bounce = 0; this.bounceV = 0;
    }

    const squash = clamp(this.chS * CFG.squashMax + Math.max(this.imp, 0) * CFG.squashMax
      + Math.max(this.bounce, 0) * CFG.boingSquash, 0, 0.62);
    const stretch = clamp(this.airS * 0.17 + Math.max(-this.imp, 0) * CFG.stretchMax
      + Math.max(-this.bounce, 0) * CFG.boingStretch, 0, 0.58);

    const sy = (1 - squash) * (1 + stretch);
    const sx = (1 + squash * 0.62) * (1 - stretch * 0.40);

    /* 4. 待机：极轻的上下浮动 + 左右摆动，静止时也不像贴图 */
    const rest = clamp(1 - this.chS * 3 - this.airS * 3 - Math.abs(this.bounce) * 2.2, 0, 1);
    const bob = Math.sin(this.time * 2.0) * 0.013 * rest;
    const sway = Math.sin(this.time * 1.3 + 0.7) * 0.019 * rest;

    this.pivot.scale.set(sx, sy, 1);
    /* 蹦床不只是形变：整块人真的会被弹起来（负数 = 向上），脚离地那种感觉 */
    this.pivot.position.y = -this.centerY + bob - this.bounce * CFG.boingLift;
    /* 蓄力时侧倾"蹲下咬住"，起跳瞬间甩正 —— 势能感 */
    this.pivot.rotation.z = this.chS * 0.055 - this.airS * 0.055 + sway;

    /* 5. 冰冻外壳：淡入 / 淡出，冻住时轻微发抖（高频小振幅，读作"在冰里抖"）。
     *  发抖只改 scale，不动 position —— position 是 applyDef 按脚底对齐算好的，
     *  在 update 里偏移就得再存一份基准值，容易在换角色时错位。 */
    this.frostK = damp(this.frostK, this.frozen ? 1 : 0, 0.07, dt);
    const fk = this.frostK;
    if (fk > 0.004) {
      const sh = 1 + Math.sin(this.time * 34) * 0.014 * fk;
      this.ice.visible = true;
      /* ★ 0.72 而不是 0.5x：0.60 那版截出来只是"套了个很淡的蓝轮廓"，
       *   肉眼看不出"被冻住了"（截图核对过）。霜壳是贴剪影的（alphaTest），
       *   加厚不会把角色糊成方块，只会让"冻住"一眼可读。 */
      this.ice.material.opacity = fk * 0.72;
      this.ice.scale.set(this.iceW * sh, this.iceH * sh, 1);
      // 本体也往冰蓝偏一点，冰壳才不是"套了个蓝色轮廓"
      this.mesh.material.color.setRGB(1 - 0.20 * fk, 1 - 0.06 * fk, 1);
    } else if (this.ice.visible) {
      this.ice.visible = false;
      this.ice.material.opacity = 0;
      this.mesh.material.color.setRGB(1, 1, 1);
    }
  }
}
