// 前端共享助手：转义/时间码/请求/轮询/状态文案/顶栏/待办条。被各视图模块引用，本身不渲染整页。
import type { JobSurvey, LibraryItem, RunRecord, StepState, Survey, TodoItem } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { confirmModal, dangerBody, promptModal } from "./modal.ts";
import { themeButtonHtml } from "./theme.ts";
import { toast } from "./toast.ts";

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

// ---- 状态消息（就地、不会消失；与「说明」区分开） ----

export type MsgKind = "info" | "ok" | "err" | "busy";

export function setMsg(el: HTMLElement, text: string, kind: MsgKind = "info"): void {
  // 读屏靠 live region 播报，而 region 必须在内容变化**之前**就存在，所以各视图模板里
  // .msg 默认已带 role=status + polite；这里只按 kind 改档：
  // 进行中/成功是进度，polite 不打断用户；失败必须打断——失败被静音等于没报（WCAG 4.1.3）。
  el.setAttribute("role", kind === "err" ? "alert" : "status");
  el.setAttribute("aria-live", kind === "err" ? "assertive" : "polite");
  el.setAttribute("aria-atomic", "true");
  el.classList.remove("ok", "err", "busy");
  if (kind !== "info") el.classList.add(kind);
  el.textContent = "";
  if (kind === "busy") {
    const sp = document.createElement("span");
    sp.className = "spinner";
    el.appendChild(sp);
  } else if (kind === "err") {
    el.insertAdjacentHTML("beforeend", icon("warn", 12));
  } else if (kind === "ok") {
    el.insertAdjacentHTML("beforeend", icon("check", 12));
  }
  el.appendChild(document.createTextNode(text));
}

// 提交期间：按钮禁用 + aria-busy，避免重复点击；无论成败都恢复
export async function withBusy<T>(btn: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T | undefined> {
  if (!btn) return await fn();
  const was = btn.disabled;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.disabled = was;
      btn.removeAttribute("aria-busy");
    }
  }
}

// ---- 任务操作 ----

