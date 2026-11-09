// 界面入口（Vite + TS 无框架，b13；直接 DOM 渲染，哈希路由）。
// 视图：#/ 总览、#/job/<id>[/<step>] 任务工作空间（s00 字幕 / s01 选高光）、
//       #/clip/<id>[/<tab>] 片段工作空间（s02/s03/s04/s05 + 分叉树）、#/settings。
//
// 每个视图只负责自己的 DOM 与接线；共用件在 lib.ts（工具/顶栏/待办条）、panel.ts（档位/预览/分叉树）。
import { viewClip } from "./clip.ts";
import { viewHome } from "./home.ts";
import { viewJob } from "./job.ts";
import { viewSettings } from "./settings.ts";

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

async function render(): Promise<void> {
  const r = route();
  const again = (): void => void render();
  if (r.view === "job") {
    await viewJob(r.id, again);
    // 深链 #/job/<id>/s01 要能定位到那个工作空间（b59 的「入口」就靠它）
    if (r.step) document.getElementById(`step-${r.step}`)?.scrollIntoView({ block: "start" });
    return;
  }
  if (r.view === "clip") return void (await viewClip(r.id, r.tab, again));
  if (r.view === "settings") return void (await viewSettings(again));
  return void (await viewHome(again));
}

window.addEventListener("hashchange", () => void render());
void render();
