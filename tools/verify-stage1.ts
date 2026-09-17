// 阶段 1 判据验证：三态读模型（真实文件落盘，不用 mock）
// 覆盖：empty → ready → stale（输入变）→ suspect（递归传播）→ 恢复后自动回 ready（b27 只标脏）→ error 事实
// 运行：node tools/verify-stage1.ts（在 slice-studio 根目录下）；结束清理 work/_verify*
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { survey } from "../src/server/survey.ts";
import { fingerprint } from "../src/server/fingerprint.ts";
import type { StepFile, StepStatus } from "../src/shared/types.ts";

const ROOT = process.cwd();
const WORK = path.join(ROOT, "work");

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expect: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}: 期望 ${JSON.stringify(expect)} 实际 ${JSON.stringify(actual)}`);
  }
}

async function fp(rel: string): Promise<string> {
  const v = await fingerprint(path.join(WORK, rel));
  if (v === null) throw new Error(`指纹为空：${rel}`);
  return v;
}

async function writeStep(
  ownerRel: string,
  stepId: string,
  inputs: { key: string; path: string }[],
  artifact: string,
  content: string,
  error?: string,
): Promise<void> {
  const dir = path.join(WORK, ownerRel, stepId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, artifact), content, "utf8");
  const step: StepFile = {
    schema: 1,
    step: stepId,
    finished_at: new Date().toISOString(),
    inputs: await Promise.all(
      inputs.map(async (i) => ({ key: i.key, path: i.path, fingerprint: await fp(i.path) })),
    ),
    outputs: [artifact],
    ...(error ? { error } : {}),
  };
  await writeFile(path.join(dir, "step.json"), JSON.stringify(step, null, 2), "utf8");
}

async function statusOf(owner: "jobs" | "clips", id: string): Promise<Record<string, StepStatus>> {
  const s = await survey(ROOT);
  const list = owner === "jobs" ? s.jobs : s.clips;
  const found = list.find((o) => o.id === id);
  if (!found) throw new Error(`survey 里找不到 ${owner}/${id}`);
  return Object.fromEntries(found.steps.map((st) => [st.step, st.status]));
}

// 用旧项目真实素材视频做 job 输入（不造内容，只引用）
const MATERIALS = "<old-repo>/assets/materials";
const video = (await readdir(MATERIALS)).find((f) => f.endsWith(".mp4"));
if (!video) throw new Error("materials 里没有 mp4");

const jobRel = "jobs/_verify";
await mkdir(path.join(WORK, jobRel), { recursive: true });
const jobPath = path.join(WORK, jobRel, "job.json");
const jobJson = JSON.stringify(
  { schema: 1, id: "_verify", video_path: `${MATERIALS}/${video}`, srt_path: null, created_at: new Date().toISOString() },
  null,
  2,
);
await writeFile(jobPath, jobJson, "utf8");

const clipRel = "clips/_verify_c1";
await mkdir(path.join(WORK, clipRel), { recursive: true });
const clipPath = path.join(WORK, clipRel, "clip.json");
const clipJson = JSON.stringify(
  { schema: 1, id: "_verify_c1", job_id: "_verify", title: "验证片段", start: 1.0, end: 9.5, fps: null },
  null,
  2,
);
await writeFile(clipPath, clipJson, "utf8");

try {
  console.log("[1] 初始：全部 empty");
  check("job 步骤", await statusOf("jobs", "_verify"), { s00: "empty", s01: "empty" });
  check("clip 步骤", await statusOf("clips", "_verify_c1"), { s02: "empty", s03: "empty", s04: "empty", s05: "empty" });

  console.log("[2] s00 跑完 → ready；s01 仍 empty");
  await writeStep(jobRel, "s00", [{ key: "job.json", path: `${jobRel}/job.json` }], "job.srt", "1\n00:00:01,000 --> 00:00:02,000\n你好\n");
  check("s00", (await statusOf("jobs", "_verify"))["s00"], "ready");
  check("s01", (await statusOf("jobs", "_verify"))["s01"], "empty");

  console.log("[3] s01 跑完（输入只挂 s00 产物）→ 双 ready");
  await writeStep(jobRel, "s01", [{ key: "s00/job.srt", path: `${jobRel}/s00/job.srt` }], "candidates.json", "[]");
  check("s00+s01", await statusOf("jobs", "_verify"), { s00: "ready", s01: "ready" });

  console.log("[4] 改 job.json（上游变）→ s00 stale，s01 suspect（影响未定，b35）");
  await writeFile(jobPath, jobJson.replace('"srt_path": null', '"srt_path": "x.srt"'), "utf8");
  check("s00+s01", await statusOf("jobs", "_verify"), { s00: "stale", s01: "suspect" });

  console.log("[5] 恢复 job.json → 自动回 ready（重跑产物逐字节相同则无需动作，b27）");
  await writeFile(jobPath, jobJson, "utf8");
  check("s00+s01", await statusOf("jobs", "_verify"), { s00: "ready", s01: "ready" });

  console.log("[6] clip 级：s03/s04 ready 后改 clip.json → s03 stale，s04 suspect 递归（b28），s05 empty 不受影响");
  await writeStep(clipRel, "s03", [{ key: "clip.json", path: `${clipRel}/clip.json` }], "sentences.json", "[]");
  await writeStep(clipRel, "s04", [{ key: "s03/sentences.json", path: `${clipRel}/s03/sentences.json` }], "bgm.json", "{}");
  check("就绪基线", await statusOf("clips", "_verify_c1"), { s02: "empty", s03: "ready", s04: "ready", s05: "empty" });
  await writeFile(clipPath, clipJson.replace('"end": 9.5', '"end": 8.5'), "utf8");
  check("传播后", await statusOf("clips", "_verify_c1"), { s02: "empty", s03: "stale", s04: "suspect", s05: "empty" });

  console.log("[7] error 事实如实呈现（b59）");
  await writeStep(clipRel, "s02", [{ key: "clip.json", path: `${clipRel}/clip.json` }], "vocals.wav", "x", "demucs_not_found");
  check("s02", (await statusOf("clips", "_verify_c1"))["s02"], "error");

  console.log("[8] 恢复 clip.json → s03/s04 回 ready；s02 仍 error（错误是事实，不自动消失）");
  await writeFile(clipPath, clipJson, "utf8");
  check("恢复后", await statusOf("clips", "_verify_c1"), { s02: "error", s03: "ready", s04: "ready", s05: "empty" });
} finally {
  await rm(path.join(WORK, "jobs", "_verify"), { recursive: true, force: true });
  await rm(path.join(WORK, "clips", "_verify_c1"), { recursive: true, force: true });
}

console.log(`\n结果: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