// 只产按钮串，容器（.card-tools）由调用方给：容器里还要塞别的东西（任务页的「复制路径」），
// 自带一层会导致嵌套两层 .card-tools，分组间距被内层抹平成组内间距。
export function jobTools(j: Pick<JobSurvey, "id" | "title" | "video_path" | "archived">): string {
  const name = jobLabel(j.title, j.video_path);
  const act = j.archived ? "restore" : "archive";
  return `<button class="minibtn" type="button" data-job-act="rename" data-job="${esc(j.id)}" data-job-title="${esc(j.title)}" data-job-name="${esc(name)}">改名</button>
    <button class="minibtn" type="button" data-job-act="${act}" data-job="${esc(j.id)}" data-job-name="${esc(name)}">${j.archived ? "恢复" : "归档"}</button>
    <button class="minibtn danger" type="button" data-job-act="delete" data-job="${esc(j.id)}" data-job-name="${esc(name)}">删除</button>`;
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
          const next = await promptModal({
            title: "任务名称",
            label: "留空则用视频文件名。改名不进 job.json，不会把下游标脏。",
            value: btn.dataset.jobTitle ?? "",
            placeholder: name,
          });
          if (next === null) return;
          await api(`/api/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title: next }) });
        } else if (act === "archive" || act === "restore") {
          await api(`/api/jobs/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ archived: act === "archive" }),
          });
          toast(act === "archive" ? `已归档「${name}」` : `已恢复「${name}」`);
        } else if (act === "delete") {
          const ok = await confirmModal({
            title: `删除任务「${name}」？`,
            bodyHtml: dangerBody([
              "任务下所有片段与产物会一并删除，不可恢复。",
              "源视频文件留在原处，不会被删除。",
            ]),
            confirmLabel: "删除",
            danger: true,
          });
          if (!ok) return;
          await api(`/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
          if (location.hash.startsWith("#/job/") || location.hash.startsWith("#/clip/")) {
            location.hash = "#/";
            return;
          }
        }
        rerender();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), "err");
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

// 触发 run 并轮询心跳（b53）。
// 三条纪律（此前都没有）：① 每次轮询自己 catch，服务端 5xx 不会变成未处理 rejection；
// ② 视图被重画/离页后（statusEl 脱离 DOM）立刻停，避免继续打已废弃的 run；
// ③ 连续 3 次拿不到心跳才判失败——单次抖动不该把一次正常的长任务报成失败。
// ④ 显示已用时，但**不进 live region**：这个数字每 800ms 变一次，放进
//    role=status 里读屏会把「已用 0:03 / 0:04 / 0:05」一句句念出来。用户要的是
//    「它还在动」，不是听秒表。所以它挂在状态位旁边的兄弟节点上，并 aria-hidden。
const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export async function runAndPoll(
  statusEl: HTMLElement,
  owner: string,
  step: string,
  mode: string | null,
): Promise<boolean> {
  setMsg(statusEl, "启动中…", "busy");
  const elapsedEl = document.createElement("span");
  elapsedEl.className = "elapsed";
  elapsedEl.setAttribute("aria-hidden", "true");
  statusEl.insertAdjacentElement("afterend", elapsedEl);
  let rec: RunRecord;
  try {
    rec = await post<RunRecord>("/api/run", { owner, step, mode });
  } catch (e) {
    elapsedEl.remove();
    setMsg(statusEl, `失败：${e instanceof Error ? e.message : String(e)}`, "err");
    return false;
  }
  // 用服务端记的开始时刻，不是点下去的那一刻：排队等槽的时间不算「在跑」，
  // 否则 sliver 一长，用户会以为任务卡在开头。
  const startedAt = Number.isFinite(Date.parse(rec.started_at)) ? Date.parse(rec.started_at) : Date.now();
  const paint = (): void => {
    elapsedEl.textContent = `已用 ${mmss(Date.now() - startedAt)}`;
  };
  paint();
  // 取消按钮也放在 live region 之外：它跑完就撤，若被播报，读屏用户会听到
  // 「取消 按钮」然后片刻又听到它消失——而真正该播报的是「已取消」那句话。
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "minibtn";
  cancelBtn.textContent = "取消";
  statusEl.insertAdjacentElement("afterend", cancelBtn);
  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = "取消中…";
    try {
      const r = await post<RunRecord>(`/api/runs/${encodeURIComponent(rec.id)}/cancel`, {});
      // 服务端会如实说明「进程未能终止」这类情况，照它的话显示，不自己编一句「已取消」
      const text = r.message || "已取消";
      setMsg(statusEl, text, text.startsWith("已取消") ? "info" : "err");
    } catch (e) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = "取消";
      setMsg(statusEl, `取消失败：${e instanceof Error ? e.message : String(e)}`, "err");
    }
  });
  try {
    let lost = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      paint();
      if (!statusEl.isConnected) return false; // 已离页：这不是失败，是没人看了
      let cur: RunRecord;
      try {
        cur = await api<RunRecord>(`/api/runs/${rec.id}`);
        lost = 0;
      } catch (e) {
        lost++;
        if (lost >= 3) {
          setMsg(statusEl, `失去与服务端的联系：${e instanceof Error ? e.message : String(e)}`, "err");
          return false;
        }
        setMsg(statusEl, "连接波动，正在重试…", "busy");
        continue;
      }
      if (cur.status !== "running") {
        if (cur.status === "done") {
          setMsg(statusEl, `完成：${cur.message}`, "ok");
          return true;
        }
        // 主动取消不是故障：报成「失败」会让用户以为是自己弄坏了什么
        if (cur.status === "cancelled") {
          setMsg(statusEl, cur.message || "已取消", "info");
          return false;
        }
        setMsg(statusEl, `失败：${cur.error ?? cur.message}`, "err");
        return false;
      }
      setMsg(statusEl, cur.message, "busy");
    }
  } finally {
    elapsedEl.remove();
    cancelBtn.remove();
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
  // 整条链路一次都没跑过时，逐步铺三个「未跑」读起来像三条各自独立的问题，
  // 实际是一件事。收成一句；各步的确切状态在上方的步列表里逐行写着，不丢信息。
  if (steps.length > 1 && steps.every((st) => st.status === "empty")) {
    return `<span class="chip"><span class="dot empty"></span>本链路还没跑过</span>`;
  }
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

// ---- 待办条（b5）：回答「现在该干什么」，并且能点进那一步 ----

// ctx 省略 = 总览页（列全部）；任务页只列本任务相关；片段页只列本片段。
export function renderTodo(s: Survey, ctx?: { kind: "job" | "clip"; id: string }): string {
  const jobIds = new Set(s.jobs.map((j) => j.id));
  const clipToJob = new Map(s.clips.map((c) => [c.id, c.job_id]));
  const inCtx = (t: TodoItem): boolean => {
    if (!ctx) return true;
    if (ctx.kind === "clip") return t.owner === ctx.id;
    return t.owner === ctx.id || clipToJob.get(t.owner) === ctx.id;
  };
  const href = (t: TodoItem): string => {
    const isJob = jobIds.has(t.owner);
    const base = isJob ? `#/job/${encodeURIComponent(t.owner)}` : `#/clip/${encodeURIComponent(t.owner)}`;
    return t.step ? `${base}/${encodeURIComponent(t.step)}` : base;
  };
  const items = s.todo.filter(inCtx);
  // 同文案同类别的多条（例如两个片段都「人声分离 未跑」）合并成一条 + 条数，
  // 否则待办条上会出现两条一模一样的 chip，看起来像渲染重复。
  const merged = new Map<string, { t: TodoItem; n: number; owners: string[] }>();
  for (const t of items) {
    const key = `${t.kind}|${t.step ?? ""}|${t.text}`;
    const hit = merged.get(key);
    if (hit) {
      hit.n++;
      hit.owners.push(t.owner);
    } else {
      merged.set(key, { t, n: 1, owners: [t.owner] });
    }
  }
  const chips = [...merged.values()]
    .map(({ t, n, owners }) => `<a class="${TODO_CLS[t.kind]}" href="${href(t)}" data-owner="${esc(t.owner)}" data-step="${esc(t.step ?? "")}" title="${n > 1 ? `${n} 条：${owners.join("、")}` : "去处理"}">${icon(TODO_ICON[t.kind], 11)}${esc(t.text)}${n > 1 ? `<span class="badge">×${n}</span>` : ""}</a>`)
    .join("");
  return `<div class="todo"><span class="label">待办</span>${chips || `<span class="none">没有待办</span>`}</div>`;
}

export const topbar = (right: string): string => `
  <div class="topbar">
    <a class="brand link" href="#/">切片助手</a>
    <span class="spacer"></span>
    ${themeButtonHtml()}
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
