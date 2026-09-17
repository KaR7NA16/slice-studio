// 界面入口（Vite + TS 无框架，b13；直接 DOM 渲染）
// 第一版范围 = 读（b53）：三态清单 + 待办条 + 素材库，全部来自服务端现算，界面不猜。
import type { Library, LibraryItem, StepState, Survey } from "../shared/types.ts";
import { icon } from "./icons.ts";

const STATE_TEXT: Record<StepState["status"], string> = {
  ready: "就绪",
  stale: "待重跑",
  suspect: "待定",
  empty: "未跑",
  error: "出错",
};

const KIND_TEXT: Record<string, string> = {
  bgm: "配乐",
  font: "字体",
  material: "素材视频",
  meme: "梗图",
  sfx: "音效",
};

const app = document.getElementById("app")!;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

function fmtBytes(n: number): string {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + " KB";
  return n + " B";
}

function stepRow(st: StepState): string {
  const reason = st.reason ? `<span class="reason">${esc(st.reason)}</span>` : `<span class="reason"></span>`;
  return `<div class="step">
    <span class="dot ${st.status}"></span>
    <span class="id num">${esc(st.step)}</span>
    <span class="name">${esc(st.title)}</span>
    <span class="state ${st.status}">${STATE_TEXT[st.status]}</span>
    ${reason}
  </div>`;
}

function renderSurvey(s: Survey): string {
  if (s.jobs.length === 0) {
    return `<div class="card"><div class="empty-hint">${icon("film", 20)}<div style="margin-top:6px">还没有任务</div></div></div>`;
  }
  const clipsByJob = new Map<string, typeof s.clips>();
  for (const c of s.clips) {
    const list = clipsByJob.get(c.job_id) ?? [];
    list.push(c);
    clipsByJob.set(c.job_id, list);
  }
  return s.jobs
    .map((j) => {
      const clips = clipsByJob.get(j.id) ?? [];
      const clipHtml = clips
        .map(
          (c) => `<div class="clip-group">
            <div class="clip-title">${icon("cut", 11)} ${esc(c.title)} <span class="num">${esc(c.id)}</span></div>
            ${c.steps.map(stepRow).join("")}
          </div>`,
        )
        .join("");
      return `<div class="card" id="job-${esc(j.id)}">
        <div class="card-head">${icon("film")} <span class="num">${esc(j.id)}</span> <span class="sub">${esc(baseName(j.video_path))}</span></div>
        ${j.steps.map(stepRow).join("")}
        ${clipHtml}
      </div>`;
    })
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

function libGroup(kind: string, items: LibraryItem[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map(
      (it) => `<div class="lib-item">
        <span class="t">${esc(it.title)}</span>
        ${it.group ? `<span class="g">${esc(it.group)}</span>` : ""}
        <span class="b num">${fmtBytes(it.bytes)}</span>
      </div>`,
    )
    .join("");
  const ic = kind === "bgm" ? icon("music") : kind === "font" ? icon("font") : icon("film");
  return `<details class="lib">
    <summary>${ic} ${KIND_TEXT[kind] ?? esc(kind)} <span class="count num">${items.length} 项</span></summary>
    ${rows}
  </details>`;
}

function renderLibrary(lib: Library): string {
  const byKind = new Map<string, LibraryItem[]>();
  for (const it of lib.items) {
    const list = byKind.get(it.kind) ?? [];
    list.push(it);
    byKind.set(it.kind, list);
  }
  const groups = [...byKind.entries()].sort().map(([k, items]) => libGroup(k, items)).join("");
  return `<div class="section-title">素材库（${esc(lib.source_root)}）</div><div class="card" style="background:transparent;box-shadow:none">${groups}</div>`;
}

async function load(): Promise<void> {
  const [survey, library] = (await Promise.all([
    fetch("/api/survey").then((r) => r.json()),
    fetch("/api/library").then((r) => r.json()),
  ])) as [Survey, Library];
  app.innerHTML = `
    <div class="topbar">
      <span class="title">切片助手</span>
      <span class="spacer"></span>
      <button class="iconbtn" id="btn-refresh">${icon("refresh", 12)} 刷新</button>
    </div>
    ${renderTodo(survey)}
    <div class="main">
      <div class="section-title">任务</div>
      ${renderSurvey(survey)}
      ${renderLibrary(library)}
    </div>`;
  document.getElementById("btn-refresh")!.addEventListener("click", () => void load());
}

void load();
