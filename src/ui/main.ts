// 界面入口（Vite + TS 无框架，b13；直接 DOM 渲染，哈希路由）
// 三视图：#/ 总览（待办+任务+素材库）、#/job/<id> 任务页（字幕+建片段）、#/clip/<id> 逐句删留工作台（b9）
import type {
  Library,
  LibraryItem,
  RunRecord,
  S03View,
  Sentence,
  SentencesFile,
  StepState,
  Survey,
} from "../shared/types.ts";
import { icon } from "./icons.ts";

const STATE_TEXT: Record<StepState["status"], string> = {
  ready: "就绪", stale: "待重跑", suspect: "待定", empty: "未跑", error: "出错",
};
const KIND_TEXT: Record<string, string> = { bgm: "配乐", font: "字体", material: "素材视频", meme: "梗图", sfx: "音效" };

const app = document.getElementById("app")!;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + " KB";
  return n + " B";
}
// 等宽时间码（b40：float 秒显示到毫秒）
function tc(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w: number): string => String(n).padStart(w, "0");
  return h > 0 ? `${h}:${p(m, 2)}:${p(s, 2)}.${p(ms % 1000, 3)}` : `${p(m, 2)}:${p(s, 2)}.${p(ms % 1000, 3)}`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

// 触发 run 并轮询心跳（b53），状态行实时更新；返回是否成功
async function runAndPoll(statusEl: HTMLElement, owner: string, step: string, mode: string | null): Promise<boolean> {
  statusEl.textContent = "启动中…";
  const rec = await api<RunRecord>("/api/run", { method: "POST", body: JSON.stringify({ owner, step, mode }) });
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    const cur = await api<RunRecord>(`/api/runs/${rec.id}`);
    statusEl.textContent = cur.message;
    if (cur.status !== "running") {
      statusEl.textContent = cur.status === "done" ? `完成：${cur.message}` : `失败：${cur.error ?? cur.message}`;
      return cur.status === "done";
    }
  }
}

// ---- 路由 ----

type Route = { view: "home" } | { view: "job"; id: string } | { view: "clip"; id: string };
function route(): Route {
  const m = location.hash.match(/^#\/(job|clip)\/(.+)$/);
  if (m) return { view: m[1] as "job" | "clip", id: decodeURIComponent(m[2]!) };
  return { view: "home" };
}

// ---- 共用片段 ----

function stepRow(st: StepState): string {
  return `<div class="step">
    <span class="dot ${st.status}"></span>
    <span class="id num">${esc(st.step)}</span>
    <span class="name">${esc(st.title)}</span>
    <span class="state ${st.status}">${STATE_TEXT[st.status]}</span>
    <span class="reason">${esc(st.reason ?? "")}</span>
  </div>`;
}

function stepChips(steps: StepState[]): string {
  return steps
    .map((st) => `<span class="chip" title="${esc(st.reason ?? STATE_TEXT[st.status])}">
      <span class="dot ${st.status}"></span>${esc(st.step)} ${esc(st.title)}·${STATE_TEXT[st.status]}</span>`)
    .join("");
}

function renderTodo(s: Survey): string {
  const chips = s.todo
    .map((t) => {
      const cls = t.text.includes("出错") ? "chip err" : t.text.includes("待重跑") ? "chip warn" : "chip";
      const ic = t.text.includes("出错") ? icon("warn", 11) : t.text.includes("待重跑") ? icon("refresh", 11) : icon("clock", 11);
      return `<span class="${cls}" title="${esc(t.owner)}">${ic}${esc(t.text)}</span>`;
    })
    .join("");
  return `<div class="todo"><span class="label">待办</span>${chips}</div>`;
}

const topbar = (right: string): string => `
  <div class="topbar">
    <span class="title">切片助手</span>
    <span class="spacer"></span>
    ${right}
  </div>`;

// ---- 总览 ----

function libGroup(kind: string, items: LibraryItem[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map((it) => `<div class="lib-item"><span class="t">${esc(it.title)}</span>
      ${it.group ? `<span class="g">${esc(it.group)}</span>` : ""}<span class="b num">${fmtBytes(it.bytes)}</span></div>`)
    .join("");
  const ic = kind === "bgm" ? icon("music") : kind === "font" ? icon("font") : icon("film");
  return `<details class="lib"><summary>${ic} ${KIND_TEXT[kind] ?? esc(kind)} <span class="count num">${items.length} 项</span></summary>${rows}</details>`;
}

async function viewHome(): Promise<void> {
  const [survey, libraryRaw] = await Promise.all([api<Survey>("/api/survey"), api<Library | null>("/api/library")]);
  const library: Library = libraryRaw ?? { schema: 1, source_root: "（未入库）", items: [] };
  const clipsByJob = new Map<string, Survey["clips"]>();
  for (const c of survey.clips) {
    const list = clipsByJob.get(c.job_id) ?? [];
    list.push(c);
    clipsByJob.set(c.job_id, list);
  }
  const jobs = survey.jobs
    .map((j) => {
      const clips = (clipsByJob.get(j.id) ?? [])
        .map((c) => `<a class="clip-link" href="#/clip/${encodeURIComponent(c.id)}">${icon("cut", 11)} ${esc(c.title)} <span class="num">${esc(c.id)}</span></a>`)
        .join("");
      return `<div class="card">
        <a class="card-head link" href="#/job/${encodeURIComponent(j.id)}">${icon("film")} <span class="num">${esc(j.id)}</span> <span class="sub">${esc(baseName(j.video_path))}</span></a>
        ${j.steps.map(stepRow).join("")}
        ${clips ? `<div class="clip-links">${clips}</div>` : ""}
      </div>`;
    })
    .join("");
  const byKind = new Map<string, LibraryItem[]>();
  for (const it of library.items) {
    const list = byKind.get(it.kind) ?? [];
    list.push(it);
    byKind.set(it.kind, list);
  }
  app.innerHTML = `
    ${topbar(`<button class="iconbtn" id="btn-refresh">${icon("refresh", 12)} 刷新</button>`)}
    ${renderTodo(survey)}
    <div class="main">
      <div class="section-title">新建任务</div>
      <div class="card form-card">
        <input class="text" id="nj-video" placeholder="视频文件的完整路径（必填）" />
        <input class="text" id="nj-srt" placeholder="剪映导出的 .srt 路径（可空，空则后续走本地转写）" />
        <button class="btn primary" id="nj-go">${icon("plus", 12)} 建任务</button>
        <span class="hint" id="nj-msg"></span>
      </div>
      <div class="section-title">任务</div>
      ${jobs || `<div class="card"><div class="empty-hint">${icon("film", 20)}<div style="margin-top:6px">还没有任务</div></div></div>`}
      <div class="section-title">素材库（${esc(library.source_root)}）</div>
      ${[...byKind.entries()].sort().map(([k, items]) => libGroup(k, items)).join("")}
    </div>`;
  document.getElementById("btn-refresh")!.addEventListener("click", () => void render());
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
      const { id } = await api<{ id: string }>("/api/jobs", { method: "POST", body: JSON.stringify({ video_path: video, srt_path: srt || null }) });
      location.hash = `#/job/${encodeURIComponent(id)}`;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  });
}

