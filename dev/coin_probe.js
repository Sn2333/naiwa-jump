/* 货币 / 商店 / 公告赠礼 / 新砖种 / 冰冰冰 / 奶块大笑 / 角色 / 动图角色 / 装饰 / 设置
 * / 渲染循环防异常 —— 一次跑完
 *
 * 覆盖这些链路：
 *   1) 公告：首次打开（localStorage 无已读标记）自动弹出 + 按钮红点；
 *      第一篇公告的日期/标题/正文/附赠四样都在位；点「领取」把生日帽发到手、
 *      判重键落盘、按钮切"已领取"，重复触发幂等；关闭后写已读标记、红点消失
 *   2) 商店：入口 → 面板 → 余额 → 货架分组（只剩"角色"一栏）；生日帽已下架
 *   3) 奶币：?coin=7 起始余额 → 砖上随机挂的**旋转实体**被跳过去捡到
 *      （局内只累计、不动真账）→ 结算按「捡到枚数 ×10」入账，**和分数脱钩**
 *   4) 渲染循环防异常：往 tick 里注入一个必抛的异常，确认 rAF 没被杀
 *      （vendor 的 WebGLAnimation 是「先回调后调度」，
 *       不包 try/catch 的话这里会永久定格 —— 就是"标题界面卡住"）
 *   5) 脆砖 fragile：落上 arm 倒计时 → 到期碎裂下沉 → 站在上面的人一起掉
 *   6) ×2 砖 double：落正中心的收益必须正好是普通砖的两倍
 *   7) 五种效果砖（弹簧 / 粘液 / 冰冰冰 / 磁铁 / 圣光）+ 冰冰冰的三冰块模型与物理材质
 *      + 奶块：顶面蛙脸、跳上去放一声大笑（受「奶块大笑」开关控制）
 *   8) 装饰（公告赠品不可买 → 装备 → 通用 → 卸下）+ 角色买卖 + 雪碧图动图推帧
 *   9) 设置：开关 / 滑条写档，音量经总线生效，面板互斥
 *
 * 前置：?coin=7&coins=1&plain&seenotice&kind=round&r=0.8&gap=2.6
 *   ?coin=7     起始余额，方便对账
 *   ?coins=1    每块砖都挂奶币（抽签固定住，拾取用例才可复现）
 *   ?plain      只用基础砖 —— 第 3 节靠"真的跳两次过去"验拾取，
 *               砖种随机抽到移动砖/弹簧砖就会跳空，必须固定住
 *               （需要特殊砖的子节自己用 g.forceTrait 现造，不依赖抽签）
 *   ?seenotice  先标成已读 —— "自动弹公告"在探针里自己清标记重演，
 *               免得它在别的用例（商店/奶币）中途插手
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (id) => !document.getElementById(id).classList.contains('hidden');
const txt = (id) => document.getElementById(id).textContent.trim();

/* 等 window.__game 挂上：DOMContentLoaded 之后才 new Game()，
 * 页面冷启动偶尔比探针慢一拍 —— 轮询而不是死等固定毫秒，避免偶发 "no game" */
let g = window.__game;
for (let i = 0; i < 60 && !g; i++) { await sleep(100); g = window.__game; }
if (!g) return { ok: false, err: 'no game' };
const CFG = window.__CFG || {};

/* 上限从 CFG 现读，避免断言写死数字后改常量就静默失配。
 * ★ 弹簧现在**没有"层数"**了：助推只有"有 / 没有"两种，且只活一跳，
 *   所以这里不再有 BOOST_MAX（它对应已删除的 CFG.boostMax）。 */
const SLIME_MAX = CFG.slimeMax || 2;    // 粘液块：射程削减最多叠几层

/* 固定步长推进 n 帧。
 * ★ 必须顺手把 `_noRender` 打开：无头环境跑的是 swiftshader 软渲染，
 *   一次 `renderer.render` 要几十毫秒，几百帧全渲染就会把 JS 线程堵死，
 *   探针的 Runtime.evaluate 直接超时（页面还会顺带卡在旧状态）。
 *   中间帧不画、只推进物理；画面交给一直在跑的 rAF 循环出最后一帧。 */
const step = (n) => {
  g._noRender = true;
  for (let i = 0; i < n; i++) g.tick(1 / 60);
  g._noRender = false;
};

await sleep(1000);   // 等首帧和 HUD 稳定

/* ---------- 1) 公告：未读 → 红点点亮 → 自动弹出 → 已读不再弹 ---------- */
/* URL 带了 ?seenotice（已读），这里清掉标记重演"首次打开游戏" */
localStorage.removeItem('jump3d_notice_seen');
g.dom.noticeDot.classList.add('hidden');
g.maybeShowNotice();                     // 内部 450ms 后才弹
await sleep(120);
const dotOn = show('noticeDot');         // 红点先亮，面板还没弹出来
await sleep(600);
const notice = {
  panel: show('noticePanel'),
  dot: show('noticeDot'),                // 打开即已读 → 红点该灭了
  hasPanel: document.body.classList.contains('has-panel'),
  body: txt('noticeBody'),
  /* 条目按"新的在前"排：第一条 = v1.1 更新说明（带正文），第二条 = 生日帽（无正文） */
  date: (document.querySelector('#noticeBody .noticeItem .noticeDate') || {}).textContent || '',
  title: (document.querySelector('#noticeBody .noticeItem .noticeTitle') || {}).textContent || '',
  firstBody: (document.querySelector('#noticeBody .noticeItem .noticeBody') || {}).textContent || '',
  items: document.querySelectorAll('#noticeBody .noticeItem').length,
  giftLine: (document.querySelector('#noticeBody .noticeGift') || {}).textContent || '',
  giftBtn: !!document.querySelector('#noticeBody .giftBtn'),
  ownedBefore: g.ownsAcc('hat_birthday'),
  /* 第二条（生日帽）必须没有正文 —— 那篇的正文用户要自己写 */
  secondBody: !!(document.querySelectorAll('#noticeBody .noticeItem .noticeBody')[1]),
};
/* 1b) 公告附赠：点「领取」→ 生日帽进拥有清单、判重键落盘、按钮切成"已领取"。
 *     ★ 生日帽已经**从商店下架**，公告是它唯一的来源，所以这条必须真跑通。 */
