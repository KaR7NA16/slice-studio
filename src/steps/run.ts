// 步执行子进程入口：node src/steps/run.ts <root> <owner> <step> <mode> <runId>
// 未实现的步据实报错（s01/s02/s04/s05 属阶段 3），不静默不假装。
import { finishRun, progress } from "./lib.ts";
import { runS00 } from "./s00.ts";
import { buildS03, draftS03 } from "./s03.ts";

const [root, owner, step, mode, runId] = process.argv.slice(2) as [string, string, string, string, string];

async function main(): Promise<void> {
  await progress(root, runId, `开始 ${step}${mode ? `（${mode}）` : ""}`);
  let message: string;
  if (step === "s00" && owner.startsWith("jobs/")) {
    message = await runS00(root, owner, runId);
  } else if (step === "s03" && owner.startsWith("clips/")) {
    message = mode === "draft" ? await draftS03(root, owner, runId) : await buildS03(root, owner, runId);
  } else {
    throw new Error(`${step} 尚未实现（属阶段 3）`);
  }
  await finishRun(root, runId, "done", message, null);
}

main().catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  await finishRun(root, runId, "error", msg, msg).catch(() => {});
  process.exitCode = 1;
});
