// 步面板的共用件：档位开关（b3/b4）、重跑确认（b39）、分叉树（b7/b8）、依赖未就绪的禁用态（b59）。
//
// 这几件事都长在「每个步面板」上，所以单独成模块——复制到四个视图里必然有一天不一致。
import type { AutomationView, RunPreview, StepState, VariantsView } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { STATE_TEXT, api, esc, post, runAndPoll } from "./lib.ts";

// ---- b59：依赖未就绪 = 禁用 + 原因 + 入口 ----

// 跑这一步之前先看依赖。返回 HTML 提示（空串 = 依赖齐备，可以跑）。
//   **强依赖**没就绪 → 跑了必然失败，所以按钮要禁用，且给出「去跑那一步」的入口；
//   **惰性依赖**（b23）没就绪 → 不阻塞，按钮**不禁用**，但要说清「少了什么、去哪补」——
//   禁用它是错的：s03 在没跑 s02 时照样能构建句流，只是没有波形可看。
// linkFor 由各视图给出（片段页是切换 tab 的哈希，任务页是锚点）。
export function depHint(st: StepState, byId: Map<string, StepState>, linkFor: (step: string) => string): string {
  const rows: string[] = [];
  for (const d of st.deps) {
    const ds = byId.get(d);
    if (ds && (ds.status === "ready" || ds.status === "suspect")) continue;
    rows.push(`<span class="hint block">强依赖「${esc(ds?.title ?? d)}」未就绪（${STATE_TEXT[ds?.status ?? "empty"]}）——
      <a class="link" href="${esc(linkFor(d))}">去跑 ${esc(d)}</a>，否则这一步跑不起来</span>`);
  }
  for (const l of st.lazy ?? []) {
    if (l.available) continue;
    rows.push(`<span class="hint block">${esc(l.title)} 未跑——<a class="link" href="${esc(linkFor(l.step))}">去跑 ${esc(l.step)}</a>
      （不阻塞本步，只是少了它带来的东西）</span>`);
  }
  return rows.join("");
}

// 该步能不能跑：强依赖全部就绪（ready 或 suspect）。
// suspect 也算能跑是刻意的——它只说明「上游变了、影响未定」，产物还在，跑得动。
export function canRun(st: StepState, byId: Map<string, StepState>): boolean {
  return st.deps.every((d) => {
    const ds = byId.get(d);
    return ds ? ds.status === "ready" || ds.status === "suspect" : false;
  });
}

// ---- b3/b4：档位开关 ----

// 档位开关的一行。生效值来自 effective（每步都有值），来源由 global/override 决定：
//   override 里有 → 这个片段自己定的；否则 global 里有 → 跟全局；都没有 → 默认人工。
export function automationRow(av: AutomationView, step: string): string {
  const eff = av.effective[step] ?? "manual";
  const own = step in av.override;
  const fromGlobal = !own && step in av.global;
  const src = own ? "本片段覆盖" : fromGlobal ? "跟全局" : "默认人工";
  const btn = (v: "manual" | "auto", text: string): string =>
    `<button class="seg${eff === v ? " on" : ""}" data-auto="${v}">${text}</button>`;
  return `<span class="auto-slot" data-step="${esc(step)}" title="生效：${eff === "auto" ? "自动" : "人工"}（${src}）">
    <span class="auto-label">${icon("bolt", 11)}档位</span>
    <span class="seg-group">${btn("manual", "人工")}${btn("auto", "自动")}</span>
    <span class="auto-src">${esc(src)}</span>
  </span>`;
}

// 接档位开关：点一下写回。**片段页写覆盖、任务页写全局**——
// job 级没有覆盖层（后端会拒），所以任务页的开关改的就是全局默认，提示语里写清楚。
export async function wireAutomation(owner: string, rerender: () => void): Promise<void> {
  const scope = owner.startsWith("clips/") ? "override" : "global";
  const av = await api<AutomationView>(`/api/automation/${owner}`);
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(".auto-slot"))) {
    const step = el.dataset.step!;
    for (const b of Array.from(el.querySelectorAll<HTMLButtonElement>(".seg"))) {
      b.addEventListener("click", async () => {
        const next = { ...(scope === "override" ? av.override : av.global) };
        const want = b.dataset.auto as "manual" | "auto";
        // 点成「与全局一致」时**删掉覆盖**，而不是写一条同值覆盖——
        // 否则以后改全局这个片段不会跟着变，而界面上两处看起来一模一样。
        if (scope === "override" && av.global[step] === want) delete next[step];
        else next[step] = want;
        try {
          await api(`/api/automation/${owner}`, { method: "PUT", body: JSON.stringify({ settings: next, scope }) });
        } catch (e) {
          alert(e instanceof Error ? e.message : String(e));
        }
        rerender();
      });
    }
  }
}

