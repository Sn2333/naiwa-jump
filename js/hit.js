/**
 * hit.js —— 落脚判定（纯几何，不依赖 three.js，可单独跑测试）
 *
 * 判定用的"落脚面"必须和看得见的轮廓一致：
 *   圆砖 / 双层砖 / 弹簧砖 → 圆。半径由调用方按"真正踩得到的那一圈"给出：
 *       普通圆砖 = radius，弹簧砖 = 顶盘 0.88 * radius
 *   八棱柱     → 圆，半径 0.95 * radius（外接圆的话，正对棱边的位置会悬空）
 *   方块       → 半边长 halfW 的正方形
 *   移动砖     → 同上，只是圆心每帧都在变，调用方传实时中心即可
 *
 * 之前圆砖用 radius*0.94、方块用 radius*1.06 的圆去判，和眼睛看到的差得远，
 * 于是出现"看着还在砖上，结果掉下去了"。
 */

/** 落点越过砖面边缘多少：≤0 表示还在砖上（绝对值 = 离边缘还有多远），>0 表示已经出去了多少 */
export function edgeOver(kind, radius, halfW, cx, cz, x, z) {
  const dx = x - cx;
  const dz = z - cz;
  if (kind === 'box') {
    const ax = Math.abs(dx);
    const az = Math.abs(dz);
    if (ax <= halfW && az <= halfW) return Math.max(ax, az) - halfW;
    const ox = ax - halfW > 0 ? ax - halfW : 0;
    const oz = az - halfW > 0 ? az - halfW : 0;
    return Math.sqrt(ox * ox + oz * oz);
  }
  return Math.sqrt(dx * dx + dz * dz) - radius;
}

/** 落点是否算"站在砖上"（允许一点点踩边宽容） */
export function onPlatform(kind, radius, halfW, cx, cz, x, z, grace) {
  return edgeOver(kind, radius, halfW, cx, cz, x, z) <= grace;
}

/** 完美判定的容差：随砖的大小缩放，小砖不至于被判得太死 */
export function perfectTol(radius) {
  const v = radius * 0.30;
  return v < 0.13 ? 0.13 : (v > 0.26 ? 0.26 : v);
}
