// 片段工作空间（b5：每步独立工作空间）：s02 人声分离 / s03 逐句删留 / s04 配乐 / s05 成片 + 分叉树。
//
// 四个面板**一次性都渲染进 DOM**、用 hidden 切显隐，而不是「切 tab 才拉数据」：
// 本地服务端，四个请求的代价远小于「切一下卡一下」；也避免了每个 tab 各写一套加载态。
import { CUT_GAP, filmRanges, filmSeconds } from "../shared/cut.ts";
import type { AutomationView, S03View, StepState, Survey, VariantsView } from "../shared/types.ts";
import { s04Panel } from "./bgm.ts";
import { icon } from "./icons.ts";
import { STATE_TEXT, api, app, esc, notFound, renderTodo, setMsg, tc, topbar, withBusy } from "./lib.ts";
import { automationRow, canRun, depHint, runWithConfirm, treeHtml, wireAutomation, wireTree } from "./panel.ts";
import { mountPlayback } from "./playback.ts";
import { drawWave } from "./wave.ts";

const TABS = [
  { id: "s02", title: "人声分离" },
  { id: "s03", title: "逐句删留" },
  { id: "s04", title: "配乐" },
  { id: "s05", title: "成片" },
  { id: "tree", title: "分叉树" },
];

const mediaUrl = (clipId: string, step: string, name: string): string =>
  `/api/media/clip/${encodeURIComponent(clipId)}/${step}/${encodeURIComponent(name)}`;

