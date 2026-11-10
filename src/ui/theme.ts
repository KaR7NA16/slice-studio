// 主题三态：跟随系统 / 浅 / 深。
//
// 存储的是**选择**（ss-theme = auto|light|dark），写到 <html data-theme> 的是**解析结果**（light|dark）。
// 于是 tokens.css 里只需要一份暗色定义——不需要「媒体查询一份 + 手动切换一份」两处同值，
// 那两处一旦漂移，就是「系统暗色正常、手动暗色某个色值不对」这类难查的分裂。
//
// 首屏不闪：src/ui/index.html 的 <head> 里有一小段同样的解析逻辑，在样式生效前就跑。
import { icon } from "./icons.ts";
import { repaintWaves } from "./wave.ts";

export type ThemeChoice = "auto" | "light" | "dark";
type Resolved = "light" | "dark";

const KEY = "ss-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    /* 隐私模式下 localStorage 可能不可用：退回跟随系统，不抛错 */
  }
  return "auto";
}

function resolve(c: ThemeChoice): Resolved {
  if (c === "light" || c === "dark") return c;
  return media.matches ? "dark" : "light";
}

// 写 data-theme 并重画像素产物。两处都要经过它，否则「跟随系统时系统切了」那条路会漏重画。
function paint(r: Resolved): void {
  document.documentElement.dataset.theme = r;
  // 画进像素的东西不会自己跟着令牌变（波形线、以后任何 canvas）。样式换完立刻让它重画一次。
  repaintWaves();
}

export function applyChoice(c: ThemeChoice): void {
  paint(resolve(c));
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* 存不了也要让本次生效 */
  }
}

export const nextChoice = (c: ThemeChoice): ThemeChoice =>
  c === "auto" ? "light" : c === "light" ? "dark" : "auto";

const TEXT: Record<ThemeChoice, string> = {
  auto: "主题：跟随系统",
  light: "主题：浅色",
  dark: "主题：深色",
};

export function themeButtonHtml(): string {
  const c = getChoice();
  const ic = c === "auto" ? "contrast" : c === "light" ? "sun" : "moon";
  return `<button class="iconbtn" type="button" id="btn-theme" title="${TEXT[c]}（点击切换）" aria-label="${TEXT[c]}，点击切换">${icon(ic, 12)}</button>`;
}

// 每次重画后由 main.ts 统一接线（视图各画各的 innerHTML，事件不跟着走）
export function wireThemeButton(): void {
  const b = document.getElementById("btn-theme");
  if (!b || b.dataset.wired === "1") return;
  b.dataset.wired = "1";
  b.addEventListener("click", () => {
    const c = nextChoice(getChoice());
    applyChoice(c);
    const ic = c === "auto" ? "contrast" : c === "light" ? "sun" : "moon";
    b.innerHTML = icon(ic, 12);
    b.title = `${TEXT[c]}（点击切换）`;
    b.setAttribute("aria-label", `${TEXT[c]}，点击切换`);
  });
}

// 跟随系统时，系统切换要跟着走；手动选定后系统再变也不动它
media.addEventListener("change", () => {
  if (getChoice() === "auto") paint(resolve("auto"));
});
