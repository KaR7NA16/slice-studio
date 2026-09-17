// 步执行共享助手：目录定位、输入指纹登记、step.json 落盘、run 心跳
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunRecord, StepFile, StepInputRef } from "../shared/types.ts";
import { fingerprint } from "../server/fingerprint.ts";
import { readJson, writeJsonAtomic } from "../server/jsonfile.ts";
import { runFile } from "../server/runs.ts";

export const workDir = (root: string, owner: string): string => path.join(root, "work", owner);
export const stepDir = (root: string, owner: string, step: string): string => path.join(workDir(root, owner), step);

// 登记一个输入：key 是名字，relToWork 是相对 work/ 根的路径（跨 owner 引用也走这里，b28）
export async function inputRef(root: string, key: string, relToWork: string): Promise<StepInputRef> {
  // 文件缺失记空指纹：之后文件一出现即不符 → stale，行为诚实
  return { key, path: relToWork, fingerprint: (await fingerprint(path.join(root, "work", relToWork))) ?? "" };
}

// step.json 只存事实（b43）；inputs 与 outputs 一律与既有记录**并集**。
// 为什么 inputs 也必须并集：同一步可先 build 再 draft，两者登记的输入集不同
// （build 挂 clip.json + s00/sentences.json，draft 挂 s03/sentences.json）。
// 若 inputs 直接覆盖，后跑的模式会抹掉前者的输入 → survey 再也侦测不到那些上游的变化（假 ready）。
export async function finishStep(
  root: string,
  owner: string,
  step: string,
  inputs: StepInputRef[],
  outputs: string[],
): Promise<void> {
  const dir = stepDir(root, owner, step);
  await mkdir(dir, { recursive: true });
  const prev = await readJson<StepFile>(path.join(dir, "step.json"));
  const mergedInputs = new Map<string, StepInputRef>();
  for (const i of prev?.inputs ?? []) mergedInputs.set(i.key, i);
  for (const i of inputs) mergedInputs.set(i.key, i); // 同 key 取本次（更新的指纹）
  const file: StepFile = {
    schema: 1,
    step,
    finished_at: new Date().toISOString(),
    inputs: [...mergedInputs.values()],
    outputs: [...new Set([...(prev?.outputs ?? []), ...outputs])],
  };
  await writeJsonAtomic(path.join(dir, "step.json"), file);
}

async function patchRun(root: string, runId: string, patch: Partial<RunRecord>): Promise<void> {
  const file = runFile(root, runId);
  const rec = await readJson<RunRecord>(file);
  if (!rec) return;
  await writeJsonAtomic(file, { ...rec, ...patch, updated_at: new Date().toISOString() });
}

export const progress = (root: string, runId: string, message: string): Promise<void> =>
  patchRun(root, runId, { message });

export const finishRun = (root: string, runId: string, status: "done" | "error", message: string, error: string | null): Promise<void> =>
  patchRun(root, runId, { status, message, error, finished_at: new Date().toISOString() });
