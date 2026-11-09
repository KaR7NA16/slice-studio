// 设置页（#/settings）：LLM 配置档 + 全局自动化档位（b3/b4 的「全局默认」）。
//
// LLM 草稿全量留在内存、保存时一次 PUT（服务端全量替换）——切档 / 新建 / 删除都不会丢已输入的内容。
// api_key 输入框只显示**草稿里还没保存的**那把 key：已存的 key 永不下发到浏览器，占位符显示掩码。
// 于是「看到掩码 → 保存」不会把 key 写成掩码——服务端把空串解释成「沿用原密钥」。
// 但草稿值必须回填进输入框：否则「填了 key → 点设为默认（触发重画）→ 保存」会读回空串，
// 静默丢掉刚填的 key。这个坑是界面冒烟测出来的，回填是修法。
// 要清掉某档已存的密钥就删掉该档（空串一律解释成「不改」，没有「清空但保留」这种半状态）。
import { STEPS } from "../shared/steps.ts";
import type { AutomationSettings, LlmSave, LlmView } from "../shared/types.ts";
import { icon } from "./icons.ts";
import { api, app, esc, setMsg, topbar } from "./lib.ts";
import { confirmModal, dangerBody } from "./modal.ts";
import { toast } from "./toast.ts";

type Draft = { id: string; name: string; base_url: string; api_key: string; model: string };

let drafts: Draft[] | null = null; // null = 还没从服务端读过
let defaultId: string | null = null;
let cur = 0;
let hints = new Map<string, string>(); // id → key_hint（占位符用）
let modelLists = new Map<string, string[]>(); // id → 拉取到的模型清单（切档重画不丢）
let savedOk = false;
let savedReason = "";

function newDraft(): Draft {
  let id = "";
  do {
    id = `p${Math.random().toString(36).slice(2, 8)}`;
  } while (drafts?.some((d) => d.id === id));
  return { id, name: "", base_url: "", api_key: "", model: "" };
}

async function loadSettings(): Promise<void> {
  const v = await api<LlmView>("/api/llm");
  drafts = v.profiles.map((p) => ({ id: p.id, name: p.name, base_url: p.base_url, api_key: "", model: p.model }));
  hints = new Map(v.profiles.map((p) => [p.id, p.key_hint]));
  defaultId = v.default_id;
  savedOk = v.ok;
  savedReason = v.reason ?? "";
  if (drafts.length === 0) drafts.push(newDraft());
  cur = 0;
}

// 只在结构变化（切档 / 保存 / 拉取）前调用：把输入框里的当前值收回草稿
function syncFromDom(): void {
  const d = drafts?.[cur];
  if (!d || !document.getElementById("st-name")) return;
  d.name = (document.getElementById("st-name") as HTMLInputElement).value.trim();
  d.base_url = (document.getElementById("st-url") as HTMLInputElement).value.trim();
  d.api_key = (document.getElementById("st-key") as HTMLInputElement).value.trim();
  d.model = (document.getElementById("st-model") as HTMLInputElement).value.trim();
}

const draftName = (d: Draft): string => d.name || d.base_url || "（未命名）";

// 全局档位：只列**还没被覆盖**时会用到的默认值。片段页可以逐条覆盖（b4），
// 所以这里改一下立刻作用于所有没覆盖的片段——这正是把全局与覆盖分开存的理由。
function globalAutomationHtml(g: AutomationSettings): string {
  return STEPS.map((s) => {
    const v = g[s.id] ?? "manual";
    const seg = (x: "manual" | "auto", text: string): string =>
      `<button class="seg${v === x ? " on" : ""}" data-gstep="${esc(s.id)}" data-gval="${x}">${text}</button>`;
    return `<div class="grow">
      <span class="k num">${esc(s.id)}</span>
      <span class="t">${esc(s.title)}</span>
      <span class="hint">${s.level === "job" ? "任务级" : "片段级"}</span>
      <span class="seg-group">${seg("manual", "人工")}${seg("auto", "自动")}</span>
      <span class="hint">${v === "auto" ? "上游跑完自动往下走" : "不自动跑（默认）"}</span>
    </div>`;
  }).join("");
}