document.querySelector('#noticeBody .giftBtn').click();
await sleep(160);
const giftBtnNow = document.querySelector('#noticeBody .giftBtn');
const gift = {
  owned: g.ownsAcc('hat_birthday'),
  btnText: giftBtnNow ? giftBtnNow.textContent : '',
  disabled: giftBtnNow ? giftBtnNow.disabled : null,
  stored: JSON.parse(localStorage.getItem('jump3d_acc_owned') || '[]'),
  keys: JSON.parse(localStorage.getItem('jump3d_gifts') || '[]'),
};
/* 重复触发必须幂等（重启/重开面板不该重复发）。**判重键 = 公告条目日期|附件id**，
 * 与 NOTICE_VERSION 无关 —— 发新公告不该让旧赠礼再领一次。 */
g.claimGift('2026-10-02|hat_birthday');
await sleep(60);
const giftAgain = {
  owned: g.ownsAcc('hat_birthday'),
  keys: JSON.parse(localStorage.getItem('jump3d_gifts') || '[]').length,
};
document.getElementById('noticeClose').click();
await sleep(200);
const noticeClosed = {
  panel: show('noticePanel'),
  dot: show('noticeDot'),
  seen: localStorage.getItem('jump3d_notice_seen'),
  hasPanel: document.body.classList.contains('has-panel'),
};
/* 已读之后再触发一次，必须什么都不发生 */
g.maybeShowNotice();
await sleep(600);
const noticeAgain = show('noticePanel');

/* ---------- 2) 商店：入口 / 余额 / 货架分组 / 公告赠品不上架 ---------- */
document.getElementById('shopBtn').click();
await sleep(250);
const shop = {
  panel: show('shopPanel'),
  coins: txt('shopCoins'),                       // 奶币图标是 <img>，textContent 只剩数字
  hasPanel: document.body.classList.contains('has-panel'),
  shelf: txt('shopShelf').slice(0, 40),
  coinIco: document.querySelectorAll('#shopCoins .coinIco').length,
  heads: [...document.querySelectorAll('#shopShelf .shelfHead')].map((e) => e.textContent).join(','),
  charBuy: document.querySelectorAll('#shopShelf [data-buykey]').length,
  /* ★ 生日帽改成公告赠礼之后，商店里**一个字都不该出现** */
  hatGone: txt('shopShelf').indexOf('生日帽') < 0,
  accHead: txt('shopShelf').indexOf('头饰') >= 0,   // 只有赠品装饰 → 整栏都不该有
  price50: txt('shopShelf').indexOf('50') >= 0,     // 大笑奶蛙 50
};
document.getElementById('shopClose').click();
await sleep(250);
const shopClosed = { panel: show('shopPanel'), hasPanel: document.body.classList.contains('has-panel') };

/* ---------- 3) 奶币：砖上的旋转实体 → 跳过去捡到 → 结算 ×10 ---------- */
/* ?coins=1 让每块砖都挂币（抽签分支被固定住），余额从 ?coin=7 起算，方便对账 */
const coinsStart = g.coins;                    // 7

document.getElementById('startBtn').click();
await sleep(400);
/* 3a) 砖上真的挂了 3D 实体，而且挂在砖的 group 上（移动砖能带着它走） */
const coinBrick = g.next;
const coinOnBrick = !!coinBrick.coin;
const coinAttached = !!coinBrick.coin && coinBrick.coin.parent === coinBrick.group;
const coinFaceIsMesh = !!coinBrick.coin
  && coinBrick.coin.children[0].material.length === 3;   // [侧圈, 端面, 端面]

/* 3b) 按真实距离反算蓄力跳过去（和机器人同一条路径）；拾取判定在 tick 里跑 */
g.botPress();
step(150);
const coinPick = {
  runCoins: g.runCoins,                        // 1
  taken: coinBrick.coinTaken === true,
  landed: g.current === coinBrick,
  tag: txt('runCoinTag'),                      // 只剩数字（图标是 <img>）
  tagShown: show('runCoinTag'),
  tagIco: document.querySelectorAll('#runCoinTag .coinIco').length,
  meshHidden: coinBrick.coin ? coinBrick.coin.visible === false : null,
  coinsUnchanged: g.coins === coinsStart,      // ★ 局内拾取**不动真账**
};
/* 3c) 再跳一次：计数必须是累加，不是覆盖 */
g.botPress();
step(150);
const coinPick2 = { runCoins: g.runCoins, tag: txt('runCoinTag') };

/* 3d) 结算：把分数拉满也不该多给一枚 —— 奶币只认"捡到的枚数" */
g.score = 999;
g.gameOver();
await sleep(150);
const settle = {
  coins: g.coins,                              // 7 + 2×10 = 27
  runCoins: g.runCoins,                        // 2
  perPick: CFG.coinPerPick || 10,
  overCoin: txt('overCoin'),
  stored: localStorage.getItem('jump3d_coins'),
  tag: txt('coinTag'),                         // 同上：只剩数字
  tagIco: document.querySelectorAll('#coinTag .coinIco').length,
};

/* ---------- 4) 渲染循环防异常 ---------- */
document.getElementById('titleBtn').click();
await sleep(300);
const clockBefore = g.clock.elapsedTime;
const realTick = g.tick.bind(g);
let injected = 0;
/* 只让前 3 次调用抛，之后自动恢复正常 —— 模拟"偶发一次异常"。
 * 循环没被兜住的话 rAF 链会断，injected 永远停在 1、时间也不再推进；
 * 兜住了的话 rAF 继续调度，injected 会随帧数继续涨、elapsedTime 继续涨。 */
g.tick = function () {
  if (++injected <= 3) throw new Error('probe-boost');
  return realTick();
};
await sleep(700);
g.tick = realTick;
await sleep(300);
const loopGuard = {
  injected,                                    // >=3 就说明异常没掐掉 rAF 链
  advanced: +(g.clock.elapsedTime - clockBefore).toFixed(3),
};

/* ---------- 5) 脆砖：arm → 碎裂 → 人跟着掉 → 砖被清掉 ---------- */
g.forceTrait = 'fragile';
g.beginRun();
await sleep(300);
const fp = g.next;
g.charRoot.position.set(fp.center.x, 0, fp.center.z);
g.state = 'jumping';
const fragScore0 = g.score;
g.finishJump();
const fragile = {
  trait: fp.trait,
  state: g.state,
  armed: fp.crackT != null,
  crackT: fp.crackT != null ? +fp.crackT.toFixed(2) : null,
  gained: g.score - fragScore0,
};
/* 固定步长手动推进：无头浏览器 rAF 帧率不稳，靠它才有确定性 */
step(110);   // 1.83s > crackTime 1.4s
const fragileAfter = {
  sinking: fp.sinking,
  state: g.state,                              // falling（人还站在上面）
  inList: g.platforms.includes(fp),
};
step(50);    // 下沉动画放完 → 被清出数组
const fragileCleaned = { inList: g.platforms.includes(fp), dead: fp.dead };

