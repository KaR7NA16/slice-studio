// 自动化档位（b3/b4：每步独立开关；全局默认 + 单条覆盖）。
//
// 存两份是刻意的：
//   config.json 的 `automation`  = 全局默认（按步）
//   work/<clip>/automation.json = 该片段的覆盖（只记被覆盖的步）
// 不写进 clip.json：那份文件是 s03/s05 的输入指纹，档位一改句子步就会被标脏。
// 生效值 = 覆盖 ?? 全局 ?? "manual"（b5/b6「默认人工」是底线，缺省不自动跑）。
// 为什么不做成「一份按 owner 展开的表」：改了全局要立刻作用于所有没覆盖的片段，
// 展开存会把「没覆盖」和「覆盖成和全局一样」变成同一状态，之后改全局就漏掉后者。
import { rm } from "node:fs/promises";
import path from "node:path";
import { STEPS } from "../shared/steps.ts";
import type { AutomationLevel, AutomationSettings, AutomationView, ClipFile } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";

const CONFIG_FILE = "config.json";
const LEVELS: AutomationLevel[] = ["manual", "auto"];
const KNOWN = new Set(STEPS.map((s) => s.id));

// 容错：未知步名、未知档位一律丢弃（不猜、不保留脏值）。
// 步名做白名单而不是全收——否则 steps.ts 删掉一步后，config 里的孤儿键会一直留着。
function normalize(raw: unknown): AutomationSettings {
  if (!raw || typeof raw !== "object") return {};
  const out: AutomationSettings = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN.has(k)) continue;
    if (typeof v !== "string" || !LEVELS.includes(v as AutomationLevel)) continue;
    out[k] = v as AutomationLevel;
  }
  return out;
}

export async function readGlobal(root: string): Promise<AutomationSettings> {
  const cfg = await readJson<{ automation?: unknown }>(path.join(root, CONFIG_FILE));
  return normalize(cfg?.automation);
}

export async function saveGlobal(root: string, settings: AutomationSettings): Promise<AutomationSettings> {
  const next = normalize(settings);
  const all = (await readJson<Record<string, unknown>>(path.join(root, CONFIG_FILE))) ?? {};
  await writeJsonAtomic(path.join(root, CONFIG_FILE), { ...all, automation: next });
  return next;
}

const overrideFile = (root: string, owner: string): string => path.join(root, "work", owner, "automation.json");

export async function readOverride(root: string, owner: string): Promise<AutomationSettings> {
  if (!owner.startsWith("clips/")) return {}; // 档位只对片段可覆盖（job 级步骤走全局）
  const own = await readJson<{ settings?: unknown }>(overrideFile(root, owner));
  if (own) return normalize(own.settings);
  // 旧数据写在 clip.json 里。读得到，下次保存再搬走。
  const clip = await readJson<ClipFile>(path.join(root, "work", owner, "clip.json"));
  return normalize(clip?.automation);
}

export async function saveOverride(root: string, owner: string, settings: AutomationSettings): Promise<AutomationSettings> {
  const clipFile = path.join(root, "work", owner, "clip.json");
  const clip = await readJson<ClipFile>(clipFile);
  if (!clip) throw new Error(`片段不存在：${owner}`);
  const next = normalize(settings);
  const file = overrideFile(root, owner);
  if (Object.keys(next).length === 0) await rm(file, { force: true });
  else await writeJsonAtomic(file, { schema: 1, settings: next });
  if (clip.automation) {
    const { automation: _drop, ...rest } = clip;
    await writeJsonAtomic(clipFile, rest);
  }
  return next;
}

// 生效档位：每步都有值（缺省 manual），供界面直接渲染开关与供自动链判定。
export async function effective(root: string, owner: string): Promise<AutomationSettings> {
  const [g, o] = await Promise.all([readGlobal(root), readOverride(root, owner)]);
  const level = owner.startsWith("jobs/") ? "job" : "clip";
  const out: AutomationSettings = {};
  for (const s of STEPS.filter((x) => x.level === level)) out[s.id] = o[s.id] ?? g[s.id] ?? "manual";
  return out;
}

export async function automationView(root: string, owner: string): Promise<AutomationView> {
  const [g, o, e] = await Promise.all([readGlobal(root), readOverride(root, owner), effective(root, owner)]);
  return { effective: e, global: g, override: o };
}
