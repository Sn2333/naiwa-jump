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
 *   7) 四种效果砖（弹簧 / 粘液 / 冰冰冰 / 磁铁）+ 冰冰冰的三冰块模型与物理材质
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
const accDef = (id) => (window.__acc && window.__acc.def ? window.__acc.def(id) : null);

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
  /* 置顶标：第一条（紧急通知）必须挂着「置顶」小红标（2026-10-04） */
  pin: (document.querySelector('#noticeBody .noticeItem .noticeTitle .pinTag') || {}).textContent || '',
  firstBody: (document.querySelector('#noticeBody .noticeItem .noticeBody') || {}).textContent || '',
  items: document.querySelectorAll('#noticeBody .noticeItem').length,
  giftLine: (document.querySelector('#noticeBody .noticeGift') || {}).textContent || '',
  giftBtn: !!document.querySelector('#noticeBody .giftBtn'),
  ownedBefore: g.ownsAcc('hat_birthday'),
  /* 第二条 = 新加的 v1.2 更新说明；第四条（生日帽）必须没有正文 —— 那篇的正文用户要自己写 */
  secondTitle: (document.querySelectorAll('#noticeBody .noticeItem .noticeTitle')[1] || {}).textContent || '',
  fourthBody: !!(document.querySelectorAll('#noticeBody .noticeItem .noticeBody')[3]),
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
  /* 头饰 / 背饰两栏都在：光环与很冷的翅膀各 10 奶币，两侧价格按钮都能找到 */
  accHead: txt('shopShelf').indexOf('头饰') >= 0,
  accBack: txt('shopShelf').indexOf('背饰') >= 0,
  accFx: txt('shopShelf').indexOf('特效') >= 0,
  haloInShop: txt('shopShelf').indexOf('光环') >= 0,
  wingInShop: txt('shopShelf').indexOf('很冷的翅膀') >= 0,
  splashInShop: txt('shopShelf').indexOf('魔法阵') >= 0,           // 落地特效上架
  /* ★ 旧「水花」已按要求整体删除 —— 商店里不该再有那两个字 */
  splashGone: txt('shopShelf').indexOf('水花') < 0,
  accBuy10: document.querySelectorAll('#shopShelf [data-buy="halo"], #shopShelf [data-buy="wing"]').length,
  splashBuy: document.querySelectorAll('#shopShelf [data-buy="fx_magic"]').length,
  /* ★ fx 类没有贴图 —— 不能渲染出一个 src="" 的碎图 img */
  splashIcoIsDiv: document.querySelectorAll('#shopShelf [data-buy="fx_magic"]').length === 1
    && [...document.querySelectorAll('#shopShelf .shopItem')]
      .filter((it) => it.textContent.indexOf('魔法阵') >= 0)
      .every((it) => it.querySelector('.shopIco.fxico') && !it.querySelector('img.shopIco')),
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

/* 3d) 结算：捡到的枚数 ×(coinPerPick) 入账，同时每枚给分数外加 coinBonusPoint
 *     ★ 这里故意把 g.score 拉到 999 再结算 —— 金币入账**不该**受分数影响，
 *       但分数**要**因为捡币而变多（999 + 2×5 = 1009）。两件事必须同时成立。 */
