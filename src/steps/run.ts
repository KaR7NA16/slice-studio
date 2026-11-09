// 步执行子进程入口：node src/steps/run.ts <root> <owner> <step> <mode> <runId>
// 未实现的步据实报错，不静默不假装。
import { safeOwner } from "../server/jobcard.ts";
import { finishRun, progress } from "./lib.ts";
import { runS00 } from "./s00.ts";
import { runS01 } from "./s01.ts";
import { runS02 } from "./s02.ts";
import { buildS03, draftS03 } from "./s03.ts";
import { runS04 } from "./s04.ts";
import { runS05 } from "./s05.ts";

const [root, owner, step, mode, runId] = process.argv.slice(2) as [string, string, string, string, string];

// 参数校验（P3-5）：缺 root/owner/step/runId 必须显式失败。
// 为什么不能靠下游兜底：runId 缺失时 runFile() 拼出 "undefined.json"，
// patchRun 读不到就静默 return —— 进度与完成状态一个都不落盘，
// 子进程却仍以 0 退出，调用方看到的是「成功」。这类调用只可能来自手工直调
// （正常路径的 id 由 runs.ts 的 startRun 生成），所以直接报错退出，不落任何文件。
// mode 允许为空串（build 模式就是空），故不校验。
if (!root || !owner || !step || !runId || !safeOwner(owner)) {
  console.error("用法：node src/steps/run.ts <root> <owner> <step> <mode> <runId>");
  console.error("owner 只能是 jobs/<id> 或 clips/<id>");
  process.exit(2);
}

async function main(): Promise<void> {
  await progress(root, runId, `开始 ${step}${mode ? `（${mode}）` : ""}`);
  let message: string;
  if (step === "s00" && owner.startsWith("jobs/")) {
    message = await runS00(root, owner, runId);
  } else if (step === "s01" && owner.startsWith("jobs/")) {
    message = await runS01(root, owner, runId);
  } else if (step === "s02" && owner.startsWith("clips/")) {
    message = await runS02(root, owner, runId);
  } else if (step === "s03" && owner.startsWith("clips/")) {
    message = mode === "draft" ? await draftS03(root, owner, runId) : await buildS03(root, owner, runId);
  } else if (step === "s04" && owner.startsWith("clips/")) {
    message = await runS04(root, owner, runId);
  } else if (step === "s05" && owner.startsWith("clips/")) {
    message = await runS05(root, owner, runId);
  } else {
    throw new Error(`${step} 不属于${owner.startsWith("jobs/") ? "任务" : "片段"}`);
  }
  await finishRun(root, runId, "done", message, null);
}

main().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  await finishRun(root, runId, "error", msg, msg).catch(() => {});
  process.exitCode = 1;
});
