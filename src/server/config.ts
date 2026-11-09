// 应用配置（config.json，gitignored；模板 config.example.json）
// 设计：LLM 走 OpenAI 兼容协议单通路——{base_url}/chat/completions 与 {base_url}/models，
// 无 provider 分支；换提供方只加一个配置档，不动代码。
// 多配置档（profiles[] + default_id）：2026-09-18 用户拍板（原「不做多配置切换」的决议作废）。
// 密钥纪律：api_key 明文只在数据根 config.json 与调用它的子进程内存；对外只给 key_hint。
import path from "node:path";
import type { LlmCall, LlmConfig, LlmProfile, LlmProfileView, LlmSave, LlmView } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";

export type { LlmCall, LlmConfig, LlmProfile };
export type LlmStatus = { ok: true; llm: LlmCall } | { ok: false; reason: string };

const CONFIG_FILE = "config.json";

// 没写过 llm 配置时用这个。Pollinations 的 OpenAI 兼容口，匿名就能出 JSON，
// 不需要用户先去申请 key。设置里另存一档会盖掉它；显式写 profiles:[] 表示关掉。
const FREE_LLM: LlmProfile = {
  id: "free",
  name: "免密钥",
  base_url: "https://text.pollinations.ai/openai",
  api_key: "",
  model: "openai",
};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// 掩码：只露尾 4 位（短 key 全掩）。够区分「存的是哪一把」，不足以还原。
export function keyHint(key: string): string {
  if (!key) return "";
  return key.length <= 8 ? "••••" : `••••${key.slice(-4)}`;
}

function toView(p: LlmProfile): LlmProfileView {
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    model: p.model,
    key_hint: keyHint(p.api_key),
    configured: Boolean(p.base_url && p.model),
  };
}

// 读容错：形状不对一律当「没配」。旧单块格式（{base_url, api_key, model}）升成单档 p1，
// 名字取 host——只读侧升级，写回时自然落成新格式（一次性迁移，不需要单独脚本）。
// default_id 悬空（指向不存在的档）**原样保留**：那是手改文件留下的真实状态，
// 由 llmStatus 据实报出来，不在这里悄悄改成 null。
function normalizeLlm(raw: unknown): LlmConfig {
  if (!raw || typeof raw !== "object") return { profiles: [], default_id: null };
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.profiles)) {
    const profiles: LlmProfile[] = [];
    const seen = new Set<string>();
    for (const item of o.profiles) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = str(r.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const base_url = str(r.base_url);
      profiles.push({
        id,
        name: str(r.name) || hostOf(base_url) || `配置 ${profiles.length + 1}`,
        base_url,
        api_key: str(r.api_key),
        model: str(r.model),
      });
    }
    const default_id = str(o.default_id) || profiles[0]?.id || null;
    return { profiles, default_id };
  }
  const base_url = str(o.base_url);
  const api_key = str(o.api_key);
  const model = str(o.model);
  if (!base_url && !api_key && !model) return { profiles: [], default_id: null };
  const p: LlmProfile = { id: "p1", name: hostOf(base_url) || "默认配置", base_url, api_key, model };
  return { profiles: [p], default_id: "p1" };
}

export async function readLlm(root: string): Promise<LlmConfig> {
  const cfg = await readJson<Record<string, unknown>>(path.join(root, CONFIG_FILE));
  // 文件里没有 llm 这一块 = 还没配过，走免密钥。写了 llm 但 profiles 为空 = 用户关掉了，不要再塞回来。
  if (!cfg || !Object.prototype.hasOwnProperty.call(cfg, "llm")) {
    return { profiles: [{ ...FREE_LLM }], default_id: FREE_LLM.id };
  }
  return normalizeLlm(cfg.llm);
}

function statusOf(cfg: LlmConfig): LlmStatus {
  if (cfg.profiles.length === 0) {
    return { ok: false, reason: "未配置 LLM：在「设置」里添加一个 API 配置" };
  }
  if (!cfg.default_id) return { ok: false, reason: "未指定默认配置：在「设置」里选一个默认档" };
  const p = cfg.profiles.find((x) => x.id === cfg.default_id);
  if (!p) return { ok: false, reason: `默认配置不存在：${cfg.default_id}（在「设置」里重选）` };
  const miss = (["base_url", "model"] as const).filter((k) => !p[k]);
  if (miss.length) return { ok: false, reason: `默认配置「${p.name}」缺 ${miss.join(" / ")}` };
  return { ok: true, llm: { base_url: p.base_url, api_key: p.api_key, model: p.model } };
}

// 调用侧入口（steps/s03.ts 用它）：解析默认档，解析不出来就给原因，不猜。
export async function llmStatus(root: string): Promise<LlmStatus> {
  return statusOf(await readLlm(root));
}

export async function llmView(root: string): Promise<LlmView> {
  const cfg = await readLlm(root);
  const st = statusOf(cfg);
  return {
    profiles: cfg.profiles.map(toView),
    default_id: cfg.default_id,
    ok: st.ok,
    model: st.ok ? st.llm.model : null,
    reason: st.ok ? null : st.reason,
  };
}

function newId(taken: Set<string>): string {
  for (let i = 1; ; i++) if (!taken.has(`p${i}`)) return `p${i}`;
}

export type SaveLlmResult = { ok: true; view: LlmView } | { ok: false; reason: string };

// 全量替换写入。校验在前、落盘在后——任一档不合法就整批拒，不留半更新。
export async function saveLlm(root: string, body: LlmSave): Promise<SaveLlmResult> {
  if (!Array.isArray(body?.profiles)) return { ok: false, reason: "profiles 必须是数组" };
  const cur = await readLlm(root);
  const before = new Map(cur.profiles.map((p) => [p.id, p]));
  const taken = new Set(before.keys());
  const profiles: LlmProfile[] = [];
  for (const [i, raw] of body.profiles.entries()) {
    const base_url = str(raw?.base_url);
    if (base_url && !/^https?:\/\//i.test(base_url)) {
      return { ok: false, reason: `第 ${i + 1} 个配置的地址必须以 http:// 或 https:// 开头：${base_url}` };
    }
    const given = str(raw?.id);
    if (given && profiles.some((p) => p.id === given)) return { ok: false, reason: `配置 id 重复：${given}` };
    const id = given || newId(taken);
    taken.add(id);
    profiles.push({
      id,
      name: str(raw?.name) || hostOf(base_url) || `配置 ${profiles.length + 1}`,
      base_url,
      // 空 = 不改：界面拿不到明文，所以「没填」只能解释成「沿用原来的」
      api_key: str(raw?.api_key) || before.get(id)?.api_key || "",
      model: str(raw?.model),
    });
  }
  const given = str(body.default_id);
  if (given && !profiles.some((p) => p.id === given)) {
    return { ok: false, reason: `默认配置不存在：${given}` };
  }
  // 与读侧同一条规则（有档没指定默认 → 默认第一个）。写侧必须落同一个值：
  // 否则文件里写着 null、运行时却按 profiles[0] 跑——两处说的不是一回事。
  const default_id = given || profiles[0]?.id || null;
  // 保留 llm 以外的顶层字段：人工在 config.json 里写的东西不该被程序抹掉
  const all = (await readJson<Record<string, unknown>>(path.join(root, CONFIG_FILE))) ?? {};
  await writeJsonAtomic(path.join(root, CONFIG_FILE), { ...all, llm: { profiles, default_id } });
  return { ok: true, view: await llmView(root) };
}