g.score = 999;
g.gameOver();
await sleep(150);
const settle = {
  coins: g.coins,                              // 7 + 2×10 = 27
  runCoins: g.runCoins,                        // 2
  perPick: CFG.coinPerPick || 10,
  bonus: CFG.coinBonusPoint || 5,
  score: g.score,                              // ★ 999 + 2×5 = 1009
  overCoin: txt('overCoin'),
  overCoinPoint: txt('overCoinPoint'),         // ★ 加分明细行
  overCoinPointShown: show('overCoinPoint'),
  /* ★ 加分行必须 innerHTML 渲染出 <img>（线上事故：textContent 把标签
   *   原文当文字显示成"一串代码"）——img 存在 + 文本里没有 '<' 才算过 */
  pointIco: document.querySelectorAll('#overCoinPoint .coinIco').length,
  pointNoRaw: document.getElementById('overCoinPoint').textContent.indexOf('<') < 0,
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
 *   三件事一起验：① 助推把射程倍率抬到 1+boostRange；② 那一跳真的更远；
 *   ③ 落到普通砖后自动归零、落在弹簧上则保持 —— 这就是"离开弹簧就结束"。 */
const boostIdle = g.rangeMul();               // 没有助推 = 1
g.setBoost(true);
const boostAfter = g.rangeMul();              // 有助推 = 1 + boostRange（现为 1.25）
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
/* 7a3) 弹簧的下一块**不能太近**：站弹簧上最轻一跳也飞 minReach×(1+boostRange) 远，
 *   生成器要把间距下限抬到轻跳也飞不过头的位置，否则满射程必跳过 —— 物理无解。
 *   注意 boostRange 现在只有 0.25，弹簧下限（≈1.28）已低于全局最小间距 gapMin，
 *   所以这个用例真正的兜底是 gapMin —— 断言取两者的较大值。 */
const springGap = Math.hypot(g.next.center.x - g.current.center.x, g.next.center.z - g.current.center.z);
const springGapLo = Math.max(CFG.gapMin, CFG.jumpMin * (1 + CFG.boostRange) * 1.08);
const springGapOk = springGap >= springGapLo - 1e-6;
g.fixedGap = savedGap7a;

/* 7b) 粘液块 slime：射程倍率被砍（1 → (1-0.25)^2 = 0.5625；0.30 时代是 0.49，0.40 时代是 0.36）。
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
/* 7b3) 站粘液上生成的新一块**不能太远**：射程被砍到 ×0.5625（两层），
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

/* 7e) 冰冰冰（原「冻结砖」）的**模型与材质** —— 改名不算改完，视觉换没换才是重点。
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

/* 7f2) 音效本身的两条硬指标（2026-10-04 用户要求）：
 *   · 大笑只保留**前四秒** —— 原音源 9.98s，落在奶块上会一直笑
 *   · 大笑 / 叮叮叮的音量再调低（真实录音比合成音效响得多）
 *  直接读解码后的 AudioBuffer 时长与源码里的音量参数，不靠"听起来差不多"。 */
const laughBuf = window.__sound.clips.laugh && window.__sound.clips.laugh.buf;
const dingBuf = window.__sound.clips.ding && window.__sound.clips.ding.buf;
const clipInfo = {
  laughDur: laughBuf ? +laughBuf.duration.toFixed(2) : null,
  dingDur: dingBuf ? +dingBuf.duration.toFixed(2) : null,
  laughVol: (window.__clipVol && window.__clipVol.laugh) || null,
  dingVol: (window.__clipVol && window.__clipVol.ding) || null,
};

/* 7g) 圣光砖整体删除（2026-10-04）：配置项没了，抽签池里也不该再出现。
 *   跑一批 spawnNext 实测 —— 池子里要是还留着 holy，120 次几乎必然撞到（原概率 0.035）。
 *   ★ 不重置局内状态：这段夹在别的用例中间，backToTitle/beginRun 会污染后面的用例。 */
let holySeen = 0;
const traitPool = new Set();
const savedPlainMode = g.plainMode;
g.plainMode = false;                          // 关掉 plain 才抽得到特色砖（否则池子恒为 plain，断言是假阳性）
for (let i = 0; i < 120; i++) {
  g.spawnNext();
  const t = g.next.trait || 'plain';
  if (t === 'holy') holySeen++;
  traitPool.add(t);
}
g.plainMode = savedPlainMode;
const holyGone = {
  cfg: !('holyChance' in CFG),
  seen: holySeen,
  pool: [...traitPool].sort().join(','),
};

/* ---------- 7i) FOV 40：画面缩小 = 视野扩大（2026-10-04） ---------- */
const fovNow = window.__CFG.fov;

/* ---------- 7j) MJ 砖 + 蜘蛛奶抓人 ----------
 * ① 砖上真的立着 M/J 点阵字母（BoxGeometry 粒数：M 13 + J 9 = 22）
 * ② 落砖 → mjTimer 武装；离开脚下砖 → 计时作废
 * ③ 站满 1s → mjgrab 演出（drop→grab→rise→land 全由 tick 推进）
 * ④ 被放回后方第 3 块砖（不足取最近）+ 目标砖之后的旧链当场清干净 + 覆盖层收干净
 * ★ forceTrait 绕过 plain 模式（抽签链根本不进），?plain 的探针 URL 也能造出 MJ 砖。 */
g.forceTrait = 'mj';
g.backToTitle();
await sleep(140);
g.beginRun();
await sleep(180);
g.spawnNext();
const mjP = g.platforms[g.platforms.length - 1];
let mjCubeCount = 0, mjCylCount = 0, mjFlat = null;
let frameLegs = 0, frameHoops = 0;
/* 砖上可能随机挂着一枚奶币（圆柱做的，且和砖身无关）—— 统计时跳过 coin 子树。
 * 框架腿也是圆柱（半径 0.02 细杆），"无砖身"只指半径 > r/2 的实心大圆柱 */
for (const child of mjP.group.children) {
  if (child === mjP.coin) continue;
  child.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (o.geometry.type === 'BoxGeometry') mjCubeCount++;
    else if (o.geometry.type === 'CylinderGeometry') {
      const pr = (o.geometry.parameters || {}).radiusTop || 0;
      if (pr > mjP.radius / 2) mjCylCount++;        // 实心砖身圆柱
      else frameLegs++;                             // 框架细杆
    } else if (o.geometry.type === 'TorusGeometry') {
      if ((o.geometry.parameters || {}).tube < 0.05) frameHoops++;  // 环箍
    }
  });
}
/* 字母组 = group 的 child 里唯一 rotation.x ≈ -π/2 的 Group（卧倒） */
for (const o of mjP.group.children) {
  if (o.isGroup && o.rotation.order === 'YXZ' && Math.abs(o.rotation.x + Math.PI / 2) < 0.01) {
    mjFlat = { ry: +o.rotation.y.toFixed(3), lift: +o.position.y.toFixed(3) };
  }
}
mjP.radius = 0.8; mjP.hitRadius = 0.8;
g.next = mjP;
g.charRoot.position.set(mjP.center.x, 0, mjP.center.z);
g.state = 'jumping';
g.current.center.x += 6;        // 否则 finishJump 第一分支判成"原地跳"
g.finishJump();
const mjIdx = g.platforms.indexOf(mjP);
const mjArmed = {
  trait: mjP.trait,
  state: g.state,
  timer: g.mjTimer == null ? null : +g.mjTimer.toFixed(2),
  letters: mjCubeCount,
  idx: mjIdx,
  noBody: mjCylCount === 0,        // ★ 无实心砖身（细框架不算——用户要"看不见支撑"）
  flat: mjFlat,                    // ★ 字母平躺：order YXZ、rx≈-π/2、抬 cell/2 贴地
  frame: { legs: frameLegs, hoops: frameHoops },   // ★ 6 细杆 + 2 环箍托住落脚面
};
/* tick 推进 2s（> mjDwell 1.5s）→ 蜘蛛登场 */
const mjTickOnce = () => { g._noRender = true; g.tick(0.05); g._noRender = false; };
for (let i = 0; i < 40 && g.state !== 'mjgrab'; i++) mjTickOnce();
for (let i = 0; i < 4 && g.state === 'mjgrab'; i++) mjTickOnce();   // 再走几帧看 DOM
const mjDrop = {
  state: g.state,
  phase: g.mj ? g.mj.phase : null,
  layerShown: g.dom.mjLayer.classList.contains('show'),
  spiderTop: g.dom.mjSpider.style.top || null,       // 蜘蛛 DOM 真的在被驱动
  silkH: g.dom.mjSilk.style.height || null,
};
/* mjgrab 期间 press() 必须无效 */
g.press();
const mjPressBlocked = g.state === 'mjgrab';
/* 推完整场演出（0.7+0.25+0.6+落体 ≈ 1.8s，0.05×80=4s 余量） */
for (let i = 0; i < 80 && g.state === 'mjgrab'; i++) mjTickOnce();
const mjDone = {
  state: g.state,
  layerGone: !g.dom.mjLayer.classList.contains('show'),
  curIdx: g.platforms.indexOf(g.current),
  backOk: g.platforms.indexOf(g.current) === Math.max(0, mjIdx - 3),
  nextIsMj: g.next === g.platforms[g.platforms.indexOf(g.current) + 1],
  charVisible: g.charRoot.visible,
  blobVisible: g.blob.visible,
  mjCleared: g.mj === null,
  /* ★ 抓回 = 重新出发：目标砖之后的旧链当场清干净（数组只剩 current + 新 next），
   *   原 MJ 砖（m.from）必须已被 dispose 掉 —— 线上事故：抓回后旧砖不消失、
   *   新砖无限堆积（spawnNext 只加尾不清中段，旧链变永久孤儿） */
  tailCut: !g.platforms.includes(mjP)
    && g.platforms.length === Math.max(0, mjIdx - 3) + 2,
};
/* 继续跳（spawnNext×6）：数组长度有上界，旧砖不堆积 */
for (let i = 0; i < 6; i++) g.spawnNext();
const mjGrow = { len: g.platforms.length, mjGone: !g.platforms.includes(mjP) };
/* 计时守卫：站在 MJ 砖上才倒数，离开脚下砖即作废 */
g.current.trait = 'mj'; g.mjTimer = 0.4;
mjTickOnce();
const mjKeepOnBrick = g.mjTimer != null;
g.current.trait = null;
mjTickOnce();
const mjLeaveCancels = g.mjTimer === null;
const mjCancel = { keepOnBrick: mjKeepOnBrick, leaveCancels: mjLeaveCancels };

