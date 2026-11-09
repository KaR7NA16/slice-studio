// 重跑预览（b39：**重跑前只列将动哪些文件，不估时长**）。
//
// 三块内容各自的口径：
//   writes       本步将写入/覆盖的路径。**按模式算**——s03 的 build 与 draft 动的文件不同，
//                混在一起列会让人以为「跑一次 build 会把 AI 稿也覆盖掉」。
//   marks_stale  重跑后会被标脏的**传递下游**（含当前 ready 与 suspect 的）。
//                只列这两态：error/missing 的步本来就脏，列出来是噪音；empty 的步还没跑过。
//   warnings     不阻塞但用户该知道的事（未配 LLM、可选依赖没就绪）。
//
// 刻意**不给时长估计**——那是猜，且 b39 明确要求不估。
import path from "node:path";
import { STEP_BY_ID, stepsFor } from "../shared/steps.ts";
import type { RunPreview, StepFile, StepStatus } from "../shared/types.ts";
import { llmStatus } from "./config.ts";
import { readJson } from "./jsonfile.ts";
import { survey } from "./survey.ts";

// 传递下游（同一 owner 内按 deps 反向闭包）。顺序按注册表序，界面稳定。
function downstreamOf(owner: string, step: string): string[] {
  const level = owner.startsWith("jobs/") ? "job" : "clip";
  const specs = stepsFor(level);
  const hit = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of specs) {
      if (s.id === step || hit.has(s.id)) continue;
      if (s.deps.some((d) => d === step || hit.has(d))) {
        hit.add(s.id);
        changed = true;
      }
    }
  }
  return specs.filter((s) => hit.has(s.id)).map((s) => s.id);
}

export async function preview(root: string, owner: string, step: string, mode: string | null): Promise<RunPreview> {
  const spec = STEP_BY_ID.get(step);
  if (!spec) throw new Error(`未知的步：${step}`);
  const level = owner.startsWith("jobs/") ? "job" : "clip";
  if (spec.level !== level) throw new Error(`${step} 不属于 ${level} 级`);

  const stepDir = path.join(root, "work", owner, step);
  const prev = await readJson<StepFile>(path.join(stepDir, "step.json"));

  // ---- writes ----
  const names = new Set<string>();
  if (mode === "draft") {
    // draft 只产 AI 稿：不碰契约产物（s03 的 sentences.json 是 build 的事）
    if (spec.aiArtifact) names.add(spec.aiArtifact);
  } else if (mode === "build") {
    for (const a of spec.artifacts) names.add(a);
  } else {
    for (const a of spec.artifacts) names.add(a);
    if (spec.aiArtifact) names.add(spec.aiArtifact);
    // 上次实际产出过的可选产物（如 s05 的 clip.srt / kept.json）也会被重写
    for (const o of prev?.outputs ?? []) names.add(o);
  }
  const writes = [...names].map((n) => `${owner}/${step}/${n}`);
  if (spec.aiArtifact && mode !== "build") writes.push(`${owner}/${step}/variants/v*.json`);

  // ---- marks_stale ----
  const sv = await survey(root);
  const id = owner.slice(owner.indexOf("/") + 1);
  const states =
    level === "job" ? sv.jobs.find((j) => j.id === id)?.steps : sv.clips.find((c) => c.id === id)?.steps;
  const statusOf = new Map<string, StepStatus>((states ?? []).map((s) => [s.step, s.status]));
  const marks_stale = downstreamOf(owner, step)
    .filter((d) => {
      const st = statusOf.get(d);
      return st === "ready" || st === "suspect";
    })
    .map((d) => ({ owner, step: d, title: STEP_BY_ID.get(d)?.title ?? d }));

  // ---- warnings ----
  const warnings: string[] = [];
  // 强依赖没就绪 → 这次重跑会直接失败。不是「可能」——子进程一定会抛。
  for (const d of spec.deps) {
    const st = statusOf.get(d);
    if (st !== "ready" && st !== "suspect") {
      warnings.push(`强依赖「${STEP_BY_ID.get(d)?.title ?? d}」未就绪（${st ?? "未知"}），重跑会失败`);
    }
  }
  // 需要 LLM 的路径：s01 恒需；s03 的 draft 需；s04 只在没指定 bgm_mood（走 LLM 兜底）时需
  const needsLlm =
    step === "s01" ||
    (step === "s03" && mode === "draft") ||
    (step === "s04" && !(await readJson<{ bgm_mood?: string | null }>(path.join(stepDir, "params.json")))?.bgm_mood?.trim());
  if (needsLlm) {
    const llm = await llmStatus(root);
    if (!llm.ok) warnings.push(`未配置可用的 LLM：${llm.reason}`);
  }
  // s04 是 s05 的**可选**消费对象：没它就出片，只是不带配乐
  if (step === "s05") {
    const s04 = statusOf.get("s04");
    if (s04 !== "ready" && s04 !== "suspect") warnings.push("s04 未就绪，成片将不带配乐");
  }

  return { owner, step, title: spec.title, writes, marks_stale, warnings };
}