/* ---------- 6) ×2 砖：落正中心，收益翻倍 ---------- */
g.forceTrait = 'double';
g.backToTitle();
await sleep(200);
g.beginRun();
await sleep(200);
const dp = g.next;
g.charRoot.position.set(dp.center.x, 0, dp.center.z);
g.state = 'jumping';
const dblScore0 = g.score;
g.finishJump();
const dbl = { trait: dp.trait, state: g.state, gained: g.score - dblScore0 };

/* ---------- 7) 特殊效果砖：真的改变了玩法数值 ---------- */
/* 7a) 弹簧 spring：助推**只作用从弹簧起跳的那一跳**，落地就清。
 *   三件事一起验：① 助推把射程倍率抬到 1+0.92；② 那一跳真的更远；
 *   ③ 落到普通砖后自动归零、落在弹簧上则保持 —— 这就是"离开弹簧就结束"。 */
const boostIdle = g.rangeMul();               // 没有助推 = 1
g.setBoost(true);
const boostAfter = g.rangeMul();              // 有助推 = 1.92
const buffTagShown = document.getElementById('buffTag').classList.contains('show');
const buffTagText = document.getElementById('buffTag').textContent;
g.setBoost(false);
/* 从弹簧砖起跳：落点必须真的更远 */
g.forceTrait = null;
g.backToTitle();
await sleep(150);
g.beginRun();
await sleep(200);
g.setSlime(0);
g.setBoost(false);
g.power = 0.5;
g.doJump();
const distNoBoost = Math.hypot(g.jump.to.x - g.jump.from.x, g.jump.to.z - g.jump.from.z);
g.state = 'ready';
g.setBoost(true);
g.power = 0.5;
g.doJump();
const distBoosted = Math.hypot(g.jump.to.x - g.jump.from.x, g.jump.to.z - g.jump.from.z);
g.state = 'ready';

/* 7a2) 助推的生命周期：落在普通砖 → 归零；落在弹簧砖 → 保持。
 *   直接把目标砖的 trait 改掉再 finishJump，比等抽签稳定得多。
 *   7a3 还要量"弹簧的下一块间距"，所以这里临时解锁随机间距 ——
 *   URL 的 ?gap= 是固定调试间距，生成器对它刻意不干预，不解锁测不到真实行为。 */
g.setBoost(false);
const savedGap7a = g.fixedGap;
g.backToTitle();
await sleep(150);
g.fixedGap = null;
g.beginRun();
await sleep(200);
const bp = g.next;
bp.trait = null;                              // 目标砖：普通砖
g.setBoost(true);                             // 假装刚站上弹簧
g.charRoot.position.set(bp.center.x, 0, bp.center.z);
g.state = 'jumping';
g.finishJump();
const boostAfterLand = g.boostLv;             // 必须是 0（离开弹簧就结束）
const landState = g.state;

const sp2 = g.next;                           // spawnNext 之后的新目标
sp2.trait = 'spring';                         // 目标砖：弹簧
g.setBoost(true);
g.charRoot.position.set(sp2.center.x, 0, sp2.center.z);
g.state = 'jumping';
g.finishJump();
const boostOnSpring = g.boostLv;              // 必须是 1（站在弹簧上）
g.setBoost(false);
/* 7a3) 弹簧的下一块**不能太近**：站弹簧上最轻一跳也飞 minReach×1.92 远，
 *   生成器必须把间距下限抬到轻跳也飞不过头的位置，否则满射程必跳过 —— 物理无解 */
const springGap = Math.hypot(g.next.center.x - g.current.center.x, g.next.center.z - g.current.center.z);
const springGapLo = CFG.jumpMin * (1 + CFG.boostRange) * 1.15;
const springGapOk = springGap >= springGapLo - 1e-6;
g.fixedGap = savedGap7a;

/* 7b) 粘液块 slime：射程倍率被砍（1 → (1-0.3)^2 = 0.49；0.40 时代是 0.36）。
 *   这套数值原封不动从"旧冰冰冰"（那会儿还叫冻结砖）搬过来的，只是换了砖种。 */
g.setBoost(0);
g.setSlime(SLIME_MAX);
const slimeMul = g.rangeMul();
g.power = 0.5;
g.doJump();
const distSlimed = Math.hypot(g.jump.to.x - g.jump.from.x, g.jump.to.z - g.jump.from.z);
g.state = 'ready';
g.setSlime(0);

/* 7b2) 粘液的生命周期：落到粘液 → +1 层；落到普通砖 → **全清**（离开即失效）。
 *   以前粘液是常驻叠乘，离开以后照样残废 —— 用户明确要求跟弹簧对称：离开就没了。 */
g.backToTitle();
await sleep(150);
const savedGap7b = g.fixedGap;
g.fixedGap = null;                            // 同 7a3：解锁随机间距，才能测到生成器收口
g.beginRun();
await sleep(200);
const sl1 = g.next;
sl1.trait = 'slime';                          // 目标砖：粘液
g.charRoot.position.set(sl1.center.x, 0, sl1.center.z);
g.state = 'jumping';
g.finishJump();
const slimeOnBrick = g.slimeLv;               // 必须是 1（站在粘液上）
/* 7b3) 站粘液上生成的新一块**不能太远**：射程被砍到 ×0.6，
 *   生成器必须把间距上限压进"满蓄力也够得着"的范围，否则必然跳不过去 —— 物理无解 */
const slimeGap = Math.hypot(g.next.center.x - g.current.center.x, g.next.center.z - g.current.center.z);
const slimeGapHi = (CFG.jumpMin + CFG.jumpRange) * g.rangeMul() * 0.90;
const slimeGapOk = slimeGap <= slimeGapHi + 1e-6;
g.fixedGap = savedGap7b;
const sl2 = g.next;
sl2.trait = null;                             // 下一块：普通砖
g.charRoot.position.set(sl2.center.x, 0, sl2.center.z);
g.state = 'jumping';
g.finishJump();
const slimeAfterLeave = g.slimeLv;            // 必须是 0（离开粘液就干净了）
const slimeRangeAfterLeave = g.rangeMul();    // 射程倍率也必须回到 1

/* 7c) 冰冰冰 freeze：落上后角色被冻住 CFG.freezeMs（默认 1.5s），
 *   这期间 press() 拿不回控制权；倒计时走完自动解冻、恢复可跳。
 *   ★ 别再用 doJump 测 —— 冻结不改落点，改的是"你能不能动"，是状态机行为。
 *   （模型/材质见 7f，那节才需要真正按 freeze 建一块砖） */