/* ---------- 7k) 奶块大笑 GIF ----------
 * 笑声的同时砖上方浮出大笑奶蛙动图：Sprite、独立纹理实例（不与角色雪碧图
 * 共用 → 无 UV 冲突）、雪碧图切帧中（repeat<1）、播完（4.2s）自清。 */
/* 清掉早前奶块用例留下的 GIF，不然新旧难分 */
for (const f of g.fx.filter((f) => f.kind === 'gif')) {
  g.scene.remove(f.mesh);
  f.mesh.material.map.dispose();
  f.mesh.material.dispose();
  g.fx.splice(g.fx.indexOf(f), 1);
}
g.forceTrait = 'milk';
g.backToTitle();
await sleep(140);
g.beginRun();
await sleep(180);
g.spawnNext();
const milkP2 = g.platforms[g.platforms.length - 1];
milkP2.radius = 0.8; milkP2.hitRadius = 0.8;
g.next = milkP2;
g.charRoot.position.set(milkP2.center.x, 0, milkP2.center.z);
g.state = 'jumping';
g.current.center.x += 6;
laughHits = 0;
g.finishJump();
const gifFx = g.fx.find((f) => f.kind === 'gif');
const gif = {
  laughHits,
  hasGif: !!gifFx,
  isSprite: gifFx ? gifFx.mesh.isSprite : null,
  life: gifFx ? +gifFx.life.toFixed(2) : null,
  max: gifFx ? +gifFx.max.toFixed(2) : null,
  ownTex: gifFx ? gifFx.mesh.material.map !== g.character.tex : null,   // ★ 独立实例
  repeatW: gifFx ? +gifFx.mesh.material.map.repeat.x.toFixed(4) : null, // <1 = 切帧中
  opacity: gifFx ? +gifFx.mesh.material.opacity.toFixed(2) : null,
  aboveChar: gifFx ? gifFx.mesh.position.y > g.character.height : null,
};
for (let i = 0; i < 100 && g.fx.some((f) => f.kind === 'gif'); i++) mjTickOnce();
const gifGone = { left: g.fx.filter((f) => f.kind === 'gif').length };
g.forceTrait = null;

/* 7h) 角色体积缩小：所有角色按 character.js 的 CFG.height 统一高度，现在封顶 1.48
 *   （原 1.62）。过宽角色会等比缩小，所以 h ≤ 1.48、w ≤ h 都要成立。 */
const charSize = {
  h: +g.character.height.toFixed(3),
  w: +g.character.width.toFixed(3),
  footR: +g.character.footR.toFixed(3),
};

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
/* 尺寸断言必须按**内容框**算：画布是正方形的，但装饰主体只占其中一块
 * （光环的内容框只有画布高的 48%），所以"画布高 / 角色高"并不等于 hK ——
 * 要乘回 box.h 才是本体高。 */
const accContentH = (mesh, deco) => {
  const boxes = (window.__acc && window.__acc.box) || {};
  const box = boxes[deco.img] || { h: 1 };
  return mesh.scale.y * (box.h || 1);
};
/* 内容**宽度**同理（背饰这类"宽扁"素材最容易在这一维翻车：冰晶内容框宽高比 1.63，
 * hK 稍大一点内容宽度就失控，整组从"背上的翅膀"变成"横着摊开的冰环"）。 */
const accContentW = (mesh, deco) => {
  const boxes = (window.__acc && window.__acc.box) || {};
  const box = boxes[deco.img] || { w: 1 };
  return mesh.scale.x * (box.w || 1);
};
g.equipAcc('head', accId);
await sleep(400);                                       // 等头饰贴图解码 + 定位
const ch = g.character;
const accHead = ch.accLayer.head;
const headTopY = ch.mesh.position.y + ch.height / 2 - ch.headAnchor().ny * ch.height;
const equipped = {
  id: ch.accIds.head, visible: accHead.visible,
  stored: localStorage.getItem('jump3d_acc_head'),
  scale: +accHead.scale.x.toFixed(3),
  /* 头饰中心必须落在头顶之上（dy 为正） */
  aboveHead: accHead.position.y > headTopY,
  /* 头饰要在立绘前面（z 为正） */
  inFront: accHead.position.z > 0,
  relHeight: +(accContentH(accHead, accDef(accId)) / ch.height).toFixed(3),   // ≈ hK
};

/* 8b2) 光环（10 奶币）：走同一套头饰槽位，买了能戴、位置在头顶之上 */
g.coins = 100;
const haloErr = g.buyAcc('halo');
const haloBought = {
  err: haloErr, coins: g.coins, owned: g.ownsAcc('halo'),
  price: accDef('halo').price,
  stored: JSON.parse(localStorage.getItem('jump3d_acc_owned') || '[]').includes('halo'),
};
g.equipAcc('head', 'halo');
await sleep(400);
const haloEq = {
  id: ch.accIds.head, visible: ch.accLayer.head.visible,
  aboveHead: ch.accLayer.head.position.y > headTopY,
  relHeight: +(accContentH(ch.accLayer.head, accDef('halo')) / ch.height).toFixed(3),  // ≈ 0.30
};

/* 8b3) 很冷的翅膀（10 奶币）：**独立背饰槽位** —— 与头饰同时存在、互不顶替，
 *      且垫在角色后面（z 为负），不会被身体挡住。 */
