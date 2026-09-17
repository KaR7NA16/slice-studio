// 阶段 2 判据验证（真实文件 + 真实服务 + 真实 HTTP，无 fixture/mock）：
//  判据A 手动删一句下游跟着变——覆盖层落盘、合并视图变更、上游指纹变动经 survey 传播
//  判据B 重跑不丢人工——s03 重建后覆盖层决策原样保留；人工 > AI 优先级实测
//  附带：懒依赖诚实（未配 LLM 时 draft 据实报错 b59）、未实现步据实拒绝
// 说明：本机未配 LLM，ai.json 由本脚本手写以模拟 AI 产物（仅此一处），
//       用于验证「人工 > AI」合并优先级；draft 的真实 LLM 通路待配置后可用。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mergeDecisions } from "../src/server/overrides.ts";
import { readJson } from "../src/server/jsonfile.ts";
import type { AiDraftFile, OverlayFile, RunRecord, S03View, SentencesFile, Survey } from "../src/shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const VROOT = path.join(tmpdir(), "slice-verify2");
const FFMPEG = path.join(ROOT, "tools", "ffmpeg", "ffmpeg.exe");
const execFileP = promisify(execFile);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

const SRT = `1
00:00:00,000 --> 00:00:03,000
大家好，欢迎来到今天的直播回放

2
00:00:03,500 --> 00:00:06,500
呃，先等一下，我喝口水

3
00:00:07,000 --> 00:00:10,000
今天讲三个重点，第一个是切片

4
00:00:10,500 --> 00:00:13,000
切片的核心是找到高光时刻

5
00:00:13,500 --> 00:00:16,000
对对对，就是刚才说的那个

6
00:00:16,500 --> 00:00:19,000
第二个重点是配乐要贴情绪

7
00:00:19,500 --> 00:00:23,000
第三个重点是字幕要逐句校对

8
00:00:23,500 --> 00:00:28,000
好，今天就到这里，谢谢大家
`;

async function makeVideo(out: string): Promise<void> {
  const base = ["-y", "-f", "lavfi", "-i", "testsrc=duration=30:size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-shortest"];
  try {
    await execFileP(FFMPEG, [...base, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out]);
  } catch {
    await execFileP(FFMPEG, [...base, "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", out]);
  }
}

let server: ChildProcess | null = null;
let port = 0;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, init);
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

async function runAndWait(owner: string, step: string, mode: string | null): Promise<RunRecord> {
  const rec = await api<RunRecord>("/api/run", { method: "POST", body: JSON.stringify({ owner, step, mode }) });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const cur = await api<RunRecord>(`/api/runs/${rec.id}`);
    if (cur.status !== "running") return cur;
  }
  throw new Error(`run 超时：${owner} ${step}`);
}

const stepState = (s: Survey, ownerKind: "jobs" | "clips", id: string, step: string): string =>
  s[ownerKind].find((o) => o.id === id)?.steps.find((st) => st.step === step)?.status ?? "missing";