export async function viewClip(id: string, tab: string, rerender: () => void): Promise<void> {
  const owner = `clips/${id}`;
  const [survey, tree, auto] = await Promise.all([
    api<Survey>("/api/survey"),
    api<VariantsView>(`/api/variants/${owner}`),
    api<AutomationView>(`/api/automation/${owner}`),
  ]);
  const clip = survey.clips.find((c) => c.id === id);
  if (!clip) return notFound(`片段不存在：${id}`);
  const byId = new Map(clip.steps.map((s) => [s.step, s]));
  const cur = TABS.some((t) => t.id === tab) ? tab : "s03";
  const linkFor = (s: string): string => `#/clip/${encodeURIComponent(id)}/${s}`;

  const s02 = byId.get("s02")!;
  const s03 = byId.get("s03")!;
  const s04 = byId.get("s04")!;
  const s05 = byId.get("s05")!;

  // s02 产物试听：只对**确实存在**的文件渲染（present 与媒体出口白名单同源）
  const s02Audio = ["vocals.wav", "no_vocals.wav"]
    .filter((n) => s02.present.includes(n))
    .map((n) => `<div class="audio-row"><span class="k">${n === "vocals.wav" ? "人声" : "伴奏"}</span>
      <audio controls preload="none" src="${mediaUrl(id, "s02", n)}"></audio></div>`)
    .join("");

  const s05Out = (name: string, label: string): string =>
    s05.present.includes(name) ? `<a class="btn" href="${mediaUrl(id, "s05", name)}" download>${icon("save", 12)} ${label}</a>` : "";

  app.innerHTML = `
    ${topbar(`<a class="iconbtn link" href="#/job/${encodeURIComponent(clip.job_id)}">${icon("back", 12)} 任务页</a><a class="iconbtn link" href="#/">${icon("film", 12)} 总览</a>`)}
    ${renderTodo(survey)}
    <div class="main ws">
      <div class="card">
        <div class="card-head">${icon("film")} ${esc(clip.title)} <span class="num">${esc(id)}</span>
          <span class="sub num">${tc(clip.start)} – ${tc(clip.end)}</span></div>
        <div class="tabs">${TABS.map((t) => {
          const st = byId.get(t.id);
          return `<button class="tab${t.id === cur ? " on" : ""}" data-tab="${t.id}" title="${esc(st ? `${t.title}：${STATE_TEXT[st.status]}` : t.title)}">
            ${st ? `<span class="dot ${st.status}"></span>` : ""}${esc(t.title)}${st ? `<span class="tab-id">${esc(t.id)}</span>` : ""}</button>`;
        }).join("")}</div>
      </div>

      <div class="panel" id="panel-s02"${cur === "s02" ? "" : " hidden"}>
        <div class="card ws-card">
          <div class="ws-head">${icon("wave")} 人声分离 ${automationRow(auto, "s02")}</div>
          <div class="actions">
            <button class="btn" id="run-s02"${canRun(s02, byId) ? "" : " disabled"}>${icon("refresh", 12)} ${s02.status === "empty" ? "跑一次" : "重跑"}</button>
            <span class="msg" id="s02-status"></span>
          </div>
          ${depHint(s02, byId, linkFor)}
          <div class="hint block">demucs htdemucs 分离；权重随包预置在数据根，运行时不联网。</div>
        </div>
        <div class="section-title">产物试听</div>
        <div class="card">${s02Audio || `<div class="empty-hint">还没有产物——先跑一次</div>`}</div>
      </div>

      <div class="panel" id="panel-s03"${cur === "s03" ? "" : " hidden"}>
        <div class="card ws-card">
          <div class="ws-head">${icon("cut")} 逐句删留 ${automationRow(auto, "s03")}</div>
          <div class="actions">
            <button class="btn" id="run-build"${canRun(s03, byId) ? "" : " disabled"}>${icon("refresh", 12)} 重建句流</button>
            <button class="btn" id="run-draft"${canRun(s03, byId) ? "" : " disabled"}>${icon("spark", 12)} AI 出初稿</button>
            <span class="msg" id="llm-reason"></span>
            <span class="msg" id="run-status"></span>
          </div>
          ${depHint(s03, byId, linkFor)}
          <div class="hint block">人工改判写覆盖层（b29）——重跑构建或重抽 AI 都不会丢。</div>
        </div>
        <div class="card player-card">
          <video class="player" id="player" controls preload="metadata" src="/api/media/job/${encodeURIComponent(clip.job_id)}/video"></video>
        </div>
        <div class="preview-bar">
          <label><input type="checkbox" id="preview-cut" checked /> 成片预览</label>
          <span class="hint" id="preview-len"></span>
        </div>
        <div class="section-title" id="s03-wave-title"></div>
        <div class="card wave-card" id="s03-wave-box" hidden><canvas id="s03-wave" height="120"></canvas></div>
        <div class="section-title" id="s03-info"></div>
        <div class="card sents" id="s03-sents" role="listbox" aria-label="句流"></div>
      </div>

      <div class="panel" id="panel-s04"${cur === "s04" ? "" : " hidden"}></div>

      <div class="panel" id="panel-s05"${cur === "s05" ? "" : " hidden"}>
        <div class="card ws-card">
          <div class="ws-head">${icon("film")} 成片 ${automationRow(auto, "s05")}</div>
          <div class="actions">
            <button class="btn" id="run-s05"${canRun(s05, byId) ? "" : " disabled"}>${icon("refresh", 12)} ${s05.status === "empty" ? "出片" : "重出"}</button>
            <span class="msg" id="s05-status"></span>
          </div>
          ${depHint(s05, byId, linkFor)}
          <div class="hint block">成片与素材包**两个出口并列**（b24）——只出一个不算完成。</div>
        </div>
        <div class="section-title">成片</div>
        <div class="card">
          ${s05.present.includes("final.mp4")
            ? `<video class="player" controls preload="metadata" src="${mediaUrl(id, "s05", "final.mp4")}"></video>`
            : `<div class="empty-hint">还没有成片</div>`}
          <div class="actions">${s05Out("final.mp4", "下载成片")}${s05Out("package.zip", "下载素材包")}${s05Out("clip.srt", "下载字幕")}${s05Out("kept.json", "下载保留清单")}</div>
        </div>
      </div>

      <div class="panel" id="panel-tree"${cur === "tree" ? "" : " hidden"}>
        <div class="section-title">分叉树（主干 + 侧枝，切回不重跑 AI）</div>
        <div class="card tree" id="tree">${treeHtml(tree)}</div>
      </div>
    </div>`;

  // tab 切换：改哈希（保持可分享/可后退），由路由重画
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs .tab"))) {
    b.addEventListener("click", () => {
      location.hash = `#/clip/${encodeURIComponent(id)}/${b.dataset.tab}`;
    });
  }

  await wireTree(owner, rerender);

  // ---- s02 ----
  document.getElementById("run-s02")!.addEventListener("click", async () => {
    if (await runWithConfirm(document.getElementById("s02-status")!, owner, "s02", null)) rerender();
  });

  // ---- s04（单独模块：曲库试听 + 人工换曲） ----
  // ⚠️ 必须排在 wireAutomation **之前**：s04 面板的 DOM 是这里才注入的，
  // 先接线的话 s04 那个档位开关会是一个没绑事件的死按钮（点了没反应，看起来像保存失败）。
  await s04Panel(id, owner, s04, byId, auto, linkFor, rerender);
  await wireAutomation(owner, rerender);

  // ---- s05 ----
  document.getElementById("run-s05")!.addEventListener("click", async () => {
    if (await runWithConfirm(document.getElementById("s05-status")!, owner, "s05", null)) rerender();
  });

  // ---- s03：句流 + 播放器联动 + 覆盖层 + 波形 ----
  await wireS03(id, owner, s03, byId, linkFor, rerender, clip);
}

