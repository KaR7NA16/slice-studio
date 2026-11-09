// 任务工作空间（b5）：字幕（s00）→ 审片（播放器 + 句流 + 选区）→ AI 抽卡（s01）→ 片段与分叉树。
//
// 两条纪律：
//   ① 播放器与句流联动和片段页共用 playback.ts——同一份跟随规则，不各写一份。
//   ② 「人工定稿」与「片段」是同一批对象（同 clip_id），只列一次；AI 提案只列**还没建片段**的那些，
//      已有的显示成指向该片段的链接。不按标题/时刻猜来源——数据里没有来源字段，猜就是编。
import type { AutomationView, CandidatesFile, S01AiFile, SentencesFile, Survey, VariantsView } from "../shared/types.ts";
import { icon } from "./icons.ts";
import {
  api, app, bindJobActions, esc, jobLabel, jobTools, notFound, post, renderTodo, sentenceHint,
  setMsg, stepChips, tc, topbar, withBusy,
} from "./lib.ts";
import { automationRow, canRun, depHint, runWithConfirm, treeHtml, wireAutomation, wireTree } from "./panel.ts";
import { mountPlayback } from "./playback.ts";
import { toast } from "./toast.ts";

// 建片段的区间选择（模块级：切视图后回来还在）
const selection = new Map<string, { i: number | null; j: number | null }>();

const RATES = [0.75, 1, 1.25, 1.5];