const wingErr = g.buyAcc('wing');
g.equipAcc('back', 'wing');
await sleep(400);
const wingEq = {
  err: wingErr, owned: g.ownsAcc('wing'),
  price: accDef('wing').price,
  cat: accDef('wing').cat,
  id: ch.accIds.back, visible: ch.accLayer.back.visible,
  /* 两槽共存：头饰还戴着，背饰也戴着 */
  headStillOn: ch.accIds.head === 'halo',
  behind: ch.accLayer.back.position.z < 0,          // 垫在身后
  underHead: ch.accLayer.back.renderOrder < 0,      // 先画（在角色之下）
  /* ★ 背饰必须挂在"上背"而不是飘在头顶之上：它的下沿要低于头顶。
   *   第一版按画布中心摆，翅膀直接飞到了脑袋上面（截图一眼假）。 */
  belowHead: (ch.accLayer.back.position.y - ch.accLayer.back.scale.y / 2) < headTopY,
  relHeight: +(accContentH(ch.accLayer.back, accDef('wing')) / ch.height).toFixed(3),  // ≈ hK = 1.05
  /* ★ 宽度也要卡住：冰晶贴图是"宽扁"内容框（宽高比 1.63），hK 给大了宽度会失控。
   *   ★ 分母用**角色高**而不是角色宽 —— 装饰尺寸本来就按"角色高 × hK"定（见
   *     _layoutSlot），所以"宽 / 角色高"才是与角色体型无关的**不变量**；
   *     换成"宽 / 角色宽"会随角色 aspect 大幅波动（兔子 aspect 0.54、假日威龙奶 1.10），
   *     同一个翅膀在两只身上算出两个数，卡不住。
   *   期望 ≈ 1.46（内容 2.17 世界单位 / 角色高 1.48），范围 1.2~1.8 ——
   *   下限防止又缩回"被身体挡住"，上限防止又"横着摊开"。 */
  relWidth: +(accContentW(ch.accLayer.back, accDef('wing')) / ch.height).toFixed(2),
  stored: localStorage.getItem('jump3d_acc_back'),
};

/* 8c) 角色面板仓库行：两行（头饰 / 背饰）。**已拥有的不显示价格、未拥有的低亮 + 价签**
 *     —— 这条是玩家反馈的直接验收点，价格只能出现在 locked 的格子里。 */
g.openCharPanel();
await sleep(200);
const accCells = [...document.querySelectorAll('#accBar .accCell')];
const accRows = [...document.querySelectorAll('#accBar .accRow')];
const ownedWithPrice = accCells.filter((c) => {
  const id = c.dataset.id;
  return id && g.ownsAcc(id) && c.querySelector('.accPrice');
});
const lockedWithoutPrice = accCells.filter((c) => {
  const id = c.dataset.id;
  return id && !g.ownsAcc(id) && !c.querySelector('.accPrice');
});
const accRowOn = document.querySelector('#accBar .accCell.on');
const panelAcc = {
  rows: accRows.length,                              // 期望 3（头饰 + 背饰 + 特效）
  rowNames: accRows.map((r) => r.querySelector('h4').textContent).join(','),
  insideGrid: !!document.querySelector('#charGrid > #accBar'),  // ★ 并进滚动区（不挡角色）
  cells: accCells.length,
  ownedWithPrice: ownedWithPrice.length,             // 期望 0：拥有的一律不标价
  lockedWithoutPrice: lockedWithoutPrice.length,     // 期望 0：未拥有的一律有价签
  wingCell: !!accCells.find((c) => c.dataset.id === 'wing'),   // 很冷的翅膀在仓库里可见
  haloCell: !!accCells.find((c) => c.dataset.id === 'halo'),
  /* fx 类也有格子（否则玩家不知道去哪儿买落地特效）；未拥有 → 有价签 + 不带贴图 */
  splashCell: !!accCells.find((c) => c.dataset.id === 'fx_magic'),
  splashLocked: (() => {
    const c = accCells.find((x) => x.dataset.id === 'fx_magic');
    return !!c && c.classList.contains('locked') && !!c.querySelector('.accPrice')
      && !!c.querySelector('.accThumb.fxico') && !c.querySelector('img');
  })(),
  onId: accRowOn ? accRowOn.dataset.id : null,
  locked: document.querySelectorAll('#accBar .accCell.locked').length,
};
g.closeCharPanel();

/* 8d) 换角色：装饰要跟着走（通用装饰的意义就在这里 —— 头饰背饰都在） */
g.pickChar('rabbit');
await sleep(400);
const afterSwap = {
  head: g.character.accIds.head, headVisible: g.character.accLayer.head.visible,
  back: g.character.accIds.back, backVisible: g.character.accLayer.back.visible,
};

/* 8e) 卸下：visible 归假、存档清掉（只摘头饰，背饰不受影响） */
g.equipAcc('head', null);
await sleep(120);
const unequipped = {
  id: g.character.accIds.head, visible: g.character.accLayer.head.visible,
  stored: localStorage.getItem('jump3d_acc_head'),
  backKept: g.character.accIds.back === 'wing' && g.character.accLayer.back.visible,
};

/* ---------- 8e2) 落地特效「魔法阵」：买 → 装 → 落地真出阵 → 卸下就不出 ----------
 * ★ 这是第三类装饰（cat='fx'），且在 2026-10-04 第十九段把原来的「水花」换成了它。
 *   它和其他装饰根本不同：**没有 3D 贴图**，不进 character 的槽位，而是 game.js
 *   在落地瞬间读 accEquip.fx 决定要不要在脚下铺一圈魔法阵。
 *   所以这里必须验三件事，缺一件都可能"看着装上了其实没反应"：
 *     1) 它不能建出 mesh（组装饰时 setAccessory 对 fx 槽必须安全返回）；
 *     2) 装上后落地，this.fx 里真的多出魔法阵图层（外圈+内圈+阵眼+6根射线，共 9 片）；
 *     3) 卸下后再落地，fx 数回到基线 —— 否则就是"装上就再也关不掉"。 */
