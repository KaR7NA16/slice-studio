// 阶段 1 判据验证：三态读模型（真实文件落盘，不用 mock）
// 覆盖：empty → ready → stale（输入变 / 输入丢失）→ missing（契约产物缺失，P1-4）→ suspect（递归传播）
//       → 恢复后自动回 ready（b27 只标脏）→ error 事实 → lazy.available 与契约判据同源
// 运行：node tools/verify-stage1.ts（在 slice-studio 根目录下）；结束清理 work/_verify*
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { survey } from "../src/server/survey.ts";
import { fingerprint } from "../src/server/fingerprint.ts";
import { finishStep, inputRef } from "../src/steps/lib.ts";
import type { StepFile, StepState, StepStatus } from "../src/shared/types.ts";

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

// artifacts 用数组：一步的契约产物可能不止一个（s00 = sentences.json + job.srt）。
// 夹具必须与 STEPS[].artifacts 对齐，否则会被判 missing——这正是 P1-4 新判据在生效。
async function writeStep(
  ownerRel: string,
  stepId: string,
  inputs: { key: string; path: string }[],
  artifacts: string[],
  content: string,
  error?: string,
): Promise<void> {
  const dir = path.join(WORK, ownerRel, stepId);
  await mkdir(dir, { recursive: true });
  for (const a of artifacts) await writeFile(path.join(dir, a), content, "utf8");
  const step: StepFile = {
    schema: 1,
    step: stepId,
    finished_at: new Date().toISOString(),
    inputs: await Promise.all(
      inputs.map(async (i) => ({ key: i.key, path: i.path, fingerprint: await fp(i.path) })),
    ),
    outputs: [...artifacts],
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

// 夹具视频在下面「清空旧夹具」之后生成，否则会被开头清理一起删掉（见 FIXTURE_DIRS）。
// 旧项目「切片助手」只读参考目录里的素材已不存在，不能再硬编码那个绝对路径。

// 夹具目录清单（第 131 行的 p14Rel 也在其中）。开头清空、finally 清理都按这份清单走。
// _verify_graveyard 是「坟场」：用例需要「让产物不存在」时把文件 rename 进去，而不是 rm（见 bury）。
const FIXTURE_DIRS = ["jobs/_verify", "clips/_verify_c1", "clips/_verify_p14", "clips/_verify_abs", "_verify_graveyard", "_verify_input.mp4"];

// 「让产物不存在」用 rename 而非 rm。两个理由：
// ① 用例语义是「文件不在原路径」，不是「文件被销毁」——rename 完全等价，且失败时文件还在坟场可诊断；
// ② 沙箱对删除有配额（safe-delete 守卫，阈值 50/turn），超了直接抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED。
//    本脚本原先有 6 处用例内 rm，撞配额时脚本会崩在 rm 那一行——看起来像产品缺陷，实际是环境约束。
let buried = 0;
const GRAVEYARD = path.join(WORK, "_verify_graveyard");
async function bury(p: string): Promise<void> {
  await mkdir(GRAVEYARD, { recursive: true });
  await rename(p, path.join(GRAVEYARD, `${String(buried++).padStart(3, "0")}-${path.basename(p)}`));
}

// 起点必须干净：夹具目录里残留的 step.json 会让 [1]/[2]/[6] 的基线断言读到上一次运行的残影，
// 表现为 5 个假 FAIL（2026-09-18 实测：残留含 jobs/_verify/s0*/step.json 时，26 条里假红 5 条；
// 只残留 clips/_verify_p14 时 26/26 —— 因为它不被 [1] 覆盖）。
// 这不是产品缺陷，而是脚本隐含依赖「起点无残留」却从未保证。
// 残留的真实来源：finally 的 rm 被沙箱 safe-delete 拦截 → 上一次的夹具留在 work/。
// 必须在建任何夹具文件**之前**清，否则会把刚写的 job.json / clip.json 一起删掉。
// 清理失败降级为警告而非崩溃：否则「删不掉旧夹具」会伪装成「脚本坏了」，把可诊断信息换成误导信息。
for (const rel of FIXTURE_DIRS) {
  try {
    await rm(path.join(WORK, rel), { recursive: true, force: true });
  } catch {
    console.log(`⚠️ 无法清理旧夹具 ${rel}（删除被环境拦截）——本次基线断言可能受残留影响`);
  }
}

// job 的 video_path 必须指向真实存在的文件（survey 对缺失输入会标 stale）。
// 随包 ffmpeg 现场生成一段最小真实视频：自包含、不依赖另一次验证的产物；
// 同一进程内只生成一次并复用，输入指纹不会在用例之间漂移（b27 需要它稳定）。
const video = path.join(WORK, "_verify_input.mp4");
const ffmpeg = path.join(ROOT, "tools", "ffmpeg", "ffmpeg.exe");
const enc = spawnSync(
  ffmpeg,
  [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=160x120:r=25:d=3",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-shortest", "-t", "3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    video,
  ],
  { stdio: "pipe" },
);
if (enc.status !== 0) throw new Error(`ffmpeg 没生成夹具视频：${String(enc.stderr ?? enc.error)}`);

const jobRel = "jobs/_verify";
await mkdir(path.join(WORK, jobRel), { recursive: true });
const jobPath = path.join(WORK, jobRel, "job.json");
const jobJson = JSON.stringify(
  { schema: 1, id: "_verify", video_path: video, srt_path: null, created_at: new Date().toISOString() },
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
  await writeStep(jobRel, "s00", [{ key: "job.json", path: `${jobRel}/job.json` }], ["sentences.json", "job.srt"], "1\n00:00:01,000 --> 00:00:02,000\n你好\n");
  check("s00", (await statusOf("jobs", "_verify"))["s00"], "ready");
  check("s01", (await statusOf("jobs", "_verify"))["s01"], "empty");

  console.log("[3] s01 跑完（输入只挂 s00 产物）→ 双 ready");
  await writeStep(jobRel, "s01", [{ key: "s00/job.srt", path: `${jobRel}/s00/job.srt` }], ["candidates.json"], "[]");
  check("s00+s01", await statusOf("jobs", "_verify"), { s00: "ready", s01: "ready" });

  console.log("[4] 改 job.json（上游变）→ s00 stale，s01 suspect（影响未定，b35）");
  await writeFile(jobPath, jobJson.replace('"srt_path": null', '"srt_path": "x.srt"'), "utf8");
  check("s00+s01", await statusOf("jobs", "_verify"), { s00: "stale", s01: "suspect" });

  console.log("[5] 恢复 job.json → 自动回 ready（重跑产物逐字节相同则无需动作，b27）");
  await writeFile(jobPath, jobJson, "utf8");
  check("s00+s01", await statusOf("jobs", "_verify"), { s00: "ready", s01: "ready" });

  console.log("[6] clip 级：s03/s04 ready 后改 clip.json → s03 stale，s04 suspect 递归（b28），s05 empty 不受影响");
  await writeStep(clipRel, "s03", [{ key: "clip.json", path: `${clipRel}/clip.json` }], ["sentences.json"], "[]");
  await writeStep(clipRel, "s04", [{ key: "s03/sentences.json", path: `${clipRel}/s03/sentences.json` }], ["bgm.json"], "{}");
  check("就绪基线", await statusOf("clips", "_verify_c1"), { s02: "empty", s03: "ready", s04: "ready", s05: "empty" });
  await writeFile(clipPath, clipJson.replace('"end": 9.5', '"end": 8.5'), "utf8");
  check("传播后", await statusOf("clips", "_verify_c1"), { s02: "empty", s03: "stale", s04: "suspect", s05: "empty" });

  console.log("[7] error 事实如实呈现（b59）");
  await writeStep(clipRel, "s02", [{ key: "clip.json", path: `${clipRel}/clip.json` }], ["vocals.wav", "no_vocals.wav"], "x", "demucs_not_found");
  check("s02", (await statusOf("clips", "_verify_c1"))["s02"], "error");

  console.log("[8] 恢复 clip.json → s03/s04 回 ready；s02 仍 error（错误是事实，不自动消失）");
  await writeFile(clipPath, clipJson, "utf8");
  check("恢复后", await statusOf("clips", "_verify_c1"), { s02: "error", s03: "ready", s04: "ready", s05: "empty" });

  // ---- P1-4：契约产物缺失（第六态 missing）----
  // 单独开一个 clip，避免与上面 1–8 段的既有状态纠缠。
  const p14Rel = "clips/_verify_p14";
  const p14Dir = path.join(WORK, p14Rel);
  await mkdir(p14Dir, { recursive: true });
  await writeFile(path.join(p14Dir, "clip.json"), JSON.stringify(
    { schema: 1, id: "_verify_p14", job_id: "_verify", title: "P1-4 用例", start: 1.0, end: 2.0, fps: null },
    null, 2,
  ), "utf8");
  const p14 = async (step: string): Promise<StepState> => {
    const c = (await survey(ROOT)).clips.find((x) => x.id === "_verify_p14");
    if (!c) throw new Error("survey 里找不到 _verify_p14");
    return c.steps.find((s) => s.step === step)!;
  };

  console.log("[9] P1-4：契约产物被删 → missing（step.json 还在：说「未跑」是撒谎、说「已就绪」是骗人）");
  await writeStep(p14Rel, "s03", [{ key: "clip.json", path: `${p14Rel}/clip.json` }], ["sentences.json"], "[]");
  check("s03 ready", (await p14("s03")).status, "ready");
  await bury(path.join(p14Dir, "s03", "sentences.json"));
  check("s03 missing", (await p14("s03")).status, "missing");
  check("reason 写明缺哪个", (await p14("s03")).reason, "缺少 sentences.json");
  await writeFile(path.join(p14Dir, "s03", "sentences.json"), "[]", "utf8");
  check("产物补回 → 自动回 ready", (await p14("s03")).status, "ready");

  console.log("[10] P1-4：可选产物缺失**不**误报（判据取 artifacts 契约，不取 step.json.outputs）");
  // 模拟「跑过 draft」：outputs 里多一个可选产物 ai.json（真实 s03 跑 draft 后就是这个形状）
  const s03StepFile = path.join(p14Dir, "s03", "step.json");
  const s03Step = JSON.parse(await readFile(s03StepFile, "utf8")) as StepFile;
  await writeFile(path.join(p14Dir, "s03", "ai.json"), "{}", "utf8");
  await writeFile(s03StepFile, JSON.stringify({ ...s03Step, outputs: [...s03Step.outputs, "ai.json"] }, null, 2), "utf8");
  check("登记了可选产物 → 仍 ready", (await p14("s03")).status, "ready");
  await bury(path.join(p14Dir, "s03", "ai.json"));
  check("删掉可选产物 → 仍 ready（若拿 outputs 当契约，这里会误报 missing）", (await p14("s03")).status, "ready");

  console.log("[11] P1-4：missing 进传播触发集（下游没把该产物登记为输入时，靠 deps 兜底）");
  // 刻意构造：s04 的输入只挂 clip.json、不挂 s03 产物。真实链路里下游通常登记了上游产物
  // （那样它自己就 stale 了），这里专门测 deps 声明的兜底那条路。
  await writeStep(p14Rel, "s04", [{ key: "clip.json", path: `${p14Rel}/clip.json` }], ["bgm.json"], "{}");
  check("s04 ready", (await p14("s04")).status, "ready");
  await bury(path.join(p14Dir, "s03", "sentences.json"));
  check("s03 missing", (await p14("s03")).status, "missing");
  check("s04 suspect（上游产物丢了）", (await p14("s04")).status, "suspect");
  check("s04 文案指向「产物已丢失」而非「已变」", (await p14("s04")).reason, "上游 s03 产物已丢失，影响未定");

  console.log("[12] P1-4：输入文件被删 → stale 文案分流为「输入已丢失」（不再误报「输入已变」）");
  await bury(path.join(p14Dir, "s04"));
  await writeFile(path.join(p14Dir, "s03", "sentences.json"), "[]", "utf8"); // 先补回，让 s04 拿到有效指纹
  await writeStep(p14Rel, "s04", [{ key: "s03/sentences.json", path: `${p14Rel}/s03/sentences.json` }], ["bgm.json"], "{}");
  check("s04 ready", (await p14("s04")).status, "ready");
  await bury(path.join(p14Dir, "s03", "sentences.json"));
  check("s04 状态+文案", `${(await p14("s04")).status}|${(await p14("s04")).reason}`, "stale|输入已丢失：s03/sentences.json");

  console.log("[13] P1-4：lazy.available 与契约判据同源（不看 status、只看契约产物在不在）");
  await writeFile(path.join(p14Dir, "s03", "sentences.json"), "[]", "utf8");
  check("s02 未跑 → 不可用", (await p14("s03")).lazy?.[0]?.available, false);
  await writeStep(p14Rel, "s02", [], ["vocals.wav", "no_vocals.wav"], "x");
  check("s02 契约齐 → 可用", (await p14("s03")).lazy?.[0]?.available, true);
  await bury(path.join(p14Dir, "s02", "no_vocals.wav"));
  check("s02 缺一个契约产物 → 不可用", (await p14("s03")).lazy?.[0]?.available, false);

  console.log("[14] 缺席指纹：文件还不存在时记空串，和读到的 null 是同一回事；后来出现才 stale");
  const absRel = "clips/_verify_abs";
  const absDir = path.join(WORK, absRel);
  await mkdir(path.join(absDir, "s05"), { recursive: true });
  await writeFile(
    path.join(absDir, "clip.json"),
    JSON.stringify({ schema: 1, id: "_verify_abs", job_id: "_verify", title: "缺席", start: 0, end: 1, fps: null }),
    "utf8",
  );
  await writeFile(path.join(absDir, "s05", "final.mp4"), "x", "utf8");
  await writeFile(path.join(absDir, "s05", "package.zip"), "x", "utf8");
  await finishStep(ROOT, absRel, "s05", [
    await inputRef(ROOT, "clip.json", `${absRel}/clip.json`),
    await inputRef(ROOT, "s03/overlay.json", `${absRel}/s03/overlay.json`),
  ], ["final.mp4", "package.zip"]);
  const abs = async (): Promise<StepState> => {
    const c = (await survey(ROOT)).clips.find((x) => x.id === "_verify_abs");
    if (!c) throw new Error("survey 里找不到 _verify_abs");
    return c.steps.find((s) => s.step === "s05")!;
  };
  check("登记了尚不存在的输入 → 仍 ready", (await abs()).status, "ready");
  await mkdir(path.join(absDir, "s03"), { recursive: true });
  await writeFile(path.join(absDir, "s03", "overlay.json"), "{\"schema\":1}", "utf8");
  check("那份输入后来出现 → stale", (await abs()).status, "stale");
  check("文案指向新出现的输入", (await abs()).reason, "输入已变：s03/overlay.json");
} finally {
  // 清理失败不能让脚本以异常退出——那样汇总行不打印，真实结果（26 条里过了几条）被异常栈吞掉，
  // 看起来像「脚本崩了」而不是「夹具没清掉」，等于把可诊断信息换成了误导信息。
  // 改为显式报告 + 保留退出码语义（退出码只反映用例结果）。
  const stuck: string[] = [];
  for (const rel of FIXTURE_DIRS) {
    try {
      await rm(path.join(WORK, rel), { recursive: true, force: true });
    } catch (e) {
      stuck.push(`${rel}（${(e as Error).message.split("\n")[0]}）`);
    }
  }
  if (stuck.length) {
    console.log(`\n⚠️ 夹具清理失败，work/ 有残留（下次运行开头会自动清）：\n  ${stuck.join("\n  ")}`);
  }
}

console.log(`\n结果: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