// ---- b39：重跑确认页（只列将动哪些文件、不估时长） ----

function previewHtml(p: RunPreview): string {
  const writes = p.writes.map((w) => `<li class="num">${esc(w)}</li>`).join("");
  const stale = p.marks_stale.length
    ? p.marks_stale.map((s) => `<li>${esc(s.step)} ${esc(s.title)}</li>`).join("")
    : `<li class="muted">无（下游本来就不干净）</li>`;
  const warn = p.warnings.length
    ? `<div class="warn-box">${p.warnings.map((w) => `<div>${icon("warn", 12)}${esc(w)}</div>`).join("")}</div>`
    : "";
  return `<div class="modal">
    <div class="modal-card">
      <div class="modal-head">重跑 ${esc(p.step)} ${esc(p.title)}</div>
      <div class="modal-body">
        <div class="pv-col"><div class="pv-title">将写入 / 覆盖</div><ul>${writes}</ul></div>
        <div class="pv-col"><div class="pv-title">重跑后会被标脏的下游</div><ul>${stale}</ul></div>
        ${warn}
        <div class="hint">不估时长——这里只列事实。</div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="pv-cancel">取消</button>
        <button class="btn primary" id="pv-go">确认重跑</button>
      </div>
    </div>
  </div>`;
}

// 弹出重跑预览并等用户确认。返回 true = 用户点了确认。
export async function confirmRun(owner: string, step: string, mode: string | null): Promise<boolean> {
  const q = mode ? `?mode=${encodeURIComponent(mode)}` : "";
  let p: RunPreview;
  try {
    p = await api<RunPreview>(`/api/preview/${owner}/${step}${q}`);
  } catch (e) {
    // 预览取不到（如未知步）不该静默放行——把原因摊开，让人自己决定
    return confirm(`取重跑预览失败：${e instanceof Error ? e.message : String(e)}\n仍要直接重跑吗？`);
  }
  return await new Promise<boolean>((resolve) => {
    const host = document.createElement("div");
    host.innerHTML = previewHtml(p);
    document.body.appendChild(host);
    const done = (v: boolean): void => {
      host.remove();
      resolve(v);
    };
    host.querySelector("#pv-cancel")!.addEventListener("click", () => done(false));
    host.querySelector("#pv-go")!.addEventListener("click", () => done(true));
  });
}

// 带确认的重跑入口（所有「跑/重跑」按钮都走它，避免有一处忘了确认）
export async function runWithConfirm(
  statusEl: HTMLElement,
  owner: string,
  step: string,
  mode: string | null,
): Promise<boolean> {
  if (!(await confirmRun(owner, step, mode))) return false;
  return await runAndPoll(statusEl, owner, step, mode);
}

// ---- b7/b8：分叉树（每步的抽卡版本 + 主干/侧枝 + 切回） ----

export function treeHtml(v: VariantsView): string {
  if (v.steps.length === 0) return `<div class="empty-hint">这一步链路里没有 AI 抽卡</div>`;
  return v.steps
    .map((s) => {
      if (s.variants.length === 0) {
        return `<div class="tree-step"><div class="tree-head">${esc(s.step)} ${esc(s.title)}</div>
          <div class="hint">还没有抽过卡</div></div>`;
      }
      const rows = s.variants
        .map((m) => {
          const isMain = s.active === m.id;
          return `<div class="tree-node${isMain ? " main" : ""}">
            <span class="tn-id num">${esc(m.id)}</span>
            <span class="tn-label">${esc(m.label)}</span>
            <span class="tn-meta">${esc(m.model ?? "—")} · ${esc(m.created_at.slice(0, 19).replace("T", " "))}</span>
            ${m.parent ? `<span class="tn-parent num" title="创建时上游生效的变体">← ${esc(m.parent)}</span>` : ""}
            <span class="tn-badge">${isMain ? "主干" : "侧枝"}</span>
            ${isMain ? "" : `<button class="minibtn act" data-step="${esc(s.step)}" data-vid="${esc(m.id)}">切为主干</button>`}
          </div>`;
        })
        .join("");
      return `<div class="tree-step"><div class="tree-head">${esc(s.step)} ${esc(s.title)}
        <span class="hint">主干 ${esc(s.active ?? "—")} · 共 ${s.variants.length} 版</span></div>${rows}</div>`;
    })
    .join("");
}

// 切主干：只改 active_variant + 物化 AI 产物，不重跑 AI（b8 判据是「能切回任一侧枝」）。
export async function wireTree(owner: string, rerender: () => void): Promise<void> {
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".tree-node .act"))) {
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await post(`/api/variants/${owner}/${b.dataset.step}/${b.dataset.vid}/activate`, {});
      } catch (e) {
        b.disabled = false;
        alert(e instanceof Error ? e.message : String(e));
        return;
      }
      rerender();
    });
  }
}