g.forceTrait = null;
g.backToTitle();
await sleep(150);
g.beginRun();
await sleep(200);
g.next.trait = 'freeze';
g.charRoot.position.set(g.next.center.x, 0, g.next.center.z);
g.state = 'jumping';
/* 脚下的砖挪远：否则 finishJump 第一分支会判成"原地跳"，冻结根本不触发 */
g.current.center.x += 6;
g.finishJump();
const freezeLand = {
  frozenT: +g.frozenT.toFixed(3),
  flag: g.character.frozen,          // 冰壳视觉开关：必须同步打开
  state: g.state,
  /* 「叮叮叮」音效：解码必须已完成（constructor 里预解码，探针此时早该好了），
   * 且 playClip 在非静音时要真的把源启动（返回 true） */
  dingReady: !!(window.__sound.clips.ding && window.__sound.clips.ding.buf),
  dingPlayed: window.__sound.ding() === true,
};
/* 冻住期间按一下：不许进蓄力（这就是"拿不回控制权"） */
g.power = 0;
g.press();
const freezePress = { charging: g.state === 'charging', power: g.power };
/* 让倒计时一口气走完（60fps 帧步进，别用单个大 dt 免得相机/物理跳变） */
step(Math.ceil((CFG.freezeMs / 1000) * 60) + 24);
const freezeThaw = { frozenT: +g.frozenT.toFixed(3), flag: g.character.frozen };
/* 解冻之后再按：这次必须真的能蓄力 */
g.power = 0;
g.press();
const freezeAfterPress = { charging: g.state === 'charging' };
g.release();                          // 收尾：别把蓄力循环挂在探针后面

/* 7d) 磁铁砖 lure：蓄力差一点点时，落点被拽回砖心附近（只是"对准"，不是"变远"）
 * 误差 = 落点到【目标砖】中心的距离 —— 别用 current.distToCenter，
 * 那量的是"跳了多远"，不是"偏了多少"。
 * 磁铁的价值在"差一点点"：所以先把目标砖摆到"蓄力九成够得着"的距离，
 * 这样才能看出磁铁把误差吃掉了多少。 */
const lureErr = () => g.next.distToCenter(g.jump.to.x, g.jump.to.z);
const lurePower = 0.90;
/* 把 next 摆到"满蓄力才刚刚够到"的位置：够得着，但不用满力就差一截 */
{
  const far = CFG.jumpMin + lurePower * CFG.jumpRange;    // 满力落点
  const dx = g.next.center.x - g.current.center.x;
  const dz = g.next.center.z - g.current.center.z;
  const l = Math.hypot(dx, dz) || 1;
  g.next.center.set(
    g.current.center.x + (dx / l) * (far + 0.55), 0,
    g.current.center.z + (dz / l) * (far + 0.55));
  g.next.group.position.set(g.next.center.x, g.next.group.position.y, g.next.center.z);
}
const lureGap = Math.hypot(
  g.next.center.x - g.current.center.x, g.next.center.z - g.current.center.z);
/* 先测"没有磁铁"的误差 */
g.current.trait = null;
g.power = lurePower;
g.doJump();
const lureNoTrait = lureErr();
const lureReach = Math.hypot(g.jump.to.x - g.jump.from.x, g.jump.to.z - g.jump.from.z);
g.state = 'ready';
/* 再测"有磁铁"：同一蓄力，误差必须明显变小 */
g.current.trait = 'lure';
const lureCap = Math.max(CFG.lureMaxPull, g.next.hitRadius * CFG.lureCapMul);
g.power = lurePower;
g.doJump();
const lureDist = lureErr();
const lureTol = g.next.perfectTol;
g.state = 'ready';
/* 反向对照：蓄力严重不足（差一整个砖）时，磁铁也救不了 —— 必须还是够不着 */
g.current.trait = 'lure';
g.power = 0.30;
g.doJump();
const lureFarDist = lureErr();
g.state = 'ready';
g.current.trait = null;

/* 7e) 圣光砖 holy：把场上脆砖全部净化回普通砖 */
g.forceTrait = 'fragile';
g.backToTitle();
await sleep(150);
g.beginRun();
await sleep(200);
/* 场上铺几块脆砖（forceTrait 会把 spawnNext 的每一块都抽成脆砖） */
for (let i = 0; i < 3; i++) g.spawnNext();
/* 挑一块脆砖当"圣光砖"：先把它转成 holy，再从脆砖计数里剔除 —— 它不是要被净化的对象 */
const holyTarget = g.platforms[g.platforms.length - 1];
holyTarget.trait = 'holy';
holyTarget.radius = 0.8;
holyTarget.hitRadius = 0.8;
holyTarget.color && holyTarget.color.set(0xF3EDD6);
/* 脆砖数只数"真正该被净化的"：排除 holyTarget 与脚下这块（这两块按设计会跳过） */
const isCleanable = (p) => p.trait === 'fragile' && p !== holyTarget && p !== g.current;
/* 先记下"净化前就该在场上的这批砖" —— finishJump 成功后 spawnNext() 会新摆一块，
 * 新砖不该被回溯净化，所以只统计这一批 */
const holyWatch = g.platforms.filter(isCleanable);
const fragCount = holyWatch.length;
const fragSkipped = g.platforms.filter((p) => p === g.current && p.trait === 'fragile').length;
g.next = holyTarget;
g.charRoot.position.set(holyTarget.center.x, 0, holyTarget.center.z);
g.state = 'jumping';
/* 把脚下这块挪远：否则 finishJump 第一分支会判成"原地跳"，圣光根本不触发 */
g.current.center.x += 6;
g.finishJump();
const fragAfterHoly = holyWatch.filter((p) => p.trait === 'fragile').length;
const holy = {
  fragBefore: fragCount, fragAfter: fragAfterHoly,
  skipped: fragSkipped, spawnedFragile: g.platforms.filter((p) => p.trait === 'fragile').length - fragAfterHoly,
  state: g.state, targetTrait: holyTarget.trait,
};
g.forceTrait = null;

/* 7f) 冰冰冰（原「冻结砖」）的**模型与材质** —— 改名不算改完，视觉换没换才是重点。
 *   ★ 必须走 forceTrait + beginRun 让 Platform 真正按 freeze 建一遍；
 *     直接给一块已建好的砖 `.trait = 'freeze'` 只改标签、模型材质一概不变。 */
