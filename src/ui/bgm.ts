// s04 配乐工作空间：s04 产物 + 人工换曲（覆盖层）+ 曲库试听（b33/b34：全部可列出、可播）。
//
// 界面上的两条纪律：
//   ① 「当前生效」那一行永远显示**合并后**的结果（effectiveBgm），不显示 bgm.json 的原始值——
//      否则人工换过曲之后界面还写着 LLM 挑的那首，人会以为换曲没生效。
//   ② 人工换曲**不改 bgm.json**（b29/b46），所以重跑 s04 不会抹掉你换的曲子；界面上标出来源。
import type { S04View, StepState } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { api, esc, fmtBytes, post } from "./lib.ts";
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

  host.innerHTML = `
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
      <span class="hint" id="s04-status"></span>
    </div>
    ${depHint(st, byId, linkFor)}
    ${v.missing_pick ? `<div class="warn-box">${icon("warn", 12)}你人工选的那首已不在曲库（${esc(v.pick!.track_id)}）——s05 出片会因此报错。重新入库、换一首，或清除人工选择。</div>` : ""}
    <div class="section-title">当前生效</div>
    ${effective}
    <div class="section-title">曲库（${v.total} 首，全部可试听）</div>
    <audio id="bgm-audio" controls preload="none" style="width:100%"></audio>
    <div class="tracks">${groups || `<div class="empty-hint">曲库里没有 bgm——回总览页填素材目录，重新入库</div>`}</div>`;

  if (needsLlm && !llm.ok) {
    document.getElementById("s04-status")!.innerHTML =
      `${esc(llm.reason ?? "")} <a class="link" href="#/settings">去设置</a>，或先在上面选定风格。`;
  }
  document.getElementById("bgm-mood")!.addEventListener("change", async (ev) => {
    const mood = (ev.target as HTMLSelectElement).value;
    try {
      await post(`/api/clips/${encodeURIComponent(clipId)}/s04/params`, { bgm_mood: mood || null });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
    rerender();
  });
  document.getElementById("run-s04")!.addEventListener("click", async () => {
    if (await runWithConfirm(document.getElementById("s04-status")!, owner, "s04", null)) rerender();
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
        alert(e instanceof Error ? e.message : String(e));
        return;
      }
      rerender();
    });
  }
  document.getElementById("bgm-clear")?.addEventListener("click", async () => {
    try {
      await post(`/api/clips/${encodeURIComponent(clipId)}/s04/pick`, { track_id: null });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      return;
    }
    rerender();
  });
}
