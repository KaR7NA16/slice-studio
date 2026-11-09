// 任务工作空间（b5：每步独立工作空间）——s00 字幕 与 s01 选高光 两个工作空间 + 建片段 + 分叉树。
//
// s01 的两个清单**分列不合并**（b29/b46）：
//   「人工定稿」= candidates.json（契约产物，建片段时写入）
//   「AI 提案」  = ai.json（可选产物，抽卡多版）
// 界面上把 AI 提案标成「未采纳」，采纳动作 = 用这条候选去建片段——而不是把 AI 提案并进人工清单。
import type { AutomationView, CandidatesFile, S01AiFile, SentencesFile, Survey, VariantsView } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { api, app, bindJobActions, esc, jobLabel, jobTools, notFound, post, renderTodo, sentenceHint, stepChips, tc, topbar } from "./lib.ts";
import { automationRow, canRun, depHint, runWithConfirm, treeHtml, wireAutomation, wireTree } from "./panel.ts";

// 建片段的区间选择（模块级：切视图后回来还在）
const selection = new Map<string, { i: number | null; j: number | null }>();

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
  const sel = selection.get(id) ?? { i: null, j: null };
  selection.set(id, sel);
  const tree = await api<VariantsView>(`/api/variants/${owner}`);
  const auto = await api<AutomationView>(`/api/automation/${owner}`);
  const linkFor = (s: string): string => `#/job/${encodeURIComponent(id)}/${s}`;

  const sentRows = sentences
    ? sentences.sentences
        .map((s, idx) => `<div class="sent pick" data-idx="${idx}">
          <span class="tc num">${tc(s.start)}–${tc(s.end)}</span>
          <span class="txt">${esc(s.text)}</span>
          <span class="pick-btns"><button class="minibtn" data-act="i" data-idx="${idx}">起</button><button class="minibtn" data-act="j" data-idx="${idx}">止</button></span>
        </div>`)
        .join("")
    : "";

  // AI 提案（未采纳）。采纳 = 用这条候选建片段（走与人工建片段同一条 API）。
  const aiRows = s01.ai
    ? s01.ai.candidates
        .map((c) => `<div class="cand">
          <span class="cand-head"><span class="t">${esc(c.title)}</span>
            <span class="tc num">${tc(c.start)}–${tc(c.end)}</span>
            <span class="badge">AI</span></span>
          ${c.reason ? `<span class="reason-line">${esc(c.reason)}</span>` : ""}
          <button class="minibtn adopt" data-title="${esc(c.title)}" data-start="${c.start}" data-end="${c.end}">采纳并建片段</button>
        </div>`)
        .join("")
    : "";

  const candRows = (s01.candidates?.clips ?? [])
    .map((c) => `<a class="clip-row link" href="#/clip/${encodeURIComponent(c.clip_id)}">
      ${icon("check", 11)} <span class="t">${esc(c.title)}</span> <span class="num">${esc(c.clip_id)}</span>
      <span class="hint num">${tc(c.start)}–${tc(c.end)}</span></a>`)
    .join("");

  app.innerHTML = `
    ${topbar(`<a class="iconbtn link" href="#/">${icon("back", 12)} 总览</a><a class="iconbtn link" href="#/settings">${icon("sliders", 12)} 设置</a>`)}
    ${renderTodo(survey)}
    <div class="main">
      <div class="card">
        <div class="card-head">${icon("film")} <span class="job-name">${esc(jobLabel(job.title, job.video_path))}</span> <span class="num">${esc(job.id)}</span> <span class="sub">${esc(job.video_path)}</span>${job.archived ? `<span class="badge">已归档</span>` : ""}${jobTools(job)}</div>
        <div class="steps-line">${stepChips(job.steps)}</div>
      </div>

      <div class="section-title">s00 字幕工作空间</div>
      <div class="card ws-card" id="step-s00">
        <div class="ws-head">${icon("doc")} 字幕 ${automationRow(auto, "s00")}</div>
        <div class="actions">
          <button class="btn" id="run-s00"${canRun(s00, byId) ? "" : " disabled"}>${icon("doc", 12)} ${s00.status === "empty" ? "导入字幕" : "重跑字幕"}</button>
          <span class="hint" id="run-status"></span>
        </div>
        ${depHint(s00, byId, linkFor)}
        <div class="hint block">有 .srt 就直接解析；没有则走本地转写（b2/b14/b41/b42：SRT 优先、ASR 兜底）。</div>
      </div>
      <div class="card sents" id="job-sents">${sentences ? sentRows : `<div class="empty-hint">${esc(sentenceHint(s00))}</div>`}</div>
      <div class="card form-card" id="mk-clip">
        <span class="hint" id="sel-info">未选区间</span>
        <input class="text" id="mc-title" placeholder="片段标题（可空）" />
        <button class="btn primary" id="mc-go">${icon("cut", 12)} 建片段（人工定稿）</button>
        <span class="hint" id="mc-msg"></span>
      </div>

      <div class="section-title">s01 选高光工作空间</div>
      <div class="card ws-card" id="step-s01">
        <div class="ws-head">${icon("spark")} AI 抽卡（每次抽卡另存一版，可切回） ${automationRow(auto, "s01")}</div>
        <div class="actions">
          <button class="btn" id="run-s01"${canRun(s01st, byId) && llm.ok ? "" : " disabled"}>${icon("spark", 12)} ${s01.ai ? "再抽一版" : "AI 挑高光"}</button>
          <span class="hint" id="s01-status"></span>
        </div>
        ${depHint(s01st, byId, linkFor)}
      </div>
      <div class="section-title">AI 提案${s01.ai ? `（${s01.ai.model} · ${esc(s01.ai.at.slice(0, 19).replace("T", " "))}）` : ""}——未采纳</div>
      <div class="card">${aiRows || `<div class="empty-hint">还没有 AI 提案——点上方「AI 挑高光」</div>`}</div>
      <div class="section-title">人工定稿（candidates.json，共 ${s01.candidates?.clips.length ?? 0} 条）</div>
      <div class="card">${candRows || `<div class="empty-hint">还没有定稿片段——在句流里选区间建一个，或采纳上面的 AI 提案</div>`}</div>

      <div class="section-title">分叉树（主干 + 侧枝，可回退）</div>
      <div class="card tree" id="tree">${treeHtml(tree)}</div>

      <div class="section-title">片段（${clips.length}）</div>
      <div class="card">
        ${clips.length ? clips.map((c) => `<a class="clip-row link" href="#/clip/${encodeURIComponent(c.id)}">
            ${icon("cut", 11)} <span class="t">${esc(c.title)}</span> <span class="num">${esc(c.id)}</span>
            <span class="steps-inline">${stepChips(c.steps)}</span></a>`).join("")
          : `<div class="empty-hint">还没有片段</div>`}
      </div>
    </div>`;

  await wireAutomation(owner, rerender);
  await wireTree(owner, rerender);

  const statusEl = document.getElementById("run-status")!;
  document.getElementById("run-s00")!.addEventListener("click", async () => {
    await runWithConfirm(statusEl, owner, "s00", null);
    rerender();
  });
  const s01Status = document.getElementById("s01-status")!;
  if (!llm.ok) {
    s01Status.innerHTML = `${esc(llm.reason ?? "")} <a class="link" href="#/settings">去设置</a>`;
  }
  document.getElementById("run-s01")!.addEventListener("click", async () => {
    if (await runWithConfirm(s01Status, owner, "s01", null)) rerender();
  });

  // 采纳一条 AI 候选 = 建片段（与人工建片段同一条路，b1 的「人工定稿」没有被绕过）
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".cand .adopt"))) {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const { id: clipId } = await post<{ id: string }>("/api/clips", {
          job_id: id,
          title: b.dataset.title ?? "",
          start: Number(b.dataset.start),
          end: Number(b.dataset.end),
        });
        location.hash = `#/clip/${encodeURIComponent(clipId)}`;
      } catch (e) {
        b.disabled = false;
        s01Status.textContent = e instanceof Error ? e.message : String(e);
      }
    });
  }

  // ---- 建片段：句流里选起止 ----
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

  bindJobActions(rerender);

  document.getElementById("mc-go")!.addEventListener("click", async () => {
    const msg = document.getElementById("mc-msg")!;
    if (!sentences || sel.i === null || sel.j === null) {
      msg.textContent = "先在句流里选「起」「止」";
      return;
    }
    msg.textContent = "创建中…";
    try {
      const { id: clipId } = await post<{ id: string }>("/api/clips", {
        job_id: id,
        title: (document.getElementById("mc-title") as HTMLInputElement).value.trim(),
        start: sentences.sentences[sel.i]!.start,
        end: sentences.sentences[sel.j]!.end,
      });
      location.hash = `#/clip/${encodeURIComponent(clipId)}`;
    } catch (e) {
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  });
}