g.forceTrait = 'freeze';
g.backToTitle();
await sleep(140);
g.beginRun();
await sleep(180);
g.spawnNext();
const iceP = g.platforms[g.platforms.length - 1];
const iceMeshes = [];
iceP.group.traverse((o) => { if (o.isMesh && o.geometry.parameters && o.geometry.parameters.depth !== undefined) iceMeshes.push(o); });
const iceMat = iceMeshes.length ? iceMeshes[0].material : null;
/* 三块的位置/半边长要满足 2b + 2t = h 的锁死关系：
 *   顶块 y = -t、半边长 t（t = 0.23h）；底下两块 y = -h + b、半边长 b = 0.5h - t。
 * 用「块心 y + 半边长」而不是包围盒 —— 三块都带旋转，包围盒算不出"顶面在不在落脚面"。 */
const hh = iceP.height;
const tExp = hh * 0.23;
const bExp = hh * 0.5 - tExp;
const iceBlocks = iceMeshes
  .map((m) => ({ y: +m.position.y.toFixed(3), half: +(m.geometry.parameters.height / 2).toFixed(4) }))
  .sort((a, b) => b.y - a.y);
const ice = {
  count: iceMeshes.length,
  /* 三块共用**同一份**材质实例（不是各建一份 —— 那样物理材质会被编译三遍） */
  shared: iceMeshes.length === 3 && iceMeshes.every((m) => m.material === iceMat),
  /* 顶块：落在 -t、半边长 t */
  topY: iceBlocks[0] ? iceBlocks[0].y : null,
  topHalf: iceBlocks[0] ? iceBlocks[0].half : null,
  tExp: +(-tExp).toFixed(3), tHalf: +tExp.toFixed(4),
  /* 底下两块：落在 -h + b、半边长 b */
  lowYs: iceBlocks.slice(1).map((b) => b.y).join(','),
  lowHalfs: iceBlocks.slice(1).map((b) => b.half).join(','),
  bExpY: +(-hh + bExp).toFixed(3), bExpHalf: +bExp.toFixed(4),
  /* MeshPhysicalMaterial 的"冰"特征 —— 少任何一个都会退回磨砂塑料 */
  ior: iceMat ? +iceMat.ior.toFixed(2) : null,
  clearcoat: iceMat ? iceMat.clearcoat : null,
  transparent: iceMat ? iceMat.transparent : null,
  depthWrite: iceMat ? iceMat.depthWrite : null,
  flatShading: iceMat ? iceMat.flatShading : null,
  /* 顶面图案：freeze 分支已从 iconTexture / 顶面装配里删干净 → icon 必须是空的 */
  hasIcon: !!iceP.icon,
  castsShadow: iceMeshes.some((m) => m.castShadow),
};

/* 7g) 奶块 milk：① 顶面印着蛙脸（作为"有没有顶面图案"的对照组，证明上面那条
 *     判据不是恒假）② 跳上去会放一声大笑，且受设置里的「奶块大笑」开关控制。
 *   ★ 无头环境听不到声音，只能把 sound.laugh() 包一层数调用次数 ——
 *     验的是"game.js 到底有没有去调"，这正是开关的分支所在。 */
let laughHits = 0;
const realLaugh = window.__sound.laugh.bind(window.__sound);
window.__sound.laugh = () => { laughHits++; return realLaugh(); };

/* 每次都在干净的一局里落一次奶块：forceTrait 让新砖全是奶块 */
const landOnMilk = async () => {
  g.forceTrait = 'milk';
  g.backToTitle();
  await sleep(140);
  g.beginRun();
  await sleep(180);
  g.spawnNext();
  const p = g.platforms[g.platforms.length - 1];
  p.radius = 0.8; p.hitRadius = 0.8;
  g.next = p;
  g.charRoot.position.set(p.center.x, 0, p.center.z);
  g.state = 'jumping';
  g.current.center.x += 6;        // 否则 finishJump 第一分支判成"原地跳"，落砖分支不走
  laughHits = 0;
  g.finishJump();
  return p;
};

g.setSetting('laugh', false);
const milkP = await landOnMilk();
const milkLaughOff = { hits: laughHits, icon: !!milkP.icon };
g.setSetting('laugh', true);
await landOnMilk();
/* ★ 2026-10-03 补的盲区：之前只数 laugh() 被调了几次，没验"真的能响"——
 *   结果音源其实是套着 mp3 扩展名的 WMA，decodeAudioData 一直悄悄失败、
 *   线上永远无声，探针却全绿。这里必须断言解码成功且 playClip 真的放出来。 */
const milkLaughOn = {
  hits: laughHits,
  laughReady: !!(window.__sound.clips.laugh && window.__sound.clips.laugh.buf),
  laughPlayed: window.__sound.laugh() === true,
};
g.forceTrait = null;

/* ---------- 8) 装饰 / 角色：赠品不可买 → 装备 → 3D 生效 → 换角色 → 卸下 ---------- */
/* 8a) 生日帽已经是**公告赠品**：商店买不到（buyAcc 直接拒），而且第 1 节已经从
 *     公告里领到手了 —— 这两件事同时成立才对（"来源只有公告按钮"）。 */
const accId = 'hat_birthday';
const noticeBuyErr = g.buyAcc(accId);
const noticeBuy = {
  err: noticeBuyErr,                       // 期望「这件要去公告里领」
  owned: g.ownsAcc(accId),                 // 已在 1b 从公告领到
  inShop: txt('shopShelf').indexOf('生日帽') >= 0,
};

/* 8b) 装备 → 3D 角色上真的挂上了，且位置在头顶之上、尺寸与角色身高成比例 */
g.equipAcc('head', accId);
await sleep(400);                                       // 等头饰贴图解码 + 定位
const ch = g.character;
const headTopY = ch.mesh.position.y + ch.height / 2 - ch.headAnchor().ny * ch.height;
const equipped = {
  id: ch.accId, visible: ch.acc.visible,
  stored: localStorage.getItem('jump3d_acc_head'),
  scale: +ch.acc.scale.x.toFixed(3),
  /* 头饰中心必须落在头顶之上（dy 为正） */
  aboveHead: ch.acc.position.y > headTopY,
  /* 贴图是正方形画布、内容框 h=1，所以画布高就是帽子本体高 */
  relHeight: +(ch.acc.scale.y / ch.height).toFixed(3),           // 本体高/角色高 ≈ hK
};

/* 8c) 角色面板里的头饰行：已存在，这里只验"选中态"跟着走 */
const accRowOn = document.querySelector('#accBar .accCell.on');
const panelAcc = {
  cells: document.querySelectorAll('#accBar .accCell').length,
  onId: accRowOn ? accRowOn.dataset.id : null,
  locked: document.querySelectorAll('#accBar .accCell.locked').length,
};

/* 8d) 换角色：装饰要跟着走（通用装饰的意义就在这里） */
g.pickChar('rabbit');
await sleep(400);
const afterSwap = { id: g.character.accId, visible: g.character.acc.visible };