async function wireS03(
  id: string,
  owner: string,
  s03: StepState,
  byId: Map<string, StepState>,
  linkFor: (s: string) => string,
  rerender: () => void,
  clip: { start: number; end: number },
): Promise<void> {
  const llm = await api<{ ok: boolean; model?: string; reason?: string }>("/api/llm");
  let view: S03View | null = await api<S03View>(`/api/clips/${encodeURIComponent(id)}/s03`).catch(() => null);
  const draftBtn = document.getElementById("run-draft") as HTMLButtonElement;
  if (!llm.ok) {
    draftBtn.disabled = true;
    document.getElementById("llm-reason")!.innerHTML =
      `${esc(llm.reason ?? "")} <a class="link" href="#/settings">去设置</a>`;
  } else {
    draftBtn.insertAdjacentHTML("beforeend", `<span class="hint">（${esc(llm.model ?? "")}）</span>`);
  }

  const player = document.getElementById("player") as HTMLVideoElement;
  const listEl = document.getElementById("s03-sents")!;
  const infoEl = document.getElementById("s03-info")!;
  const statusEl = document.getElementById("run-status")!;
  let rowEls: HTMLElement[] = [];
  let previewOn = true;
  let paintWave: (() => Promise<void>) | null = null;

  const rangesNow = (): [number, number][] => (view ? filmRanges(view.sentences, clip) : []);

  // 播放联动与任务页共用同一份实现（playback.ts）：跟随高亮、跳段、防抖 seek 都在那里
  const pb = mountPlayback({
    player,
    sentences: () => view?.sentences ?? [],
    rows: () => rowEls,
    bounds: () => clip,
    list: () => listEl,
    preview: () => previewOn,
  });

  const paintPreview = (): void => {
    const el = document.getElementById("preview-len");
    if (!el) return;
    if (!view) {
      el.textContent = "句流还没构建";
      return;
    }
    const rs = rangesNow();
    const sec = filmSeconds(rs);
    el.textContent = rs.length
      ? `约 ${sec.toFixed(1)} 秒，${rs.length} 段。播放时跳过已删的句子；间隔小于 ${CUT_GAP} 秒的保留句会连着播，和出片同一规则。`
      : "没有保留句，播放会停住";
  };

  const refreshMarks = async (): Promise<void> => {
    try {
      const survey = await api<Survey>("/api/survey");
      const clipNow = survey.clips.find((c) => c.id === id);
      // 状态点挂在 tab 上（tab 即导航，不再单独占一行重复列同一批步名）
      for (const b of Array.from(document.querySelectorAll<HTMLElement>(".tabs .tab"))) {
        const st = clipNow?.steps.find((s) => s.step === b.dataset.tab);
        const dot = b.querySelector<HTMLElement>(".dot");
        if (st && dot) dot.className = `dot ${st.status}`;
      }
      const todo = document.querySelector(".todo");
      if (todo) todo.outerHTML = renderTodo(survey, { kind: "clip", id });
    } catch (err) {
      setMsg(statusEl, err instanceof Error ? err.message : String(err), "err");
    }
  };

  const renderList = (): void => {
    paintPreview();
    if (!view) {
      infoEl.textContent = "句流（未构建）";
      listEl.innerHTML = `<div class="empty-hint">句流未构建——点上方「重建句流」</div>`;
      return;
    }
    const kept = view.sentences.filter((s) => s.keep).length;
    infoEl.textContent = `句流（留 ${kept} / 共 ${view.sentences.length} 句${view.ai ? `，AI 初稿 ${view.ai.model}` : ""}${view.orphans.length ? `，${view.orphans.length} 条决策已对不上句子` : ""}）`;
    listEl.innerHTML = view.sentences
      .map((s, idx) => `<div class="sent${s.keep ? "" : " drop"}" role="option" tabindex="${idx === 0 ? 0 : -1}" aria-selected="${s.keep}" data-idx="${idx}">
        <span class="tc num">${tc(s.start)}<br/>${tc(s.end)}</span>
        <span class="body"><span class="txt">${esc(s.text)}</span>
          ${s.reason ? `<span class="reason-line">${esc(s.reason)}</span>` : ""}</span>
        <span class="side">
          ${s.source === "human" ? `<span class="badge human">人</span>` : s.source === "ai" ? `<span class="badge">AI</span>` : ""}
          <button class="minibtn toggle" type="button" tabindex="-1" data-idx="${idx}" aria-pressed="${s.keep}" title="${s.keep ? "当前保留，点击改为删" : "当前已删，点击恢复保留"}">${s.keep ? "留" : "删"}</button>
        </span>
      </div>`)
      .join("");
    rowEls = Array.from(listEl.querySelectorAll<HTMLElement>(".sent"));
    pb.reset();

    const seekRow = (idx: number, pauseIfDropped: boolean): void => {
      const s = view!.sentences[idx];
      if (!s) return;
      pb.seekTo(s.start + 0.02); // 点句跳转（b9）
      // 点开已删的句子是为了看这一帧。成片预览开着时先停住，再按播放会跳到下一段保留。
      if (pauseIfDropped && previewOn && !s.keep) player.pause();
    };

    // roving tabindex：整张表只占一个 Tab 位，↑↓ 在句间移动，Space 切留删
    const focusRow = (idx: number): void => {
      const row = rowEls[idx];
      if (!row) return;
      rowEls.forEach((el, i) => (el.tabIndex = i === idx ? 0 : -1));
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest" });
    };

    for (const row of rowEls) {
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        const idx = Number(row.dataset.idx);
        focusRow(idx);
        seekRow(idx, true);
      });
      row.addEventListener("keydown", (e) => {
        const idx = Number(row.dataset.idx);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = Math.max(0, Math.min(rowEls.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)));
          focusRow(next);
          seekRow(next, false);
        } else if (e.key === " ") {
          e.preventDefault();
          listEl.querySelector<HTMLButtonElement>(`.toggle[data-idx="${idx}"]`)?.click();
        } else if (e.key === "Enter") {
          e.preventDefault();
          seekRow(idx, true);
        }
      });
    }

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
          await paintWave?.();
          // 覆盖层一落盘，s05 的指纹就变了。步骤条和待办是进页时画的，这里再拉一次总览，标脏立刻出现。
          await refreshMarks();
          pb.follow();
        } catch (err) {
          btn.disabled = false;
          setMsg(statusEl, err instanceof Error ? err.message : String(err), "err");
        }
      });
    });
  };

  player.addEventListener("error", () => {
    setMsg(statusEl, "源视频取不到——文件可能被移动或改名", "err");
  });
  document.getElementById("preview-cut")!.addEventListener("change", () => {
    previewOn = (document.getElementById("preview-cut") as HTMLInputElement).checked;
    if (previewOn) pb.follow();
  });

  const buildBtn = document.getElementById("run-build") as HTMLButtonElement;
  buildBtn.addEventListener("click", async () => {
    await withBusy(buildBtn, async () => {
      if (await runWithConfirm(statusEl, owner, "s03", null)) {
        view = await api<S03View>(`/api/clips/${encodeURIComponent(id)}/s03`).catch(() => null);
        renderList();
        rerender();
      }
    });
  });
  draftBtn.addEventListener("click", async () => {
    await withBusy(draftBtn, async () => {
      if (await runWithConfirm(statusEl, owner, "s03", "draft")) {
        view = await api<S03View>(`/api/clips/${encodeURIComponent(id)}/s03`).catch(() => null);
        renderList();
        rerender();
      }
    });
  });

  renderList();

  // 波形气口：数据来自 s02 的 vocals.wav（惰性依赖）。没有就不画，**不禁用 s03**。
  //
  // ⚠️ 两个时间基准必须换算：s02 切的是**片段音轨**（0 = clip.start），
  // 而句子的 start/end 是**视频绝对秒**。不换算的话波形与句子边界整体错位 clip.start 秒，
  // 而错位后的波形看起来照样「像那么回事」——这种错最难发现。
  const waveBox = document.getElementById("s03-wave-box")!;
  const waveTitle = document.getElementById("s03-wave-title")!;
  if (byId.get("s02")!.present.includes("vocals.wav")) {
    waveBox.hidden = false;
    waveTitle.textContent = "波形气口（灰 = 成片里会被删掉，点一下跳播放器）";
    const waveUrl = mediaUrl(id, "s02", "vocals.wav");
    paintWave = async () => {
      await drawWave(document.getElementById("s03-wave") as HTMLCanvasElement, waveUrl, {
        span: { start: 0, end: clip.end - clip.start },
        sentences: (view?.sentences ?? []).map((s) => ({
          start: s.start - clip.start,
          end: s.end - clip.start,
          keep: s.keep,
        })),
        onSeek: (t) => {
          const abs = t + clip.start;
          pb.seekTo(abs);
          const dropped = view?.sentences.some((s) => !s.keep && s.start <= abs && abs < s.end) === true;
          if (previewOn && dropped) player.pause();
        },
      });
    };
    try {
      await paintWave();
    } catch {
      paintWave = null;
      waveBox.hidden = true;
      waveTitle.textContent = "波形气口（读取失败——s02 的人声轨取不到）";
    }
  } else {
    // 不重复写「去跑 s02」：面板顶部的依赖提示已经带了入口，同一屏两个一模一样的链接
    // 会让人以为是两种不同的缺口。这里只回答「为什么这块是空的」。
    waveTitle.textContent = "波形气口";
    waveBox.innerHTML = `<div class="empty-hint">波形来自 s02 的人声轨，本步不依赖它——所以这里先空着</div>`;
    waveBox.hidden = false;
  }
}
