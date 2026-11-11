// 阶段 2 判据验证（真实文件 + 真实服务 + 真实 HTTP，无 fixture/mock）：
//  判据A 手动删一句下游跟着变——覆盖层落盘、合并视图变更、上游指纹变动经 survey 传播
//  判据B 重跑不丢人工——s03 重建后覆盖层决策原样保留；人工 > AI 优先级实测
//  附带：懒依赖诚实（未配 LLM 时 draft 据实报错 b59）、未实现步据实拒绝
// 说明：本机未配 LLM，ai.json 由本脚本手写以模拟 AI 产物（仅此一处），
//       用于验证「人工 > AI」合并优先级；draft 的真实 LLM 通路待配置后可用。
// 只为副作用导入（改写 TEMP/TMP 到项目盘上的 work/_scratch，供子进程用），本文件不用 SCRATCH。
// 本文件的夹具根 VROOT 走 SYSTEM_TEMP 并在 .finally 里整棵删掉，不进项目盘。
import { SYSTEM_TEMP } from "./scratchdir.ts";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { mergeDecisions } from "../src/server/overrides.ts";
import { readJson, writeJsonAtomic } from "../src/server/jsonfile.ts";
import { survey } from "../src/server/survey.ts";
import { acquire, resourceOf } from "../src/server/slots.ts";
import { readDemucsStats } from "../src/steps/demucspool.ts";
import { pythonChildEnv } from "../src/steps/toolenv.ts";
import { finishStep, commitVariant, inputRef, removeQuietly } from "../src/steps/lib.ts";
import { parseSrt } from "../src/steps/s00.ts";
import { sanitizeHighlights } from "../src/steps/s01.ts";
import { runS02 } from "../src/steps/s02.ts";
import { buildS03 } from "../src/steps/s03.ts";
import { runS04 } from "../src/steps/s04.ts";
import { runS05 } from "../src/steps/s05.ts";
import type {
  AiDraftFile,
  AutomationView,
  BgmFile,
  ClipFile,
  LazyDep,
  LlmSave,
  LlmView,
  OverlayFile,
  RunRecord,
  S03View,
  S04View,
  SentencesFile,
  StepFile,
  Survey,
  VariantsView,
} from "../src/shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
// 每次运行用唯一素材根：clip id 由 job/start/end/title 哈希稳定复现，固定名根上残留的
// s04 run 会被 /api/runs 重新读到，把「档位=人工时不自动跑」读成假红（2026-11-09 实测）。
// 唯一根让「先清旧根」不再必要，也就绕开了删除守卫的 turn 级配额。
// 建在**系统临时目录**而不是项目盘 work/_scratch：这份素材根是一次性的（收尾会删），
// 放项目盘的话任何一次中断都会永久留 1.8MB，堆起来就是历史那 8 份残留。
const VROOT = await mkdtemp(path.join(SYSTEM_TEMP, "slice-verify2-"));
const FFMPEG = path.join(ROOT, "tools", "ffmpeg", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "tools", "ffmpeg", "ffprobe.exe");
const execFileP = promisify(execFile);

// 「让文件不在原路径」统一走 rename 而不是 rm：用例语义是「不存在」而非「被销毁」，
// 且沙箱对删除有配额（阈值 50/turn，第 5 轮实测累计到 290+ 就全被拦）——rm 会抛
// SAFE_DELETE_BULK_CONFIRM_REQUIRED，把一条断言变成一次脚本崩溃。序号保证目标名唯一，重跑不撞车。
let goneSeq = 0;
const gone = (p: string): Promise<void> => rename(p, `${p}.gone${goneSeq++}`);

// 素材包是手写 ZIP（stored，零依赖）。断言「文件存在」只能证明形式，所以这里真解析一遍结构：
// EOCD → central directory → 逐条读文件名与大小。解析器只覆盖必要字段（本包不压缩、无 extra/comment）。
function zipEntries(buf: Buffer): { name: string; size: number }[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: { name: string; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const size = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    out.push({ name: buf.subarray(off + 46, off + 46 + nlen).toString("utf8"), size });
    off += 46 + nlen + elen + clen;
  }
  return out;
}

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

// 与 runAndWait 同，但把轮询期间见过的 progress_detail 全收集起来。
// 「进度只写在终态记录里」是查不出问题的——收尾会清空它，必须在中途采样。
async function runAndSample(owner: string, step: string): Promise<{ rec: RunRecord; details: string[] }> {
  const rec = await api<RunRecord>("/api/run", { method: "POST", body: JSON.stringify({ owner, step, mode: null }) });
  const details: string[] = [];
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const cur = await api<RunRecord>(`/api/runs/${rec.id}`);
    if (cur.progress_detail && details.at(-1) !== cur.progress_detail) details.push(cur.progress_detail);
    if (cur.status !== "running") return { rec: cur, details };
  }
  throw new Error(`run 采样超时：${owner} ${step}`);
}

const stepState = (s: Survey, ownerKind: "jobs" | "clips", id: string, step: string): string =>
  s[ownerKind].find((o) => o.id === id)?.steps.find((st) => st.step === step)?.status ?? "missing";

