/* 背景主题：纯色 + 渐变，玩家自选。
 *
 * 每一个主题给三样东西：
 *   image / color —— 直接喂给 CSS 的 background-image / background-color，画面底板
 *   fog           —— three.js 的雾色。雾色必须跟着底板走：原来固定 0x2A3260，
 *                    一换浅色底远处方块就糊成一片和背景完全不搭的深蓝。
 *   tone          —— 'light' / 'dark'，决定整套 UI 用深字还是浅字。
 *                    浅底上的白字等于没有，所以 body 会挂上 tone-light 类，
 *                    CSS 变量整体翻转（见 index.html 的 body.tone-light）。
 *
 * 排列顺序：先浅色，再深色；浅色里第一项是默认的奶黄色。
 */

/** @type {{key:string,name:string,tone:'light'|'dark',image:string,color:string,fog:number}[]} */
export const BACKGROUNDS = [
  /* ---------------- 纯色 · 浅 ---------------- */
  { key: 'cream', name: '奶油黄', tone: 'light', image: 'none', color: '#FFF3D6', fog: 0xE8D3A6 },
  { key: 'ivory', name: '象牙白', tone: 'light', image: 'none', color: '#F7F3E8', fog: 0xDED7C4 },
  { key: 'sakura', name: '樱花粉', tone: 'light', image: 'none', color: '#FFE3EC', fog: 0xEEC3D2 },
  { key: 'mint', name: '薄荷绿', tone: 'light', image: 'none', color: '#DFF5E6', fog: 0xBCDCC7 },
  { key: 'sky', name: '天空蓝', tone: 'light', image: 'none', color: '#DDEEFF', fog: 0xB6D3EE },
  { key: 'lilac', name: '暮光紫', tone: 'light', image: 'none', color: '#EDE4FF', fog: 0xCBBBE8 },
  { key: 'coral', name: '珊瑚橙', tone: 'light', image: 'none', color: '#FFE6D5', fog: 0xEDC4A6 },
  { key: 'ash', name: '石墨灰', tone: 'light', image: 'none', color: '#E8EAF0', fog: 0xC2C7D4 },

  /* ---------------- 纯色 · 深 ---------------- */
  { key: 'navy', name: '深海蓝', tone: 'dark', image: 'none', color: '#1B2A4A', fog: 0x1B2A4A },
  { key: 'midnight', name: '墨夜黑', tone: 'dark', image: 'none', color: '#12162C', fog: 0x2A3260 },
  { key: 'forest', name: '森林绿', tone: 'dark', image: 'none', color: '#16342A', fog: 0x16342A },
  { key: 'wine', name: '酒红', tone: 'dark', image: 'none', color: '#3A1626', fog: 0x3A1626 },

  /* ---------------- 渐变 · 浅 ---------------- */
  { key: 'milkshake', name: '奶昔', tone: 'light', fog: 0xEED9B0,
    image: 'linear-gradient(172deg, #FFF8E8 0%, #FFEDC8 46%, #FFDFA6 100%)', color: '#FFEDC8' },
  { key: 'peach', name: '蜜桃气泡', tone: 'light', fog: 0xE9BEC6,
    image: 'radial-gradient(110% 80% at 62% 22%, #FFF7E6 0%, rgba(255,247,230,0) 62%), linear-gradient(168deg, #FFEFD9 0%, #FFD3C4 52%, #FFC2CE 100%)', color: '#FFD9C8' },
  { key: 'clearsky', name: '晴空', tone: 'light', fog: 0xAFCDEA,
    image: 'radial-gradient(120% 80% at 50% 14%, #FFFFFF 0%, rgba(255,255,255,0) 58%), linear-gradient(176deg, #E4F1FF 0%, #C2DCFF 58%, #B4C8F2 100%)', color: '#C2DCFF' },
  { key: 'aurora', name: '极光', tone: 'light', fog: 0xA9D6DC,
    image: 'radial-gradient(100% 70% at 76% 18%, rgba(255,255,255,.9) 0%, rgba(255,255,255,0) 60%), linear-gradient(160deg, #D7F8EC 0%, #B6E4F5 48%, #C3CBF5 100%)', color: '#B6E4F5' },
  { key: 'grape', name: '紫葡萄', tone: 'light', fog: 0xC9B4E4,
    image: 'radial-gradient(110% 78% at 30% 16%, #FFFFFF 0%, rgba(255,255,255,0) 58%), linear-gradient(170deg, #F2E8FF 0%, #DCC9FF 55%, #C9B2F0 100%)', color: '#DCC9FF' },
  { key: 'matcha', name: '抹茶奶', tone: 'light', fog: 0xC2DFA8,
    image: 'linear-gradient(174deg, #EFF9E2 0%, #D8F0C4 52%, #C0E4A4 100%)', color: '#D8F0C4' },
  { key: 'sundown', name: '落日', tone: 'light', fog: 0xEE9A86,
    image: 'radial-gradient(90% 62% at 74% 20%, #FFF2C8 0%, rgba(255,242,200,0) 62%), linear-gradient(184deg, #FFE0AE 0%, #FFB07E 44%, #E97D93 100%)', color: '#FFB07E' },
  { key: 'latte', name: '奶咖', tone: 'light', fog: 0xD8BE9E,
    image: 'linear-gradient(172deg, #F7EBDC 0%, #E9D3B8 52%, #D6B995 100%)', color: '#E9D3B8' },
  { key: 'cloud', name: '云朵', tone: 'light', fog: 0xC3CEDF,
    image: 'radial-gradient(120% 84% at 50% 10%, #FFFFFF 0%, rgba(255,255,255,0) 62%), linear-gradient(178deg, #F4F8FF 0%, #DCE6F6 60%, #C8D5EA 100%)', color: '#DCE6F6' },

  /* ---------------- 渐变 · 深 ---------------- */
  { key: 'deepsea', name: '深海夜色', tone: 'dark', fog: 0x1E2E52,
    image: 'radial-gradient(100% 70% at 62% 20%, rgba(96, 150, 235, .34) 0%, rgba(96, 150, 235, 0) 62%), linear-gradient(178deg, #263C6D 0%, #1B2A4C 52%, #101A33 100%)', color: '#1B2A4C' },
  { key: 'galaxy', name: '星河', tone: 'dark', fog: 0x352A5C,
    image: 'radial-gradient(80% 56% at 26% 18%, rgba(190, 140, 255, .30) 0%, rgba(190, 140, 255, 0) 66%), linear-gradient(168deg, #322A63 0%, #462F6E 44%, #191B3D 100%)', color: '#2E2760' },
  { key: 'rosewood', name: '玫瑰暮', tone: 'dark', fog: 0x5A2740,
    image: 'radial-gradient(88% 60% at 70% 22%, rgba(255, 150, 140, .22) 0%, rgba(255, 150, 140, 0) 62%), linear-gradient(180deg, #4A2136 0%, #6B2E4A 50%, #2C1220 100%)', color: '#4A2136' },
  { key: 'pinewood', name: '松林', tone: 'dark', fog: 0x1E5240,
    image: 'linear-gradient(176deg, #1B4A3A 0%, #12332A 54%, #0C231C 100%)', color: '#12332A' },
];

export const DEFAULT_BG = 'cream';

/* 名字刻意带 BG_ 前缀：打包成单文件后，本模块和 character.js 会落在同一个
 * IIFE 作用域里，而 character.js 里已经有一个 BY_KEY 了，重名会直接 SyntaxError */
const BG_BY_KEY = new Map(BACKGROUNDS.map((b) => [b.key, b]));

/** 背景清单（给 UI 用） */
export function bgList() { return BACKGROUNDS; }
/** 按 key 取主题，找不到退回默认 */
export function bgDef(key) { return BG_BY_KEY.get(key) || BG_BY_KEY.get(DEFAULT_BG) || BACKGROUNDS[0]; }
