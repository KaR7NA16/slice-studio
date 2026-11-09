// s01 选高光（b1：默认人工；AI 出候选 = **抽卡多版**，b7/b8）。
//
// 两条路**分文件存放**（b29/b46「AI 产物与人工判断分文件存放」）：
//   人工定稿 → `candidates.json`（契约产物，由建片段那条路维护，AI 永不写它）
//   AI 提案   → `ai.json`（可选产物），每次抽卡另存一版 `variants/<id>.json`
// 为什么不能合成一个文件：抽一次卡就把人工定稿的清单抹了，而「人工定稿」是这个项目
// 最不该被机器覆盖的东西（b1 默认人工）。分文件的代价只是界面要读两份。
//
// 采纳方式 = **用候选去建片段**（前端点一下走 POST /api/clips），本步不回写 candidates.json——
// 回写等于让 AI 间接定稿，与 b1 冲突。
import path from "node:path";
import type { HighlightCandidate, S01AiFile, SentencesFile } from "../shared/types.ts";
import { llmStatus } from "../server/config.ts";
import { readJson } from "../server/jsonfile.ts";
import { chatJson } from "./llm.ts";
import { commitVariant, inputRef, progress, stepDir, workDir } from "./lib.ts";

const SYSTEM = `你是短视频选题助手。输入是一个长视频的逐句字幕（id、起止秒、文本）。
挑出适合做短视频的高光片段：有完整起承转合、信息密度高、有钩子。
只返回 JSON：{"highlights":[{"title":"中文短标题（≤12字）","start":起始秒,"end":结束秒,"reason":"中文一句话理由"}]}。
要求：最多 5 条；start/end 必须落在给定时间范围内；end 必须大于 start；片段时长控制在 5~120 秒。`;

// 采纳前的最小校验：越界/倒置/过短/超长的候选一律丢弃，并**如实回报丢弃条数**。
// 不静默丢弃——LLM 挑出「end < start」这类东西说明它没按格式来，藏起来下次还会犯。
export function sanitizeHighlights(raw: unknown, lo: number, hi: number): { kept: HighlightCandidate[]; dropped: number } {
  const arr = (raw as { highlights?: unknown })?.highlights;
  if (!Array.isArray(arr)) return { kept: [], dropped: 0 };
  const kept: HighlightCandidate[] = [];
  let dropped = 0;
  for (const [i, it] of arr.entries()) {
    const o = it as { title?: unknown; start?: unknown; end?: unknown; reason?: unknown };
    const start = Number(o?.start);
    const end = Number(o?.end);
    const title = typeof o?.title === "string" ? o.title.trim() : "";
    const span = end - start;
    const ok =
      Number.isFinite(start) && Number.isFinite(end) &&
      start >= lo && end <= hi && span >= 5 && span <= 120 && title.length > 0;
    if (!ok) {
      dropped++;
      continue;
    }
    kept.push({
      id: `h${i + 1}`,
      title: title.slice(0, 24),
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      reason: typeof o?.reason === "string" ? o.reason.trim() : "",
    });
  }
  return { kept, dropped };
}

export async function runS01(root: string, owner: string, runId: string): Promise<string> {
  const jobId = owner.slice("jobs/".length);
  const src = await readJson<SentencesFile>(path.join(workDir(root, `jobs/${jobId}`), "s00", "sentences.json"));
  if (!src || src.sentences.length === 0) throw new Error("s00 未跑或句流为空：先导入字幕");
  const llm = await llmStatus(root);
  if (!llm.ok) throw new Error(llm.reason);

  let lo = Infinity;
  let hi = -Infinity;
  for (const s of src.sentences) {
    if (s.start < lo) lo = s.start;
    if (s.end > hi) hi = s.end;
  }
  await progress(root, runId, `LLM（${llm.llm.model}）从 ${src.sentences.length} 句里挑高光…`);
  const user = JSON.stringify({
    range: { start: lo, end: hi },
    sentences: src.sentences.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text })),
  });
  const reply = await chatJson(llm.llm, SYSTEM, user);
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new Error(`LLM 返回不是合法 JSON：${reply.slice(0, 120)}`);
  }
  const { kept, dropped } = sanitizeHighlights(parsed, lo, hi);
  if (kept.length === 0) throw new Error(`LLM 没给出可用的高光区间（${dropped} 条越界或格式不符，已全部丢弃）`);

  const ai: S01AiFile = { schema: 1, model: llm.llm.model, at: new Date().toISOString(), candidates: kept };
  const label = `${kept.length} 条：${kept[0]!.title}${kept.length > 1 ? " 等" : ""}`;
  await commitVariant(root, owner, "s01", { model: llm.llm.model, label }, ai, {
    inputs: [await inputRef(root, "s00/sentences.json", `${owner}/s00/sentences.json`)],
    outputs: ["ai.json"],
  });
  return `AI 给出 ${kept.length} 条高光${dropped > 0 ? `（另有 ${dropped} 条越界已丢弃）` : ""}`;
}

// 当前 AI 提案（只读，供 s01 工作空间）
export const readS01Ai = (root: string, jobId: string): Promise<S01AiFile | null> =>
  readJson<S01AiFile>(path.join(stepDir(root, `jobs/${jobId}`, "s01"), "ai.json"));