async function main(): Promise<void> {
  // VROOT 是本次 mkdtemp 新建的唯一目录，天然干净：不再需要「先清旧根」，
  // 也不再有删除守卫耗尽配额导致旧夹具残留、污染断言的可能。
  await mkdir(path.join(VROOT, "work"), { recursive: true });
  // 产品在「从没写过 llm」时会自动用免密钥接口。这套回归要守的是「显式清空 = 未配置」，
  // 所以验收根先写一份空的 llm，别让免密钥把「未配置」的断言跑成真请求。
  await writeFile(path.join(VROOT, "config.json"), JSON.stringify({ llm: { profiles: [], default_id: null } }), "utf8");
  const video = path.join(VROOT, "demo.mp4");
  const srt = path.join(VROOT, "demo.srt");
  console.log("准备真实素材（ffmpeg 生成 30s 视频 + 手写 SRT）…");
  await makeVideo(video);
  await writeFile(srt, SRT, "utf8");

  // 服务进程继承这里的环境：把转写切成小块，进度才会连续来几条、采样才抓得住。
  // 默认 30s 一块在 10s 夹具上只报一次，那一次大概率落在两次轮询之间，等于没测。
  // 只影响这条验证，产品默认值不动（切太碎会掉识别质量，见 asr_worker.py 的注释）。
  process.env["SLICE_ASR_CHUNK_SEC"] = "3";
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

  // A2. 上次转写被中断留下的临时件，下一次跑 s00 要清掉。
  //    取消是**整棵进程树被杀**，runS00 末尾那句 removeQuietly 跑不到，所以中断的 run
  //    一定会留一份 jobDir/_asr（8 分钟音频约 15MB）。这里不真跑转写：造一份假的残留，
  //    走 SRT 路径跑一次 s00，看它有没有被清——顺带证明「换源」也清，
  //    只清转写路径的话换 SRT 这种场景就漏了。
  const exists = (p: string): Promise<boolean> => stat(p).then(() => true).catch(() => false);
  const asrLeftover = path.join(VROOT, "work", "jobs", jobId, "_asr");
  await mkdir(asrLeftover, { recursive: true });
  await writeFile(path.join(asrLeftover, "asr-16k.wav"), "dummy", "utf8");
  check("前置：造出一份上次转写的残留", await exists(path.join(asrLeftover, "asr-16k.wav")));
  const r1b = await runAndWait(`jobs/${jobId}`, "s00", null);
  check("重跑 s00 成功（走 SRT 路径）", r1b.status === "done" && r1b.message.includes("8 句"), r1b.message);
  check("上次中断留下的 _asr 临时目录被清掉", !(await exists(asrLeftover)), asrLeftover);

  // A3. s00 的 **ASR 路径**（不带 SRT）——b2「SRT 优先、ASR 兜底」的另一半。
  //    在此之前所有判据都带 srt 建任务，走的一直是解析分支，转写分支只有手工验证覆盖过。
  //    夹具是 tools/fixtures/asr-sample.mp4：从真实讲解视频裁的 10s（320x180、单声道 16k、97KB），
  //    压缩后仍能被 Paraformer 识别出 4 句中文。入库而不是现场合成——现场合成只能造正弦波，
  //    转写路径「能跑」但「识别不出东西」等于没测。
  //    依赖本机 models/asr 权重（不进版本库，随绿色目录分发）；权重缺失时这条会如实变红而不是跳过。
  const asrVideo = path.join(ROOT, "tools", "fixtures", "asr-sample.mp4");
  check("前置：ASR 夹具存在（缺了就是夹具没入库）", await exists(asrVideo), asrVideo);
  const { id: asrJob } = await api<{ id: string }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ video_path: asrVideo, srt_path: null }),
  });
  const { rec: rAsr, details: asrDetails } = await runAndSample(`jobs/${asrJob}`, "s00");
  check("无 SRT 时 s00 走转写并成功", rAsr.status === "done", rAsr.message);
  // 文案本身就区分了两条路（「本地转写 N 句」vs「解析 N 句」），所以它能证明走的是哪一支，
  // 不是只看「没报错」——没报错也可能是走了 SRT 分支而 srt 恰好不存在。
  check("确认走的是转写分支", rAsr.message.includes("本地转写"), rAsr.message);
  // 服务层有没有把 worker 的进度搬到 run 记录上：采样看得见多个不同值才算数。
  // 只在终态查是查不出来的——收尾会把 progress_detail 清掉（下一条正是断言这件事）。
  check("转写过程中连续进度被写进 run 记录", asrDetails.length >= 2, asrDetails.join(" | "));
  check(
    "连续进度是「已处理 / 总长」的读数，不是百分比或空串",
    // 带上长度前置同前：空数组 every 恒真，不写就是一条只会在别的判据红时才「看起来对」的假判据。
    asrDetails.length >= 2 && asrDetails.every((d) => /^\d+:\d{2} \/ \d+:\d{2}$/.test(d)),
    asrDetails.join(" | "),
  );
  check(
    "连续进度在推进（不是同一个值反复写）",
    new Set(asrDetails).size >= 2,
    String(new Set(asrDetails).size),
  );
  check("跑完把连续进度抹掉了（否则界面停在最后一格）", rAsr.progress_detail == null, String(rAsr.progress_detail));
  const asrSent = await api<SentencesFile>(`/api/jobs/${asrJob}/sentences`);
  check("转写真的出了句子（不是空跑通过）", asrSent.sentences.length >= 2, String(asrSent.sentences.length));
  // 时间码必须落在音频真实时长内：出句但时间码越界，等于 VAD 切分或偏移有问题。
  // 前面必须显式带 length > 0——`[].every(...)` 恒为 true，零句时这条会假装通过。
  // 注入「转写零句静默成功」实测过这一点：不加上限时只有「出了句子」那条红，这条仍是绿的。
  check(
    "转写时间码落在音频时长内（0 ≤ t ≤ 10.5s）",
    asrSent.sentences.length > 0 && asrSent.sentences.every((s) => s.start >= 0 && s.end <= 10.5),
    asrSent.sentences.map((s) => `${s.start}-${s.end}`).join(",") || "(无句子)",
  );
  check("转写路径跑完自己的临时件也清掉了", !(await exists(path.join(VROOT, "work", "jobs", asrJob, "_asr"))));
  check("转写作了缓存并登记 job.srt", await exists(path.join(VROOT, "work", "jobs", asrJob, "s00", "job.srt")));

  // A4. 转写进度的**数据侧**：worker 每切一块就报一次「已处理到哪儿」。
  //     这里不经过服务、也不经过界面——那两层各有自己的判据，这条只证明进度本身在单调推进。
  //     必须调小切块：10s 音频按默认 30s 切只有一块、只报一次，「递增」无从证明。
  //     （副作用已知：切太碎会掉识别质量，所以 chunk-sec 只用于验证，不改产品默认值。）
  const PY = path.join(ROOT, "tools", "python", "venv", "Scripts", "python.exe");
  const progWav = path.join(VROOT, "prog.wav");
  await execFileP(FFMPEG, ["-y", "-v", "error", "-i", asrVideo, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", progWav]);
  const pyOut = await execFileP(
    PY,
    ["-m", "asr_worker", "--audio", progWav, "--model-dir", path.join(ROOT, "models", "asr"), "--chunk-sec", "3"],
    {
      cwd: path.join(ROOT, "tools"),
      env: { ...process.env, PYTHONPATH: path.join(ROOT, "tools"), PYTHONIOENCODING: "utf-8" },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const progEvents = pyOut.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as { done_sec?: number; total_sec?: number })
    .filter((o): o is { done_sec: number; total_sec: number } => typeof o.done_sec === "number" && typeof o.total_sec === "number");
  check("进度事件不止一条（切多块才可能递增）", progEvents.length >= 2, String(progEvents.length));
  check(
    "进度单调递增（不是原地跳或倒退）",
    progEvents.every((e, i) => i === 0 || e.done_sec > progEvents[i - 1]!.done_sec),
    progEvents.map((e) => e.done_sec).join("→"),
  );
  check(
    "进度末值落在音频总长上（分母是真的，不是估的）",
    progEvents.length > 0 && Math.abs(progEvents.at(-1)!.done_sec - progEvents.at(-1)!.total_sec) < 0.5,
    progEvents.length ? `${progEvents.at(-1)!.done_sec} / ${progEvents.at(-1)!.total_sec}` : "(无进度)",
  );

  // A5. 换字幕源：已有任务不该只能靠「重建任务」换字幕（P2-2）。
  //     语义是**换一份源**，不是同一份重算——所以 AI 候选要清、人工删留按内容哈希自然进孤儿。
  //     选中转写出来的那个任务来换：它原本没有 source.srt，正好证明「没有也能补挂」。
  const swapSrt = path.join(VROOT, "swap.srt");
  const SWAP_SRT = `1
00:00:00,000 --> 00:00:02,000
换成的新字幕第一句

2
00:00:02,500 --> 00:00:04,500
换成的新字幕第二句

3
00:00:05,000 --> 00:00:07,000
换成的新字幕第三句
`;
  await writeFile(swapSrt, SWAP_SRT, "utf8");
  // 先造一条 AI 候选：换源后它对应的句子已经不存在，留着就是解释不了来历的孤儿
  const swapAiPath = path.join(VROOT, "work", "jobs", asrJob, "s01", "ai.json");
  await mkdir(path.dirname(swapAiPath), { recursive: true });
  await writeJsonAtomic(swapAiPath, {
    schema: 1,
    model: "stub",
    at: new Date().toISOString(),
    decisions: [{ id: "deadbeefdead", keep: true, reason: "旧句子的候选" }],
  });
  check("前置：造出一条旧 AI 候选", await exists(swapAiPath), swapAiPath);
  const swapRes = await api<{ ok: boolean; sentences: number; ai_cleared: boolean }>(
    `/api/jobs/${asrJob}/subtitle`,
    { method: "POST", body: JSON.stringify({ srt_path: swapSrt }) },
  );
  check("换源接口报出解析到的句数", swapRes.ok === true && swapRes.sentences === 3, JSON.stringify(swapRes));
  check(
    "source.srt 换成了新内容",
    (await readFile(path.join(VROOT, "work", "jobs", asrJob, "source.srt"), "utf8")) === SWAP_SRT,
  );
  check("AI 候选被清掉（换源后它对应不到任何句子）", !(await exists(swapAiPath)), swapAiPath);
  const rSwap = await runAndWait(`jobs/${asrJob}`, "s00", null);
  check("换源后重建走解析路径（不再转写）", rSwap.status === "done" && rSwap.message.includes("解析 3 句"), rSwap.message);
  const swapSent = await api<SentencesFile>(`/api/jobs/${asrJob}/sentences`);
  check(
    "句子真的换成了新字幕的内容",
    swapSent.sentences.length === 3 && swapSent.sentences[0]!.text.includes("换成的新字幕"),
    swapSent.sentences.map((s) => s.text).join(" / "),
  );
  // 错误分支：换上一份解析不出东西的字幕，等于把这个任务改成「必然失败」，
  // 而用户只会以为「选错文件了」。宁可当场拒。
  const emptySrt = path.join(VROOT, "empty-swap.srt");
  await writeFile(emptySrt, "没有时间码的一行字\n", "utf8");
  const postSub = (job: string, srt: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api/jobs/${job}/subtitle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ srt_path: srt }),
    });
  check("解析不出句子的字幕被拒（400）", (await postSub(asrJob, emptySrt)).status === 400);
  check("不存在的字幕路径被拒（400）", (await postSub(asrJob, path.join(VROOT, "nope.srt"))).status === 400);
  check("不存在的任务被拒（404）", (await postSub("ghost-job", swapSrt)).status === 404);

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
  // N-4：未构建改成 200 + built:false，所以「跑成功了却没有句流」不再以异常形式暴露，
  // 必须显式问 built——否则下一步取 sentences[0] 会拿到 undefined，报出来的错离病根很远。
  check("s03 视图自报已构建", view.built === true, `built=${String(view.built)}`);
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
  // AI 侧孤儿同样要亮（P3-3）：ai.json 里对不上当前句流的键，s00 重解析后就会出现。
  // 它和人工键一样是「对某个句子做过的判断」，凭空消失就是留痕丢失。
  // 一条断言同时管两件事：两侧孤儿都收得到（888 只在 AI 侧、999 只在人工侧）、
  // 同一 id 两侧都出现时只报一次（777）。**故意不拆开**——单测「只报一次」时，
  // 「只收人工一侧」的错误实现也会通过（天然不重复），那种守护抓不住回归。
  const baseOnly = view.sentences.map(({ keep: _k, source: _s, reason: _r, ...s }) => s);
  const m4 = mergeDecisions(
    baseOnly,
    { schema: 1, model: "simulate", at: "", decisions: [{ id: "777", keep: false, reason: "" }, { id: "888", keep: false, reason: "AI 对旧句子的判断" }] },
    { schema: 1, decisions: { "777": { keep: true, at: "" }, "999": { keep: false, at: "" } } },
  );
  check("AI 侧与人工侧的孤儿都亮，且同 id 只报一次（P3-3 回归）",
    m4.orphans.slice().sort().join(",") === "777,888,999", m4.orphans.join(","));
  await gone(aiPath); // 让 ai.json「不在原路径」，不销毁它（见文件头 gone 的说明）

  // F2. 回归（P1-1）：同一步多模式不得互相覆盖输入集
  //   背景：draft 只登记 s03/sentences.json；若 finishStep 的 inputs 是直接覆盖，
  //   build 登记的 clip.json 与 s00/sentences.json 会被抹掉 → 此后改片段区间或改 s00 句流，
  //   s03 都仍读 ready（假就绪）。本机无 LLM，故按 draft 的真实登记方式直调 finishStep
  //   （与上面手写 ai.json 同性质：只模拟「谁调用了」，不模拟机制本身）。
  const stepPath = path.join(VROOT, "work", "clips", clipId, "s03", "step.json");
  const keysOf = async (): Promise<string[]> =>
    ((await readJson<StepFile>(stepPath))?.inputs ?? []).map((i) => i.key).sort();
  const keysBefore = await keysOf();
  check("build 后 s03 登记了 clip.json + s00/sentences.json",
    keysBefore.includes("clip.json") && keysBefore.includes("s00/sentences.json"), keysBefore.join(","));
  await finishStep(VROOT, `clips/${clipId}`, "s03",
    [await inputRef(VROOT, "sentences.json", `clips/${clipId}/s03/sentences.json`)], ["ai.json"]);
  const keysAfter = await keysOf();
  check("draft 登记后 build 的输入未被抹掉（P1-1 回归）",
    keysAfter.includes("clip.json") && keysAfter.includes("s00/sentences.json"), keysAfter.join(","));
  check("draft 自己的输入也在（并集而非替换）", keysAfter.includes("sentences.json"), keysAfter.join(","));
  // 并集必须真的让上游变化可被侦测，否则只是记了个没用的字段
  const clipPath = path.join(VROOT, "work", "clips", clipId, "clip.json");
  const clipOrig = await readFile(clipPath, "utf8");
  await writeFile(clipPath, clipOrig.replace(/"end": [\d.]+/, '"end": 12.5'), "utf8");
  const afterDraftState = stepState(await api<Survey>("/api/survey"), "clips", clipId, "s03");
  check("draft 之后改 clip.json → s03 stale（P1-1 回归核心）", afterDraftState === "stale", afterDraftState);
  await writeFile(clipPath, clipOrig, "utf8");
  const restoredState = stepState(await api<Survey>("/api/survey"), "clips", clipId, "s03");
  check("还原 clip.json → s03 自动回 ready", restoredState === "ready", restoredState);
  // build 会重写 draft 登记过的 sentences.json。并集若冻住旧指纹，这次成功的 build 一结束就是 stale，
  // 而且再跑 build 也清不掉（build 不刷新那把 key）。
  const sentPath = path.join(VROOT, "work", "clips", clipId, "s03", "sentences.json");
  const sentOrig = await readFile(sentPath);
  await writeFile(sentPath, Buffer.concat([sentOrig, Buffer.from("\n")]));
  await finishStep(
    VROOT,
    `clips/${clipId}`,
    "s03",
    [
      await inputRef(VROOT, "clip.json", `clips/${clipId}/clip.json`),
      await inputRef(VROOT, "s00/sentences.json", `jobs/${jobId}/s00/sentences.json`),
    ],
    ["sentences.json"],
  );
  check(
    "build 重写 draft 登记的句流后仍 ready",
    stepState(await api<Survey>("/api/survey"), "clips", clipId, "s03") === "ready",
    stepState(await api<Survey>("/api/survey"), "clips", clipId, "s03"),
  );
  await writeFile(sentPath, sentOrig);
  check(
    "句流再被改掉 → s03 stale（key 还在盯着）",
    stepState(await api<Survey>("/api/survey"), "clips", clipId, "s03") === "stale",
    stepState(await api<Survey>("/api/survey"), "clips", clipId, "s03"),
  );
  await finishStep(
    VROOT,
    `clips/${clipId}`,
    "s03",
    [
      await inputRef(VROOT, "clip.json", `clips/${clipId}/clip.json`),
      await inputRef(VROOT, "s00/sentences.json", `jobs/${jobId}/s00/sentences.json`),
    ],
    ["sentences.json"],
  );
  check("句流按这次产物重新登记后回 ready", stepState(await api<Survey>("/api/survey"), "clips", clipId, "s03") === "ready");
  const inserted = parseSrt("1\n00:00:00,100 --> 00:00:00,400\n插在前面\n\n" + SRT);
  const plain = parseSrt(SRT);
  check(
    "SRT 开头插一句，原句 id 不变",
    plain.length > 0 && inserted.slice(1).every((s, i) => s.id === plain[i]!.id),
    `${plain[0]?.id} / ${inserted[1]?.id}`,
  );
  check("句子 id 不是出现序号", plain[0]!.id !== "0", plain[0]!.id);

  // F3. 顺序无关性（P2-4）：并集语义必须对调用顺序不敏感。
  //   为什么单独测：P1-1 之所以能藏很久，正是因为原用例把 draft 排在最后，
  //   只覆盖了「build 在前」这一种序列。这里用两个互不相干的 scratch owner
  //   把两种序列各跑一遍，断言最终登记的输入集**完全相同**。
  //   落在 work/scratch/ 下（不是 work/clips/），survey 不扫这个目录，不会污染后续断言。
  const seqKeys = async (owner: string, order: "build-first" | "draft-first"): Promise<string[]> => {
    const buildSide = [
      await inputRef(VROOT, "clip.json", `clips/${clipId}/clip.json`),
      await inputRef(VROOT, "s00/sentences.json", `jobs/${jobId}/s00/sentences.json`),
    ];
    const draftSide = [await inputRef(VROOT, "sentences.json", `clips/${clipId}/s03/sentences.json`)];
    for (const side of order === "build-first" ? [buildSide, draftSide] : [draftSide, buildSide]) {
      await finishStep(VROOT, owner, "s03", side, []);
    }
    const file = await readJson<StepFile>(path.join(VROOT, "work", owner, "s03", "step.json"));
    return (file?.inputs ?? []).map((i) => i.key).sort();
  };
  const seqA = await seqKeys("scratch/p24-build-first", "build-first");
  const seqB = await seqKeys("scratch/p24-draft-first", "draft-first");
  check("两种调用顺序得到同一输入集（P2-4 顺序无关）", seqA.join(",") === seqB.join(","), `${seqA.join(",")} vs ${seqB.join(",")}`);
  check("build-first：build 的输入未被后跑的 draft 抹掉", seqA.includes("clip.json") && seqA.includes("s00/sentences.json"), seqA.join(","));
  check("draft-first：draft 的输入未被后跑的 build 抹掉", seqB.includes("sentences.json"), seqB.join(","));
  check("两个序列都含全部 3 条输入（并集无遗漏）", seqA.length === 3 && seqB.length === 3, `${seqA.length} / ${seqB.length}`);

  // F4. 待办条不被遮蔽（P3-1）：同 owner 里排在前面的未跑步，不得挡住排在后面的 error。
  //   构造的正是真实会发生的形态——s02 没跑（empty），s03 跑挂了（error）。
  //   旧逻辑遇 empty 即 break，于是待办条只会说「s02 未跑」，而 s03 的 error 消失；
  //   卡片视图却照样显示 s03 出错 → 两处视图不一致。
  const todoClip = "p31-todo";
  const todoDir = path.join(VROOT, "work", "clips", todoClip);
  await mkdir(path.join(todoDir, "s03"), { recursive: true });
  await writeFile(path.join(todoDir, "clip.json"), JSON.stringify({
    schema: 1, id: todoClip, job_id: jobId, title: "待办条用例", start: 0, end: 1, fps: null,
  } satisfies ClipFile), "utf8");
  await writeFile(path.join(todoDir, "s03", "step.json"), JSON.stringify({
    schema: 1, step: "s03", finished_at: new Date().toISOString(), inputs: [], outputs: [], error: "模拟失败：句流为空",
  } satisfies StepFile), "utf8");
  const todoMine = (await survey(VROOT)).todo.filter((t) => t.owner === todoClip);
  check("s02 未跑不遮蔽 s03 的 error（P3-1 回归）",
    todoMine.some((t) => t.step === "s03" && t.text.includes("出错")), JSON.stringify(todoMine));
  check("s03 有 error 时不再额外提示「s02 未跑」（不刷屏）",
    !todoMine.some((t) => t.step === "s02"), JSON.stringify(todoMine));

  // F5. 参数校验（P3-5）：缺 runId 必须显式失败。
  //   旧行为：runFile() 拼出 "undefined.json"，patchRun 读不到就静默 return，
  //   进度与完成状态一个都不落盘，子进程仍以 0 退出 —— 调用方看到的是「成功」。
  //   两个细节是**故意**的，少了任何一个这条断言就抓不住回归：
  //   ① 用真实存在的 jobId + s00（不是随便一个 owner）——否则 runS00 自己会抛
  //      「job 不存在」，退出码本来就不是 0，断言 `!== 0` 会白过（第一版就踩了这个坑）。
  //   ② 断言退出码恰为 2（用法错误的约定）而不是「非 0」，才能把「校验拦下」和
  //      「下游自己崩了」区分开。
  //   副作用：修复生效时校验在最前面拦下，s00 根本不会执行，对本 root 零改动。
  const bad = await new Promise<{ code: number; err: string }>((resolve) => {
    const c = spawn(
      process.execPath,
      [path.join(ROOT, "src", "steps", "run.ts"), VROOT, `jobs/${jobId}`, "s00", "", ""],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    c.stderr.on("data", (d) => (err += String(d)));
    c.on("exit", (code) => resolve({ code: code ?? -1, err }));
  });
  check("缺 runId 时 run.ts 以用法错误退出（P3-5 回归）",
    bad.code === 2 && bad.err.includes("用法"), `${bad.code} / ${bad.err.trim()}`);

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

  // I. 白名单守卫（阶段 3 收口后六步全部落地，「未实现的步」已经没有举例对象了）。
  // 本条改守两件仍然有意义的事，都是白名单真正的防线：
  //   ① 未知步名被拒——否则将来新增/改名时的笔误会静默放行一个不存在的步；
  //   ② **跨级步**被拒——jobs/<id> 上跑 s02（片段级）必须 400，否则子进程会拿到一个
  //      它不知道该往哪写 owner 的步，产物落到 jobs/<id>/s02/ 里，而 survey 永远看不见它。
  const unknown = await fetch(`http://127.0.0.1:${port}/api/run`, { method: "POST", body: JSON.stringify({ owner: `clips/${clipId}`, step: "s99" }) });
  check("未知步 s99 被拒（400）", unknown.status === 400, `${unknown.status}`);
  const crossLevel = await fetch(`http://127.0.0.1:${port}/api/run`, { method: "POST", body: JSON.stringify({ owner: `jobs/${jobId}`, step: "s02" }) });
  check("跨级步（jobs 上跑 s02）被拒（400）", crossLevel.status === 400, `${crossLevel.status}`);
  const escaped = await fetch(`http://127.0.0.1:${port}/api/run`, {
    method: "POST",
    body: JSON.stringify({ owner: "clips/../../outside", step: "s05" }),
  });
  check("owner 带 .. 被拒（400）", escaped.status === 400, `${escaped.status}`);
  const reimport = await api<{ id: string }>("/api/jobs", { method: "POST", body: JSON.stringify({ video_path: video, srt_path: null }) });
  const snapGone = await stat(path.join(VROOT, "work", "jobs", jobId, "source.srt")).then(() => true).catch(() => false);
  check("同一视频不带字幕重建会清掉 source.srt", reimport.id === jobId && !snapGone, `${reimport.id} / ${snapGone}`);
  await api("/api/jobs", { method: "POST", body: JSON.stringify({ video_path: video, srt_path: srt }) });
  check(
    "原字幕放回后 s00 仍 ready",
    stepState(await api<Survey>("/api/survey"), "jobs", jobId, "s00") === "ready",
    stepState(await api<Survey>("/api/survey"), "jobs", jobId, "s00"),
  );
  // 反过来：已落地的步必须被白名单接受——漏加这一步 UI 里就永远点不动，
  // 而「忘了加」不会让任何既有断言变红，所以要逐个守一条（不是只守最新那个）。
  // 刻意用不存在的 owner：只为验证白名单放行，不让它真跑起来污染夹具。
  for (const s of ["s00", "s01"]) {
    const accepted = await fetch(`http://127.0.0.1:${port}/api/run`, { method: "POST", body: JSON.stringify({ owner: "jobs/__whitelist_probe__", step: s }) });
    check(`${s} 已进白名单（job 级）`, accepted.status === 200, `${s}: ${accepted.status}`);
  }
  for (const s of ["s02", "s03", "s04", "s05"]) {
    const accepted = await fetch(`http://127.0.0.1:${port}/api/run`, { method: "POST", body: JSON.stringify({ owner: "clips/__whitelist_probe__", step: s }) });
    check(`${s} 已进白名单（clip 级）`, accepted.status === 200, `${s}: ${accepted.status}`);
  }
  const [busyA, busyB] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/run`, { method: "POST", body: JSON.stringify({ owner: "clips/__busy_probe__", step: "s05" }) }),
    fetch(`http://127.0.0.1:${port}/api/run`, { method: "POST", body: JSON.stringify({ owner: "clips/__busy_probe__", step: "s05" }) }),
  ]);
  const busyCodes = [busyA.status, busyB.status].sort((a, b) => a - b);
  check("同一步同时起两次：一个接受、一个 409", busyCodes[0] === 200 && busyCodes[1] === 409, busyCodes.join("/"));

  // J. 媒体 Range（播放器拖动必需）
  const full = await fetch(`http://127.0.0.1:${port}/api/media/job/${jobId}/video`);
  const ranged = await fetch(`http://127.0.0.1:${port}/api/media/job/${jobId}/video`, { headers: { range: "bytes=0-1023" } });
  check("视频流 200 + Range 206", full.status === 200 && ranged.status === 206 && ranged.headers.get("content-range")?.startsWith("bytes 0-1023/") === true);
  const ghostDir = path.join(VROOT, "work", "jobs", "ghost-video");
  await mkdir(ghostDir, { recursive: true });
  await writeFile(
    path.join(ghostDir, "job.json"),
    JSON.stringify({ schema: 1, id: "ghost-video", video_path: path.join(VROOT, "no-such-video.mp4"), srt_path: null, created_at: "2026-01-01T00:00:00.000Z" }),
    "utf8",
  );
  const ghost = await fetch(`http://127.0.0.1:${port}/api/media/job/ghost-video/video`);
  check("源视频不在 → 404（不是 500）", ghost.status === 404, String(ghost.status));

  // K. clip 媒体出口（P1-2）+ 惰性依赖消费（P2-3）+ 契约产物（P1-4）：同一份真实产物上验证。
  //   出口白名单 = 该步 step.json 自己登记的 outputs（并集语义，所以 s03 的 sentences.json
  //   与 ai.json 都该可取）；lazy.available 走另一条判据——STEPS[].artifacts 契约产物是否齐备
  //   （P1-4 起与 survey 的状态判定同源）。白名单宽（登记过就能取）、可用性严（契约缺一即不可用），
  //   两者回答的不是同一个问题，刻意不合并。
  const s02dir = path.join(VROOT, "work", "clips", clipId, "s02");
  await mkdir(s02dir, { recursive: true });
  const vocals = path.join(s02dir, "vocals.wav");
  await execFileP(FFMPEG, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "44100", "-ac", "2", vocals]);
  const vocalSize = (await stat(vocals)).size;
  // s02 的契约是 vocals.wav + no_vocals.wav（demucs 一次分离必然同时产出两者，见 STEPS 注释）。
  // 夹具必须与 STEPS[].artifacts 对齐，否则 s02 会被判 missing、lazy.available 也跟着变 false。
  await execFileP(FFMPEG, ["-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-ar", "44100", "-ac", "2", path.join(s02dir, "no_vocals.wav")]);
  // s02 的输入刻意挂一个独立文件（work/scratch/ 不在 survey 扫描范围，也不牵连其它步）：
  // 只有把 s02 单独弄脏，才能观察 s03 会不会被连带标脏——这是「惰性不阻塞」的判别条件。
  const s02in = path.join(VROOT, "work", "scratch", "s02-in.bin");
  await mkdir(path.dirname(s02in), { recursive: true });
  await writeFile(s02in, "v1", "utf8");
  await finishStep(VROOT, `clips/${clipId}`, "s02", [await inputRef(VROOT, "s02-input", "scratch/s02-in.bin")], ["vocals.wav", "no_vocals.wav"]);

  const media = (p: string, init?: RequestInit): Promise<Response> => fetch(`http://127.0.0.1:${port}${p}`, init);
  const mFull = await media(`/api/media/clip/${clipId}/s02/vocals.wav`);
  check("clip 媒体出口：登记产物可取（200 + audio/wav + 长度一致）",
    mFull.status === 200 && mFull.headers.get("content-type") === "audio/wav" && Number(mFull.headers.get("content-length")) === vocalSize,
    `${mFull.status} / ${mFull.headers.get("content-type")} / ${mFull.headers.get("content-length")} vs ${vocalSize}`);
  const mRange = await media(`/api/media/clip/${clipId}/s02/vocals.wav`, { headers: { range: "bytes=0-99" } });
  check("clip 媒体出口支持 Range（206 + content-range）",
    mRange.status === 206 && mRange.headers.get("content-range") === `bytes 0-99/${vocalSize}`,
    `${mRange.status} / ${mRange.headers.get("content-range")}`);
  check("白名单逐 step 读（s03 的 sentences.json 同样可取）",
    (await media(`/api/media/clip/${clipId}/s03/sentences.json`)).status === 200);
  check("未登记的产物取不到（404）", (await media(`/api/media/clip/${clipId}/s02/no-such-artifact.wav`)).status === 404);
  check("路径穿越被拒（400）", (await media(`/api/media/clip/${clipId}/s02/..%2f..%2fclip.json`)).status === 400);
  check("片段不存在取不到（404）", (await media(`/api/media/clip/no-such-clip/s02/vocals.wav`)).status === 404);
  check("未跑的步取不到（404）", (await media(`/api/media/clip/${clipId}/s05/final.mp4`)).status === 404);

  const lazyOf = (s: Survey, id: string, step: string): LazyDep[] =>
    s.clips.find((c) => c.id === id)?.steps.find((st) => st.step === step)?.lazy ?? [];
  const svLazy = await api<Survey>("/api/survey");
  const lz0 = lazyOf(svLazy, clipId, "s03");
  check("s03 现算出 lazyDeps（s02 / 人声分离）", lz0.length === 1 && lz0[0]!.step === "s02" && lz0[0]!.title === "人声分离", JSON.stringify(lz0));
  check("s02 就绪 → lazy.available = true", lz0[0]!.available === true, JSON.stringify(lz0));
  check("无 lazyDeps 的步不带 lazy 字段（不给界面造空结构）",
    svLazy.clips.find((c) => c.id === clipId)!.steps.find((st) => st.step === "s02")!.lazy === undefined);

  // 核心：上游变脏 ≠ 产物不可用。s02 变 stale，但 vocals.wav 还在磁盘上——
  // available 必须仍为 true，否则上游一改试听区就被禁掉。这正是 available 不能用
  // status === "ready" 当判据的原因（status 说新鲜度，lazy 说可用性）。
  await writeFile(s02in, "v2", "utf8");
  const svDirty = await api<Survey>("/api/survey");
  check("改 s02 的输入 → s02 stale", stepState(svDirty, "clips", clipId, "s02") === "stale", stepState(svDirty, "clips", clipId, "s02"));
  check("s02 stale 但产物在 → lazy.available 仍 true（判据不是 ready）",
    lazyOf(svDirty, clipId, "s03")[0]?.available === true, JSON.stringify(lazyOf(svDirty, clipId, "s03")));
  check("惰性依赖不阻塞：s02 脏不把 s03 标 suspect", stepState(svDirty, "clips", clipId, "s03") === "ready", stepState(svDirty, "clips", clipId, "s03"));

  // 产物缺失要据实反映：登记在案 ≠ 文件还在
  await gone(vocals); // 「产物不在原路径」，不销毁（见文件头 gone 的说明）
  const svGone = await api<Survey>("/api/survey");
  check("产物文件被删 → lazy.available = false", lazyOf(svGone, clipId, "s03")[0]?.available === false, JSON.stringify(lazyOf(svGone, clipId, "s03")));
  check("已登记但文件缺失 → 媒体出口 404", (await media(`/api/media/clip/${clipId}/s02/vocals.wav`)).status === 404);

  // P1-4 端到端：契约产物缺失必须让**状态**掉下来——此前界面照样说「就绪」，
  // 用户点播放才吃 404（这正是 P1-4 的标题）。承接上面：此刻 vocals.wav 已删、
  // s02 的输入也已被改脏，两条路都要先复原，否则测到的是 stale 而不是 missing。
  await writeFile(s02in, "v1", "utf8"); // 输入指纹回到登记值
  await execFileP(FFMPEG, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ar", "44100", "-ac", "2", vocals]);
  const svBack = await api<Survey>("/api/survey");
  check("P1-4 基线：产物补回 + 输入复原 → s02 回 ready", stepState(svBack, "clips", clipId, "s02") === "ready", stepState(svBack, "clips", clipId, "s02"));
  await gone(path.join(s02dir, "no_vocals.wav"));
  const svMiss = await api<Survey>("/api/survey");
  check("P1-4：契约产物被删 → s02 missing（不再显示「就绪」）", stepState(svMiss, "clips", clipId, "s02") === "missing", stepState(svMiss, "clips", clipId, "s02"));
  check("P1-4：lazy.available 同步变 false", lazyOf(svMiss, clipId, "s03")[0]?.available === false, JSON.stringify(lazyOf(svMiss, clipId, "s03")));
  check("P1-4：待办条列出「产物丢失」且 kind=missing（界面据此配色，不再嗅探文案）",
    svMiss.todo.some((t) => t.owner === clipId && t.kind === "missing" && t.text.includes("产物丢失")),
    JSON.stringify(svMiss.todo));

  // L. LLM 配置（多配置档）：真实 HTTP + 真实落盘。
  //   守两条线：① 明文 key 不出进程（任何响应体里都不许出现，只给尾 4 位掩码）；
  //            ② 旧单块格式读得进来、写回去是新格式（迁移不需要单独脚本，也不需要用户动手）。
  //   模型列表与 draft 调用都打在本进程起的「假提供方」上——它是真实 HTTP 往返
  //   （真实 Authorization 头、真实请求体、真实 JSON 解析），只是把提供方换成几十行代码。
  //   这样测到的是「我们的代码怎么发请求、怎么解析、怎么报错」，而不是「某家 API 今天通不通」。
  const cfgPath = path.join(VROOT, "config.json");
  const saveLlm = (body: LlmSave | Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api/llm`, { method: "PUT", body: JSON.stringify(body) });
  const errOf = async (r: Response): Promise<string> => ((await r.json()) as { error: string }).error;

  // L0 未配置：形状与原因（界面靠它决定「去设置」提示）
  let lv = await api<LlmView>("/api/llm");
  check("未配置时 /api/llm 形状完整（空列表 + 无默认 + 原因 + ok=false）",
    lv.profiles.length === 0 && lv.default_id === null && !lv.ok && lv.model === null && (lv.reason ?? "").includes("未配置 LLM"),
    JSON.stringify(lv));

  // L1 旧格式自动迁移（单块 → 单档）
  const OLD_KEY = "sk-oldformat-1234567890";
  await writeFile(cfgPath, JSON.stringify({
    llm: { base_url: "https://api.example.com/v1", api_key: OLD_KEY, model: "old-model" },
    keepme: 1,
  }), "utf8");
  lv = await api<LlmView>("/api/llm");
  check("旧单块格式读成单档（id=p1 并自动设为默认）",
    lv.profiles.length === 1 && lv.profiles[0]!.id === "p1" && lv.default_id === "p1" && lv.ok === true,
    JSON.stringify({ n: lv.profiles.length, id: lv.profiles[0]?.id, d: lv.default_id, ok: lv.ok }));
  check("旧格式没名字 → 档名回落成 host", lv.profiles[0]!.name === "api.example.com", lv.profiles[0]!.name);

  // L2 掩码：明文 key 绝不出现在响应里
  const rawView = await (await fetch(`http://127.0.0.1:${port}/api/llm`)).text();
  check("GET /api/llm 响应里没有明文 key", !rawView.includes(OLD_KEY));
  check("key_hint 只露尾 4 位", lv.profiles[0]!.key_hint === "••••7890", lv.profiles[0]!.key_hint);
  check("configured 判定 = 三项齐全", lv.profiles[0]!.configured === true);

  // L3 全量替换 + 默认档切换
  const NEW_KEY = "sk-newkey-abcdefghij";
  const r6 = await saveLlm({
    profiles: [
      { id: "p1", name: "旧的", base_url: "https://api.example.com/v1", api_key: "", model: "old-model" },
      { id: "p2", name: "新的", base_url: "https://api.other.com/v1", api_key: NEW_KEY, model: "new-model" },
    ],
    default_id: "p2",
  });
  lv = (await r6.json()) as LlmView;
  check("PUT 全量替换：两档都在、默认切到 p2、ok/model 跟着默认档走",
    r6.status === 200 && lv.profiles.length === 2 && lv.default_id === "p2" && lv.ok && lv.model === "new-model",
    JSON.stringify({ s: r6.status, n: lv.profiles.length, d: lv.default_id, m: lv.model }));
  check("空 api_key = 沿用原密钥（尾 4 位不变）", lv.profiles[0]!.key_hint === "••••7890", lv.profiles[0]!.key_hint);
  check("PUT 响应里没有明文 key", !JSON.stringify(lv).includes(NEW_KEY) && !JSON.stringify(lv).includes(OLD_KEY));
  const disk1 = await readJson<{ llm: { profiles: { id: string; api_key: string }[] }; keepme: number }>(cfgPath);
  check("落盘是新格式 profiles[]（旧格式已迁移）",
    Array.isArray(disk1?.llm.profiles) && disk1.llm.profiles.length === 2, JSON.stringify(disk1?.llm));
  check("密钥真的写进了数据根 config.json", disk1?.llm.profiles.find((p) => p.id === "p2")?.api_key === NEW_KEY);
  check("llm 以外的顶层字段被保留（人工写的东西不被抹掉）", disk1?.keepme === 1);

  // L4 校验：任一项不合法整批拒，不留半更新
  const beforeBad = await readFile(cfgPath, "utf8");
  const bad1 = await saveLlm({ profiles: [{ id: "p1", name: "x", base_url: "ftp://nope", api_key: "", model: "m" }], default_id: "p1" });
  check("地址非 http(s) 被拒（400）", bad1.status === 400 && (await errOf(bad1)).includes("http://"), String(bad1.status));
  const bad2 = await saveLlm({ profiles: [], default_id: "p9" });
  check("默认档悬空被拒（400）", bad2.status === 400 && (await errOf(bad2)).includes("默认配置不存在"), String(bad2.status));
  const bad3 = await saveLlm({ default_id: null });
  check("profiles 不是数组被拒（400，不静默清空）", bad3.status === 400 && (await errOf(bad3)).includes("数组"), String(bad3.status));
  const bad4 = await saveLlm({
    profiles: [
      { id: "dup", name: "", base_url: "", api_key: "", model: "" },
      { id: "dup", name: "", base_url: "", api_key: "", model: "" },
    ],
    default_id: null,
  });
  check("重复 id 被拒（400）", bad4.status === 400 && (await errOf(bad4)).includes("重复"), String(bad4.status));
  check("被拒的请求没有改动 config.json（无半更新）", (await readFile(cfgPath, "utf8")) === beforeBad);

  // L5 删档：落盘少一个，密钥随之消失
  const r7 = await saveLlm({
    profiles: [{ id: "p2", name: "新的", base_url: "https://api.other.com/v1", api_key: "", model: "new-model" }],
    default_id: "p2",
  });
  const disk2 = await readJson<{ llm: { profiles: { id: string }[] } }>(cfgPath);
  check("删档后只剩 1 个，且真的落盘了",
    r7.status === 200 && disk2?.llm.profiles.length === 1 && disk2.llm.profiles[0]!.id === "p2",
    JSON.stringify(disk2?.llm));

  // L6 拉模型列表：本地假提供方（真实 HTTP 往返 + 真实 Authorization 头）
  const seen: { path: string; auth: string }[] = [];
  const chatSeen: { model: string; auth: string; rf: string; user: string; sys: string }[] = [];
  let fakeReply = "{}";
  const fake = createServer((freq, fres) => {
    const p = (freq.url ?? "/").split("?")[0]!;
    let raw = "";
    freq.on("data", (c) => (raw += c));
    freq.on("end", () => {
      seen.push({ path: p, auth: freq.headers.authorization ?? "" });
      if (p === "/v1/chat/completions") {
        const b = JSON.parse(raw || "{}") as {
          model?: string;
          response_format?: { type?: string };
          messages?: { role?: string; content?: string }[];
        };
        chatSeen.push({
          model: b.model ?? "",
          auth: freq.headers.authorization ?? "",
          rf: b.response_format?.type ?? "",
          // 记下 system/user 内容：s04 要断言「曲库值域真的被注入了 prompt」，光看返回值证明不了这件事。
          // ⚠️ 值域走 **system**（s04.ts 的 systemPrompt），句流才走 user——两处分开记，
          // 免得断言挑错字段（第 8 轮踩过：断言 user 含分组名，实际永远不含，红得莫名其妙）。
          user: (b.messages ?? []).filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n"),
          sys: (b.messages ?? []).filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n"),
        });
        fres.writeHead(200, { "content-type": "application/json" });
        return fres.end(JSON.stringify({ choices: [{ message: { content: fakeReply } }] }));
      }
      if (p === "/v1/models") {
        fres.writeHead(200, { "content-type": "application/json" });
        // 故意混入重复项与一个非字符串项：去重、丢垃圾，但保持提供方给的顺序
        return fres.end(JSON.stringify({ data: [{ id: "m-b" }, { id: "m-a" }, { id: "m-b" }, { id: 7 }] }));
      }
      if (p === "/bad/models") { fres.writeHead(401); return fres.end("unauthorized"); }
      if (p === "/gone/models") { fres.writeHead(404); return fres.end("no such path"); }
      if (p === "/boom/models") { fres.writeHead(503); return fres.end("upstream down"); }
      if (p === "/plain/models") { fres.writeHead(200); return fres.end("<html>hi</html>"); }
      if (p === "/empty/models") { fres.writeHead(200); return fres.end('{"object":"list"}'); }
      fres.writeHead(500); return fres.end("boom");
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const askModels = (body: Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api/llm/models`, { method: "POST", body: JSON.stringify(body) });

  const lm1 = await askModels({ profile_id: "p2", base_url: `${fakeBase}/v1`, api_key: "" });
  const lm1j = (await lm1.json()) as { ok: boolean; models?: string[] };
  const seen1 = seen.at(-1)!;
  check("拉模型列表：去重 + 丢非字符串项 + 保持提供方顺序",
    lm1.status === 200 && lm1j.ok && lm1j.models?.join(",") === "m-b,m-a", JSON.stringify(lm1j));
  check("表单 key 为空时回落已存档密钥（Authorization 真的发出去了）",
    seen1.auth === `Bearer ${NEW_KEY}`, seen1.auth);
  check("打的是 /models（不消耗 token 的清单端点）", seen1.path === "/v1/models", seen1.path);

  const lm2 = await askModels({ profile_id: "", base_url: `${fakeBase}/v1`, api_key: "sk-formkey-9999" });
  const lm2j = (await lm2.json()) as { ok: boolean };
  check("表单里填了 key 就用表单的（未保存的新档也能先拉一下）",
    lm2j.ok && seen.at(-1)!.auth === "Bearer sk-formkey-9999", seen.at(-1)!.auth);

  // 错误分支必须说人话：这些文案就是用户配置出错时唯一的线索
  const e401 = (await (await askModels({ base_url: `${fakeBase}/bad`, api_key: "" })).json()) as { ok: boolean; reason: string };
  check("401 → 报「API Key 无效或无权限」", !e401.ok && e401.reason.includes("API Key 无效"), e401.reason);
  const e404 = (await (await askModels({ base_url: `${fakeBase}/gone`, api_key: "" })).json()) as { ok: boolean; reason: string };
  check("404 → 报「地址不对」并提示检查 /v1",
    !e404.ok && e404.reason.includes("地址不对") && e404.reason.includes("/v1"), e404.reason);
  const e503 = (await (await askModels({ base_url: `${fakeBase}/boom`, api_key: "" })).json()) as { ok: boolean; reason: string };
  check("503 → 报「提供方服务端错误」", !e503.ok && e503.reason.includes("提供方服务端错误"), e503.reason);
  const ePlain = (await (await askModels({ base_url: `${fakeBase}/plain`, api_key: "" })).json()) as { ok: boolean; reason: string };
  check("非 JSON 响应 → 报「返回的不是 JSON」", !ePlain.ok && ePlain.reason.includes("不是 JSON"), ePlain.reason);
  const eEmpty = (await (await askModels({ base_url: `${fakeBase}/empty`, api_key: "" })).json()) as { ok: boolean; reason: string };
  check("没有 data 字段 → 据实说「没给出模型清单」", !eEmpty.ok && eEmpty.reason.includes("没给出模型清单"), eEmpty.reason);
  check("拉不到一律 200 + ok=false（诊断信息，不是服务故障）",
    [lm1, lm2].every((r) => r.status === 200));
  const eDead = (await (await askModels({ base_url: "http://127.0.0.1:1/v1", api_key: "" })).json()) as { ok: boolean; reason: string };
  check("连不上 → 报「无法连接」而不是抛 500", !eDead.ok && eDead.reason.includes("无法连接"), eDead.reason);

  // 测试连接：打一条最短对话。响应里不能出现明文 key（诊断接口也是泄漏面）。
  const probeKey = "sk-probe-should-not-leak";
  const testedRes = await fetch(`http://127.0.0.1:${port}/api/llm/test`, {
    method: "POST",
    body: JSON.stringify({ base_url: `${fakeBase}/v1`, api_key: probeKey, model: "fake-model" }),
  });
  const testedText = await testedRes.text();
  const testedJson = JSON.parse(testedText) as { ok: boolean; reply?: string };
  const chatProbe = chatSeen.at(-1)!;
  check(
    "测试连接打到 /chat/completions，模型名与密钥都带上了",
    testedRes.status === 200 && testedJson.ok && chatProbe.model === "fake-model" && chatProbe.auth === `Bearer ${probeKey}` && chatProbe.rf === "",
    testedText.slice(0, 180),
  );
  check("测试连接的响应里没有明文 key", !testedText.includes(probeKey), testedText.slice(0, 180));
  const noModel = (await (await fetch(`http://127.0.0.1:${port}/api/llm/test`, {
    method: "POST",
    body: JSON.stringify({ base_url: `${fakeBase}/v1`, api_key: probeKey, model: "" }),
  })).json()) as { ok: boolean };
  check(
    "表单没填模型 → 回落已存档的模型名（与密钥回落同一条规则）",
    noModel.ok && chatSeen.at(-1)!.model === "new-model",
    chatSeen.at(-1)!.model,
  );

  // L7 端到端：配好默认档 → draft 真的把请求打出去并落盘
  //   这一条把「设置页存的 key」与「工作流里的调用」接起来——前面所有断言都只到配置层为止。
  const s03cur = await api<S03View>(`/api/clips/${clipId}/s03`);
  const aiTarget = s03cur.sentences[0]!;
  fakeReply = JSON.stringify({ deletions: [{ id: aiTarget.id, reason: "假提供方：这句可以删" }] });
  await saveLlm({
    profiles: [{ id: "pf", name: "假提供方", base_url: `${fakeBase}/v1`, api_key: NEW_KEY, model: "fake-model" }],
    default_id: "pf",
  });
  const r8 = await runAndWait(`clips/${clipId}`, "s03", "draft");
  const chat1 = chatSeen.at(-1)!;
  check("配好默认档后 draft 真的跑通（不再报未配置）",
    r8.status === "done" && r8.message.includes("AI 建议删 1 句"), r8.error ?? r8.message);
  check("draft 用的是默认档的模型名（请求体 model）", chat1.model === "fake-model", JSON.stringify(chat1));
  check("draft 请求带上了存起来的 key", chat1.auth === `Bearer ${NEW_KEY}`, chat1.auth);
  check("draft 要求 JSON 输出（response_format=json_object）", chat1.rf === "json_object", chat1.rf);
  const aiNow = await readJson<AiDraftFile>(path.join(VROOT, "work", "clips", clipId, "s03", "ai.json"));
  check("AI 初稿落盘，带提供方给的理由",
    aiNow?.model === "fake-model" && aiNow.decisions.some((d) => d.id === aiTarget.id && d.reason.includes("假提供方")),
    JSON.stringify(aiNow));
  const afterDraft = await api<S03View>(`/api/clips/${clipId}/s03`);
  const aiRow = afterDraft.sentences.find((s) => s.id === aiTarget.id)!;
  check("读模型里 AI 建议生效（keep=false / source=ai）", !aiRow.keep && aiRow.source === "ai",
    JSON.stringify({ keep: aiRow.keep, source: aiRow.source }));

  // L8 清空回到未配置：据实说「没配」，并给出下一步
  await saveLlm({ profiles: [], default_id: null });
  lv = await api<LlmView>("/api/llm");
  check("清空后回到「未配置」并指出下一步",
    !lv.ok && lv.profiles.length === 0 && (lv.reason ?? "").includes("未配置 LLM"), lv.reason ?? "");
  const eNoBase = (await (await askModels({ base_url: "", api_key: "" })).json()) as { ok: boolean; reason: string };
  check("没地址且没存档 → 据实说「还没填 API 地址」", !eNoBase.ok && eNoBase.reason.includes("还没填"), eNoBase.reason);
  const chatBeforeBare = chatSeen.length;
  const bareModel = (await (await fetch(`http://127.0.0.1:${port}/api/llm/test`, {
    method: "POST",
    body: JSON.stringify({ base_url: `${fakeBase}/v1`, api_key: probeKey, model: "" }),
  })).json()) as { ok: boolean; reason?: string };
  check(
    "没模型且没存档 → 据实说还没填模型，且不打提供方",
    !bareModel.ok && (bareModel.reason ?? "").includes("还没填模型") && chatSeen.length === chatBeforeBare,
    bareModel.reason ?? "",
  );
  const eScheme = (await (await askModels({ base_url: "api.foo.com/v1", api_key: "" })).json()) as { ok: boolean; reason: string };
  check("地址缺协议头 → 拦下并说明要 http(s)", !eScheme.ok && eScheme.reason.includes("http://"), eScheme.reason);

  // L9 写侧与读侧同口径（界面冒烟测出来的缺陷）：有档但没指定默认 → 落第一个，不落 null。
  //   旧行为：文件写 default_id:null，而读侧 normalize 会把它升成 profiles[0].id 并报 ok——
  //   于是「文件说没默认、运行时说默认可用」两处不一致。规则只该有一条。
  const r9 = await saveLlm({
    profiles: [{ id: "pz", name: "独苗", base_url: "https://api.solo.com/v1", api_key: "sk-solo-1234", model: "m" }],
    default_id: null,
  });
  const v9 = (await r9.json()) as LlmView;
  const disk9 = await readJson<{ llm: { default_id: string | null } }>(cfgPath);
  check("没指定默认档 → 写侧落第一个（文件与运行时同一口径，不落 null）",
    disk9?.llm.default_id === "pz", JSON.stringify(disk9?.llm));
  check("返回视图与文件一致（default_id / ok）",
    v9.default_id === "pz" && v9.ok === true, JSON.stringify({ d: v9.default_id, ok: v9.ok }));

  // ── s04 配乐（阶段 3.3）：值域现算 + 规则优先 + LLM 兜底 + 越界报错 ─────────────
  // 判据核心是 b51a/b50c：**mood 值域从曲库现算**，不是硬编码。所以这里刻意用一份**临时曲库**
  // （只有两个自造分组），而不是真实曲库——硬编码真实那 7 个分组的实现在这里必然报错，能区分。
  console.log("\n[s04] 值域现算 / 规则优先 / LLM 兜底 / 越界报错");
  {
    const s04Clip = `s04clip-${Math.random().toString(36).slice(2, 8)}`;
    const cdir = path.join(VROOT, "work", "clips", s04Clip);
    const s04dir = path.join(cdir, "s04");
    await mkdir(path.join(cdir, "s03"), { recursive: true });
    await mkdir(s04dir, { recursive: true });
    // 临时曲库：两个自造分组、各 2 首；组内 id **故意乱序**，用来验证「组内按 id 取最小」这条规则
    const libPath = path.join(VROOT, "data", "library.json");
    await mkdir(path.dirname(libPath), { recursive: true });
    await writeFile(
      libPath,
      JSON.stringify({
        schema: 1,
        source_root: "(临时)",
        items: [
          { id: "z-02", kind: "bgm", group: "测试组A", title: "A2", path: path.join(VROOT, "a2.mp3"), sha256: "x", bytes: 11 },
          { id: "z-01", kind: "bgm", group: "测试组A", title: "A1", path: path.join(VROOT, "a1.mp3"), sha256: "x", bytes: 12 },
          { id: "z-04", kind: "bgm", group: "测试组B", title: "B2", path: path.join(VROOT, "b2.mp3"), sha256: "x", bytes: 13 },
          { id: "z-03", kind: "bgm", group: "测试组B", title: "B1", path: path.join(VROOT, "b1.mp3"), sha256: "x", bytes: 14 },
          { id: "f-01", kind: "font", group: null, title: "字体", path: path.join(VROOT, "f.ttf"), sha256: "x", bytes: 1 },
        ],
      }),
      "utf8",
    );
    await writeFile(
      path.join(cdir, "clip.json"),
      JSON.stringify({ schema: 1, id: s04Clip, job_id: jobId, title: "s04", start: 0, end: 30, fps: null }),
      "utf8",
    );
    await writeFile(
      path.join(cdir, "s03", "sentences.json"),
      JSON.stringify({
        schema: 1,
        sentences: [
          { id: "1", start: 0, end: 3, text: "今天教一个特别好用的剪辑技巧" },
          { id: "2", start: 3, end: 6, text: "第一步把素材拖进时间线" },
        ],
      }),
      "utf8",
    );

    const s04State = async (): Promise<string> =>
      (await survey(VROOT)).clips.find((c) => c.id === s04Clip)!.steps.find((s) => s.step === "s04")!.status;
    const tryRun = async (): Promise<{ ok: boolean; msg: string }> => {
      try {
        return { ok: true, msg: await runS04(VROOT, `clips/${s04Clip}`, "rS04VERIFY") };
      } catch (e) {
        return { ok: false, msg: (e as Error).message };
      }
    };
    await writeFile(path.join(VROOT, "a1.mp3"), "a");
    await writeFile(path.join(VROOT, "a2.mp3"), "aa");
    await writeFile(path.join(VROOT, "b1.mp3"), "b");
    await writeFile(path.join(VROOT, "b2.mp3"), "bb");
    const paramsPath = path.join(s04dir, "params.json");
    const writeParams = (mood: string): Promise<void> =>
      writeFile(paramsPath, JSON.stringify({ schema: 1, bgm_mood: mood }), "utf8");

    const st0 = await s04State();
    check("跑之前 s04 = empty", st0 === "empty", st0);

    // 选中的那首（组内 id 最小）文件不在：这一步就失败，不能先标成就绪、拖到出片才说。
    await rename(path.join(VROOT, "a1.mp3"), path.join(VROOT, "a1.mp3.gone"));
    await writeParams("测试组A");
    const missingTrack = await tryRun();
    check("选中的曲目文件不在 → 这一步就报错", !missingTrack.ok && missingTrack.msg.includes("曲目文件不存在"), missingTrack.msg);
    check("文件不在时 s04 仍是 empty（没有被标成就绪）", (await s04State()) === "empty", await s04State());
    await rename(path.join(VROOT, "a1.mp3.gone"), path.join(VROOT, "a1.mp3"));

    // ① 规则路：人工指定 mood（完全离线，不碰 LLM）
    const r1 = await tryRun();
    check("指定 mood → 规则路跑通", r1.ok, r1.msg);
    const bgm1 = await readJson<BgmFile>(path.join(s04dir, "bgm.json"));
    check("bgm.json 落盘且 mood/source 正确", bgm1?.mood === "测试组A" && bgm1.source === "human", JSON.stringify(bgm1));
    check("组内按 id 取最小（z-01 而非 z-02）", bgm1?.track.id === "z-01", bgm1?.track.id ?? "");
    check("candidates 记下该组曲目数（界面展示用）", bgm1?.candidates === 2, String(bgm1?.candidates));

    // ② 值域现算：真实曲库里有的分组，在这份临时曲库里**不存在** → 必须报错。
    //    硬编码那 7 个真实分组的实现会在这里放行，所以这条能区分两种实现。
    await writeParams("励志-明朗");
    const r2 = await tryRun();
    check("越界 mood → 报错不回退（真实曲库有的组，临时曲库没有）", !r2.ok, r2.msg);
    // 断言必须只看「现有：」之后那份清单：报错文案开头会**回显用户填的那个值**
    // （`bgm_mood「励志-明朗」不在…`），拿整条消息做「不含 励志-明朗」的判断必然假红。
    const domain2 = r2.msg.split("现有：")[1] ?? "";
    check(
      "错误文案列出的是**临时曲库**的分组（值域现算，非硬编码）",
      domain2.includes("测试组A") && domain2.includes("测试组B") && !domain2.includes("励志-明朗"),
      r2.msg,
    );

    // ③ LLM 兜底：不指定 mood → 值域注入 prompt，由 LLM 按句流内容挑
    await saveLlm({
      profiles: [{ id: "pf2", name: "假提供方2", base_url: `${fakeBase}/v1`, api_key: NEW_KEY, model: "fake-model" }],
      default_id: "pf2",
    });
    // 用 rename 而不是删除来「让 params.json 不在原路径」：删除在本 turn 可能被沙箱配额拦，
    // 一旦拦掉，下一条用例会读到上一轮的 mood 而变成假 FAIL（第 7 轮教训）。
    await rename(paramsPath, path.join(s04dir, "_gone_params.json"));
    fakeReply = JSON.stringify({ mood: "测试组B", reason: "假提供方：教学向内容配轻松组" });
    const r3 = await tryRun();
    check("未指定 mood → LLM 兜底跑通", r3.ok, r3.msg);
    const stLlm = await s04State();
    check("未写 params.json 的 LLM 路跑完仍 ready（缺席不是丢失）", stLlm === "ready", stLlm);
    await writeParams("测试组A");
    check("后来补上 params.json → s04 stale", (await s04State()) === "stale", await s04State());
    await rename(paramsPath, path.join(s04dir, "_gone_params_again.json"));
    check("params 再次不在 → 回到 ready", (await s04State()) === "ready", await s04State());
    const bgm3 = await readJson<BgmFile>(path.join(s04dir, "bgm.json"));
    check(
      "采纳 LLM 挑的 mood（source=llm，reason 落盘）",
      bgm3?.mood === "测试组B" && bgm3.source === "llm" && (bgm3.reason ?? "").includes("假提供方"),
      JSON.stringify(bgm3),
    );
    const chat4 = chatSeen.at(-1)!;
    check(
      "prompt 里注入了**现算的**值域（两个自造分组都在 system 里）",
      chat4.sys.includes("测试组A") && chat4.sys.includes("测试组B"),
      chat4.sys.slice(0, 140),
    );
    // 顺带守一条：句流该走 user。两边混着放虽然也能跑，但断言挑错字段就查不出「值域没注入」。
    check("句流走 user（system 只放值域与规则）", chat4.user.includes("剪辑技巧") && !chat4.sys.includes("剪辑技巧"), chat4.user.slice(0, 80));

    // ④ LLM 越界同样报错：自创分组名不该被放行（放行的话下面选曲会选到空集，归因还指错方向）
    fakeReply = JSON.stringify({ mood: "赛博朋克", reason: "自创" });
    const r4 = await tryRun();
    check("LLM 挑了值域外的分组 → 报错", !r4.ok && r4.msg.includes("赛博朋克"), r4.msg);

    // ⑤ 既没指定 mood、又没配 LLM → 据实报错，不塞一个默认值糊过去
    await saveLlm({ profiles: [], default_id: null });
    const r5 = await tryRun();
    check("未指定 mood 且未配 LLM → 据实报错（不塞默认组）", !r5.ok && r5.msg.includes("未指定 bgm_mood"), r5.msg);

    // ⑥ 跑通后判 ready（契约产物 bgm.json）
    await writeParams("测试组B");
    const r6 = await tryRun();
    check("恢复指定 mood → 再次跑通", r6.ok, r6.msg);
    const st1 = await s04State();
    check("跑完 s04 判 ready（契约产物齐）", st1 === "ready", st1);
    // 退回验证的等价物：移走产物 → 立刻 missing（证明上一条的 ready 不是白给的）
    await rename(path.join(s04dir, "bgm.json"), path.join(s04dir, "_gone_bgm.json"));
    const st2 = await s04State();
    check("移走 bgm.json → missing", st2 === "missing", st2);
  }

  await new Promise<void>((r) => fake.close(() => r()));

  // ── s02 真实链路（阶段 3.1）：不手工造产物，而是真跑一遍 ─────────────────────
  // 真视频 → ffmpeg 切片段 → demucs 分离 → 产物落盘。mock 出来的 wav 只能证明「登记语义」，
  // 证明不了「分离真的能跑」。数据根刻意用 ROOT 而非 VROOT：权重是随包资产、按规划放数据根的
  // `models/demucs`（§6 已定），临时数据根下没有它。
  console.log("\n[slots] 资源类槽位：满了就排队，不同类不互相占用");
  {
    check("s02 归 cpu", (await resourceOf(VROOT, "clips/none", "s02", null)) === "cpu");
    check("s05 归 cpu", (await resourceOf(VROOT, "clips/none", "s05", null)) === "cpu");
    check("s01 归 net", (await resourceOf(VROOT, "jobs/none", "s01", null)) === "net");
    check("s03 构建归 io", (await resourceOf(VROOT, "clips/none", "s03", null)) === "io");
    check("s03 初稿归 net", (await resourceOf(VROOT, "clips/none", "s03", "draft")) === "net");
    check("没写 mood 的 s04 归 net", (await resourceOf(VROOT, "clips/none", "s04", null)) === "net");
    const prevCpu = process.env.SLICE_SLOT_CPU;
    process.env.SLICE_SLOT_CPU = "1";
    let release1: (() => void) | undefined;
    let release2: (() => void) | undefined;
    try {
      release1 = await acquire("cpu");
      const gate = { entered: false };
      const pending = acquire("cpu").then((rel) => {
        gate.entered = true;
        release2 = rel;
      });
      await new Promise((r) => setTimeout(r, 80));
      check("cpu 槽满时后来者排队", gate.entered === false);
      release1();
      release1 = undefined;
      await pending;
      check("让出槽位后排队者进入", gate.entered === true);
    } finally {
      release1?.();
      release2?.();
      if (prevCpu === undefined) delete process.env.SLICE_SLOT_CPU;
      else process.env.SLICE_SLOT_CPU = prevCpu;
    }
  }

  console.log("\n[s02] 真实视频 → 真实 demucs → 契约产物与惰性依赖");
  {
    // id 带随机后缀，与本站其它夹具同一范式（见 demo-5a2f61）。这是**起点干净的最稳做法**：
    // 第 5 轮的教训是「残留的 step.json 会让基线断言读到残影」，而清理本身可能被沙箱拦住
    // （删除配额耗尽时 rm 必抛）——与其「先删再跑、删失败就假红」，不如让每次运行都用全新目录名。
    const s02Job = `s02demo-${Math.random().toString(36).slice(2, 8)}`;
    const s02Clip = `s02clip-${Math.random().toString(36).slice(2, 8)}`;
    const s02ClipB = `s02clip-${Math.random().toString(36).slice(2, 8)}`;
    const jobDir = path.join(ROOT, "work", "jobs", s02Job);
    const clipDir = path.join(ROOT, "work", "clips", s02Clip);
    const clipDirB = path.join(ROOT, "work", "clips", s02ClipB);
    await mkdir(jobDir, { recursive: true });
    await mkdir(clipDir, { recursive: true });
    await mkdir(clipDirB, { recursive: true });
    try {
      // 1 秒视频即可：分离耗时由固定开销主导（实测 3 秒音频 4.34s），clip 再长只是白等
      const vid = path.join(jobDir, "src.mp4");
      await execFileP(FFMPEG, [
        "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=44100",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", vid,
      ]);
      await writeFile(
        path.join(jobDir, "job.json"),
        JSON.stringify({ schema: 1, id: s02Job, video_path: vid, srt_path: null, created_at: new Date().toISOString() }, null, 2),
        "utf8",
      );
      await writeFile(
        path.join(clipDir, "clip.json"),
        JSON.stringify({ schema: 1, id: s02Clip, job_id: s02Job, title: "s02", start: 0, end: 1, fps: null }, null, 2),
        "utf8",
      );
      await writeFile(
        path.join(clipDirB, "clip.json"),
        JSON.stringify({ schema: 1, id: s02ClipB, job_id: s02Job, title: "s02b", start: 0, end: 1, fps: null }, null, 2),
        "utf8",
      );

      const s02State = async () =>
        (await survey(ROOT)).clips.find((c) => c.id === s02Clip)!.steps.find((s) => s.step === "s02")!;
      const before = (await s02State()).status;
      check("跑之前 s02 = empty", before === "empty", before);

      const statsBefore = await readDemucsStats(ROOT);
      const [msg, msgB] = await Promise.all([
        runS02(ROOT, `clips/${s02Clip}`, "rS02A"),
        runS02(ROOT, `clips/${s02ClipB}`, "rS02B"),
      ]);
      check("runS02 正常返回（临时件清理失败不影响结论）", msg.includes("分离出") && msgB.includes("分离出"), `${msg} | ${msgB}`);
      const statsAfter = await readDemucsStats(ROOT);
      const taskBase = statsBefore && statsAfter && statsBefore.pid === statsAfter.pid ? statsBefore.tasks : 0;
      check("两条片段共用一个 demucs 进程，权重只报了一次 ready", statsAfter?.ready === 1, JSON.stringify(statsAfter));
      check("两条片段的分离都进了这一个进程", (statsAfter?.tasks ?? 0) - taskBase === 2, JSON.stringify({ before: statsBefore, after: statsAfter }));
      check("两条片段同时在跑（峰值至少 2，不是等一条结束再起下一条）", (statsAfter?.last_peak ?? 0) >= 2, JSON.stringify(statsAfter));

      const s02dir = path.join(clipDir, "s02");
      const sizeOf = (n: string): Promise<number> =>
        stat(path.join(s02dir, n)).then((s) => s.size).catch(() => 0);
      const vSize = await sizeOf("vocals.wav");
      const nSize = await sizeOf("no_vocals.wav");
      check("vocals.wav 真在盘上且非空", vSize > 1000, String(vSize));
      check("no_vocals.wav 真在盘上且非空", nSize > 1000, String(nSize));

      const after = (await survey(ROOT)).clips.find((c) => c.id === s02Clip)!;
      const s02after = after.steps.find((s) => s.step === "s02")!;
      check("跑完 s02 判 ready（契约产物齐）", s02after.status === "ready", s02after.status);
      const lazy = after.steps.find((s) => s.step === "s03")!.lazy?.find((l) => l.step === "s02");
      check("s03 的 lazyDeps 随之可用（b23/b59）", lazy?.available === true, JSON.stringify(lazy));

      // 退回验证的等价物：让一个契约产物「不在原路径」→ 立刻 missing（证明上一条的 ready 不是白给的）。
      // 用 rename 而不是 rm：用例语义是「不在原路径」不是「被销毁」，而且沙箱对删除有配额
      // （第 5 轮教训）——rm 在这里会抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，把断言变成脚本崩溃。
      await rename(path.join(s02dir, "no_vocals.wav"), path.join(s02dir, "_gone_no_vocals.wav"));
      const gone = (await s02State()).status;
      check("删掉一个契约产物 → missing", gone === "missing", gone);

      // 自愈：pid 被系统**复用**后，data/workers/demucs.json 里的 pid 归了别的进程，
      // process.kill(pid, 0) 于是说「活着」，客户端便一直去连一个没人听的端口——
      // 不清记录的话，这个数据根上的 s02 会永久失败，而报错只说「连不上」。
      // 用「当前脚本进程的 pid + 一个刚关掉的端口」精确复现这个现场：pid 真的活着，端口真的没人听。
      const tmpSrv = createServer();
      await new Promise<void>((r) => tmpSrv.listen(0, "127.0.0.1", () => r()));
      const deadPort = (tmpSrv.address() as { port: number }).port;
      await new Promise<void>((r) => tmpSrv.close(() => r()));
      await writeJsonAtomic(path.join(ROOT, "data", "workers", "demucs.json"), {
        pid: process.pid,
        port: deadPort,
        ready: 1,
        tasks: 0,
        last_peak: 0,
      });
      // 抛错要变成**红**而不是中断：中断的输出是「N passed / 0 failed」，比红更容易被当成通过。
      let msgHeal = "";
      try {
        msgHeal = await runS02(ROOT, `clips/${s02Clip}`, "rS02Heal");
      } catch (e) {
        msgHeal = `抛错：${e instanceof Error ? e.message : String(e)}`;
      }
      check("pid 被复用（记录活着、端口没人听）时能自愈重拉 broker", msgHeal.includes("分离出"), msgHeal);
    } finally {
      // 夹具清理：失败必须**留痕并带出错误码**。原先这里是 `.catch(() => {})` —— 静默吞掉，
      // 结果 work/ 悄悄堆了 37 个残留文件而脚本每次都报「全绿」。
      // 第 5 轮的结论是「清理失败降级为警告」，不是「让失败消失」。
      // 实测真因是沙箱删除守卫的 turn 级配额（不是文件锁），所以重试无意义 —— 见 lib.removeQuietly 注释。
      for (const d of [jobDir, clipDir, clipDirB]) {
        const e = await removeQuietly(d);
        if (e) console.log(`  ⚠️ 夹具清理失败（work/ 会留残留）：${d}（${e}）`);
      }
    }
  }

  // ── s05 成片（阶段 3.2 / BGM 叠加）：保留句拼接 + b24 两出口并列 + 消费 s04 配乐 ──
  console.log("\n[s05] 真实视频 → 保留句拼接 → 成片 + 素材包两出口 + BGM 叠加");
  {
    const s05Job = `s05demo-${Math.random().toString(36).slice(2, 8)}`;
    const s05Clip = `s05clip-${Math.random().toString(36).slice(2, 8)}`;
    const jobDir = path.join(ROOT, "work", "jobs", s05Job);
    const clipDir = path.join(ROOT, "work", "clips", s05Clip);
    await mkdir(path.join(jobDir, "s00"), { recursive: true });
    await mkdir(path.join(clipDir, "s03"), { recursive: true });
    try {
      const vid = path.join(jobDir, "src.mp4");
      await execFileP(FFMPEG, [
        "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=44100",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", vid,
      ]);
      await writeFile(
        path.join(jobDir, "job.json"),
        JSON.stringify({ schema: 1, id: s05Job, video_path: vid, srt_path: null, created_at: new Date().toISOString() }),
        "utf8",
      );
      // 句 3（1.6–2.4）与句 4（2.7–3.0）之间刻意留 0.3s 空隙，**小于 GAP(0.5)**：
      // 于是「合并相邻段」与「不合并」两种实现产出的东西**可区分**（2 段/2.2s vs 3 段/1.9s）。
      // 若把空隙取成 0（首尾相接），两种实现时长完全一致，断言就白过了（铁律 12：能区分两种实现才算守护）。
      await writeFile(
        path.join(jobDir, "s00", "sentences.json"),
        JSON.stringify({
          schema: 1,
          sentences: [
            { id: "1", start: 0, end: 0.8, text: "第一句" },
            { id: "2", start: 0.8, end: 1.6, text: "第二句要删" },
            { id: "3", start: 1.6, end: 2.4, text: "第三句" },
            { id: "4", start: 2.7, end: 3.0, text: "第四句" },
          ],
        }),
        "utf8",
      );
      await writeFile(
        path.join(clipDir, "clip.json"),
        JSON.stringify({ schema: 1, id: s05Clip, job_id: s05Job, title: "s05", start: 0, end: 3, fps: "10/1" }),
        "utf8",
      );
      // 人工删掉第 2 句——走覆盖层，与工作台完全同一条通路（不是给 s05 开的后门）
      await writeFile(
        path.join(clipDir, "s03", "overlay.json"),
        JSON.stringify({ schema: 1, decisions: { "2": { keep: false, at: new Date().toISOString() } } }),
        "utf8",
      );

      const s05State = async (): Promise<string> =>
        (await survey(ROOT)).clips.find((c) => c.id === s05Clip)!.steps.find((s) => s.step === "s05")!.status;
      const before = await s05State();
      check("跑之前 s05 = empty", before === "empty", before);

      // 句流必须先构建：s05 不自己截句，直接吃 s03 的产物（单一真相源）
      await buildS03(ROOT, `clips/${s05Clip}`, "rS05build");
      const msg = await runS05(ROOT, `clips/${s05Clip}`, "rS05VERIFY");
      check("runS05 正常返回", msg.includes("成片"), msg);

      const dir = path.join(clipDir, "s05");
      const sizeOf = (n: string): Promise<number> =>
        stat(path.join(dir, n)).then((s) => s.size).catch(() => 0);
      const mp4Size = await sizeOf("final.mp4");
      const zipSize = await sizeOf("package.zip");
      check("final.mp4 真在盘上且非空", mp4Size > 1000, String(mp4Size));
      check("package.zip 真在盘上且非空", zipSize > 100, String(zipSize));

      // 成片时长 = 保留段总长：0.8 + (3.0−1.6) = 2.2s（合并）/ 1.9s（不合并）——能区分
      const probe = await execFileP(FFPROBE, [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, "final.mp4"),
      ]);
      const dur = Number(probe.stdout.trim());
      check("成片时长 = 保留段总长（2.2s，含相邻段合并）", Math.abs(dur - 2.2) < 0.15, String(dur));

      // 音频指纹：BGM 那一段要用它证明「音频真的变了」——文件存在、时长对，都不能证明配乐进了混音。
      // ⚠️ volumedetect 的统计走 **INFO 级日志**：加 `-v error` 会把它自己静默掉（mean 变 NaN，实测踩过）。
      const audioFp = async (f: string): Promise<{ hash: string; mean: number }> => {
        const pcm = await execFileP(
          FFMPEG,
          ["-v", "error", "-i", f, "-vn", "-f", "s16le", "-ar", "8000", "-ac", "1", "-"],
          { encoding: "buffer", maxBuffer: 1 << 26 },
        );
        const vd = await execFileP(FFMPEG, ["-hide_banner", "-i", f, "-af", "volumedetect", "-f", "null", "-"]);
        const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(vd.stderr);
        return { hash: createHash("sha256").update(pcm.stdout as unknown as Buffer).digest("hex").slice(0, 16), mean: m ? Number(m[1]) : NaN };
      };
      const fpNoBgm = await audioFp(path.join(dir, "final.mp4"));

      // kept.json 是结构化判据：段数直接暴露「有没有合并」（2 段 vs 3 段）
      const kept = JSON.parse(await readFile(path.join(dir, "kept.json"), "utf8")) as { ranges: number[][]; total_seconds: number };
      const ranges = JSON.stringify(kept.ranges);
      check("相邻段被合并成 2 段（间隔 0.3s < GAP）", ranges === "[[0,0.8],[1.6,3]]", ranges);

      // 字幕走成片时间轴（不烧画面，属第二出口）
      const srt = await readFile(path.join(dir, "clip.srt"), "utf8");
      const cueCount = (srt.match(/-->/g) ?? []).length;
      check("clip.srt 只含保留句（3 条）", cueCount === 3, String(cueCount));
      check("字幕时间轴已重排到成片（第 2 条从 0.8s 起）", srt.includes("00:00:00,800 --> 00:00:01,600"), srt.split("\n").slice(0, 6).join(" | "));

      // 素材包必须是**真能解开**的 zip（铁律 8：文件存在只是形式）
      const zip = await readFile(path.join(dir, "package.zip"));
      const names = zipEntries(zip).map((e) => e.name).sort();
      check(
        "package.zip 结构可解析且含 final.mp4 / clip.srt / kept.json",
        JSON.stringify(names) === JSON.stringify(["clip.srt", "final.mp4", "kept.json"]),
        JSON.stringify(names),
      );

      const after = (await survey(ROOT)).clips.find((c) => c.id === s05Clip)!;
      const s05after = after.steps.find((s) => s.step === "s05")!;
      check("跑完 s05 判 ready（两出口契约齐）", s05after.status === "ready", s05after.status);
      const s05Keys = ((await readJson<StepFile>(path.join(dir, "step.json")))?.inputs ?? []).map((i) => i.key);
      check(
        "当时不存在的 ai/params/bgm/pick 也登记了",
        ["s03/ai.json", "s05/params.json", "s04/bgm.json", "s04/pick.json"].every((k) => s05Keys.includes(k)),
        s05Keys.join(","),
      );
      const lateAi = path.join(clipDir, "s03", "ai.json");
      await writeFile(lateAi, JSON.stringify({ schema: 1, model: "t", at: "t", decisions: [] }), "utf8");
      check("出片后才出现的 ai.json → s05 stale", (await s05State()) === "stale", await s05State());
      await rename(lateAi, path.join(clipDir, "s03", "_gone_ai.json"));
      check("拿掉后回到 ready", (await s05State()) === "ready", await s05State());
      // s02/s04 都没跑，s05 照样出片：强依赖只用于 stale 传播，不阻塞运行（本轮是最小成片，不吃 s02 产物）
      const s02st = after.steps.find((s) => s.step === "s02")!.status;
      check("s02/s04 未跑时 s05 仍能出片（deps 不阻塞）", s02st === "empty", s02st);

      // ── BGM 叠加：s05 真消费 s04 的 bgm.json（此前 deps 里写着 s04 却不读它，是契约里的谎）──
      // 判据不能是「文件存在」——成片无论如何都存在。必须证明**音频真的变了，且变化方向对**。
      const s04dir = path.join(clipDir, "s04");
      await mkdir(s04dir, { recursive: true });
      // 不读 data/library.json 里的第一首：那份索引指向旧项目 assets/，文件不在时整段中断，
      // 而这里要证明的是混音，不是曲库还在不在。就地生成一段立体声。
      const trackFile = path.join(clipDir, "bed.wav");
      await execFileP(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-ac", "2", trackFile]);
      const track = {
        id: "bed",
        group: "测试",
        title: "测试铺底",
        path: trackFile,
        bytes: (await stat(trackFile)).size,
      };
      const bgmPath = path.join(s04dir, "bgm.json");
      const bgmJson = (trackPath: string): string =>
        JSON.stringify({
          schema: 1,
          mood: track.group!,
          source: "human",
          reason: null,
          track: { id: track.id, title: track.title, path: trackPath, bytes: track.bytes },
          candidates: 1,
          at: new Date().toISOString(),
        } satisfies BgmFile);
      // 复原必须**逐字节**：`inputRef` 对小文件按内容 sha256 取指纹，重新 stringify 会换掉 `at`
      // → 指纹不符 → s05 判 stale，而 stale 优先于 missing，末条「移走素材包 → missing」就拿到 stale 假红。
      // （实测踩过一次：138 PASS / 1 FAIL，红的就是这一条。）
      const goodBgm = bgmJson(track.path);

      await writeFile(bgmPath, goodBgm, "utf8");
      const msgBgm = await runS05(ROOT, `clips/${s05Clip}`, "rS05BGM");
      check("有 bgm.json 时正常出片，并在结果里报出配乐", msgBgm.includes("BGM") && msgBgm.includes(track.title), msgBgm);

      const fpBgm = await audioFp(path.join(dir, "final.mp4"));
      check("成片音频真的变了（配乐进了混音，不是只写了个文件）", fpBgm.hash !== fpNoBgm.hash, `${fpNoBgm.hash} → ${fpBgm.hash}`);
      // 守的是「mono 人声被 amix 上混成 stereo、rematrix 默认 -3 dB」这个只在真跑里看得见的坑：
      // 退回验证实测过——不带 `aformat=channel_layouts=<人声布局>` 时是 -21.1 → -24.1 dB，本断言变红。
      check("叠 BGM 后人声音量没掉（配乐迁就人声的声道布局）", fpBgm.mean > fpNoBgm.mean - 0.5, `${fpNoBgm.mean} → ${fpBgm.mean} dB`);
      const durBgm = Number(
        (await execFileP(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, "final.mp4")])).stdout.trim(),
      );
      check("叠 BGM 后时长不变（无限循环的配乐输入没把成片拉长）", Math.abs(durBgm - 2.2) < 0.15, String(durBgm));

      // 曲目文件不在 → 必须报错：配乐是用户显式选的，静默出个没音乐的片子等于让他自己去发现。
      await writeFile(bgmPath, bgmJson(path.join(clipDir, "nope.mp3")), "utf8");
      const bgmErr = await runS05(ROOT, `clips/${s05Clip}`, "rS05BGMbad").then(() => null, (e: Error) => e.message);
      check("曲目文件缺失 → 据实报错，不静默出片", (bgmErr ?? "").includes("曲目文件不存在"), bgmErr ?? "没有报错");
      await writeFile(bgmPath, goodBgm, "utf8"); // 逐字节复原，别让下一条用例读到被改动的指纹

      // ── 字幕烧录（s05/params.json 的 burn_subtitles，默认烧）──
      // 判据必须是**画面真的变了**。只断言「文件存在」等于没断言——烧没烧成片都存在，
      // 这是本项目在音视频上吃过两次的教训（时长对、文件在，内容照样可以整体是错的）。
      const videoFp = async (f: string): Promise<string> => {
        const { stdout } = await execFileP(FFMPEG, ["-v", "error", "-i", f, "-frames:v", "5", "-f", "framemd5", "-"]);
        return createHash("sha1").update(stdout).digest("hex").slice(0, 12);
      };
      const paramsFile = path.join(dir, "params.json");
      const fpBurned = await videoFp(path.join(dir, "final.mp4"));
      await writeFile(paramsFile, JSON.stringify({ schema: 1, burn_subtitles: false }), "utf8");
      await runS05(ROOT, `clips/${s05Clip}`, "rS05NoSub");
      const fpPlain = await videoFp(path.join(dir, "final.mp4"));
      check("关掉烧录后画面真的不同（字幕确实烧进了画面）", fpBurned !== fpPlain, `${fpBurned} / ${fpPlain}`);
      check("不烧录时 clip.srt 出口照旧在（两出口并列，b24）", (await stat(path.join(dir, "clip.srt"))).size > 0);
      await writeFile(paramsFile, JSON.stringify({ schema: 1, burn_subtitles: true }), "utf8");
      await runS05(ROOT, `clips/${s05Clip}`, "rS05SubAgain");
      check("改回烧录 → 画面又与不烧录时不同（开关双向生效，不是单程）", (await videoFp(path.join(dir, "final.mp4"))) !== fpPlain);
      check("渲染参数登记进 s05 的输入（改开关会让 s05 变脏）", ((await readJson<StepFile>(path.join(dir, "step.json")))?.inputs ?? []).some((i) => i.key === "s05/params.json"));

      // 退回验证的等价物：两出口**并列**，缺任一个都必须 missing（只出一个不算兑现 b24）
      await rename(path.join(dir, "package.zip"), path.join(dir, "_gone_package.zip"));
      const goneState = await s05State();
      check("移走素材包 → s05 立刻 missing（两出口并列都是契约）", goneState === "missing", goneState);
    } finally {
      for (const d of [jobDir, clipDir]) {
        const e = await removeQuietly(d);
        if (e) console.log(`  ⚠️ 夹具清理失败（work/ 会留残留）：${d}（${e}）`);
      }
    }
  }

  // ── 阶段 3 收口（3.4 s01 抽卡 / 3.5 变体主干 + 档位 + 重跑预览 + 人工换曲 + 曲库出口） ──
  // 用一条**全新的片段**当夹具：主夹具此刻已被上面各段用过，状态不再是干净起点
  // （铁律：验证脚本不得假设起点干净，但也不该在脏状态上断言新功能）。
  {
    const c2 = await api<{ id: string }>("/api/clips", {
      method: "POST",
      body: JSON.stringify({ job_id: jobId, title: "收口夹具", start: sentences.sentences[0]!.start, end: sentences.sentences[7]!.end }),
    }).then((r) => r.id);
    const c2owner = `clips/${c2}`;
    const c2dir = path.join(VROOT, "work", c2owner);
    // ⚠️ 曲库夹具必须**显式复位**：上面的 [s04] 段把临时曲库（测试组A/B、假文件路径）写进了
    // VROOT/data/library.json 且**没有复原**（它的用例只关心分组名，不需要真文件）。
    // 而服务端读的是 VROOT 的曲库——不复位的话：规则路的 mood 对不上（实测踩到）、
    // 曲库出口 404、换曲拿到假 id。所以这里把项目的真实曲库拷过来，别指望上一段会还回来。
    await copyFile(path.join(ROOT, "data", "library.json"), path.join(VROOT, "data", "library.json"));
    const libAll = JSON.parse(await readFile(path.join(VROOT, "data", "library.json"), "utf8")) as {
      items: { id: string; kind: string; group: string | null; title: string; path: string; bytes: number }[];
    };
    // 索引里的路径指向旧项目 assets/，那些文件已经不在。分组和 id 保留，文件换成一段真音频，
    // 否则规则路选中的第一首不存在，自动链的 s04 会失败，后面的换曲和试听也没有东西可播。
    const bed = path.join(VROOT, "library-bed.wav");
    await execFileP(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-ac", "2", bed]);
    const bedBytes = (await stat(bed)).size;
    for (const item of libAll.items) {
      if (item.kind !== "bgm") continue;
      item.path = bed;
      item.bytes = bedBytes;
    }
    await writeFile(path.join(VROOT, "data", "library.json"), JSON.stringify(libAll));
    const bgmAll = libAll.items.filter((i) => i.kind === "bgm");
    // 规则路要求曲目**有分组**（moodDomain 只收 group 非空的）——夹具前提，先守一条
    const withGroup = bgmAll.find((i) => i.group);
    check("曲库里有带分组的 bgm（规则路夹具前提）", withGroup !== undefined, `bgm ${bgmAll.length} 首`);
    const mood0 = withGroup!.group!;
    // s04 走**规则路**（人工指定 mood）→ 不需要 LLM，自动链才能在本机无 key 的环境里真跑通
    await mkdir(path.join(c2dir, "s04"), { recursive: true });
    await writeFile(path.join(c2dir, "s04", "params.json"), JSON.stringify({ schema: 1, bgm_mood: mood0 }), "utf8");

    // N1. 档位：全局默认 + 单条覆盖 + 生效值回落（b3/b4）
    await api("/api/automation/global", { method: "PUT", body: JSON.stringify({ settings: { s04: "auto" } }) });
    await api(`/api/automation/${c2owner}`, { method: "PUT", body: JSON.stringify({ settings: { s04: "manual" }, scope: "override" }) });
    const av1 = await api<AutomationView>(`/api/automation/${c2owner}`);
    check("覆盖压过全局（override s04=manual）", av1.effective.s04 === "manual" && av1.override.s04 === "manual" && av1.global.s04 === "auto");
    check("没被覆盖的步回落全局/默认", av1.effective.s03 === "manual" && av1.effective.s05 === "manual");

    // N2. 自动链的**反面**：档位=人工时，上游跑完不该自动往下跑。
    // 这条不能省——只测「auto 会跑」的话，一个「永远自动跑」的错误实现也会通过（铁律 12）。
    // 双保险：只统计本次新增的 run。即使将来把 VROOT 改回固定名根，
    // 旧夹具里的 s04 记录也不会把 N2 反面 / N3 正面读成假红或假绿。
    const s04Baseline = new Set(
      (await api<RunRecord[]>("/api/runs")).filter((r) => r.owner === c2owner && r.step === "s04").map((r) => r.id),
    );
    const s04Runs = async (): Promise<RunRecord[]> =>
      (await api<RunRecord[]>("/api/runs")).filter((r) => r.owner === c2owner && r.step === "s04" && !s04Baseline.has(r.id));
    await runAndWait(c2owner, "s03", null);
    await new Promise((r) => setTimeout(r, 4000)); // 给「万一真自动跑了」足够的时间露头
    check("档位=人工时不自动跑 s04（反面）", (await s04Runs()).length === 0, String((await s04Runs()).length));

    // N3. 自动链的**正面**：删掉覆盖 → 回落全局 auto → 重跑 s03 → s04 应被自动拉起并跑成。
    await api(`/api/automation/${c2owner}`, { method: "PUT", body: JSON.stringify({ settings: {}, scope: "override" }) });
    const av2 = await api<AutomationView>(`/api/automation/${c2owner}`);
    check("删掉覆盖后回落全局（s04=auto）", av2.effective.s04 === "auto" && !("s04" in av2.override));
    await runAndWait(c2owner, "s03", null);
    let autoRec: RunRecord | null = null;
    for (let i = 0; i < 40 && !autoRec; i++) {
      await new Promise((r) => setTimeout(r, 500));
      autoRec = (await s04Runs())[0] ?? null;
    }
    check("档位=自动时 s03 跑完自动拉起 s04（正面）", autoRec !== null);
    for (let i = 0; i < 40 && autoRec && autoRec.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      autoRec = (await s04Runs())[0] ?? null;
    }
    check("自动拉起的 s04 真的跑成了", autoRec?.status === "done", autoRec?.error ?? autoRec?.status ?? "没有 run");

    // N3b. 重复跑命中复用：规则路的 s04 不读句流，s03 再跑一遍输入没变，
    // 已经 ready 的 s04 不得被自动链再拉起（runs.ts：档位不是「每次都重算」）。
    const s04Before = (await s04Runs()).length;
    const bgmBytes = await readFile(path.join(c2dir, "s04", "bgm.json"));
    await runAndWait(c2owner, "s03", null);
    await new Promise((r) => setTimeout(r, 4000));
    const s04After = await s04Runs();
    check("重复跑命中复用：已就绪的 s04 不再被拉起", s04After.length === s04Before, `${s04Before} → ${s04After.length}`);
    check("复用时 s04 产物逐字节未动", Buffer.compare(bgmBytes, await readFile(path.join(c2dir, "s04", "bgm.json"))) === 0);
    const svReuse = await api<Survey>("/api/survey");
    check("复用后 s04 仍是就绪", stepState(svReuse, "clips", c2, "s04") === "ready", stepState(svReuse, "clips", c2, "s04"));

    // N4. 重跑预览（b39）：只列将动哪些文件、不估时长
    const pv = await api<{
      writes: string[]; marks_stale: { step: string }[]; warnings: string[];
    }>(`/api/preview/${c2owner}/s03`);
    check("预览列出将写入的产物", pv.writes.some((w) => w.endsWith(`${c2owner}/s03/sentences.json`)), JSON.stringify(pv.writes));
    check("预览标出会被标脏的下游（s04 已就绪）", pv.marks_stale.some((s) => s.step === "s04"), JSON.stringify(pv.marks_stale));
    check("预览不含未就绪的下游（s05 未跑）", !pv.marks_stale.some((s) => s.step === "s05"), JSON.stringify(pv.marks_stale));
    check("预览不估时长", !/[秒分时]钟?\s*$|预计|大约|耗时/.test(JSON.stringify(pv)), JSON.stringify(pv));
    const pv5 = await api<{ warnings: string[] }>(`/api/preview/${c2owner}/s05`);
    check("预览对未就绪的强依赖给出警告", pv5.warnings.some((w) => w.includes("强依赖")), JSON.stringify(pv5.warnings));

    // N5. 变体与主干（b7/b8）：抽卡多版 + 切回侧枝**不重跑 AI** + 人工覆盖层逐字节不动（b29/b46）
    const ovFile = path.join(c2dir, "s03", "overlay.json");
    const sentsNow = (await api<S03View>(`/api/clips/${c2}/s03`)).sentences;
    await api(`/api/clips/${c2}/s03/overlay`, { method: "POST", body: JSON.stringify({ sentence_id: sentsNow[0]!.id, keep: false }) });
    const ovBefore = await readFile(ovFile);
    const mkAi = (tag: string): AiDraftFile => ({ schema: 1, model: "simulate", at: `2026-01-0${tag}T00:00:00.000Z`, decisions: [{ id: sentsNow[1]!.id, keep: false, reason: `第${tag}版` }] });
    const aiA = mkAi("1");
    const aiB = mkAi("2");
    const s03Inputs = [await inputRef(VROOT, "s03/sentences.json", `${c2owner}/s03/sentences.json`)];
    const vA = await commitVariant(VROOT, c2owner, "s03", { model: "simulate", label: "第一版" }, aiA, { inputs: s03Inputs, outputs: ["ai.json"] });
    const vB = await commitVariant(VROOT, c2owner, "s03", { model: "simulate", label: "第二版" }, aiB, { inputs: s03Inputs, outputs: ["ai.json"] });
    check("两次抽卡得到 v1 / v2", vA.meta.id === "v1" && vB.meta.id === "v2", `${vA.meta.id}/${vB.meta.id}`);
    const vv = await api<VariantsView>(`/api/variants/${c2owner}`);
    const s03v = vv.steps.find((s) => s.step === "s03")!;
    check("分叉树列出两版且主干=最新", s03v.variants.length === 2 && s03v.active === "v2", JSON.stringify(s03v));
    await api(`/api/variants/${c2owner}/s03/${vA.meta.id}/activate`, { method: "POST", body: "{}" });
    const aiNow = await readJson<AiDraftFile>(path.join(c2dir, "s03", "ai.json"));
    check("切回侧枝 = 物化那一版（不重跑 AI：时间戳是存档里的，不是刚刚）", aiNow?.at === aiA.at, `${aiNow?.at} vs ${aiA.at}`);
    check("切主干后人工覆盖层逐字节未变（b29/b46）", Buffer.compare(ovBefore, await readFile(ovFile)) === 0);
    const vv2 = await api<VariantsView>(`/api/variants/${c2owner}`);
    check("切回后主干指向 v1", vv2.steps.find((s) => s.step === "s03")!.active === "v1");
    // 分叉树的边：s04 也是 AI 步，它的变体要记下「创建时 s03 的生效变体」。
    // 载荷直接用曲库里的真实曲目构造，**不依赖自动链那一步是否成功**——
    // 否则一条上游失败会把后面所有用例连锁带崩（第一次跑就是这样：159 PASS / 3 FAIL + 中断）。
    const seedTrack = bgmAll.find((i) => i.group === mood0)!;
    const s04Payload: BgmFile = {
      schema: 1, mood: mood0, source: "human", reason: null,
      track: { id: seedTrack.id, title: seedTrack.title, path: seedTrack.path, bytes: seedTrack.bytes },
      candidates: 1, at: "2026-01-03T00:00:00.000Z",
    };
    const v04 = await commitVariant(VROOT, c2owner, "s04", { model: "simulate", label: "配乐甲" }, s04Payload, {
      inputs: [await inputRef(VROOT, "s04/bgm.json", `${c2owner}/s04/bgm.json`)],
      outputs: ["bgm.json"],
    });
    check("分叉树的边记到上游生效变体（s04 的 parent = s03/v1）", v04.meta.parent === "s03/v1", String(v04.meta.parent));

    // N6. 人工换曲（b29/b46）：写覆盖层 pick.json，**不动** bgm.json；越界拒；可清除
    const bgmFile = path.join(c2dir, "s04", "bgm.json");
    const bgmBefore = await readFile(bgmFile);
    const curTrack = s04Payload.track.id;
    // 换一首**不同于当前**的：只有 1 首时退化为「换成同一首」，断言仍成立（pick 照样是人工来源）
    const other = bgmAll.find((i) => i.id !== curTrack) ?? bgmAll[0]!;
    check("曲库 bgm 至少两首（换曲用例的完整前提）", bgmAll.length >= 2, `bgm ${bgmAll.length} 首`);
    const s04v1 = await api<S04View>(`/api/clips/${c2}/s04`);
    check("换曲前生效曲目来自 s04 产物", s04v1.track_source === "ai" && s04v1.total === bgmAll.length, `${s04v1.track_source}/${s04v1.total}`);
    const s04v2 = await api<S04View>(`/api/clips/${c2}/s04/pick`, { method: "POST", body: JSON.stringify({ track_id: other.id }) });
    check("换曲后生效曲目来自人工", s04v2.track_source === "human" && s04v2.track?.id === other.id, JSON.stringify(s04v2.track));
    check("换曲不改 s04 产物（bgm.json 逐字节未变）", Buffer.compare(bgmBefore, await readFile(bgmFile)) === 0);
    check("曲库清单下发全部 bgm（b33/b34：全部可列出）", s04v1.groups.reduce((n, g) => n + g.tracks.length, 0) === bgmAll.length);
    const pickBad = await fetch(`http://127.0.0.1:${port}/api/clips/${c2}/s04/pick`, { method: "POST", body: JSON.stringify({ track_id: "no-such-track" }) });
    check("换一首曲库里没有的 → 400（不在出片时才报错）", pickBad.status === 400, String(pickBad.status));
    // 曲库换血：人工选的那首没了 → missing_pick 亮出来，且不静默回落
    await writeFile(path.join(c2dir, "s04", "pick.json"), JSON.stringify({ schema: 1, track_id: "gone-track", at: "" }), "utf8");
    const s04v3 = await api<S04View>(`/api/clips/${c2}/s04`);
    check("人工选的曲子已不在曲库 → missing_pick 亮出（不静默回落）", s04v3.missing_pick === true, JSON.stringify(s04v3));
    const pickClear = await api<S04View>(`/api/clips/${c2}/s04/pick`, { method: "POST", body: JSON.stringify({ track_id: null }) });
    check("清除人工换曲 → 回落 s04 产物且 pick 文件消失", pickClear.track_source === "ai" && pickClear.pick === null);

    // N7. 曲库媒体出口（b34：可播）+ s01 抽卡的越界过滤
    const libMedia = await fetch(`http://127.0.0.1:${port}/api/media/library/${encodeURIComponent(bgmAll[0]!.id)}`);
    const libRanged = await fetch(`http://127.0.0.1:${port}/api/media/library/${encodeURIComponent(bgmAll[0]!.id)}`, { headers: { range: "bytes=0-1023" } });
    check("曲库条目可播（200 + Range 206）", libMedia.status === 200 && libRanged.status === 206, `${libMedia.status}/${libRanged.status}`);
    const libBad = await fetch(`http://127.0.0.1:${port}/api/media/library/nope`);
    check("曲库出口只认登记过的 id（未知 id 404）", libBad.status === 404, String(libBad.status));
    const san = sanitizeHighlights({ highlights: [
      { title: "合法", start: 5, end: 25, reason: "ok" },
      { title: "倒置", start: 30, end: 10, reason: "" },
      { title: "过短", start: 5, end: 8, reason: "" },
      { title: "过长", start: 0, end: 200, reason: "" },
      { title: "", start: 5, end: 25, reason: "" },
      { title: "越界", start: 5, end: 9999, reason: "" },
    ] }, 0, 28);
    check("s01 候选越界/倒置/过短/过长/空标题全被丢弃且如实计数", san.kept.length === 1 && san.dropped === 5, `${san.kept.length}/${san.dropped}`);
    check("s01 保留项的 id/时间被规范化", san.kept[0]!.id === "h1" && san.kept[0]!.start === 5 && san.kept[0]!.end === 25);
    const s01view = await api<{ ai: unknown; candidates: { clips: unknown[] } }>(`/api/jobs/${jobId}/s01`);
    const moodSet = await api<S04View>(`/api/clips/${c2}/s04/params`, { method: "POST", body: JSON.stringify({ bgm_mood: mood0 }) });
    check("界面能把风格写成 params（规则路不靠手改文件）", moodSet.bgm_mood === mood0 && moodSet.moods.includes(mood0), `${moodSet.bgm_mood}/${moodSet.moods.length}`);
    const moodBad = await fetch(`http://127.0.0.1:${port}/api/clips/${c2}/s04/params`, { method: "POST", body: JSON.stringify({ bgm_mood: "没有这组" }) });
    check("风格不在曲库值域 → 400", moodBad.status === 400, String(moodBad.status));
    const moodClear = await api<S04View>(`/api/clips/${c2}/s04/params`, { method: "POST", body: JSON.stringify({ bgm_mood: null }) });
    check("清空风格 → 回到 LLM 兜底", moodClear.bgm_mood === null);
    await writeFile(path.join(c2dir, "s04", "params.json"), JSON.stringify({ schema: 1, bgm_mood: mood0 }), "utf8");
    check("s01 未跑 AI 时：人工定稿在、AI 提案为 null（分文件存放）", s01view.ai === null && s01view.candidates.clips.length >= 1, JSON.stringify(s01view.ai));
    const s01run = await runAndWait(`jobs/${jobId}`, "s01", null);
    check("未配 LLM 时 s01 抽卡据实失败（不静默成功）", s01run.status === "error" && (s01run.error ?? "").includes("未配置"), s01run.error ?? "");

    const e2 = await removeQuietly(c2dir);
    if (e2) console.log(`  ⚠️ 收口夹具清理失败（work/ 会留残留）：${c2dir}（${e2}）`);
  }

  // O. 并发写同一文件（2026-09-18 端到端验收实测到的真缺陷）
  //    writeJsonAtomic 原先把 tmp 固定成 `<file>.tmp`：并发写时甲 rename 成功即把 tmp 挪走，
  //    乙的 rename 立刻 ENOENT。乙若是「不 await 的心跳」（s02 的 10 秒 beat、demucs 的 progress
  //    事件），那就是**未捕获 rejection → 整个步进程退出 1**，run 记录只剩「进程异常退出（code 1）」。
  //    退回验证：把 tmp 改回固定名，这条立刻变红。
  {
    const target = path.join(VROOT, "concurrent.json");
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => writeJsonAtomic(target, { i })));
    const bad = results.filter((r) => r.status === "rejected");
    check(
      "24 路并发写同一文件：零失败（tmp 名唯一，rename 不互抢）",
      bad.length === 0,
      bad.length ? `${bad.length} 路失败，例：${String((bad[0] as PromiseRejectedResult).reason).slice(0, 140)}` : "",
    );
    const back = await readJson<{ i: number }>(target);
    check("并发写后文件仍是完整合法 JSON（没被写坏）", !!back && typeof back.i === "number", JSON.stringify(back));
  }

  // 素材入库走界面接口，不要求人去跑命令行。扫不到文件时不写盘，避免把好曲库覆盖空。
  {
    const libFile = path.join(VROOT, "data", "library.json");
    const before = await readFile(libFile);
    const rootLib = await readFile(path.join(ROOT, "data", "library.json"));
    const missing = await fetch(`http://127.0.0.1:${port}/api/library/ingest`, {
      method: "POST",
      body: JSON.stringify({ source_root: path.join(VROOT, "no-such-assets") }),
    });
    check("素材目录不存在 → 400", missing.status === 400, String(missing.status));
    await mkdir(path.join(VROOT, "empty-assets"), { recursive: true });
    const empty = await fetch(`http://127.0.0.1:${port}/api/library/ingest`, {
      method: "POST",
      body: JSON.stringify({ source_root: path.join(VROOT, "empty-assets") }),
    });
    check("目录里没有可登记素材 → 400", empty.status === 400, String(empty.status));
    check("失败的入库没有改曲库文件", Buffer.compare(before, await readFile(libFile)) === 0);
    const assets = path.join(VROOT, "tiny-assets", "bgm", "分组甲");
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, "a.mp3"), "a");
    await writeFile(path.join(assets, "b.mp3"), "bb");
    const ok = await api<{ count: number; bgm: number }>("/api/library/ingest", {
      method: "POST",
      body: JSON.stringify({ source_root: path.join(VROOT, "tiny-assets") }),
    });
    check("入库扫到两首测试曲", ok.count === 2 && ok.bgm === 2, JSON.stringify(ok));
    const ids1 = (JSON.parse(await readFile(libFile, "utf8")) as { items: { id: string }[] }).items.map((i) => i.id).join();
    await api("/api/library/ingest", {
      method: "POST",
      body: JSON.stringify({ source_root: path.join(VROOT, "tiny-assets") }),
    });
    const ids2 = (JSON.parse(await readFile(libFile, "utf8")) as { items: { id: string }[] }).items.map((i) => i.id).join();
    check("同一批文件再入库，id 不变", ids1 === ids2 && ids1.length > 0, `${ids1} → ${ids2}`);
    check("入库没有改程序目录里的曲库", Buffer.compare(rootLib, await readFile(path.join(ROOT, "data", "library.json"))) === 0);
    await copyFile(path.join(ROOT, "data", "library.json"), libFile);
  }

  // demucs 读文件的回落自己调 ffprobe/ffmpeg，不带路径。PATH 里没有时必须落到随包目录。
  {
    const wav = path.join(VROOT, "ff-probe.wav");
    await execFileP(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-ac", "1", wav]);
    const py = path.join(ROOT, "tools", "python", "venv", "Scripts", "python.exe");
    const script = [
      "import os, sys",
      "from pathlib import Path",
      "from demucs.audio import AudioFile",
      "wav = AudioFile(Path(sys.argv[1])).read(streams=0, samplerate=44100, channels=1)",
      "print('SHAPE', tuple(int(x) for x in wav.shape))",
      "print('FFDIR', os.environ.get('PATH','').split(os.pathsep)[0])",
    ].join("\n");
    const runPy = (env: NodeJS.ProcessEnv) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const child = spawn(py, ["-c", script, wav], { env, windowsHide: true });
        let out = "";
        child.stdout.on("data", (b: Buffer) => (out += b.toString()));
        child.stderr.on("data", (b: Buffer) => (out += b.toString()));
        child.on("exit", (code) => resolve({ code: code ?? 1, out }));
      });
    const bare: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(bare)) if (key.toLowerCase() === "path") delete bare[key];
    bare.PATH = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const missed = await runPy(bare);
    check(
      "PATH 里没有 ffmpeg 时，demucs 读音频失败",
      missed.code !== 0 && /ffprobe|FileNotFoundError|ffmpeg/i.test(missed.out),
      missed.out.slice(-180),
    );
    const hit = await runPy(pythonChildEnv(bare));
    const ffdir = path.join(ROOT, "tools", "ffmpeg");
    check(
      "随包 ffmpeg 目录放在 PATH 最前，demucs 就能读",
      hit.code === 0 && hit.out.includes("SHAPE") && hit.out.includes(ffdir),
      hit.out.slice(-220),
    );
  }

  await writeFile(path.join(VROOT, "verify-ids.json"), JSON.stringify({ jobId, clipId }), "utf8");
  console.log(`\n结果：${passed} PASS / ${failed} FAIL（素材根 ${VROOT}，job=${jobId} clip=${clipId}）`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("验证中断：", e);
    // 中断时也必须给出已跑进度：否则异常栈把「跑了多少条、错在哪一步」全吞掉，
    // 看起来像「脚本坏了」而不是「某条用例的环境前提不成立」（第 5 轮同款教训）。
    console.error(`（中断前已跑：${passed} PASS / ${failed} FAIL）`);
    process.exitCode = 1;
  })
  .finally(async () => {
    server?.kill();
    // 收尾必须删 VROOT：之前只有 server.kill()，于是每跑一次就在 work/_scratch 永久留一份
    // 约 1.8MB 的素材根（2026-11-11 实测残留 8 份 / 14MB，就是「一跑一份地堆」的来源）。
    // 清理失败只告警不抛——脚本已经跑完了，为了一句「删不掉」把成功退出改成失败退出，
    // 只会让人误判成验证没过。
    const e = await removeQuietly(VROOT);
    if (e) console.log(`⚠️ 素材根未删除（${VROOT}）：${e}`);
  });