const fxId = 'fx_magic';
g.coins = 200;
try { localStorage.setItem('jump3d_coins', String(g.coins)); } catch (e) { /* 忽略 */ }
const splashBuyErr = g.buyAcc(fxId);
const splashBought = {
  err: splashBuyErr, owned: g.ownsAcc(fxId),
  stored: JSON.parse(localStorage.getItem('jump3d_acc_owned') || '[]'),
  /* fx 槽不该有 mesh：装了也不该往 character 上挂任何东西 */
  noMesh: !g.character.accLayer.fx,
};
/* 装备 + 同步一次 → accEquip.fx 与 hasFx() 都要对上 */
g.equipAcc('fx', fxId);
await sleep(120);
const splashEquipped = {
  equipped: g.accEquip.fx,
  stored: localStorage.getItem('jump3d_acc_fx'),
  hasFx: g.hasFx('magic'),
  notOther: g.hasFx('nonexist') === false,
  /* 装了特效也不该影响头饰 / 背饰这两个真槽位 */
  headKept: g.character.accLayer.head !== undefined,
};
/* 落地一次：数 fx 数组的涨落。基线先量一次（清空现有特效） */
const clearFx = () => { for (const f of g.fx) { g.scene.remove(f.mesh); } g.fx.length = 0; };
clearFx();
g.landmagic(new window.__THREE.Vector3(0, 0, 0));
const splashParticles = g.fx.length;
const splashAfterOne = {
  count: splashParticles,
  ring: g.fx.filter((f) => f.kind === 'ring').length,
  magic: g.fx.filter((f) => f.kind === 'magic').length,
  /* 魔法阵是平铺在地上的：所有图层都该是贴地平面（rotation.x ≈ -90°），y 很小 */
  lowStart: g.fx.filter((f) => f.kind === 'magic').every((f) => f.mesh.position.y < 0.2),
  /* 生命要短：这是"短暂落地特效"，最长也别超过 1 秒 */
  shortLife: g.fx.every((f) => f.max <= 1.0),
  /* ★ 魔法阵图层：外圈/内圈是环（RingGeometry），阵眼是圆（CircleGeometry）
   *  或射线是面片（PlaneGeometry）—— 总之都必须是**平面几何**，不是立方体。 */
  flats: g.fx.filter((f) => f.kind === 'magic')
    .every((f) => ['RingGeometry', 'CircleGeometry', 'PlaneGeometry'].includes(f.mesh.geometry.type)),
  /* ★ 会旋转：每片都记了初始角 rot0，且 spin 非 0 —— 静止的阵看着像贴纸 */
  spinning: g.fx.filter((f) => f.kind === 'magic').some((f) => f.spin && f.spin !== 0),
};
clearFx();
/* 卸下 → hasFx 假 → 不再铺阵 */
g.equipAcc('fx', null);
await sleep(80);
const splashOff = {
  equipped: g.accEquip.fx || null,
  hasFx: g.hasFx('magic'),
  stored: localStorage.getItem('jump3d_acc_fx'),
  /* 卸下之后，落地分支里的 hasFx 判定为假，fx 数组不该再增长 */
  grow: (() => { clearFx(); if (g.hasFx('magic')) g.landmagic(new window.__THREE.Vector3(0, 0, 0)); return g.fx.length; })(),
};
clearFx();
/* 8e3) 端到端：真的走一次 finishJump 落地分支 —— 这是"接没接上"的唯一硬证据。
 *      landmagic() 单测能过，但 finishJump 里 hasFx 判断写错（读错槽位 /
 *      压根没调）照样绿。所以这里关掉特效跳一次、开着特效跳一次，比 fx 峰值。
 *      ★ 全程用 step() 手动推进（不 await），否则 400+ 帧的 await 会让探针超时。 */
g.equipAcc('fx', null);
await sleep(80);
document.getElementById('startBtn').click();
await sleep(450);
clearFx();
g.botPress();
/* ★ 量的是**峰值**而不是终值：落地那一帧除了魔法阵，本来就会撒一把
 *  原版的落地尘土（dust），它们要好几帧才淡完 —— 取终值会把尘土算进来，
 *   于是"没装备特效"也变成 40，断言永远假红。魔法阵是**额外**多出来的那一批，
 *   所以关/开两次的峰值之差才是"魔法阵真的接上了"的证据。
 * ★ 帧数要**刚好**够：落地（≈40 帧）后再跑满特效寿命（0.92s≈57 帧），
 *   一共 110 帧就能"看到峰值 + 看到它自己淡完"。跑 220×2 会让
 *   Runtime.evaluate 撞 60s 超时（本探针已有 46 段 await sleep）。 */
const runJumpFrames = () => {
  let peak = 0;
  /* ★ 必须关渲染（_noRender）：无头软件 WebGL 里每帧 render 要上百毫秒，
   *   跑 130 帧就该 10s+，两趟直接把 Runtime.evaluate 顶到超时。
   *   这里只推进物理（魔法阵的 life/scale/opacity 都在 tick 里算），
   *   画面交给一直在跑的 rAF 循环出。 */
  g._noRender = true;
  let landed = false;
  for (let i = 0; i < 130; i++) {
    g.tick(0.016);
    peak = Math.max(peak, g.fx.length);
    if (!landed && g.state === 'ready' && i > 20) landed = true;
    if (landed && i > 0 && g.fx.length === 0) break;
  }
  g._noRender = false;
  return peak;
};
let splashE2eOffPeak = runJumpFrames();
const splashE2eOff = { peak: splashE2eOffPeak, fx: g.fx.length };
/* 装上再跳一次：落地那一瞬必须铺出完整一圈（峰值 9 片以上） */
g.equipAcc('fx', fxId);
await sleep(120);
for (let i = 0; i < 80 && g.state !== 'ready'; i++) g.tick(0.016);
clearFx();
g.botPress();
const splashE2ePeak = runJumpFrames();
const splashE2e = {
  off: splashE2eOff.peak, peak: splashE2ePeak, after: g.fx.length,
  hasFx: g.hasFx('magic'),
};
clearFx();
/* 收尾：把魔法阵装回去，方便后面截图看效果；金币交还给后续用例 */
g.coins = 7;
try { localStorage.setItem('jump3d_coins', String(g.coins)); } catch (e) { /* 忽略 */ }

/* 8f0) 后加的免费角色：奶霸 / 小奶比耶 / 托脸奶蛙 / 假日威龙奶，以及
 *      2026-10-04 第十八段新增的 奶罐 / 隐忍奶蛙 / 超长长长奶蛙（其中超长长长奶蛙
 *      是「经典奶蛙横向压扁到 0.34」派生出来的，sprite_data.js 靠 --only 重建，
 *      最容易出的错就是"贴图生成了但没进 CHARS"→ 格子静默少一只。这里**逐个点名**。
 *      免费角色（price 0）在面板里直接可选、不挂价签。 */
