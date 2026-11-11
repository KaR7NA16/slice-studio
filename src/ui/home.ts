// 总览：待办条（b5）+ 新建任务（b1 入口）+ 任务卡片（每步三态）+ 素材库（b33）。
//
// 入口的第一动作是「把一个长视频拿进来」。浏览器拿不到真实路径，所以主路径是服务端目录浏览
// （picker.ts），路径输入框保留为兜底——两者写的是同一个字段，提交前都要过 /api/fs/stat。
import type { Library, LibraryItem, Survey } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { api, app, baseName, bindJobActions, esc, fmtBytes, jobLabel, jobTools, libGroup, post, renderTodo, setMsg, stepRow, topbar, withBusy } from "./lib.ts";
import { pickPath } from "./picker.ts";

interface StatResult {
  path: string;
  name: string;
  exists: boolean;
  is_dir: boolean;
  size: number | null;
}

const statOf = (p: string): Promise<StatResult> =>
  api<StatResult>(`/api/fs/stat?path=${encodeURIComponent(p)}`);

export async function viewHome(rerender: () => void, stale?: () => boolean): Promise<void> {
  const [survey, libraryRaw] = await Promise.all([api<Survey>("/api/survey"), api<Library | null>("/api/library")]);
  if (stale?.()) return;
  const library: Library = libraryRaw ?? { schema: 1, source_root: "（未入库）", items: [] };
  const clipsByJob = new Map<string, Survey["clips"]>();
  for (const c of survey.clips) {
    const list = clipsByJob.get(c.job_id) ?? [];
    list.push(c);
    clipsByJob.set(c.job_id, list);
  }
  const jobCard = (j: (typeof survey.jobs)[number]): string => {
    const clips = (clipsByJob.get(j.id) ?? [])
      .map((c) => `<a class="clip-link" href="#/clip/${encodeURIComponent(c.id)}">${icon("film", 11)} ${esc(c.title)} <span class="num">${esc(c.id)}</span></a>`)
      .join("");
    const named = j.title.trim().length > 0;
    return `<div class="card">
        <div class="job-row">
          <a class="card-head link" href="#/job/${encodeURIComponent(j.id)}">${icon("film")} <span class="job-name">${esc(jobLabel(j.title, j.video_path))}</span> <span class="num">${esc(j.id)}</span>${named ? ` <span class="sub">${esc(baseName(j.video_path))}</span>` : ""}</a>
          <span class="card-tools">${jobTools(j)}</span>
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
      <div class="section-title">新建任务 <span class="meta">只登记路径，不复制文件</span></div>
      <div class="card">
        <div class="nj-form">
          <button class="btn primary" id="nj-pick">${icon("folder", 12)} 选择视频…</button>
          <input class="text span-2" id="nj-video" placeholder="或粘贴视频完整路径（mp4 / mov / mkv / webm / avi）" spellcheck="false" />
          <button class="btn" id="nj-srt-pick">${icon("file", 12)} 选字幕…</button>
          <input class="text" id="nj-srt" placeholder="剪映导出的 .srt（可空，空则走本地转写）" spellcheck="false" />
          <button class="btn primary" id="nj-go">${icon("plus", 12)} 建任务</button>
        </div>
        <div class="actions">
          <span class="msg" id="nj-msg" role="status" aria-live="polite">${survey.jobs.length ? "" : "还没有任务——先选择上面那个视频"}</span>
        </div>
      </div>
      <div class="section-title">任务 <span class="meta">${activeJobs.length ? `${activeJobs.length} 个进行中` : ""}</span></div>
      <div id="jobs">${jobs || `<div class="card"><div class="empty-hint">${icon("film", 20)}<div class="sub">${survey.jobs.length ? "进行中的任务都归档了" : "还没有任务"}</div></div></div>`}</div>
      ${archived ? `<div id="archived"><div class="section-title">已归档</div>${archived}</div>` : ""}
      <div class="section-title">素材库 <span class="meta">${esc(library.source_root)}</span></div>
      <div class="card">
        <div class="form-card">
          <button class="btn" id="lib-pick">${icon("folder", 12)} 选择目录…</button>
          <input class="text" id="lib-root" placeholder="素材目录（只登记，不复制文件）" value="${esc(library.source_root === "（未入库）" ? "" : library.source_root)}" spellcheck="false" />
          <button class="btn" id="lib-go">重新入库</button>
        </div>
        <div class="actions"><span class="msg" id="lib-msg" role="status" aria-live="polite">目录下需有 bgm / fonts / materials / memes / sfx 子目录；放入新素材后重新入库即可。</span></div>
      </div>
      ${[...byKind.entries()].sort().map(([k, items]) => libGroup(k, items)).join("")}
    </div>`;

  const videoEl = document.getElementById("nj-video") as HTMLInputElement;
  const srtEl = document.getElementById("nj-srt") as HTMLInputElement;
  const njMsg = document.getElementById("nj-msg")!;
  const libMsg = document.getElementById("lib-msg")!;
  const njGo = document.getElementById("nj-go") as HTMLButtonElement;
  const libGo = document.getElementById("lib-go") as HTMLButtonElement;

  document.getElementById("btn-refresh")!.addEventListener("click", () => rerender());
  bindJobActions(rerender);

  // 选视频：选中即校验并回填，不让错误留到提交之后
  document.getElementById("nj-pick")!.addEventListener("click", async () => {
    const p = await pickPath({ mode: "video", title: "选择视频", initial: videoEl.value.trim() });
    if (!p) return;
    videoEl.value = p;
    await checkVideo();
  });
  document.getElementById("nj-srt-pick")!.addEventListener("click", async () => {
    const p = await pickPath({ mode: "srt", title: "选择字幕", initial: srtEl.value.trim() });
    if (!p) return;
    srtEl.value = p;
    await checkSrt();
  });

  const checkVideo = async (): Promise<boolean> => {
    const p = videoEl.value.trim();
    if (!p) return false;
    const st = await statOf(p).catch(() => null);
    if (!st || !st.exists) {
      setMsg(njMsg, `文件不在这里：${p}`, "err");
      return false;
    }
    if (st.is_dir) {
      setMsg(njMsg, `这是一个目录，不是视频文件：${p}`, "err");
      return false;
    }
    setMsg(njMsg, `已选：${st.name} · ${st.size !== null ? fmtBytes(st.size) : "大小未知"}`, "ok");
    return true;
  };
  const checkSrt = async (): Promise<boolean> => {
    const p = srtEl.value.trim();
    const st = await statOf(p).catch(() => null);
    if (!st || !st.exists || st.is_dir) {
      setMsg(njMsg, `字幕文件不在这里：${p}`, "err");
      srtEl.value = "";
      return false;
    }
    setMsg(njMsg, `字幕：${st.name}`, "ok");
    return true;
  };

  videoEl.addEventListener("blur", () => {
    if (videoEl.value.trim()) void checkVideo();
  });
  srtEl.addEventListener("blur", () => {
    if (srtEl.value.trim()) void checkSrt();
  });

  njGo.addEventListener("click", async () => {
    const video = videoEl.value.trim();
    const srt = srtEl.value.trim();
    if (!video) {
      setMsg(njMsg, "先选择视频文件", "err");
      videoEl.focus();
      return;
    }
    await withBusy(njGo, async () => {
      setMsg(njMsg, "校验中…", "busy");
      if (!(await checkVideo())) return;
      if (srt && !(await checkSrt())) return;
      setMsg(njMsg, "创建中…", "busy");
      try {
        const { id } = await post<{ id: string }>("/api/jobs", { video_path: video, srt_path: srt || null });
        location.hash = `#/job/${encodeURIComponent(id)}`;
      } catch (e) {
        setMsg(njMsg, e instanceof Error ? e.message : String(e), "err");
      }
    });
  });

  document.getElementById("lib-pick")!.addEventListener("click", async () => {
    const rootEl = document.getElementById("lib-root") as HTMLInputElement;
    const p = await pickPath({ mode: "dir", title: "选择素材目录", initial: rootEl.value.trim(), selectLabel: "用这个目录" });
    if (!p) return;
    rootEl.value = p;
    setMsg(libMsg, "目录已选中——点「重新入库」登记其中的素材", "ok");
  });

  libGo.addEventListener("click", async () => {
    const rootEl = document.getElementById("lib-root") as HTMLInputElement;
    const source = rootEl.value.trim();
    if (!source) {
      setMsg(libMsg, "素材目录必填", "err");
      rootEl.focus();
      return;
    }
    await withBusy(libGo, async () => {
      setMsg(libMsg, "入库中…（要算内容指纹，曲库大时会慢一会儿）", "busy");
      try {
        const r = await post<{ count: number; bgm: number }>("/api/library/ingest", { source_root: source });
        setMsg(libMsg, `入库 ${r.count} 项，其中配乐 ${r.bgm} 首`, "ok");
        rerender();
      } catch (e) {
        setMsg(libMsg, e instanceof Error ? e.message : String(e), "err");
      }
    });
  });
}
