// 步执行共享助手：目录定位、输入指纹登记、step.json 落盘、run 心跳
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RunRecord, StepFile, StepInputRef, VariantFile } from "../shared/types.ts";
import { fingerprint, resolveInputPath } from "../server/fingerprint.ts";
import { readJson, writeJsonAtomic } from "../server/jsonfile.ts";
import { runFile } from "../server/runs.ts";
import { materialize, saveVariant } from "../server/variants.ts";

export const workDir = (root: string, owner: string): string => path.join(root, "work", owner);
export const stepDir = (root: string, owner: string, step: string): string => path.join(workDir(root, owner), step);

// 删「善后文件」（临时件、验证夹具）。三条约束都是踩出来的：
// ① **不得抛异常**——善后失败不能推翻已经落盘的事实（s02 实测：临时音轨删不掉导致成功的 run 报 exit 1）；
// ② **也不得静默**——静默的后果是 work/ 悄悄堆残留而脚本报「全绿」（实测堆到 37 个文件）；
// ③ **必须把真因带出去**——只回「成功/失败」，调用方拿不到错误码，下次还得把排查重演一遍。
// 返回 null = 删掉了；返回字符串 = 失败，字符串是错误码/首行消息（供调用方留痕）。
//
// ⚠️ 真因（2026-09-18 实测，与直觉相反）：失败**不是**文件锁，而是沙箱的删除守卫**按 turn 累计**计数——
//    `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":150,"threshold":50,"scope":"turn"}`，
//    本 turn 累计删除超 50 次后，**之后所有删除一律被拦**（与删的是什么、路径对不对无关）。
//    所以重试/换删除 API 都没用，只能留痕让人知道 work/ 会有残留。判据是「进程外手工删同一目录成功」。
export async function removeQuietly(p: string): Promise<string | null> {
  try {
    await rm(p, { recursive: true, force: true });
    return null;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return `${err.code ?? "?"}: ${(err.message ?? String(e)).split("\n")[0]}`;
  }
}

// 登记一个输入：key 是名字，relToWork 是相对 work/ 根的路径（跨 owner 引用也走这里，b28）
export async function inputRef(root: string, key: string, relToWork: string): Promise<StepInputRef> {
  // 文件缺失记空串。survey 把空串和 fingerprint() 的 null 当成同一种「现在没有」：
  // 一直没有 → 不标脏；后来出现 → stale。不要改成不登记，否则「出片之后才改的删留」永远看不见。
  const file = resolveInputPath(path.join(root, "work"), relToWork);
  return { key, path: relToWork, fingerprint: (await fingerprint(file)) ?? "" };
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
  opts?: { dropKeys?: string[] },
): Promise<void> {
  const dir = stepDir(root, owner, step);
  await mkdir(dir, { recursive: true });
  const prev = await readJson<StepFile>(path.join(dir, "step.json"));
  const mergedInputs = new Map<string, StepInputRef>();
  for (const i of prev?.inputs ?? []) mergedInputs.set(i.key, i);
  for (const key of opts?.dropKeys ?? []) mergedInputs.delete(key);
  for (const i of inputs) mergedInputs.set(i.key, i); // 同 key 取本次（更新的指纹）
  // 并集留下的旧 key 不能原样冻住。两种情况必须按现在的磁盘改写，否则成功的这一跑会立刻 stale，
  // 而且再跑同一模式也清不掉：
  //   ① 这次的产物就是那个旧输入（build 重写了 draft 登记过的 sentences.json）；
  //   ② 文件已经不在了（删掉 source.srt 改走转写）。文件还在、内容变了、这次又没读它 → 保持旧指纹，继续 stale。
  const declared = new Set(inputs.map((i) => i.key));
  const produced = new Set(outputs.map((name) => `${owner}/${step}/${name}`.replace(/\\/g, "/")));
  for (const [key, ref] of mergedInputs) {
    if (declared.has(key)) continue;
    const norm = ref.path.replace(/\\/g, "/");
    const now = await fingerprint(resolveInputPath(path.join(root, "work"), ref.path));
    if (produced.has(norm)) mergedInputs.set(key, { ...ref, fingerprint: now ?? "" });
    else if (now === null) mergedInputs.set(key, { ...ref, fingerprint: "" });
  }
  const file: StepFile = {
    schema: 1,
    step,
    finished_at: new Date().toISOString(),
    inputs: [...mergedInputs.values()],
    outputs: [...new Set([...(prev?.outputs ?? []), ...outputs])],
    // 主干变体必须**继承**：抽卡时先 commitVariant（写 active_variant）再 finishStep，
    // 这里若丢掉，切好的主干会被本次运行抹成 null（「回执成功但磁盘未变」的同族坑）。
    active_variant: prev?.active_variant ?? null,
  };
  await writeJsonAtomic(path.join(dir, "step.json"), file);
}

// 切主干（b8）：改 step.json 的 active_variant。只动这一个字段，不碰 inputs/outputs。
export async function setActiveVariant(root: string, owner: string, step: string, vid: string | null): Promise<void> {
  const file = path.join(stepDir(root, owner, step), "step.json");
  const cur = await readJson<StepFile>(file);
  if (!cur) throw new Error(`${step} 还没跑过，没有可切的主干`);
  await writeJsonAtomic(file, { ...cur, active_variant: vid });
}

// 抽卡落一版：存变体 → 物化为正式 AI 产物 → 落 step.json → 标记主干。
// 四步的顺序是刻意的，反过来会出两种不同的错：
//   ① **先存变体、再物化**——物化失败时存档至少还在，能重切；反过来会留下「生效了但没存档」。
//   ② **setActiveVariant 必须在 finishStep 之后**——它要读一份存在的 step.json，而首次抽卡时
//      该步可能还没跑过（如 s04 第一次就跑 LLM 路），先 set 直接抛「还没跑过，没有可切的主干」。
//   ③ 而 finishStep 又会**继承**旧的 active_variant，所以顺序也不能颠倒成「finish 后不 set」——
//      那样切好的主干会被本次运行写回旧值（界面上显示新内容、主干却指向旧版）。
export async function commitVariant(
  root: string,
  owner: string,
  step: string,
  info: { model: string | null; label: string },
  payload: unknown,
  finish: { inputs: StepInputRef[]; outputs: string[] },
): Promise<VariantFile> {
  const v = await saveVariant(root, owner, step, info, payload);
  await materialize(root, owner, step, payload);
  await finishStep(root, owner, step, finish.inputs, finish.outputs);
  await setActiveVariant(root, owner, step, v.meta.id);
  return v;
}

async function patchRun(root: string, runId: string, patch: Partial<RunRecord>): Promise<void> {
  const file = runFile(root, runId);
  const rec = await readJson<RunRecord>(file);
  if (!rec) return;
  await writeJsonAtomic(file, { ...rec, ...patch, updated_at: new Date().toISOString() });
}

export const progress = (root: string, runId: string, message: string): Promise<void> =>
  patchRun(root, runId, { message });

// 连续进度走单独字段，不走 message：message 进 live region，读屏会念，
// 「2:15 / 8:00」这种每秒变一次的数字念出来就没法用了。
export const reportProgress = (root: string, runId: string, detail: string | null): Promise<void> =>
  patchRun(root, runId, { progress_detail: detail });

export const finishRun = (root: string, runId: string, status: "done" | "error", message: string, error: string | null): Promise<void> =>
  // 收尾必须把进度抹掉：留着「已处理 2:15」而状态已经 done，界面上就是一条永远停在 2:15 的旁注。
  patchRun(root, runId, { status, message, error, finished_at: new Date().toISOString(), progress_detail: null });