/* 8e) 卸下：visible 归假、存档清掉 */
g.equipAcc('head', null);
await sleep(120);
const unequipped = {
  id: g.character.accId, visible: g.character.acc.visible,
  stored: localStorage.getItem('jump3d_acc_head'),
};

/* ---------- 8f) 角色买卖 + 动图角色（大笑奶蛙 50 奶币） ---------- */
/* 钱不够：拒绝，余额和拥有清单都不许动 */
const charId = 'laugh';
const charPrice = 50;
g.coins = charPrice - 1;
try { localStorage.setItem('jump3d_coins', String(g.coins)); } catch (e) { /* 忽略 */ }
const charPoorErr = g.buyChar(charId);
const charPoor = { err: charPoorErr, coins: g.coins, owned: g.ownsChar(charId) };

/* 给够钱：正好扣 500，拥有清单落盘 */
g.coins = charPrice + 40;
try { localStorage.setItem('jump3d_coins', String(g.coins)); } catch (e) { /* 忽略 */ }
const charBuyErr = g.buyChar(charId);
const charBought = {
  err: charBuyErr, coins: g.coins, owned: g.ownsChar(charId),
  stored: JSON.parse(localStorage.getItem('jump3d_chars_owned') || '[]'),
};

/* 选中它 → 必须是**真·动图**：animDef 有值，且帧号 / 纹理 UV 随 tick 推进。
 * ★ 这是"动图角色"唯一能自动验证的形态 —— 无头浏览器不播 <img> 里的动画，
 *   要是做成内联动画图，这里只能测出一张静止图。 */
g.pickChar(charId);
await sleep(320);
const ch2 = g.character;
const animBefore = ch2.animIdx;
const uvBefore = ch2.tex ? +ch2.tex.offset.y.toFixed(5) : null;
step(120);                      // 2 秒：远超过单帧时长，必定换过帧
const anim = {
  key: ch2.key,
  isAnim: !!ch2.animDef,
  frames: ch2.animDef ? ch2.animDef.frames : 0,
  cols: ch2.animDef ? ch2.animDef.cols : 0,
  rows: ch2.animDef ? ch2.animDef.rows : 0,
  before: animBefore,
  after: ch2.animIdx,
  advanced: ch2.animIdx !== animBefore,
  uvBefore,
  uvAfter: ch2.tex ? +ch2.tex.offset.y.toFixed(5) : null,
  uvChanged: ch2.tex ? +ch2.tex.offset.y.toFixed(5) !== uvBefore : false,
  /* 动图必须关 mipmap：高层采样会把隔壁格子的像素混进来（边缘重影） */
  noMipmap: ch2.tex ? ch2.tex.generateMipmaps === false : null,
  /* 角色头顶锚点也要算出来（动图只量第一帧那格） */
  headAnchor: !!ch2.headAnchor(),
};
/* 商店/面板里的缩略图必须是**单帧小图**，不能塞整张雪碧图（1510×1592） */
g.openShopPanel();
await sleep(450);
const shopIcoEl = document.querySelector('#shopShelf img.shopIco');
const thumb = {
  w: shopIcoEl ? shopIcoEl.naturalWidth : 0,
  h: shopIcoEl ? shopIcoEl.naturalHeight : 0,
};
g.closeShopPanel();

/* ---------- 9) 设置面板：开关/滑条真的写进存档、面板真的互斥 ---------- */
g.openSettingsPanel();
await sleep(120);
const setRows = [...document.querySelectorAll('#settingsList .setRow')];
const setPanelOpen = !document.getElementById('settingsPanel').classList.contains('hidden');
const setTitle = document.querySelector('#settingsPanel h3').textContent;
const setSoundSw = setRows[0] ? setRows[0].querySelector('.setSwitch') : null;
const soundBefore = g.settingOn('sound');
setSoundSw.click();
const setOff = {
  on: setSoundSw.classList.contains('on'),
  setting: g.settingOn('sound'),
  stored: localStorage.getItem('jump3d_sfx'),
};
setSoundSw.click();
const setBack = {
  on: setSoundSw.classList.contains('on'),
  setting: g.settingOn('sound'),
  stored: localStorage.getItem('jump3d_sfx'),
};
/* 9b) 奶块大笑开关：独立于总音效，各存各的键 */
const laughRow = setRows.find((r) => r.dataset.key === 'laugh');
const laughSw = laughRow ? laughRow.querySelector('.setSwitch') : null;
const laughOnBefore = g.settingOn('laugh');
laughSw.click();
const setLaugh = {
  on: laughSw.classList.contains('on'),
  setting: g.settingOn('laugh'),
  stored: localStorage.getItem('jump3d_laugh'),
};
laughSw.click();
const setLaughBack = {
  on: laughSw.classList.contains('on'),
  setting: g.settingOn('laugh'),
  stored: localStorage.getItem('jump3d_laugh'),
};
/* 9c) 音效音量滑条：拖动（input）实时改增益但不写档，松手（change）才落盘 */
const volRow = setRows.find((r) => r.dataset.key === 'volume');
const volRange = volRow ? volRow.querySelector('.setRange') : null;
const volVal = volRow ? volRow.querySelector('.setRangeVal') : null;
const volWrapSplit = volRow ? volRow.classList.contains('setRowRange') : null;
const volBefore = g.settingOn('sound');
volRange.value = '0.35';
volRange.dispatchEvent(new Event('input', { bubbles: true }));
const volDragging = {
  setting: +Number(g.set.volume).toFixed(2),
  sound: +Number(window.__sound.volume).toFixed(2),
  label: volVal ? volVal.textContent : '',
  stored: localStorage.getItem('jump3d_volume'),      // 拖动中不该落盘
};
volRange.dispatchEvent(new Event('change', { bubbles: true }));
const volDropped = { stored: localStorage.getItem('jump3d_volume') };
/* 总音效关掉时，总线音量必须是 0（不是只把 muted 标上而增益还开着） */
g.setSetting('sound', false);
const volMuted = +Number(window.__sound.volume).toFixed(2);
g.setSetting('sound', volBefore === true);
g.setSetting('volume', 0.7);                          // 收尾：还原默认音量
/* 震动那行的"本设备不支持"标记，必须与现场能力判断一致
 * （无头 Edge 是细指针 → 判为不支持；真实手机才会是可用的开关） */
const vibRow = setRows.find((r) => r.dataset.key === 'vibrate');
const vibNa = vibRow ? vibRow.classList.contains('na') : null;
const vibExpectNa = !(typeof navigator.vibrate === 'function'
  && (!window.matchMedia || window.matchMedia('(pointer: coarse)').matches));
