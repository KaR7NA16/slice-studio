// s03 逐句删留：build 从 s00 句子里截出片段句流（事实）；draft 让 LLM 给删留初稿（b9：带理由）。
// 人工改判不写这里——走覆盖层（b29），所以 build/draft 重跑都不丢人工。
import path from "node:path";
import type { AiDraftFile, ClipFile, SentencesFile } from "../shared/types.ts";
import { llmStatus } from "../server/config.ts";
import { readJson, writeJsonAtomic } from "../server/jsonfile.ts";
import { chatJson } from "./llm.ts";
import { commitVariant, finishStep, inputRef, progress, stepDir, workDir } from "./lib.ts";

const SYSTEM = `你是短视频剪辑助手。输入是一个片段的逐句字幕（id、起止秒、文本）。
判断哪些句子该删，让成片紧凑：废话、重复、跑题、口头语堆砌可删；拿不准的一律保留。
只返回 JSON：{"deletions":[{"id":"句子id","reason":"中文一句话理由"}]}，没有可删就返回空数组。`;

export async function buildS03(root: string, owner: string, runId: string): Promise<string> {
  const clip = await readJson<ClipFile>(path.join(workDir(root, owner), "clip.json"));
  if (!clip) throw new Error("clip.json 不存在");
  const src = await readJson<SentencesFile>(path.join(workDir(root, `jobs/${clip.job_id}`), "s00", "sentences.json"));
  if (!src) throw new Error("s00 未跑：先到任务页导入字幕");
  await progress(root, runId, "截取片段句流…");
  // 与片段区间有交叠的句子都算进来（float 秒，b40）
  const sentences = src.sentences.filter((s) => s.end > clip.start && s.start < clip.end);
  if (sentences.length === 0) throw new Error("片段区间内没有句子");
  await writeJsonAtomic(path.join(stepDir(root, owner, "s03"), "sentences.json"), { schema: 1, sentences } satisfies SentencesFile);
  await finishStep(
    root,
    owner,
    "s03",
    [
      await inputRef(root, "clip.json", `${owner}/clip.json`),
      await inputRef(root, "s00/sentences.json", `jobs/${clip.job_id}/s00/sentences.json`),
    ],
    ["sentences.json"],
  );
  return `截出 ${sentences.length} 句`;
}

export async function draftS03(root: string, owner: string, runId: string): Promise<string> {
  const dir = stepDir(root, owner, "s03");
  const cur = await readJson<SentencesFile>(path.join(dir, "sentences.json"));
  if (!cur) throw new Error("句流未构建：先跑一次构建");
  const llm = await llmStatus(root);
  if (!llm.ok) throw new Error(llm.reason);
  await progress(root, runId, `LLM（${llm.llm.model}）审 ${cur.sentences.length} 句…`);
  const user = JSON.stringify(cur.sentences.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text })));
  const reply = await chatJson(llm.llm, SYSTEM, user);
  let deletions: AiDraftFile["decisions"] = [];
  try {
    const parsed = JSON.parse(reply) as { deletions?: { id: string; reason?: string }[] };
    const valid = new Set(cur.sentences.map((s) => s.id));
    deletions = (parsed.deletions ?? [])
      .filter((d) => valid.has(d.id))
      .map((d) => ({ id: d.id, keep: false, reason: d.reason ?? "" }));
  } catch {
    throw new Error(`LLM 返回不是合法 JSON：${reply.slice(0, 120)}`);
  }
  const ai: AiDraftFile = { schema: 1, model: llm.llm.model, at: new Date().toISOString(), decisions: deletions };
  // 抽卡：本次初稿另存一版 variants/<id>.json，并把主干指到它（b26/b7/b8）。
  // 人工改判在覆盖层里，切主干不碰它——所以「重抽一版」不会丢任何人工判断（b29/b46）。
  const label = deletions.length === 0 ? "AI 建议不删" : `AI 建议删 ${deletions.length} 句`;
  await commitVariant(root, owner, "s03", { model: llm.llm.model, label }, ai, {
    inputs: [await inputRef(root, "sentences.json", `${owner}/s03/sentences.json`)],
    outputs: ["ai.json"],
  });
  return `${label}（已存档为一版，可切回）`;
}