async function main(): Promise<void> {
  await rm(VROOT, { recursive: true, force: true });
  await mkdir(path.join(VROOT, "work"), { recursive: true });
  const video = path.join(VROOT, "demo.mp4");
  const srt = path.join(VROOT, "demo.srt");
  console.log("准备真实素材（ffmpeg 生成 30s 视频 + 手写 SRT）…");
  await makeVideo(video);
  await writeFile(srt, SRT, "utf8");

  server = spawn(process.execPath, [path.join(ROOT, "src", "server", "main.ts"), VROOT], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    server!.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    server!.on("exit", () => reject(new Error(`服务提前退出：${buf}`)));
    setTimeout(() => reject(new Error("服务启动超时")), 15000);
  });
  console.log(`服务已起：:${port}\n开始逐项验证：`);

  // A. 建任务 → 导入字幕
  const { id: jobId } = await api<{ id: string }>("/api/jobs", { method: "POST", body: JSON.stringify({ video_path: video, srt_path: srt }) });
  const r1 = await runAndWait(`jobs/${jobId}`, "s00", null);
  check("s00 导入成功", r1.status === "done" && r1.message.includes("8 句"), r1.message);
  const sentences = await api<SentencesFile>(`/api/jobs/${jobId}/sentences`);
  check("句流 8 句", sentences.sentences.length === 8);

  // B. 手动建片段（含 ffprobe 真实探测 fps）
  const { id: clipId } = await api<{ id: string }>("/api/clips", {
    method: "POST",
    body: JSON.stringify({ job_id: jobId, title: "验证片段", start: sentences.sentences[1]!.start, end: sentences.sentences[5]!.end }),
  });
  const clipJson = await readJson<{ fps: string | null }>(path.join(VROOT, "work", "clips", clipId, "clip.json"));
  check("建片段探测 fps（ffprobe 真实跑）", typeof clipJson?.fps === "string" && clipJson.fps.length > 0, String(clipJson?.fps));
  let sv = await api<Survey>("/api/survey");
  check("s01 人工定稿后 ready", stepState(sv, "jobs", jobId, "s01") === "ready", stepState(sv, "jobs", jobId, "s01"));

  // C. s03 构建句流
  const r2 = await runAndWait(`clips/${clipId}`, "s03", null);
  check("s03 构建成功", r2.status === "done", r2.message);
  let view = await api<S03View>(`/api/clips/${clipId}/s03`);
  check("片段句流 5 句（区间交叠）", view.sentences.length === 5, String(view.sentences.length));
  check("默认全留", view.sentences.every((s) => s.keep && s.source === "default"));

  // D. 手动删一句 → 覆盖层落盘 + 合并视图变更（判据A 前半）
  const target = view.sentences[1]!; // 原句「呃，先等一下，我喝口水」
  view = await api<S03View>(`/api/clips/${clipId}/s03/overlay`, { method: "POST", body: JSON.stringify({ sentence_id: target.id, keep: false }) });
  const after = view.sentences.find((s) => s.id === target.id)!;
  check("删留写覆盖层生效", !after.keep && after.source === "human");
  const overlayOnDisk = await readJson<OverlayFile>(path.join(VROOT, "work", "clips", clipId, "s03", "overlay.json"));
  check("overlay.json 真实落盘", overlayOnDisk?.decisions[target.id]?.keep === false);
  check("覆盖层变更不影响 s03 事实状态（仍 ready，不需重跑）", stepState(await api<Survey>("/api/survey"), "clips", clipId, "s03") === "ready");

  // E. 重跑构建 → 人工决策保留（判据B 前半）
  const r3 = await runAndWait(`clips/${clipId}`, "s03", null);
  check("重跑构建成功", r3.status === "done");
  view = await api<S03View>(`/api/clips/${clipId}/s03`);
  const kept = view.sentences.find((s) => s.id === target.id)!;
  check("重跑后人工删除仍在", !kept.keep && kept.source === "human");

  // F. 合并优先级：人工 > AI（ai.json 手写模拟，仅此一处）
  const aiPath = path.join(VROOT, "work", "clips", clipId, "s03", "ai.json");
  const other = view.sentences.find((s) => s.id !== target.id)!;
  const ai1: AiDraftFile = { schema: 1, model: "simulate", at: new Date().toISOString(), decisions: [
    { id: target.id, keep: true, reason: "AI 想留这句" },
    { id: other.id, keep: false, reason: "AI 建议删：重复" },
  ] };
  await writeFile(aiPath, JSON.stringify(ai1), "utf8");
  const m1 = mergeDecisions(view.sentences.map(({ keep: _k, source: _s, reason: _r, ...s }) => s), ai1, overlayOnDisk);
  check("人工删除压过 AI 保留", m1.sentences.find((s) => s.id === target.id)!.keep === false);
  const m1other = m1.sentences.find((s) => s.id === other.id)!;
  check("AI 建议生效并带理由", !m1other.keep && m1other.source === "ai" && m1other.reason === "AI 建议删：重复");
  // AI 重跑（ai.json 被覆盖写）→ 人工决策仍在
  await writeFile(aiPath, JSON.stringify({ ...ai1, decisions: [{ id: target.id, keep: true, reason: "AI 改主意了" }] } satisfies AiDraftFile), "utf8");
  const m2 = mergeDecisions(view.sentences.map(({ keep: _k, source: _s, reason: _r, ...s }) => s), await readJson<AiDraftFile>(aiPath), overlayOnDisk);
  check("AI 重跑后人工决策仍在", m2.sentences.find((s) => s.id === target.id)!.keep === false);
  // 孤儿键据实亮出
  const m3 = mergeDecisions(view.sentences.map(({ keep: _k, source: _s, reason: _r, ...s }) => s), null, { schema: 1, decisions: { "999": { keep: false, at: "" } } });
  check("对不上句子的覆盖键亮为 orphans", m3.orphans.includes("999"));
  await rm(aiPath, { force: true });

  // G. 上游变动传播（判据A 后半）：source.srt 追加一句 → s00 stale → s01 suspect
  const srcSnap = path.join(VROOT, "work", "jobs", jobId, "source.srt");
  const orig = await readFile(srcSnap, "utf8");
  await writeFile(srcSnap, orig + "\n9\n00:00:28,500 --> 00:00:29,500\n追加的一句\n", "utf8");
  sv = await api<Survey>("/api/survey");
  check("上游字幕变 → s00 stale", stepState(sv, "jobs", jobId, "s00") === "stale", stepState(sv, "jobs", jobId, "s00"));
  check("s01 随上游变 suspect（同 owner 传播 b28）", stepState(sv, "jobs", jobId, "s01") === "suspect", stepState(sv, "jobs", jobId, "s01"));
  // 重跑 s00 → 句流内容变 → s03 stale（跨 owner 指纹）
  const r4 = await runAndWait(`jobs/${jobId}`, "s00", null);
  check("s00 重跑成功（9 句）", r4.status === "done" && r4.message.includes("9 句"), r4.message);
  sv = await api<Survey>("/api/survey");
  check("s03 因输入句流变而 stale（跨 owner 指纹）", stepState(sv, "clips", clipId, "s03") === "stale", stepState(sv, "clips", clipId, "s03"));
  // 还原 source.srt → 重跑产物逐字节相同 → 自动回 ready（b27）
  await writeFile(srcSnap, orig, "utf8");
  await runAndWait(`jobs/${jobId}`, "s00", null);
  sv = await api<Survey>("/api/survey");
  check("产物逐字节相同自动回 ready（b27）", stepState(sv, "clips", clipId, "s03") === "ready", stepState(sv, "clips", clipId, "s03"));

  // H. 懒依赖诚实（b59）：未配 LLM，draft 据实报错
  const r5 = await runAndWait(`clips/${clipId}`, "s03", "draft");
  check("未配 LLM 时 draft 据实失败", r5.status === "error" && (r5.error ?? "").includes("未配置 LLM"), r5.error ?? "");
  const llm = await api<{ ok: boolean; reason?: string }>("/api/llm");
  check("/api/llm 回报未配置+原因", !llm.ok && (llm.reason ?? "").includes("未配置"));

  // I. 未实现步据实拒绝
  const rejected = await fetch(`http://127.0.0.1:${port}/api/run`, { method: "POST", body: JSON.stringify({ owner: `clips/${clipId}`, step: "s05" }) });
  check("s05 据实报「属阶段 3」", rejected.status === 400 && ((await rejected.json()) as { error: string }).error.includes("阶段 3"));

  // J. 媒体 Range（播放器拖动必需）
  const full = await fetch(`http://127.0.0.1:${port}/api/media/job/${jobId}/video`);
  const ranged = await fetch(`http://127.0.0.1:${port}/api/media/job/${jobId}/video`, { headers: { range: "bytes=0-1023" } });
  check("视频流 200 + Range 206", full.status === 200 && ranged.status === 206 && ranged.headers.get("content-range")?.startsWith("bytes 0-1023/") === true);

  await writeFile(path.join(VROOT, "verify-ids.json"), JSON.stringify({ jobId, clipId }), "utf8");
  console.log(`\n结果：${passed} PASS / ${failed} FAIL（素材根 ${VROOT}，job=${jobId} clip=${clipId}）`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("验证中断：", e);
    process.exitCode = 1;
  })
  .finally(() => {
    server?.kill();
  });
