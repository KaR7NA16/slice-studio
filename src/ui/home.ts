// 总览：待办条（b5）+ 新建任务 + 任务卡片（每步三态）+ 素材库（b33）。
import type { Library, LibraryItem, Survey } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { api, app, baseName, bindJobActions, esc, jobLabel, jobTools, libGroup, post, renderTodo, stepRow, topbar } from "./lib.ts";

export async function viewHome(rerender: () => void): Promise<void> {
  const [survey, libraryRaw] = await Promise.all([api<Survey>("/api/survey"), api<Library | null>("/api/library")]);
  const library: Library = libraryRaw ?? { schema: 1, source_root: "（未入库）", items: [] };
  const clipsByJob = new Map<string, Survey["clips"]>();
  for (const c of survey.clips) {
    const list = clipsByJob.get(c.job_id) ?? [];
    list.push(c);
    clipsByJob.set(c.job_id, list);
  }
  const jobCard = (j: (typeof survey.jobs)[number]): string => {
    const clips = (clipsByJob.get(j.id) ?? [])
      .map((c) => `<a class="clip-link" href="#/clip/${encodeURIComponent(c.id)}">${icon("cut", 11)} ${esc(c.title)} <span class="num">${esc(c.id)}</span></a>`)
      .join("");
    const named = j.title.trim().length > 0;
    return `<div class="card">
        <div class="job-row">
          <a class="card-head link" href="#/job/${encodeURIComponent(j.id)}">${icon("film")} <span class="job-name">${esc(jobLabel(j.title, j.video_path))}</span> <span class="num">${esc(j.id)}</span>${named ? ` <span class="sub">${esc(baseName(j.video_path))}</span>` : ""}</a>
          ${jobTools(j)}
        </div>
        ${j.steps.map(stepRow).join("")}
        ${clips ? `<div class="clip-links">${clips}</div>` : ""}
      </div>`;
  };
  const activeJobs = survey.jobs.filter((j) => !j.archived);
  const archivedJobs = survey.jobs.filter((j) => j.archived);
  const jobs = activeJobs.map(jobCard).join("");
  const archived = archivedJobs.map(jobCard).join("");
  const byKind = new Map<string, LibraryItem[]>();
  for (const it of library.items) {
    const list = byKind.get(it.kind) ?? [];
    list.push(it);
    byKind.set(it.kind, list);
  }
  app.innerHTML = `
    ${topbar(`<a class="iconbtn link" href="#/settings">${icon("sliders", 12)} 设置</a><button class="iconbtn" id="btn-refresh">${icon("refresh", 12)} 刷新</button>`)}
    ${renderTodo(survey)}
    <div class="main">
      <div class="section-title">新建任务</div>
      <div class="card form-card">
        <input class="text" id="nj-video" placeholder="视频文件的完整路径（必填）" />
        <input class="text" id="nj-srt" placeholder="剪映导出的 .srt 路径（可空，空则走本地转写）" />
        <button class="btn primary" id="nj-go">${icon("plus", 12)} 建任务</button>
        <span class="hint" id="nj-msg"></span>
      </div>
      <div class="section-title">任务</div>
      <div id="jobs">${jobs || `<div class="card"><div class="empty-hint">${icon("film", 20)}<div style="margin-top:6px">${survey.jobs.length ? "进行中的任务都归档了" : "还没有任务"}</div></div></div>`}</div>
      ${archived ? `<div id="archived"><div class="section-title">已归档</div>${archived}</div>` : ""}
      <div class="section-title">素材库（${esc(library.source_root)}）</div>
      <div class="card form-card">
        <input class="text" id="lib-root" placeholder="素材目录的完整路径（只登记，不复制文件）" value="${esc(library.source_root === "（未入库）" ? "" : library.source_root)}" />
        <button class="btn" id="lib-go">重新入库</button>
        <span class="hint" id="lib-msg"></span>
      </div>
      ${[...byKind.entries()].sort().map(([k, items]) => libGroup(k, items)).join("")}
    </div>`;
  document.getElementById("btn-refresh")!.addEventListener("click", () => rerender());
  bindJobActions(rerender);
  document.getElementById("lib-go")!.addEventListener("click", async () => {
    const msg = document.getElementById("lib-msg")!;
    const source = (document.getElementById("lib-root") as HTMLInputElement).value.trim();
    if (!source) {
      msg.textContent = "素材目录必填";
      return;
    }
    msg.textContent = "入库中…";
    try {
      const r = await post<{ count: number; bgm: number }>("/api/library/ingest", { source_root: source });
      msg.textContent = `入库 ${r.count} 项，其中配乐 ${r.bgm} 首`;
      rerender();
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  document.getElementById("nj-go")!.addEventListener("click", async () => {
    const msg = document.getElementById("nj-msg")!;
    const video = (document.getElementById("nj-video") as HTMLInputElement).value.trim();
    const srt = (document.getElementById("nj-srt") as HTMLInputElement).value.trim();
    if (!video) {
      msg.textContent = "视频路径必填";
      return;
    }
    msg.textContent = "创建中…";
    try {
      const { id } = await post<{ id: string }>("/api/jobs", { video_path: video, srt_path: srt || null });
      location.hash = `#/job/${encodeURIComponent(id)}`;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  });
}