/* 面板互斥：设置开着时，其它面板必须都已经收起 */
const setExclusive = ['charPanel', 'shopPanel', 'noticePanel', 'supportPanel']
  .every((id) => document.getElementById(id).classList.contains('hidden'));
g.closeSettingsPanel();
const setClosed = document.getElementById('settingsPanel').classList.contains('hidden');
/* 「支持作者点不进去」的根因回归：全局 pointerdown 只放行 .ui-block，
 * 按钮漏了这类会被吃掉 preventDefault + press() → 点它直接开局。
 * 首页每个可点按钮都必须带 ui-block，这里挨个验。 */
const uiBlockHole = ['startBtn', 'charBtn', 'bgBtn', 'shopBtn', 'noticeBtn',
  'accountBtn', 'rankBtn', 'settingsBtn', 'supportBtn', 'pauseBtn', 'muteBtn']
  .filter((id) => { const el = document.getElementById(id); return el && !el.closest('.ui-block'); });
const settings = {
  title: setTitle,
  keys: setRows.map((r) => r.dataset.key).join(','),
  rowCount: setRows.length,
  soundBefore, setOff, setBack,
  setLaugh, setLaughBack, laughOnBefore,
  volDragging, volDropped, volMuted, volWrapSplit,
  vibNa, vibExpectNa, setExclusive, uiBlockHole,
  panelOpen: setPanelOpen, setClosed,
};

/* 落正中心 = perfect：base 1 + 连击 1 的 2 分 = 3，×2 之后必须是 6 */
const ok = dotOn === true && notice.panel === true && notice.dot === false
  /* 两条公告：v1.1（带正文）在前、生日帽（无正文）在后 */
  && notice.hasPanel === true && notice.items === 2
  && notice.date.indexOf('2026-10-03') >= 0
  && notice.title.indexOf('v1.1') >= 0
  && notice.firstBody.indexOf('优化了游戏机制') >= 0
  && notice.secondBody === false
  && notice.giftLine.indexOf('生日帽') >= 0 && notice.giftBtn === true
  && notice.ownedBefore === false                     // 弹出来的时候还没领
  /* 领完：进拥有清单、按钮切"已领取"且禁用、判重键落盘、重复触发幂等 */
  && gift.owned === true && gift.btnText.indexOf('已领取') >= 0
  && gift.disabled === true && gift.stored.indexOf('hat_birthday') >= 0
  && gift.keys.indexOf('2026-10-02:hat_birthday') >= 0
  && giftAgain.owned === true && giftAgain.keys === gift.keys.length
  && noticeClosed.panel === false && noticeClosed.dot === false
  && noticeClosed.seen === '3'                 // NOTICE_VERSION 变了这里要跟着改
  && noticeClosed.hasPanel === false
  && noticeAgain === false
  /* 商店：生日帽已下架，只剩"角色"一栏、放着 50 奶币的大笑奶蛙 */
  && shop.panel === true && shop.hasPanel === true && shop.coins === '7'
  && shop.coinIco === 1 && shop.hatGone === true && shop.accHead === false
  && shop.heads === '角色' && shop.charBuy === 1 && shop.price50 === true
  && shopClosed.panel === false && shopClosed.hasPanel === false
  /* —— 奶币：砖上实体 / 拾取 / 累计 / 结算 —— */
  && coinsStart === 7
  && coinOnBrick === true && coinAttached === true && coinFaceIsMesh === true
  && coinPick.runCoins === 1 && coinPick.taken === true && coinPick.landed === true
  && coinPick.tagShown === true && coinPick.tag === '1' && coinPick.tagIco === 1
  && coinPick.meshHidden === true
  && coinPick.coinsUnchanged === true                 // ★ 局内拾取不动真账
  && coinPick2.runCoins === 2 && coinPick2.tag === '2'  // 累计而不是覆盖
  /* 结算 = 起始余额 + 捡到枚数 ×10；分数 999 一分钱都没多给 */
  && settle.runCoins === 2 && settle.coins === coinsStart + 2 * settle.perPick
  && settle.stored === String(settle.coins)
  && settle.overCoin.indexOf(`+${2 * settle.perPick}`) >= 0
  && settle.tag === String(settle.coins) && settle.tagIco === 1
  && loopGuard.injected >= 3 && loopGuard.advanced > 0.25
  && fragile.trait === 'fragile' && fragile.state === 'ready' && fragile.armed === true
  && fragile.gained >= 2
  && fragileAfter.sinking === true
  && (fragileAfter.state === 'falling' || fragileAfter.state === 'over')
  && fragileCleaned.inList === false
  && dbl.trait === 'double' && dbl.state === 'ready' && dbl.gained === 6
  /* —— 特殊效果砖 —— */
  && Math.abs(boostIdle - 1) < 1e-6 && Math.abs(boostAfter - 1.92) < 1e-6 // 1 + 0.92
  && buffTagShown === true && buffTagText.indexOf('弹簧') >= 0
  && distBoosted > distNoBoost * 1.5                           // 那一跳真的更远
  && boostAfterLand === 0 && landState === 'ready'             // ★ 离开弹簧 → 助推结束
  && boostOnSpring === 1                                       // 站在弹簧上 → 还有助推
  && springGapOk === true                                      // ★ 弹簧的下一块不能太近（轻跳也飞不过头）
  && Math.abs(slimeMul - 0.49) < 1e-6                          // (1-0.3)^2（0.40 时代是 0.36）
  && distSlimed < distNoBoost * 0.6                            // 射程真的被砍了
  && slimeOnBrick === 1                                        // 落上粘液 → +1 层
  && slimeGapOk === true                                       // ★ 粘液的下一块不能太远（满蓄力也够得着）
  && slimeAfterLeave === 0 && Math.abs(slimeRangeAfterLeave - 1) < 1e-6  // ★ 离开粘液 → 层数清零、射程复原
  && freezeLand.frozenT > 1.4 && freezeLand.flag === true      // 落上就被冻住，冰壳同步打开
  && freezeLand.dingReady === true && freezeLand.dingPlayed === true // 叮叮叮解码好且真的在放
  && milkLaughOn.hits === 1                                    // 开关开 → 奶块落砖真的去调 laugh
  && milkLaughOn.laughReady === true && milkLaughOn.laughPlayed === true // ★ 大笑音源解码成功且真的能放
  && freezePress.charging === false && freezePress.power === 0 // 冻住期间按不出蓄力
  && freezeThaw.frozenT === 0 && freezeThaw.flag === false     // 1.5s 后自动解冻
  && freezeAfterPress.charging === true                        // 解冻后真的能动了
  && lureDist < lureTol                                        // 磁铁把落点拽进完美范围
  && lureDist < lureNoTrait * 0.35                             // 而且明显比"没磁铁"更接近砖心
  && lureFarDist > lureTol * 2                                 // 蓄力差一大截时，磁铁也救不了
  && holy.fragBefore >= 3 && holy.fragAfter === 0              // 圣光净化场上全部脆砖
  /* —— 冰冰冰：三块真冰块 + 顶面不再有图案 —— */
  && ice.count === 3 && ice.shared === true
  && Math.abs(ice.topY - ice.tExp) < 0.02                      // 顶块落在 -t
  && Math.abs(ice.topHalf - ice.tHalf) < 0.01                  // 顶块半边长 = 0.23h
  && ice.lowYs.split(',').every((v) => Math.abs(Number(v) - ice.bExpY) < 0.02)
  && ice.lowHalfs.split(',').every((v) => Math.abs(Number(v) - ice.bExpHalf) < 0.01)
  && ice.ior === 1.31 && ice.clearcoat === 1                   // 冰的折射率 + 清漆膜
  && ice.transparent === true && ice.depthWrite === false      // 三块互相透出后面的棱
  && ice.flatShading === true                                  // 晶体硬边
  && ice.hasIcon === false                                     // ★ 顶面霜花已删干净
  && ice.castsShadow === false                                 // 半透明不投实心黑影
  && milkLaughOff.icon === true                                // 对照组：奶块顶面是有图案的
  && milkLaughOff.hits === 0 && milkLaughOn.hits === 1         // 开关真的管住那一声大笑
  /* —— 装饰 / 角色 —— */
  && noticeBuy.err === '这件要去公告里领' && noticeBuy.owned === true
  && noticeBuy.inShop === false                                // 赠品确实不在商店里
  && equipped.id === accId && equipped.visible === true
  && equipped.stored === accId
  && equipped.aboveHead === true                               // 帽子在头顶之上，不是嵌进身体
  && Math.abs(equipped.relHeight - 0.46) < 0.02                // 本体高 / 角色高 ≈ hK
  && panelAcc.cells >= 2 && panelAcc.onId === accId            // 面板里当前这件是选中态
  && afterSwap.id === accId && afterSwap.visible === true      // 换角色不掉装饰（通用）
  && unequipped.id === null && unequipped.visible === false
  && unequipped.stored === null                               // 卸下要把存档写掉
  /* 角色买卖 + 动图角色 */
  && charPoor.err === '奶币不够' && charPoor.owned === false
  && charPoor.coins === charPrice - 1                          // 拒绝时余额分毫不动
  && charBought.err === null && charBought.coins === 40        // 90 - 50
  && charBought.owned === true && charBought.stored.indexOf(charId) >= 0
  && anim.key === charId && anim.isAnim === true
  && anim.frames > 1 && anim.cols > 1 && anim.rows > 1
  && anim.advanced === true && anim.uvChanged === true         // 帧号与 UV 都真的在推进
  && anim.noMipmap === true && anim.headAnchor === true
  && thumb.w > 0 && thumb.w < 400                              // 缩略图是单帧小图，不是整张雪碧图
  && thumb.h > 0 && thumb.h < 400
  /* —— 设置面板 —— */
  && settings.panelOpen === true && settings.setClosed === true
  && settings.title === '设置'
  && settings.keys === 'sound,laugh,volume,vibrate' && settings.rowCount === 4
  && settings.soundBefore === true
  && settings.setOff.on === false && settings.setOff.setting === false
  && settings.setOff.stored === '0'                           // 关掉要落盘
  && settings.setBack.on === true && settings.setBack.setting === true
  && settings.setBack.stored === '1'                          // 再开也要落盘
  /* 奶块大笑：独立开关，各存各的键 */
  && settings.laughOnBefore === true
  && settings.setLaugh.on === false && settings.setLaugh.setting === false
  && settings.setLaugh.stored === '0'
  && settings.setLaughBack.on === true && settings.setLaughBack.stored === '1'
  /* 音量滑条：拖动生效但不落盘，松手才写档；总音效关掉时增益归零 */
  && settings.volWrapSplit === true
  && settings.volDragging.setting === 0.35 && settings.volDragging.sound === 0.35
  && settings.volDragging.label === '35%'
  && settings.volDragging.stored === null
  && settings.volDropped.stored === '0.35'
  && settings.volMuted === 0
  && settings.vibNa === settings.vibExpectNa                   // 不支持才压暗，且判断与实现同源
  && settings.setExclusive === true                          // 与其它面板互斥
  && settings.uiBlockHole.length === 0;                       // 首页按钮没有漏 ui-block 的