const newCharSpec = [
  ['boss', '奶霸'], ['peace', '小奶比耶'],
  ['think', '托脸奶蛙'], ['holiday', '假日威龙奶'],
  ['milkjar', '奶罐'], ['endure', '隐忍奶蛙'], ['skinny', '超长长长奶蛙'],
];
g.openCharPanel();
await sleep(200);
const newChars = newCharSpec.map(([k, want]) => {
  const cell = document.querySelector(`#charGrid .charCell[data-key="${k}"]`);
  const def = window.__chars ? window.__chars.def(k) : null;
  return {
    key: k,
    cell: !!cell,
    name: def ? def.name : null,
    nameOk: def ? def.name === want : false,
    price: def ? (def.price || 0) : -1,
    locked: cell ? cell.classList.contains('locked') : null,   // 免费 → 不该 locked
    priceTag: cell ? !!cell.querySelector('.charLock') : null, // 免费 → 不该有价签
    label: cell ? cell.querySelector('span').textContent.trim() : '',
  };
});
const charTotal = document.querySelectorAll('#charGrid .charCell').length;
/* ★ 经典奶蛙（初始角色）必须排在**第一格** —— 用户 2026-10-04 要求它置顶。
 *  以前它排在列表尾巴上，是因为派生角色 skinny 复制了它的写法被随手塞在末尾，
 *  搬 CHARS 时把它一起带下去了。这条断言防回归。 */
const firstChar = document.querySelector('#charGrid .charCell');
const frogFirst = !!(firstChar && firstChar.dataset.key === 'frog');
/* ★ 奶怒2 的贴图曾经是 0 字节 webp（转码那次静默失败）→ uri 变成空 base64，
 *  格子里是一片空白。这里直接查它拿到的贴图 data URI 长度，空了就红。 */
const angry2Def = window.__chars ? window.__chars.def('angry2') : null;
const angry2UriLen = angry2Def && angry2Def.uri ? angry2Def.uri.length : 0;
g.closeCharPanel();
await sleep(150);

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

/* ---------- 10) 玩家固定编号（#10000001 起）的显示 ----------
 * 服务端按昵称发号（who/submit/rank 都带 pid），前端在 userTag 与榜单行
 * 昵称后面各缀一个半透明 .pid。这里伪造响应直接驱动渲染，不依赖网络。 */