// ---- 任务页（s00 字幕 + 手动建片段） ----

const selection = new Map<string, { i: number | null; j: number | null }>();

async function viewJob(id: string): Promise<void> {
  const survey = await api<Survey>("/api/survey");
  const job = survey.jobs.find((j) => j.id === id);
  if (!job) {
    app.innerHTML = `${topbar("")}<div class="main"><div class="card"><div class="empty-hint">任务不存在：${esc(id)}</div></div></div>`;
    return;
  }
  const clips = survey.clips.filter((c) => c.job_id === id);
  const s00 = job.steps.find((s) => s.step === "s00")!;
  const sentences = s00.status === "ready" || s00.status === "suspect"
    ? await api<SentencesFile>(`/api/jobs/${encodeURIComponent(id)}/sentences`).catch(() => null)
    : null;
  const sel = selection.get(id) ?? { i: null, j: null };
  selection.set(id, sel);

  const sentRows = sentences
    ? sentences.sentences
        .map((s, idx) => `<div class="sent pick" data-idx="${idx}">
          <span class="tc num">${tc(s.start)}–${tc(s.end)}</span>
          <span class="txt">${esc(s.text)}</span>
          <span class="pick-btns"><button class="minibtn" data-act="i" data-idx="${idx}">起</button><button class="minibtn" data-act="j" data-idx="${idx}">止</button></span>
        </div>`)
        .join("")
    : "";

  app.innerHTML = `
    ${topbar(`<a class="iconbtn link" href="#/">${icon("back", 12)} 总览</a>`)}
    <div class="main">
      <div class="card">
        <div class="card-head">${icon("film")} <span class="num">${esc(job.id)}</span> <span class="sub">${esc(job.video_path)}</span></div>
        <div class="steps-line">${stepChips(job.steps)}</div>
        <div class="actions">
          <button class="btn" id="run-s00">${icon("doc", 12)} ${s00.status === "empty" ? "导入字幕" : "重跑字幕"}</button>
          <span class="hint" id="run-status"></span>
        </div>
      </div>
      <div class="section-title">字幕句流（点「起」「止」选定建片段的区间）</div>
      <div class="card sents" id="job-sents">${sentences ? sentRows : `<div class="empty-hint">${esc(sentences === null && s00.status !== "empty" ? "句流读取失败" : "尚未导入字幕——先点上方「导入字幕」")}</div>`}</div>
      <div class="card form-card" id="mk-clip">
        <span class="hint" id="sel-info">未选区间</span>
        <input class="text" id="mc-title" placeholder="片段标题（可空）" />
        <button class="btn primary" id="mc-go">${icon("cut", 12)} 建片段</button>
        <span class="hint" id="mc-msg"></span>
      </div>
      <div class="section-title">片段</div>
      <div class="card">
        ${clips.length ? clips.map((c) => `<a class="clip-row link" href="#/clip/${encodeURIComponent(c.id)}">
            ${icon("cut", 11)} <span class="t">${esc(c.title)}</span> <span class="num">${esc(c.id)}</span>
            <span class="steps-inline">${stepChips(c.steps)}</span></a>`).join("")
          : `<div class="empty-hint">还没有片段——在上方句流里选区间建一个</div>`}
      </div>
    </div>`;

  const statusEl = document.getElementById("run-status")!;
  document.getElementById("run-s00")!.addEventListener("click", async () => {
    await runAndPoll(statusEl, `jobs/${id}`, "s00", null);
    await render();
  });

  const selInfo = document.getElementById("sel-info")!;
  const refreshSel = (): void => {
    document.querySelectorAll("#job-sents .sent").forEach((el) => {
      const idx = Number((el as HTMLElement).dataset.idx);
      el.classList.toggle("in-sel", sel.i !== null && sel.j !== null && idx >= sel.i && idx <= sel.j);
    });
    selInfo.textContent = sel.i === null || sel.j === null || !sentences
      ? "未选区间"
      : `已选 ${tc(sentences.sentences[sel.i]!.start)} – ${tc(sentences.sentences[sel.j]!.end)}（${sel.j - sel.i + 1} 句）`;
  };
  document.querySelectorAll("#job-sents .minibtn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number((btn as HTMLElement).dataset.idx);
      if ((btn as HTMLElement).dataset.act === "i") {
        sel.i = idx;
        if (sel.j === null || sel.j < idx) sel.j = idx;
      } else {
        sel.j = idx;
        if (sel.i === null || sel.i > idx) sel.i = idx;
      }
      refreshSel();
    });
  });
  refreshSel();

  document.getElementById("mc-go")!.addEventListener("click", async () => {
    const msg = document.getElementById("mc-msg")!;
    if (!sentences || sel.i === null || sel.j === null) {
      msg.textContent = "先在句流里选「起」「止」";
      return;
    }
    msg.textContent = "创建中…";
    try {
      const { id: clipId } = await api<{ id: string }>("/api/clips", {
        method: "POST",
        body: JSON.stringify({
          job_id: id,
          title: (document.getElementById("mc-title") as HTMLInputElement).value.trim(),
          start: sentences.sentences[sel.i]!.start,
          end: sentences.sentences[sel.j]!.end,
        }),
      });
      location.hash = `#/clip/${encodeURIComponent(clipId)}`;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  });
}

