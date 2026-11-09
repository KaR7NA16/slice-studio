// 前端共享助手：转义/时间码/请求/轮询/状态文案/顶栏。被各视图模块引用，本身不渲染整页。
import type { JobSurvey, LibraryItem, RunRecord, StepState, Survey, TodoItem } from "../shared/types.ts";
import { icon } from "./icons.ts";

export const STATE_TEXT: Record<StepState["status"], string> = {
  ready: "就绪", stale: "待重跑", suspect: "待定", empty: "未跑", error: "出错", missing: "丢失",
};
// 待办条的配色与图标按 kind 取。此前靠嗅探 text（includes("出错") / includes("待重跑")）判断——
// 新增 missing 一类后新文案不含旧关键词，会静默落回默认灰，所以判据改为由后端直接给出。
export const TODO_CLS: Record<TodoItem["kind"], string> = {
  error: "chip err", stale: "chip warn", missing: "chip miss", empty: "chip",
};
export const TODO_ICON: Record<TodoItem["kind"], string> = {
  error: "warn", stale: "refresh", missing: "warn", empty: "clock",
};
export const KIND_TEXT: Record<string, string> = { bgm: "配乐", font: "字体", material: "素材视频", meme: "梗图", sfx: "音效" };

export const app = document.getElementById("app")!;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

export function jobLabel(title: string, videoPath: string): string {
  return title.trim() || baseName(videoPath);
}

export function jobTools(j: Pick<JobSurvey, "id" | "title" | "video_path" | "archived">): string {
  const name = jobLabel(j.title, j.video_path);
  const act = j.archived ? "restore" : "archive";
  return `<span class="card-tools">
    <button class="minibtn" type="button" data-job-act="rename" data-job="${esc(j.id)}" data-job-title="${esc(j.title)}" data-job-name="${esc(name)}">改名</button>
    <button class="minibtn" type="button" data-job-act="${act}" data-job="${esc(j.id)}" data-job-name="${esc(name)}">${j.archived ? "恢复" : "归档"}</button>
    <button class="minibtn" type="button" data-job-act="delete" data-job="${esc(j.id)}" data-job-name="${esc(name)}">删除</button>
  </span>`;
}

export function bindJobActions(rerender: () => void): void {
  document.querySelectorAll<HTMLButtonElement>("[data-job-act]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.job ?? "";
      const act = btn.dataset.jobAct;
      const name = btn.dataset.jobName ?? id;
      try {
        if (act === "rename") {
          const next = window.prompt("任务名称（留空则用视频文件名）", btn.dataset.jobTitle ?? "");
          if (next === null) return;
          await api(`/api/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title: next }) });
        } else if (act === "archive" || act === "restore") {
          await api(`/api/jobs/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ archived: act === "archive" }),
          });
        } else if (act === "delete") {
          if (!window.confirm(`删除任务「${name}」和它下面的片段？\n源视频文件会留在原处。`)) return;
          await api(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
          if (location.hash.startsWith("#/job/") || location.hash.startsWith("#/clip/")) {
            location.hash = "#/";
            return;
          }
        }
        rerender();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err));
      }
    });
  });
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(0) + " KB";
  return n + " B";
}

// 等宽时间码（b40：float 秒显示到毫秒）
export function tc(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w: number): string => String(n).padStart(w, "0");
  return h > 0 ? `${h}:${p(m, 2)}:${p(s, 2)}.${p(ms % 1000, 3)}` : `${p(m, 2)}:${p(s, 2)}.${p(ms % 1000, 3)}`;
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

export const post = <T>(url: string, body: unknown): Promise<T> =>
  api<T>(url, { method: "POST", body: JSON.stringify(body) });

// 触发 run 并轮询心跳（b53），状态行实时更新；返回是否成功
export async function runAndPoll(statusEl: HTMLElement, owner: string, step: string, mode: string | null): Promise<boolean> {
  statusEl.textContent = "启动中…";
  let rec: RunRecord;
  try {
    rec = await post<RunRecord>("/api/run", { owner, step, mode });
  } catch (e) {
    statusEl.textContent = `失败：${e instanceof Error ? e.message : String(e)}`;
    return false;
  }
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

// ---- 共用片段 ----

export function stepRow(st: StepState): string {
  return `<div class="step">
    <span class="dot ${st.status}"></span>
    <span class="id num">${esc(st.step)}</span>
    <span class="name">${esc(st.title)}</span>
    <span class="state ${st.status}">${STATE_TEXT[st.status]}</span>
    <span class="reason">${esc(st.reason ?? "")}</span>
  </div>`;
}

export function stepChips(steps: StepState[]): string {
  return steps
    .map((st) => `<span class="chip" title="${esc(st.reason ?? STATE_TEXT[st.status])}">
      <span class="dot ${st.status}"></span>${esc(st.step)} ${esc(st.title)}·${STATE_TEXT[st.status]}</span>`)
    .join("");
}

// 句流为空时的提示：按 s00 的状态据实说（b59：界面永不渲染猜测性内容）。
// missing 不能落到「句流读取失败」——那句会让人以为读取环节坏了，实际是产物文件不在了。
export function sentenceHint(s00: StepState): string {
  if (s00.status === "empty") return "尚未导入字幕——先点上方「导入字幕」";
  if (s00.status === "missing") return `${s00.reason ?? "字幕产物缺失"}——重跑字幕即可恢复`;
  return "句流读取失败";
}

export function renderTodo(s: Survey): string {
  const chips = s.todo
    .map((t) => `<span class="${TODO_CLS[t.kind]}" title="${esc(t.owner)}">${icon(TODO_ICON[t.kind], 11)}${esc(t.text)}</span>`)
    .join("");
  return `<div class="todo"><span class="label">待办</span>${chips}</div>`;
}

export const topbar = (right: string): string => `
  <div class="topbar">
    <a class="brand link" href="#/">切片助手</a>
    <span class="spacer"></span>
    ${right}
  </div>`;

export function libGroup(kind: string, items: LibraryItem[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map((it) => `<div class="lib-item"><span class="t">${esc(it.title)}</span>
      ${it.group ? `<span class="g">${esc(it.group)}</span>` : ""}<span class="b num">${fmtBytes(it.bytes)}</span></div>`)
    .join("");
  const ic = kind === "bgm" ? icon("music") : kind === "font" ? icon("font") : icon("film");
  return `<details class="lib"><summary>${ic} ${KIND_TEXT[kind] ?? esc(kind)} <span class="count num">${items.length} 项</span></summary>${rows}</details>`;
}

export function notFound(what: string): void {
  app.innerHTML = `${topbar(`<a class="iconbtn link" href="#/">${icon("back", 12)} 总览</a>`)}
    <div class="main"><div class="card"><div class="empty-hint">${esc(what)}</div></div></div>`;
}