export async function viewSettings(rerender: () => void): Promise<void> {
  if (drafts === null) await loadSettings();
  const global = (await api<{ global: AutomationSettings }>("/api/automation/global")).global;
  const ds = drafts!;
  if (cur >= ds.length) cur = Math.max(0, ds.length - 1);
  const d = ds[cur]!;
  const hint = hints.get(d.id) ?? "";
  const list = modelLists.get(d.id) ?? [];
  const isDefault = d.id === defaultId;
  const options = ds
    .map((x, i) => `<option value="${i}"${i === cur ? " selected" : ""}>${esc(draftName(x))}${x.id === defaultId ? "（默认）" : ""}</option>`)
    .join("");

  app.innerHTML = `
    ${topbar(`<a class="iconbtn link" href="#/">${icon("back", 12)} 总览</a>`)}
    <div class="main">
      <div class="card">
        <div class="card-head">${icon("sliders")} LLM 配置</div>
        <div class="steps-line">
          <span class="chip" title="${esc(savedReason)}">
            <span class="dot ${savedOk ? "ready" : "empty"}"></span>
            已保存状态：${savedOk ? `默认档可用（模型 ${esc(ds.find((x) => x.id === defaultId)?.model ?? "")}）` : esc(savedReason)}
          </span>
        </div>
        <div class="actions">
          <span class="hint">协议走 OpenAI 兼容（{地址}/chat/completions）；密钥只写在数据根的 config.json 里，只在本机使用。</span>
        </div>
      </div>
      <div class="section-title">配置档（${ds.length}）</div>
      <div class="card form-card">
        <select class="text" id="st-pick">${options}</select>
        <button class="btn" id="st-add">${icon("plus", 12)} 新建</button>
        <button class="btn" id="st-del">删除</button>
        <button class="btn" id="st-default"${isDefault ? " disabled" : ""}>${isDefault ? "已是默认" : "设为默认"}</button>
      </div>
      <div class="section-title">当前档</div>
      <div class="card set-grid">
        <span class="k">名称</span>
        <input class="text" id="st-name" placeholder="如 DeepSeek" value="${esc(d.name)}" />
        <span class="k">API 地址</span>
        <input class="text" id="st-url" placeholder="如 https://api.deepseek.com/v1" value="${esc(d.base_url)}" />
        <span class="k">API Key</span>
        <input class="text" id="st-key" type="password" autocomplete="off" value="${esc(d.api_key)}" placeholder="${hint ? `已存 ${esc(hint)}（留空 = 不改）` : "粘贴完整 key"}" />
        <span class="k">模型</span>
        <input class="text" id="st-model" list="st-models" placeholder="如 deepseek-chat" value="${esc(d.model)}" />
        <datalist id="st-models">${list.map((m) => `<option value="${esc(m)}"></option>`).join("")}</datalist>
      </div>
      <div class="card form-card">
        <button class="btn" id="st-fetch">${icon("down", 12)} 拉取模型列表</button>
        <button class="btn" id="st-test">测试连接</button>
        <button class="btn primary" id="st-save">保存</button>
        <button class="btn" id="st-reload">放弃修改并重载</button>
        <span class="msg" id="st-msg"></span>
      </div>

      <div class="section-title">全局自动化档位（片段可逐条覆盖）</div>
      <div class="card ws-card" id="global-auto">
        <div class="ws-head">${icon("bolt")} 上游跑完是否自动往下走</div>
        ${globalAutomationHtml(global)}
        <div class="hint block">默认「人工」：只有你把某一步设成「自动」，它才会在上游跑完后自己启动。
          自动链**一次只推一步**，且强依赖产物必须齐备——依赖没齐不会硬跑，那只会得到一个假失败。</div>
      </div>
    </div>`;

  const msg = document.getElementById("st-msg")!;
  const pick = document.getElementById("st-pick") as HTMLSelectElement;
  pick.addEventListener("change", () => {
    syncFromDom();
    cur = Number(pick.value);
    void viewSettings(rerender);
  });
  document.getElementById("st-add")!.addEventListener("click", () => {
    syncFromDom();
    ds.push(newDraft());
    cur = ds.length - 1;
    void viewSettings(rerender);
  });
  document.getElementById("st-del")!.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: `删除配置档「${draftName(d)}」？`,
      bodyHtml: dangerBody(["这一档的地址、模型与已保存的密钥会一并删掉。", "如果它是默认档，默认档会落到剩下的第一档。"]),
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    ds.splice(cur, 1);
    if (defaultId === d.id) defaultId = ds[0]?.id ?? null;
    if (ds.length === 0) ds.push(newDraft());
    cur = Math.max(0, Math.min(cur, ds.length - 1));
    void viewSettings(rerender);
  });
  document.getElementById("st-default")!.addEventListener("click", () => {
    syncFromDom();
    defaultId = d.id;
    void viewSettings(rerender);
  });
  document.getElementById("st-reload")!.addEventListener("click", async () => {
    await loadSettings();
    void viewSettings(rerender);
  });
  document.getElementById("st-fetch")!.addEventListener("click", async () => {
    syncFromDom();
    setMsg(msg, "拉取中…", "busy");
    try {
      const r = await api<{ ok: boolean; models?: string[]; reason?: string }>("/api/llm/models", {
        method: "POST",
        body: JSON.stringify({ profile_id: d.id, base_url: d.base_url, api_key: d.api_key }),
      });
      if (!r.ok) {
        setMsg(msg, r.reason ?? "拉取失败", "err");
        return;
      }
      const models = r.models ?? [];
      modelLists.set(d.id, models);
      (document.getElementById("st-models") as HTMLDataListElement).innerHTML = models
        .map((m) => `<option value="${esc(m)}"></option>`)
        .join("");
      setMsg(msg, `拉到 ${models.length} 个模型——点「模型」输入框可选，例如 ${models[0]}`, "ok");
    } catch (e) {
      setMsg(msg, e instanceof Error ? e.message : String(e), "err");
    }
  });
  document.getElementById("st-test")!.addEventListener("click", async () => {
    syncFromDom();
    setMsg(msg, "测试中…", "busy");
    try {
      const r = await api<{ ok: boolean; reason?: string; reply?: string }>("/api/llm/test", {
        method: "POST",
        body: JSON.stringify({ profile_id: d.id, base_url: d.base_url, api_key: d.api_key, model: d.model }),
      });
      setMsg(msg, r.ok ? `连接成功${r.reply ? `：${r.reply}` : ""}` : (r.reason ?? "测试失败"), r.ok ? "ok" : "err");
    } catch (e) {
      setMsg(msg, e instanceof Error ? e.message : String(e), "err");
    }
  });
  document.getElementById("st-save")!.addEventListener("click", async () => {
    syncFromDom();
    const body: LlmSave = { profiles: ds.map((x) => ({ ...x })), default_id: defaultId };
    setMsg(msg, "保存中…", "busy");
    try {
      const v = await api<LlmView>("/api/llm", { method: "PUT", body: JSON.stringify(body) });
      drafts = v.profiles.map((p) => ({ id: p.id, name: p.name, base_url: p.base_url, api_key: "", model: p.model }));
      hints = new Map(v.profiles.map((p) => [p.id, p.key_hint]));
      defaultId = v.default_id;
      savedOk = v.ok;
      savedReason = v.reason ?? "";
      cur = Math.max(0, Math.min(cur, drafts.length - 1));
      if (drafts.length === 0) drafts.push(newDraft());
      await viewSettings(rerender);
      // 重画后 msg 是旧元素，提示写到新的那个上
      setMsg(document.getElementById("st-msg")!, v.ok ? "已保存：默认档可用" : `已保存。${v.reason ?? ""}`, v.ok ? "ok" : "err");
    } catch (e) {
      setMsg(msg, e instanceof Error ? e.message : String(e), "err");
    }
  });

  // 全局档位：点一下写一份完整的全局表（服务端全量替换，避免「改一半」的中间态）
  const next = { ...global };
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#global-auto .seg"))) {
    b.addEventListener("click", async () => {
      const step = b.dataset.gstep!;
      const val = b.dataset.gval as "manual" | "auto";
      // 与默认值一致就删键，不留「显式写成默认」的冗余项
      if (val === "manual") delete next[step];
      else next[step] = val;
      try {
        await api("/api/automation/global", { method: "PUT", body: JSON.stringify({ settings: next }) });
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "err");
      }
      void viewSettings(rerender);
    });
  }
}