const pidTag = (async () => {
  const P = window.__profile || {};
  P.nick = '测试蛙';
  P.pid = 10000001;
  g.refreshNickUI();
  const tag = document.getElementById('userTag');
  const tagPid = tag ? tag.querySelector('.pid') : null;
  /* 榜单行：拦 fetch，喂一条带 pid 的假榜单，再跑一遍真实的渲染代码 */
  const realFetch = window.fetch;
  window.fetch = (u, o) => String(u).indexOf('/api/rank') >= 0
    ? Promise.resolve(new Response(JSON.stringify({
      ok: true,
      list: [{ rank: 1, nick: '测试蛙', best: 9, pid: 10000001 }],
      me: { rank: 1, best: 9, pid: 10000001 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(u, o);
  let rows = null;
  try { await g.refreshRank(); } catch (e) { /* 渲染内部已兜错 */ }
  window.fetch = realFetch;
  const row0 = document.querySelector('#rankList .rankRow');
  const rowPid = row0 ? row0.querySelector('.pid') : null;
  const nk = row0 ? row0.querySelector('.nk') : null;
  rows = {
    tagText: tagPid ? tagPid.textContent : '',
    rowPid: rowPid ? rowPid.textContent : '',
    order: row0 ? (nk.nextSibling === rowPid) : false,   // 编号紧跟昵称后面
    dim: rowPid ? getComputedStyle(rowPid).opacity : null,
  };
  P.nick = ''; P.pid = null;                              // 还原，别污染后面的用例
  g.refreshNickUI();
  return rows;
})();
const pidTagOut = await pidTag;

/* 落正中心 = perfect：base 1 + 连击 1 的 2 分 = 3，×2 之后必须是 6 */
const ok = dotOn === true && notice.panel === true && notice.dot === false
  /* 四条公告：紧急通知(置顶·带正文)→ v1.2(带正文) → v1.1（带正文）→ 生日帽（无正文） */
  && notice.hasPanel === true && notice.items === 4
  && notice.date.indexOf('2026-10-03') >= 0
  && notice.title.indexOf('紧急通知') >= 0
  && notice.pin === '置顶'                            // ★ 紧急公告挂置顶标（且排第一：date 断言已卡）
  && notice.secondTitle.indexOf('v1.2') >= 0          // ★ 新公告插在置顶之后、v1.1 之前
  && notice.firstBody.indexOf('浏览器缓存') >= 0 && notice.firstBody.indexOf('建议使用浏览器') >= 0
  && notice.firstBody.indexOf('特此通知') >= 0
  && notice.fourthBody === false
  && notice.giftLine.indexOf('生日帽') >= 0 && notice.giftBtn === true
  && notice.ownedBefore === false                     // 弹出来的时候还没领
  /* 领完：进拥有清单、按钮切"已领取"且禁用、判重键落盘、重复触发幂等 */
  && gift.owned === true && gift.btnText.indexOf('已领取') >= 0
  && gift.disabled === true && gift.stored.indexOf('hat_birthday') >= 0
  && gift.keys.indexOf('2026-10-02:hat_birthday') >= 0
  && giftAgain.owned === true && giftAgain.keys === gift.keys.length
  && noticeClosed.panel === false && noticeClosed.dot === false
  && noticeClosed.seen === '6'                 // NOTICE_VERSION 变了这里要跟着改
  && noticeClosed.hasPanel === false
  && noticeAgain === false
  /* 商店：生日帽已下架；角色栏放着 50 奶币的大笑奶蛙；装饰栏有头饰 + 背饰 */
  && shop.panel === true && shop.hasPanel === true && shop.coins === '7'
  && shop.coinIco === 1 && shop.hatGone === true
  && shop.accHead === true && shop.accBack === true                 // 两个装饰分类都在
  && shop.accFx === true                                            // ★ 第三类"特效"也上架了
  && shop.haloInShop === true && shop.wingInShop === true           // 光环 / 冰锥翅膀上架
  && shop.splashInShop === true && shop.splashBuy === 1             // 魔法阵 10 奶币 + 一个价格按钮
  && shop.splashGone === true                                       // ★ 旧「水花」已删，商店里不该有
  && shop.splashIcoIsDiv === true                                   // ★ 无贴图不渲染碎图 img
  && shop.accBuy10 === 2                                            // 两件都还没买 → 各一个价格按钮
  && shop.charBuy === 1 && shop.price50 === true
  && shopClosed.panel === false && shopClosed.hasPanel === false
  /* 玩家编号：userTag 与榜单行的昵称后面都要缀半透明 #10000001 */
  && pidTagOut.tagText === '#10000001'
  && pidTagOut.rowPid === '#10000001' && pidTagOut.order === true
  && pidTagOut.dim !== null && Number(pidTagOut.dim) < 0.9
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
  /* ★ 结算时局内拾取的奶币每枚加 coinBonusPoint 分：999 + 2×5 = 1009 */
  && settle.bonus === 5 && settle.score === 999 + 2 * settle.bonus
  && settle.overCoinPointShown === true
  && settle.overCoinPoint.indexOf('+10') >= 0 && settle.overCoinPoint.indexOf('2') >= 0
  && settle.pointIco >= 1 && settle.pointNoRaw === true        // ★ img 真渲染、无 HTML 原文
  && settle.tag === String(settle.coins) && settle.tagIco === 1
  && loopGuard.injected >= 3 && loopGuard.advanced > 0.25
  && fragile.trait === 'fragile' && fragile.state === 'ready' && fragile.armed === true
  && fragile.gained >= 2
  && fragileAfter.sinking === true
  && (fragileAfter.state === 'falling' || fragileAfter.state === 'over')
  && fragileCleaned.inList === false
  && dbl.trait === 'double' && dbl.state === 'ready' && dbl.gained === 6
  /* —— 特殊效果砖 —— */
  && Math.abs(boostIdle - 1) < 1e-6 && Math.abs(boostAfter - (1 + CFG.boostRange)) < 1e-6 // 1 + 0.50
  && buffTagShown === true && buffTagText.indexOf('弹簧') >= 0
  && distBoosted > distNoBoost * 1.4                           // 那一跳真的更远（射程 ×1.50）
  && boostAfterLand === 0 && landState === 'ready'             // ★ 离开弹簧 → 助推结束
  && boostOnSpring === 1                                       // 站在弹簧上 → 还有助推
  && springGapOk === true                                      // ★ 弹簧的下一块不能太近（轻跳也飞不过头）
  && Math.abs(slimeMul - 0.25) < 1e-6                          // (1-0.50)^2
  && distSlimed < distNoBoost * 0.35                           // 射程真的被砍掉一大半
  && slimeOnBrick === 1                                        // 落上粘液 → +1 层
  && slimeGapOk === true                                       // ★ 粘液的下一块不能太远（满蓄力也够得着）
  && slimeAfterLeave === 0 && Math.abs(slimeRangeAfterLeave - 1) < 1e-6  // ★ 离开粘液 → 层数清零、射程复原
  && freezeLand.frozenT > 1.4 && freezeLand.flag === true      // 落上就被冻住，冰壳同步打开
  && freezeLand.dingReady === true && freezeLand.dingPlayed === true // 叮叮叮解码好且真的在放
  && milkLaughOn.hits === 1                                    // 开关开 → 奶块落砖真的去调 laugh
  && milkLaughOn.laughReady === true && milkLaughOn.laughPlayed === true // ★ 大笑音源解码成功且真的能放
  /* —— 音源本身：大笑只留前 4 秒、两段录音都调低过 —— */
  && clipInfo.laughDur !== null && clipInfo.laughDur > 3.5 && clipInfo.laughDur < 4.6
  && clipInfo.dingDur !== null && clipInfo.dingDur > 0.3
  && clipInfo.laughVol !== null && clipInfo.laughVol <= 0.35   // 调低过（原 0.85/0.55）
  && clipInfo.dingVol !== null && clipInfo.dingVol <= 0.40     // 调低过（原 0.9/0.6）
  && clipInfo.laughVol >= 0.12 && clipInfo.dingVol >= 0.15     // 但也别调到听不见
  && freezePress.charging === false && freezePress.power === 0 // 冻住期间按不出蓄力
  && freezeThaw.frozenT === 0 && freezeThaw.flag === false     // 1.5s 后自动解冻
  && freezeAfterPress.charging === true                        // 解冻后真的能动了
  && lureDist < lureTol                                        // 磁铁把落点拽进完美范围
  && lureDist < lureNoTrait * 0.35                             // 而且明显比"没磁铁"更接近砖心
  && lureFarDist > lureTol * 2                                 // 蓄力差一大截时，磁铁也救不了
  && holyGone.cfg === true && holyGone.seen === 0              // 圣光砖整体删除（配置项 + 抽签池）
  /* —— 2026-10-04：FOV 40 / MJ 砖与蜘蛛抓人 / 奶块 GIF —— */
  && fovNow === 40
  && mjArmed.trait === 'mj' && mjArmed.state === 'ready'
  && mjArmed.timer !== null && mjArmed.timer > 1.3 && mjArmed.timer <= 1.5   // mjDwell 1.5
  && mjArmed.letters >= 20                                     // M 13 + J 9 = 22 粒方块
  && mjArmed.noBody === true                                   // 无实心砖身
  && mjArmed.frame.legs === 6 && mjArmed.frame.hoops === 2     // 框架支撑就位
  && mjArmed.flat !== null && mjArmed.flat.ry === 0.785        // 平躺 + 对角朝向（π/4）
  && mjArmed.flat.lift > 0.02 && mjArmed.flat.lift < 0.12      // 抬 cell/2 贴地
  && mjDrop.state === 'mjgrab' && mjDrop.phase === 'drop'
  && mjDrop.layerShown === true
  && typeof mjDrop.spiderTop === 'string' && mjDrop.spiderTop.indexOf('px') >= 0
  && mjPressBlocked === true                                   // 演出期间输入被挡
  && mjDone.state === 'ready' && mjDone.layerGone === true
  && mjDone.backOk === true                                    // 被放回后方第 3 块（不足取最近）
  && mjDone.nextIsMj === true                                  // next 重排到目标砖前一块
  && mjDone.charVisible === true && mjDone.blobVisible === true
  && mjDone.mjCleared === true
  && mjDone.tailCut === true                                   // 抓回后旧链清干净
  && mjGrow.len <= 8 && mjGrow.mjGone === true                 // 继续跳不堆积
  && mjCancel.keepOnBrick === true && mjCancel.leaveCancels === true
  && gif.laughHits === 1 && gif.hasGif === true && gif.isSprite === true
  && gif.ownTex === true                                       // ★ 独立纹理实例（防 UV 冲突）
  && gif.repeatW > 0 && gif.repeatW < 1                        // 雪碧图切帧中
  && gif.opacity === 1 && gif.aboveChar === true
  && gif.life > 4 && gif.max > 4                               // 和 4s 笑声差不多长
  && gifGone.left === 0                                        // 播完自清
  && charSize.h <= 1.481 && charSize.h >= 1.0 && charSize.w <= charSize.h + 1e-6 // 角色体积缩小
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
  && equipped.inFront === true                                 // 头饰在立绘前面
  && Math.abs(equipped.relHeight - 0.46) < 0.02                // 本体高 / 角色高 ≈ hK
  /* 光环：10 奶币买得到、走头饰槽、位置在头顶之上 */
  && haloBought.err === null && haloBought.coins === 90        // 100 - 10
  && haloBought.owned === true && haloBought.price === 10 && haloBought.stored === true
  && haloEq.id === 'halo' && haloEq.visible === true && haloEq.aboveHead === true
  && Math.abs(haloEq.relHeight - 0.30) < 0.02
  /* 冰锥翅膀：独立背饰槽位 ——  coexist 头饰、垫在身后 */
  && wingEq.err === null && wingEq.owned === true && wingEq.price === 10
  && wingEq.cat === 'back' && wingEq.id === 'wing' && wingEq.visible === true
  && wingEq.headStillOn === true                               // ★ 换背饰不顶掉头饰
  && wingEq.behind === true && wingEq.underHead === true       // 垫在角色后面
  && wingEq.belowHead === true                                 // ★ 挂在上背，不是飘在头顶
  && Math.abs(wingEq.relHeight - 0.90) < 0.05                           // ≈ hK（上线实测 1.05 嫌大，收到 0.90）
  && wingEq.relWidth > 1.2 && wingEq.relWidth < 1.8                     // ★ 宽度受控：够大能露出来、又别横摊
  && wingEq.stored === 'wing'
  /* ★ 新抠的免费角色：都在、名字对得上、免费（不 locked / 不带价签） */
  && newChars.length === 7 && newChars.every((c) => c.cell && c.nameOk)
  && newChars.every((c) => c.price === 0 && c.locked === false && c.priceTag === false)
  && newChars.every((c) => c.label === c.name)              // 格子里显示的就是角色名
  && charTotal === 43                                        // 36 静态 + 7 新 + …（数对不上说明漏了/多了）
  && frogFirst === true                                      // ★ 经典奶蛙置顶在第一格
  && angry2UriLen > 5000                                     // ★ 奶怒2 贴图不能是空 base64
  /* 仓库：已拥有不标价 / 未拥有低亮 + 标价；三行分类都在 */
  && panelAcc.rows === 3 && panelAcc.rowNames === '头饰,背饰,特效'
  && panelAcc.insideGrid === true
  && panelAcc.cells >= 5
  && panelAcc.ownedWithPrice === 0                             // ★ 拥有的一律不显示价格
  && panelAcc.lockedWithoutPrice === 0                         // ★ 未拥有的一律有价签
  && panelAcc.wingCell === true && panelAcc.haloCell === true
  && panelAcc.splashCell === true && panelAcc.splashLocked === true  // ★ 魔法阵在仓库里，未拥有→价签
  && afterSwap.head === 'halo' && afterSwap.headVisible === true
  && afterSwap.back === 'wing' && afterSwap.backVisible === true  // 换角色两槽都在（通用）
  && unequipped.id === null && unequipped.visible === false
  && unequipped.stored === null                                // 卸下要把存档写掉
  && unequipped.backKept === true                              // 摘头饰不动背饰
  /* ★ 落地特效「水花」：买 → 装 → 落地真出粒子 → 卸下不再出 */
  && splashBought.err === null && splashBought.owned === true
  && splashBought.stored.indexOf(fxId) >= 0
  && splashBought.noMesh === true                              // fx 槽不建 mesh
  && splashEquipped.equipped === fxId && splashEquipped.stored === fxId
  && splashEquipped.hasFx === true && splashEquipped.notOther === true
  && splashEquipped.headKept === true                          // 装特效不影响真槽位
  && splashAfterOne.count >= 8                                 // 阵图层要够（外圈+内圈+阵眼+6射线）
  && splashAfterOne.ring === 0                                 // ★ 魔法阵不是旧的扩散环
  && splashAfterOne.magic >= 7                                 // ★ 魔法阵至少 7 片
  && splashAfterOne.lowStart === true                          // ★ 贴地铺开，不悬空
  && splashAfterOne.shortLife === true                         // ★ 短暂：最长 < 1.0s
  && splashAfterOne.flats === true                             // ★ 都是平面几何（环/圆/面片）
  && splashAfterOne.spinning === true                          // ★ 阵在转，不是静止贴纸
  && splashOff.equipped === null && splashOff.hasFx === false
  && splashOff.stored === null                                 // 卸下要清存档
  && splashOff.grow === 0                                      // ★ 卸下后落地不再铺阵
  && splashE2e.off < splashE2e.peak - 3                        // ★ 没装备时的峰值里没有那 9 片阵
  && splashE2e.peak >= 9                                        // ★ 装备后真落地铺出完整一圈
  && splashE2e.after === 0 && splashE2e.hasFx === true          // 短促 → 自己消失干净
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
  ice,
  holyGone,
  fov: fovNow,
  mj: { armed: mjArmed, drop: mjDrop, pressBlocked: mjPressBlocked, done: mjDone, grow: mjGrow, cancel: mjCancel },
  gif, gifGone,
  charSize,
  milk: { off: milkLaughOff, on: milkLaughOn },
  clip: clipInfo,
  acc: {
    noticeBuy, equipped, panelAcc, afterSwap, unequipped,
    halo: { bought: haloBought, eq: haloEq },
    wing: { eq: wingEq },
    splash: { bought: splashBought, equipped: splashEquipped, one: splashAfterOne, off: splashOff, e2e: splashE2e },
  },
  char: { poor: charPoor, bought: charBought, anim, thumb,
          newChars: newChars, charTotal, frogFirst, angry2UriLen },
  settings,
  pidTag: pidTagOut,
};