return {
  ok, dotOn, notice, noticeClosed, noticeAgain, gift, giftAgain,
  shop, shopClosed,
  coinsStart, coinOnBrick, coinAttached, coinFaceIsMesh, coinPick, coinPick2, settle, loopGuard,
  fragile, fragileAfter, fragileCleaned, dbl,
  boost: {
    idle: +boostIdle.toFixed(3), after: +boostAfter.toFixed(3),
    land: boostAfterLand, onSpring: boostOnSpring, buffTagShown, buffTagText,
  },
  dist: { noBoost: +distNoBoost.toFixed(3), boosted: +distBoosted.toFixed(3), slimed: +distSlimed.toFixed(3) },
  gapGuard: {
    springGap: +springGap.toFixed(3), springGapLo: +springGapLo.toFixed(3), springGapOk,
    slimeGap: +slimeGap.toFixed(3), slimeGapHi: +slimeGapHi.toFixed(3), slimeGapOk,
    slimeOnBrick, slimeAfterLeave, slimeRangeAfterLeave: +slimeRangeAfterLeave.toFixed(3),
  },
  slimeMul: +slimeMul.toFixed(3),
  freeze: { land: freezeLand, press: freezePress, thaw: freezeThaw, afterPress: freezeAfterPress },
  lure: {
    dist: +lureDist.toFixed(3), noTrait: +lureNoTrait.toFixed(3),
    tol: +lureTol.toFixed(3), farDist: +lureFarDist.toFixed(3),
    power: +lurePower.toFixed(2),
    gap: +lureGap.toFixed(3), reach: +lureReach.toFixed(3), cap: +lureCap.toFixed(3),
  },
  holy,
  ice,
  milk: { off: milkLaughOff, on: milkLaughOn },
  acc: { noticeBuy, equipped, panelAcc, afterSwap, unequipped },
  char: { poor: charPoor, bought: charBought, anim, thumb },
  settings,
};
