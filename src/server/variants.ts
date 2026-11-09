// 变体（b26「变体存各步 variants/」+ b7/b8「抽卡多版 / 主干 + 侧枝存档」）。
//
// 三个刻意的决定：
// ① **变体与正式产物分开存**：正式产物（ai.json / bgm.json）是「当前生效的那一版」，
//    variants/ 是全量存档。切主干 = 把选中那版物化回正式产物名，**不重跑 AI**——
//    b8 的判据是「界面能切回任一侧枝」，重跑 AI 既慢又不保证复现同一版（LLM 非确定）。
// ② **id 按创建序递增（v1/v2…）**：id 本身即「第几版」的事实，界面不必另存序号；
//    排序也不用读 mtime（mtime 会因复制/同步而失真）。
// ③ **parent 记「创建时上游 AI 步的生效变体」**：这是分叉树真正的边（b7「把每版的后续步骤选择串成分叉树」）。
//    没有它，各步的变体只是各自一列，串不成树。
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { STEPS, STEP_BY_ID } from "../shared/steps.ts";
import type { StepLevel } from "../shared/steps.ts";
import type { VariantFile, VariantMeta, VariantsView } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";

export const variantsDir = (root: string, owner: string, step: string): string =>
  path.join(root, "work", owner, step, "variants");

export const variantFile = (root: string, owner: string, step: string, id: string): string =>
  path.join(variantsDir(root, owner, step), `${id}.json`);

const numOf = (id: string): number => Number(/^v(\d+)$/.exec(id)?.[1] ?? 0);

export async function listVariants(root: string, owner: string, step: string): Promise<VariantFile[]> {
  let names: string[] = [];
  try {
    names = await readdir(variantsDir(root, owner, step));
  } catch {
    return [];
  }
  const out: VariantFile[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const v = await readJson<VariantFile>(path.join(variantsDir(root, owner, step), n));
    if (v?.meta?.id) out.push(v);
  }
  return out.sort((a, b) => numOf(a.meta.id) - numOf(b.meta.id));
}

// 上游 AI 步的生效变体（分叉树的边）。owner 级别决定「上游有哪些步」。
export async function activeUpstream(root: string, owner: string, step: string): Promise<string | null> {
  const spec = STEP_BY_ID.get(step);
  const level: StepLevel = owner.startsWith("jobs/") ? "job" : "clip";
  if (!spec) return null;
  const before = STEPS.filter((s) => s.level === level && s.aiArtifact);
  const idx = before.findIndex((s) => s.id === step);
  if (idx < 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const up = before[i]!;
    const f = await readJson<{ active_variant?: string | null }>(
      path.join(root, "work", owner, up.id, "step.json"),
    );
    if (f?.active_variant) return `${up.id}/${f.active_variant}`;
  }
  return null;
}

// 存一版。id 由本函数分配（并发抽卡时不会撞车：id 取自目录现有最大序号 +1）。
export async function saveVariant(
  root: string,
  owner: string,
  step: string,
  info: { model: string | null; label: string },
  payload: unknown,
): Promise<VariantFile> {
  const dir = variantsDir(root, owner, step);
  await mkdir(dir, { recursive: true });
  const existing = await listVariants(root, owner, step);
  const next = (existing.at(-1) ? numOf(existing.at(-1)!.meta.id) : 0) + 1;
  const file: VariantFile = {
    schema: 1,
    meta: {
      id: `v${next}`,
      step,
      created_at: new Date().toISOString(),
      model: info.model,
      label: info.label,
      parent: await activeUpstream(root, owner, step),
    },
    payload,
  };
  await writeJsonAtomic(variantFile(root, owner, step, file.meta.id), file);
  return file;
}

// 物化：把某版写到该步的 AI 产物名。**只写 AI 产物**——人工覆盖层（overlay.json）不碰（b29/b46）。
export async function materialize(
  root: string,
  owner: string,
  step: string,
  payload: unknown,
): Promise<string> {
  const artifact = STEP_BY_ID.get(step)?.aiArtifact;
  if (!artifact) throw new Error(`${step} 没有 AI 产物，不能切主干`);
  const p = path.join(root, "work", owner, step, artifact);
  await mkdir(path.dirname(p), { recursive: true });
  await writeJsonAtomic(p, payload);
  return artifact;
}

export async function variantsView(root: string, owner: string): Promise<VariantsView> {
  const level: StepLevel = owner.startsWith("jobs/") ? "job" : "clip";
  const steps: VariantsView["steps"] = [];
  for (const s of STEPS.filter((x) => x.level === level && x.aiArtifact)) {
    const [list, f] = await Promise.all([
      listVariants(root, owner, s.id),
      readJson<{ active_variant?: string | null }>(path.join(root, "work", owner, s.id, "step.json")),
    ]);
    steps.push({
      step: s.id,
      title: s.title,
      active: f?.active_variant ?? null,
      variants: list.map((v) => v.meta),
    });
  }
  return { owner, steps };
}

export type { VariantMeta };
