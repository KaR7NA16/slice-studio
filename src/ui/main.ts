// 界面入口（Vite + TS 无框架，b13；直接 DOM 渲染，哈希路由）。
// 视图：#/ 总览、#/job/<id>[/<step>] 任务工作空间（审片 / 字幕 / AI 抽卡）、
//       #/clip/<id>[/<tab>] 片段工作空间（s02/s03/s04/s05 + 分叉树）、#/settings。
//
// 每个视图只负责自己的 DOM 与接线；共用件在 lib.ts（工具/顶栏/待办条）、panel.ts（档位/预览/分叉树）、
// playback.ts（播放联动）、picker.ts（文件选择）、modal.ts / toast.ts（反馈）。
import { viewClip } from "./clip.ts";
import { viewHome } from "./home.ts";
import { viewJob } from "./job.ts";
import { viewSettings } from "./settings.ts";
import { wireThemeButton } from "./theme.ts";

type Route =
  | { view: "home" }
  | { view: "job"; id: string; step: string | null }
  | { view: "clip"; id: string; tab: string }
  | { view: "settings" };

function route(): Route {
  if (location.hash === "#/settings") return { view: "settings" };
  let m = location.hash.match(/^#\/job\/([^/]+)(?:\/([^/]+))?$/);
  if (m) return { view: "job", id: decodeURIComponent(m[1]!), step: m[2] ? decodeURIComponent(m[2]) : null };
  m = location.hash.match(/^#\/clip\/([^/]+)(?:\/([^/]+))?$/);
  if (m) return { view: "clip", id: decodeURIComponent(m[1]!), tab: m[2] ? decodeURIComponent(m[2]) : "s03" };
  return { view: "home" };
}

// 每次都画一个代次，视图拿这个判断「我还是当前这一页吗」。
// 没有它的话：点一下任务 → await 拉数据期间又切回总览 → 旧代返回，
// 照常 app.innerHTML = 任务页，把用户刚打开的总览覆盖掉。整页级，不是局部错位。
// 视图是「先 await 取数、再一次性 innerHTML」，所以只要在写 DOM 前查一次代次就够；
// 写 DOM 之后还在跑的线（wireS03 之类会再 getElementById）也必须查——
// 否则它会命中**新页面**里同名的元素，把上一步的产物写进不相干的页面。
let gen = 0;

async function render(): Promise<void> {
  const my = ++gen;
  const stale = (): boolean => my !== gen;
  const r = route();
  const again = (): void => void render();
  if (r.view === "job") {
    await viewJob(r.id, again, stale);
    if (stale()) return;
    // 深链 #/job/<id>/s01 要能定位到那个工作空间（b59 的「入口」就靠它）
    if (r.step) document.getElementById(`step-${r.step}`)?.scrollIntoView({ block: "start" });
  } else if (r.view === "clip") {
    await viewClip(r.id, r.tab, again, stale);
    if (stale()) return;
  } else if (r.view === "settings") {
    await viewSettings(again, stale);
    if (stale()) return;
  } else {
    await viewHome(again, stale);
    if (stale()) return;
  }
  // 主题按钮随每次重画重新接线（视图各画各的 innerHTML，事件不跟着走）
  wireThemeButton();
}

window.addEventListener("hashchange", () => void render());
void render();