export async function viewJob(id: string, rerender: () => void): Promise<void> {
  const owner = `jobs/${id}`;
  const [survey, s01, llm] = await Promise.all([
    api<Survey>("/api/survey"),
    api<{ ai: S01AiFile | null; candidates: CandidatesFile | null }>(`/api/jobs/${encodeURIComponent(id)}/s01`),
    api<{ ok: boolean; model?: string; reason?: string }>("/api/llm"),
  ]);
  const job = survey.jobs.find((j) => j.id === id);
  if (!job) return notFound(`任务不存在：${id}`);
  const byId = new Map(job.steps.map((s) => [s.step, s]));
  const clips = survey.clips.filter((c) => c.job_id === id);
  const s00 = byId.get("s00")!;
  const s01st = byId.get("s01")!;
  const sentences = s00.status === "ready" || s00.status === "suspect"
    ? await api<SentencesFile>(`/api/jobs/${encodeURIComponent(id)}/sentences`).catch(() => null)
    : null;

  // 选区按当前句数夹紧：重跑字幕后句子变少，旧的 i/j 会越界（此前 refreshSel 直接抛错）
  const sel = selection.get(id) ?? { i: null as number | null, j: null as number | null };
  selection.set(id, sel);
  const n = sentences?.sentences.length ?? 0;
  if (n === 0) {
    sel.i = null;
    sel.j = null;
  } else {
    if (sel.i !== null && sel.i >= n) sel.i = n - 1;
    if (sel.j !== null && sel.j >= n) sel.j = n - 1;
    if (sel.i !== null && sel.j !== null && sel.i > sel.j) [sel.i, sel.j] = [sel.j, sel.i];
  }

  const tree = await api<VariantsView>(`/api/variants/${owner}`);
  const auto = await api<AutomationView>(`/api/automation/${owner}`);
  const linkFor = (s: string): string => `#/job/${encodeURIComponent(id)}/${s}`;

  // 时刻对照：AI 提案与已有片段是不是同一段（按 start/end 精确比对，不猜标题）
  const clipAt = (start: number, end: number) =>
    clips.find((c) => Math.abs(c.start - start) < 0.005 && Math.abs(c.end - end) < 0.005);

  const sentRows = sentences
    ? sentences.sentences
        .map((s, idx) => `<div class="sent" role="option" tabindex="${idx === 0 ? 0 : -1}" aria-selected="false" data-idx="${idx}">
          <span class="tc num">${tc(s.start)}<br/>${tc(s.end)}</span>
          <span class="body"><span class="txt">${esc(s.text)}</span></span>
          <span class="side pick-btns">
            <button class="minibtn" type="button" tabindex="-1" data-act="i" data-idx="${idx}" title="设为起点（[）">起</button>
            <button class="minibtn" type="button" tabindex="-1" data-act="j" data-idx="${idx}" title="设为终点（]）">止</button>
          </span>
        </div>`)
        .join("")
    : "";

  const aiRows = s01.ai
    ? s01.ai.candidates
        .map((c) => {
          const existed = clipAt(c.start, c.end);
          return `<div class="cand">
          <span class="cand-head"><span class="t">${esc(c.title)}</span>
            <span class="tc num">${tc(c.start)}–${tc(c.end)}</span>
            <span class="badge">AI</span></span>
          ${c.reason ? `<span class="reason-line">${esc(c.reason)}</span>` : ""}
          ${existed
            ? `<a class="minibtn link" href="#/clip/${encodeURIComponent(existed.id)}">${icon("check", 11)} 已有片段 ${esc(existed.id)}</a>`
            : `<button class="minibtn adopt" type="button" data-title="${esc(c.title)}" data-start="${c.start}" data-end="${c.end}">采纳并建片段</button>`}
        </div>`;
        })
        .join("")
    : "";

  const clipRows = clips
    .map((c) => `<a class="clip-row link" href="#/clip/${encodeURIComponent(c.id)}">
      ${icon("film", 11)} <span class="t">${esc(c.title)}</span> <span class="num">${esc(c.id)}</span>
      <span class="time num">${tc(c.start)}–${tc(c.end)}</span>
      <span class="steps-inline">${stepChips(c.steps.filter((s) => s.status !== "ready"))}</span></a>`)
    .join("");

  app.innerHTML = `
    ${topbar(`<a class="iconbtn link" href="#/">${icon("back", 12)} 总览</a><a class="iconbtn link" href="#/settings">${icon("sliders", 12)} 设置</a>`)}
    ${renderTodo(survey, { kind: "job", id })}
    <div class="main">
      <div class="card">
        <div class="card-head">${icon("film")} <span class="job-name">${esc(jobLabel(job.title, job.video_path))}</span>
          <span class="num">${esc(job.id)}</span>${job.archived ? `<span class="badge">已归档</span>` : ""}
          <span class="card-tools"><button class="minibtn" type="button" id="copy-path">复制路径</button>${jobTools(job)}</span>
        </div>
        <div class="steps-line">${stepChips(job.steps)}</div>
      </div>

      <div class="section-title">审片 <span class="meta">点句子跳到那一句；[ / ] 设起止；Enter 播放</span></div>
      <div class="card player-card">
        <video class="player" id="job-player" controls preload="metadata" src="/api/media/job/${encodeURIComponent(id)}/video"></video>
        <div class="player-tools">
          <button class="minibtn" type="button" id="pv-prev">${icon("back", 11)} 上一句</button>
          <button class="minibtn" type="button" id="pv-next">下一句 ${icon("play", 11)}</button>
          <span class="spacer"></span>
          <span class="seg-group speeds" role="group" aria-label="播放速度">
            ${RATES.map((r) => `<button class="seg${r === 1 ? " on" : ""}" type="button" data-rate="${r}" aria-pressed="${r === 1}">${r}×</button>`).join("")}
          </span>
          <span class="msg" id="pv-msg"></span>
        </div>
      </div>

      <div class="card form-card">
        <span class="selection-info" id="sel-info">未选区间</span>
        <input class="text" id="mc-title" placeholder="片段标题（可空）" />
        <button class="btn primary" id="mc-go"${sentences ? "" : " disabled"}>${icon("cut", 12)} 建片段</button>
        <span class="msg" id="mc-msg"></span>
      </div>
      <div class="card sents" id="job-sents" role="listbox" aria-label="句流">${sentences ? sentRows : `<div class="empty-hint">${esc(sentenceHint(s00))}</div>`}</div>

      <div class="section-title">字幕来源</div>
      <div class="card ws-card" id="step-s00">
        <div class="ws-head">${icon("doc")} 字幕 ${automationRow(auto, "s00")}</div>
        <div class="actions">
          <button class="btn" id="run-s00"${canRun(s00, byId) ? "" : " disabled"}>${icon("doc", 12)} ${s00.status === "empty" ? "导入字幕" : "重跑字幕"}</button>
          <span class="msg" id="run-status"></span>
        </div>
        ${depHint(s00, byId, linkFor)}
        <div class="hint block">有 .srt 就直接解析；没有则走本地转写（b2/b14/b41/b42：SRT 优先、ASR 兜底）。重跑字幕后句子可能变少，选区会自动收回。</div>
      </div>

      <div class="section-title">AI 抽卡 <span class="meta">每次抽卡另存一版，可切回</span></div>
      <div class="card ws-card" id="step-s01">
        <div class="ws-head">${icon("spark")} 选高光 ${automationRow(auto, "s01")}</div>
        <div class="actions">
          <button class="btn" id="run-s01"${canRun(s01st, byId) && llm.ok ? "" : " disabled"}>${icon("spark", 12)} ${s01.ai ? "再抽一版" : "AI 挑高光"}</button>
          <span class="msg" id="s01-status"></span>
        </div>
        ${depHint(s01st, byId, linkFor)}
        <div class="hint block">AI 只提案，不落定稿。采纳 = 用这条候选建片段，与手工建片段走同一条 API。</div>
      </div>
      <div class="section-title">AI 提案 <span class="meta">${s01.ai ? `${esc(s01.ai.model)} · ${esc(s01.ai.at.slice(0, 19).replace("T", " "))}` : "未抽卡"}</span></div>
      <div class="card">${aiRows || `<div class="empty-hint">还没有 AI 提案——点上方「AI 挑高光」</div>`}</div>

      <div class="section-title">片段 <span class="meta">${clips.length ? `${clips.length} 条` : ""}</span></div>
      <div class="card">${clipRows || `<div class="empty-hint">还没有片段——在上面的句流里选区间建一个，或采纳 AI 提案</div>`}</div>

      <details class="fold" id="tree-fold">
        <summary>${icon("branch", 13)} 分叉树 <span class="meta">主干 + 侧枝 · 切回不重跑 AI</span></summary>
        <div class="tree" id="tree">${treeHtml(tree)}</div>
      </details>
    </div>`;

  await wireAutomation(owner, rerender);
  await wireTree(owner, rerender);
  bindJobActions(rerender);

  document.getElementById("copy-path")!.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(job.video_path);
      toast("路径已复制");
    } catch {
      toast("复制失败——浏览器不允许写剪贴板", "err");
    }
  });

  const statusEl = document.getElementById("run-status")!;
  const runS00 = document.getElementById("run-s00") as HTMLButtonElement;
  runS00.addEventListener("click", async () => {
    await withBusy(runS00, async () => {
      const ok = await runWithConfirm(statusEl, owner, "s00", null);
      if (ok) rerender();
    });
  });

  const s01Status = document.getElementById("s01-status")!;
  if (!llm.ok) {
    s01Status.classList.add("err");
    s01Status.innerHTML = `${esc(llm.reason ?? "")} <a class="link" href="#/settings">去设置</a>`;
  }
  const runS01 = document.getElementById("run-s01") as HTMLButtonElement;
  runS01.addEventListener("click", async () => {
    await withBusy(runS01, async () => {
      if (await runWithConfirm(s01Status, owner, "s01", null)) rerender();
    });
  });

  // 采纳一条 AI 候选 = 建片段（与人工建片段同一条路，b1 的「人工定稿」没有被绕过）
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".cand .adopt"))) {
    b.addEventListener("click", async () => {
      await withBusy(b, async () => {
        try {
          const { id: clipId } = await post<{ id: string }>("/api/clips", {
            job_id: id,
            title: b.dataset.title ?? "",
            start: Number(b.dataset.start),
            end: Number(b.dataset.end),
          });
          location.hash = `#/clip/${encodeURIComponent(clipId)}`;
        } catch (e) {
          setMsg(s01Status, e instanceof Error ? e.message : String(e), "err");
        }
      });
    });
  }

  // ---- 播放器 + 句流联动（b9） ----
  const player = document.getElementById("job-player") as HTMLVideoElement;
  const listEl = document.getElementById("job-sents")!;
  const pvMsg = document.getElementById("pv-msg")!;
  const rowEls = Array.from(document.querySelectorAll<HTMLElement>("#job-sents .sent"));
  const sentList = sentences?.sentences ?? [];

  const pb = mountPlayback({
    player,
    sentences: () => sentList.map((s) => ({ start: s.start, end: s.end, keep: true })),
    rows: () => rowEls,
    list: () => listEl,
    // 任务页没有「成片预览」这个概念：不跳段，只做高亮与跟随
  });

  player.addEventListener("error", () => {
    setMsg(pvMsg, `源视频取不到：${job.video_path}（文件被移动或改名？）`, "err");
  });

  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".speeds .seg"))) {
    b.addEventListener("click", () => {
      const rate = Number(b.dataset.rate);
      player.playbackRate = rate;
      for (const x of Array.from(document.querySelectorAll<HTMLElement>(".speeds .seg"))) {
        const on = x === b;
        x.classList.toggle("on", on);
        x.setAttribute("aria-pressed", String(on));
      }
    });
  }

  const jumpTo = (idx: number, play: boolean): void => {
    const s = sentList[idx];
    if (!s) return;
    pb.seekTo(s.start + 0.02);
    if (play) void player.play().catch(() => undefined);
    pb.highlight();
  };

  const focusRow = (idx: number): void => {
    const row = rowEls[idx];
    if (!row) return;
    rowEls.forEach((el, i) => (el.tabIndex = i === idx ? 0 : -1));
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  };

  // 选区
  const selInfo = document.getElementById("sel-info")!;
  const mcMsg = document.getElementById("mc-msg")!;
  const refreshSel = (): void => {
    const has = sel.i !== null && sel.j !== null;
    rowEls.forEach((el, idx) => {
      el.classList.toggle("in-sel", has && idx >= sel.i! && idx <= sel.j!);
      el.setAttribute("aria-selected", String(has && idx >= sel.i! && idx <= sel.j!));
      const iBtn = el.querySelector<HTMLElement>('[data-act="i"]');
      const jBtn = el.querySelector<HTMLElement>('[data-act="j"]');
      iBtn?.classList.toggle("on", sel.i === idx);
      jBtn?.classList.toggle("on", sel.j === idx);
    });
    if (!has || !sentList[sel.i!] || !sentList[sel.j!]) {
      selInfo.textContent = sentList.length ? "未选区间——点行尾「起」「止」，或按 [ / ]" : "还没有句流";
      return;
    }
    const a = sentList[sel.i!]!;
    const b = sentList[sel.j!]!;
    selInfo.innerHTML = `已选 <b>${tc(a.start)} – ${tc(b.end)}</b>（${sel.j! - sel.i! + 1} 句 · ${(b.end - a.start).toFixed(1)} 秒）`;
  };

  const setMark = (which: "i" | "j", idx: number): void => {
    if (which === "i") {
      sel.i = idx;
      if (sel.j === null || sel.j < idx) sel.j = idx;
    } else {
      sel.j = idx;
      if (sel.i === null || sel.i > idx) sel.i = idx;
    }
    refreshSel();
  };

  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("#job-sents .pick-btns .minibtn"))) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      setMark((btn.dataset.act as "i" | "j") ?? "i", idx);
    });
  }

  rowEls.forEach((row, idx) => {
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      focusRow(idx);
      jumpTo(idx, true);
    });
    row.addEventListener("focus", () => jumpTo(idx, false));
  });

  listEl.addEventListener("keydown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".sent");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(rowEls.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)));
      focusRow(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      jumpTo(idx, true);
    } else if (e.key === "[") {
      e.preventDefault();
      setMark("i", idx);
    } else if (e.key === "]") {
      e.preventDefault();
      setMark("j", idx);
    }
  });

  document.getElementById("pv-prev")!.addEventListener("click", () => {
    const t = player.currentTime;
    let i = sentList.findIndex((s) => s.start <= t + 0.05 && t < s.end);
    if (i < 0) i = sentList.findIndex((s) => s.start > t);
    const target = Math.max(0, (i < 0 ? sentList.length : i) - 1);
    jumpTo(target, true);
    focusRow(target);
  });
  document.getElementById("pv-next")!.addEventListener("click", () => {
    const t = player.currentTime;
    let i = sentList.findIndex((s) => s.start <= t + 0.05 && t < s.end);
    if (i < 0) i = sentList.findIndex((s) => s.start > t);
    const target = i < 0 ? sentList.length - 1 : Math.min(sentList.length - 1, i + 1);
    jumpTo(target, true);
    focusRow(target);
  });

  refreshSel();

  const mcGo = document.getElementById("mc-go") as HTMLButtonElement;
  mcGo.addEventListener("click", async () => {
    if (!sentences || sel.i === null || sel.j === null) {
      setMsg(mcMsg, "先在句流里选「起」「止」", "err");
      return;
    }
    const start = sentList[sel.i]!.start;
    const end = sentList[sel.j]!.end;
    await withBusy(mcGo, async () => {
      setMsg(mcMsg, "创建中…", "busy");
      try {
        const { id: clipId } = await post<{ id: string }>("/api/clips", {
          job_id: id,
          title: (document.getElementById("mc-title") as HTMLInputElement).value.trim(),
          start,
          end,
        });
        location.hash = `#/clip/${encodeURIComponent(clipId)}`;
      } catch (e) {
        setMsg(mcMsg, e instanceof Error ? e.message : String(e), "err");
      }
    });
  });
}
