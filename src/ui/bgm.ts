// s04 配乐工作空间：s04 产物 + 人工换曲（覆盖层）+ 曲库试听（b33/b34：全部可列出、可播）。
//
// 界面上的两条纪律：
//   ① 「当前生效」那一行永远显示**合并后**的结果（effectiveBgm），不显示 bgm.json 的原始值——
//      否则人工换过曲之后界面还写着 LLM 挑的那首，人会以为换曲没生效。
//   ② 人工换曲**不改 bgm.json**（b29/b46），所以重跑 s04 不会抹掉你换的曲子；界面上标出来源。
import type { S04View, StepState } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { api, esc, fmtBytes, post, setMsg, withBusy } from "./lib.ts";
import { toast } from "./toast.ts";
import { automationRow, canRun, depHint, runWithConfirm } from "./panel.ts";
import type { AutomationView } from "../shared/types.ts";

export async function s04Panel(
  clipId: string,
  owner: string,
  st: StepState,
  byId: Map<string, StepState>,
  auto: AutomationView,
  linkFor: (s: string) => string,
  rerender: () => void,
): Promise<void> {
  const host = document.getElementById("panel-s04");
  if (!host) return;
  const [v, llm] = await Promise.all([
    api<S04View>(`/api/clips/${encodeURIComponent(clipId)}/s04`),
    api<{ ok: boolean; reason?: string }>("/api/llm"),
  ]);
  const runnable = canRun(st, byId);
  // 依赖没就绪时，这一整块是死路：只有「跑一次」是灰的，其余照旧可点、曲库还占掉半屏，
  // 空状态写着「点上方跑一次」——指向一个点不动的按钮。所以拦断要显式化：
  //   ① 结论进 .blocked-box（depHint 已改），② 空状态不再劝你去点禁用按钮，
  //   ③ 曲库收进折叠区（试听与预选仍可用，b34 不破，但不再冒充本步可用）。
  const blocked = !runnable;
  // 没选风格就得问模型。模型没配时不要让人点出一次失败，选定风格后规则路不需要模型。
  const needsLlm = !v.bgm_mood;
  const canStart = runnable && (!needsLlm || llm.ok);

  const effective = v.track
    ? `<div class="bgm-now">
        <span class="badge ${v.track_source === "human" ? "human" : ""}">${v.track_source === "human" ? "人工换曲" : "s04 产物"}</span>
        <span class="t">${esc(v.track.title)}</span>
        <span class="hint">${v.bgm ? `风格 ${esc(v.bgm.mood)}` : ""}${v.bgm?.source === "llm" ? "（LLM 按内容挑）" : v.bgm?.source === "human" ? "（人工指定 mood）" : ""}</span>
        ${v.pick ? `<button class="minibtn" id="bgm-clear">清除人工换曲</button>` : ""}
      </div>
      ${v.bgm?.reason ? `<div class="hint block">理由：${esc(v.bgm.reason)}</div>` : ""}`
    : blocked
      ? `<div class="empty-hint">还没有配乐产物——上游跑完才会出现。</div>`
      : `<div class="empty-hint">还没有配乐产物——点上方「跑一次」</div>`;

  const groups = v.groups
    .map((g) => {
      // 当前生效曲目所在的那一组**默认展开**：不展开的话用户进来看到一排折叠的分组，
      // 还得先猜「现在用的是哪首、在哪一组」。其余组保持折叠——曲库几十上百首，全展开是刷屏。
      const open = v.track !== null && g.tracks.some((t) => t.id === v.track!.id);
      const rows = g.tracks
        .map((t) => {
          const isNow = v.track?.id === t.id;
          return `<div class="track${isNow ? " now" : ""}">
            <span class="t">${esc(t.title)}</span>
            <span class="b num">${fmtBytes(t.bytes)}</span>
            <button class="minibtn play" data-id="${esc(t.id)}">${icon("play", 10)} 试听</button>
            <button class="minibtn pick" data-id="${esc(t.id)}"${isNow ? " disabled" : ""}>${isNow ? "当前" : "换这首"}</button>
          </div>`;
        })
        .join("");
      return `<details class="lib"${open ? " open" : ""}><summary>${icon("music")} ${esc(g.group)} <span class="count num">${g.tracks.length} 首</span></summary>${rows}</details>`;
    })
    .join("");

  // 曲库两种呈现：能跑 → 标题 + 卡片（当主角）；不能跑 → 折叠成一行（当配角）。
  // 曲目一条不少、照样能试听，只是不再把半屏让给「暂时用不上」的东西。
  const libInner = `<div class="form-card"><audio id="bgm-audio" controls preload="none"></audio></div>
      <div class="tracks">${groups || `<div class="empty-hint">曲库里没有 bgm——回总览页选素材目录，重新入库</div>`}</div>`;
  const libBlock = blocked
    ? `<details class="fold" id="bgm-lib">
        <summary>${icon("music")} 曲库<span class="meta">${v.total} 首 · 展开可试听或预选</span></summary>
        ${libInner}
      </details>`
    : `<div class="section-title">曲库 <span class="meta">${v.total} 首，全部可试听</span></div>
      <div class="card">${libInner}</div>`;

  host.innerHTML = `
    <div class="card ws-card">
      <div class="ws-head">${icon("music")} 配乐 ${automationRow(auto, "s04")}</div>
      <div class="form-card">
        <span class="hint">风格</span>
        <select class="text" id="bgm-mood">
          <option value="">按内容自动挑（需要已配置的 LLM）</option>
          ${v.moods.map((m) => `<option value="${esc(m)}"${v.bgm_mood === m ? " selected" : ""}>${esc(m)}</option>`).join("")}
        </select>
      </div>
      <div class="actions">
        <button class="btn" id="run-s04"${canStart ? "" : " disabled"}>${icon("refresh", 12)} ${st.status === "empty" ? "跑一次" : "重跑"}</button>
        <span class="msg" id="s04-status"></span>
      </div>
      ${depHint(st, byId, linkFor)}
      ${v.missing_pick ? `<div class="warn-box inset">${icon("warn", 12)}你人工选的那首已不在曲库（${esc(v.pick!.track_id)}）——s05 出片会因此报错。重新入库、换一首，或清除人工选择。</div>` : ""}
    </div>
    <div class="section-title">当前生效</div>
    <div class="card">${effective}</div>
    ${libBlock}`;

  const s04Status = document.getElementById("s04-status")!;
  if (needsLlm && !llm.ok) {
    s04Status.classList.add("err");
    s04Status.innerHTML = `${esc(llm.reason ?? "")} <a class="link" href="#/settings">去设置</a>，或先在上面选定风格。`;
  }
  document.getElementById("bgm-mood")!.addEventListener("change", async (ev) => {
    const mood = (ev.target as HTMLSelectElement).value;
    try {
      await post(`/api/clips/${encodeURIComponent(clipId)}/s04/params`, { bgm_mood: mood || null });
    } catch (e) {
      setMsg(s04Status, e instanceof Error ? e.message : String(e), "err");
      return;
    }
    rerender();
  });
  const runS04 = document.getElementById("run-s04") as HTMLButtonElement;
  runS04.addEventListener("click", async () => {
    await withBusy(runS04, async () => {
      if (await runWithConfirm(s04Status, owner, "s04", null)) rerender();
    });
  });
  const audio = document.getElementById("bgm-audio") as HTMLAudioElement;
  for (const b of Array.from(host.querySelectorAll<HTMLButtonElement>(".track .play"))) {
    b.addEventListener("click", () => {
      audio.src = `/api/media/library/${encodeURIComponent(b.dataset.id!)}`;
      void audio.play();
    });
  }
  for (const b of Array.from(host.querySelectorAll<HTMLButtonElement>(".track .pick"))) {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await post(`/api/clips/${encodeURIComponent(clipId)}/s04/pick`, { track_id: b.dataset.id });
      } catch (e) {
        b.disabled = false;
        setMsg(s04Status, e instanceof Error ? e.message : String(e), "err");
        return;
      }
      rerender();
    });
  }
  document.getElementById("bgm-clear")?.addEventListener("click", async () => {
    try {
      await post(`/api/clips/${encodeURIComponent(clipId)}/s04/pick`, { track_id: null });
      toast("已清除人工换曲，回到 s04 产物");
    } catch (e) {
      setMsg(s04Status, e instanceof Error ? e.message : String(e), "err");
      return;
    }
    rerender();
  });
}
