import * as THREE from './vendor/three.module.js';
import { CHARS, DEFAULT_CHAR } from './sprite_data.js';

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

const BY_KEY = new Map(CHARS.map((c) => [c.key, c]));

/** 角色清单（给 UI 用） */
export function charList() { return CHARS; }
/** 按 key 取角色定义，找不到就退回默认角色 */
export function charDef(key) { return BY_KEY.get(key) || BY_KEY.get(DEFAULT_CHAR) || CHARS[0]; }

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
};

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
    const tex = this._loadTex(def.uri);

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

  _loadTex(uri) {
    const t = new THREE.TextureLoader().load(uri);
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
  }

  /** 换角色：只换贴图与尺寸，几何体与材质都复用 */
  setChar(key) {
    const def = charDef(key);
    if (def.key === this.key) return def;
    const old = this.tex;
    const tex = this._loadTex(def.uri);
    this.tex = tex;
    this.key = def.key;
    this.mesh.material.map = tex;
    this.edge.material.map = tex;
    this.mesh.material.needsUpdate = true;
    this.edge.material.needsUpdate = true;
    this.applyDef(def);
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

  update(dt, camera) {
    this.time += dt;

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

  }
}