// ---- 逐句删留工作台（b9：句子流+播放器联动，当前句带上下各两句；覆盖层 b29） ----

async function viewClip(id: string): Promise<void> {
  const survey = await api<Survey>("/api/survey");
  const clip = survey.clips.find((c) => c.id === id);
  if (!clip) {
    app.innerHTML = `${topbar("")}<div class="main"><div class="card"><div class="empty-hint">片段不存在：${esc(id)}</div></div></div>`;
    return;
  }
  const llm = await api<{ ok: boolean; model?: string; reason?: string }>("/api/llm");
  let view: S03View | null = await api<S03View>(`/api/clips/${encodeURIComponent(id)}/s03`).catch(() => null);

  app.innerHTML = `
    ${topbar(`<a class="iconbtn link" href="#/job/${encodeURIComponent(clip.job_id)}">${icon("back", 12)} 任务页</a>`)}
    <div class="main ws">
      <div class="card">
        <div class="card-head">${icon("cut")} ${esc(clip.title)} <span class="num">${esc(id)}</span>
          <span class="sub num">${tc(clip.start)} – ${tc(clip.end)}</span></div>
        <div class="steps-line">${stepChips(clip.steps)}</div>
      </div>
      <video class="player" id="player" controls preload="metadata" src="/api/media/job/${encodeURIComponent(clip.job_id)}/video"></video>
      <div class="card form-card">
        <button class="btn" id="run-build">${icon("refresh", 12)} 重建句流</button>
        <button class="btn" id="run-draft" ${llm.ok ? "" : "disabled"}>${icon("spark", 12)} AI 出初稿${llm.ok ? `（${esc(llm.model ?? "")}）` : ""}</button>
        <span class="hint" id="llm-reason">${llm.ok ? "" : esc(llm.reason ?? "")}</span>
        <span class="hint" id="run-status"></span>
      </div>
      <div class="section-title" id="s03-info"></div>
      <div class="card sents" id="s03-sents"></div>
    </div>`;

  const player = document.getElementById("player") as HTMLVideoElement;
  const listEl = document.getElementById("s03-sents")!;
  const infoEl = document.getElementById("s03-info")!;
  const statusEl = document.getElementById("run-status")!;
  let rowEls: HTMLElement[] = [];
  let curIdx = -1;

  const renderList = (): void => {
    if (!view) {
      infoEl.textContent = "句流（未构建）";
      listEl.innerHTML = `<div class="empty-hint">句流未构建——点上方「重建句流」</div>`;
      return;
    }
    const kept = view.sentences.filter((s) => s.keep).length;
    infoEl.textContent = `句流（留 ${kept} / 共 ${view.sentences.length} 句${view.ai ? `，AI 初稿 ${view.ai.model}` : ""}${view.orphans.length ? `，${view.orphans.length} 条覆盖已对不上句子` : ""}）`;
    listEl.innerHTML = view.sentences
      .map((s, idx) => `<div class="sent${s.keep ? "" : " drop"}" data-idx="${idx}">
        <span class="tc num">${tc(s.start)}<br/>${tc(s.end)}</span>
        <span class="body"><span class="txt">${esc(s.text)}</span>
          ${s.reason ? `<span class="reason-line">${esc(s.reason)}</span>` : ""}</span>
        <span class="side">
          ${s.source === "human" ? `<span class="badge human">人</span>` : s.source === "ai" ? `<span class="badge">AI</span>` : ""}
          <button class="minibtn toggle" data-idx="${idx}">${s.keep ? "留" : "删"}</button>
        </span>
      </div>`)
      .join("");
    rowEls = Array.from(listEl.querySelectorAll<HTMLElement>(".sent"));
    curIdx = -1;
    listEl.querySelectorAll<HTMLElement>(".sent .txt, .sent .tc").forEach((el) => {
      el.addEventListener("click", () => {
        const row = el.closest(".sent") as HTMLElement;
        const s = view!.sentences[Number(row.dataset.idx)]!;
        player.currentTime = s.start + 0.02; // 点句跳转（b9）
      });
    });
    listEl.querySelectorAll<HTMLButtonElement>(".toggle").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const s = view!.sentences[Number(btn.dataset.idx)]!;
        btn.disabled = true;
        try {
          view = await api<S03View>(`/api/clips/${encodeURIComponent(id)}/s03/overlay`, {
            method: "POST",
            body: JSON.stringify({ sentence_id: s.id, keep: !s.keep }),
          });
          renderList();
        } catch (err) {
          btn.disabled = false;
          statusEl.textContent = err instanceof Error ? err.message : String(err);
        }
      });
    });
  };

  // 播放联动：高亮当前句，并保持上下各两句在视口内（b9）
  player.addEventListener("timeupdate", () => {
    if (!view || rowEls.length === 0) return;
    const t = player.currentTime;
    const idx = view.sentences.findIndex((s) => s.start <= t && t < s.end);
    if (idx === curIdx) return;
    curIdx = idx;
    rowEls.forEach((el, i) => el.classList.toggle("cur", i === idx));
    if (idx >= 0 && !player.paused) {
      const anchor = rowEls[Math.max(0, idx - 2)]!;
      listEl.scrollTo({ top: anchor.offsetTop, behavior: "smooth" });
    }
  });

  document.getElementById("run-build")!.addEventListener("click", async () => {
    if (await runAndPoll(statusEl, `clips/${id}`, "s03", null)) {
      view = await api<S03View>(`/api/clips/${encodeURIComponent(id)}/s03`).catch(() => null);
      renderList();
    }
  });
  document.getElementById("run-draft")!.addEventListener("click", async () => {
    if (await runAndPoll(statusEl, `clips/${id}`, "s03", "draft")) {
      view = await api<S03View>(`/api/clips/${encodeURIComponent(id)}/s03`).catch(() => null);
      renderList();
    }
  });

  renderList();
}

async function render(): Promise<void> {
  const r = route();
  if (r.view === "job") return viewJob(r.id);
  if (r.view === "clip") return viewClip(r.id);
  return viewHome();
}

window.addEventListener("hashchange", () => void render());
void render();
