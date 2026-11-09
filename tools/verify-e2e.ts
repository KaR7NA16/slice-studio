// 阶段 3 端到端验收（b57 / b18）：**真实公开素材 + 真实服务 + 真实 HTTP**，全程无 fixture。
//
// 素材（自找公开可商用）：archive.org 公共领域中文影片《马路天使》(1937) 第 2700–2760 秒。
//   影片页 https://archive.org/details/street_angel （licenseurl 标 publicdomain）
//   取片方式：ffmpeg 直接对远端 mp4 做 Range 读取 + 区间拷贝，不下整部片（90 分钟 / 565MB）。
//   该区间实测有真实对白（"要不是姐姐叫我来 / 我总不在这看见你了…"），不是音乐段。
//
// 输入形态：**只给视频，不给 SRT** → 强制走 s00 的 ASR 兜底路（b42/b2/b14/b41）。
//   SRT 优先那条路由 verify-stage2 覆盖（它给的就是真 SRT），这里补的是「无 SRT 也能出字幕」。
//
// 与剪映真实场景的偏离（b57 原文要求记明）：
//   ① LLM：本机无任何 LLM 凭据，s01/s03/s04 的模型调用打到本脚本起的**本地桩**。
//      桩是真实 HTTP 往返（真实 Authorization、真实请求体、真实 JSON 解析），只把提供方换成几十行代码；
//      所以验到的是「我们的代码怎么发请求、怎么解析、怎么报错」，不是「某家 API 今天通不通」。
//   ② 素材规格：320×240 / 29.97fps / 60 秒。剪映的真实场景是 1080p 长视频（几十分钟），
//      分辨率与时长的量级不同——本验收证的是**链路与产物真实**，不是性能量级。
//   ③ ASR：引擎是 FunASR 的 Paraformer-zh（ONNX 权重），但没有标点模型（本包只含 ASR AM），
//      所以断句按**停顿**而不是按标点。见 tools/asr_worker.py 头部。
//   ④ 数据根：本脚本用 work/_e2e 而不是项目根，避免把验收产物混进产品数据。
//      服务本身是 root 参数化的，换根不改任何代码路径。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, link, mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { RunRecord, Survey } from "../src/shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const EROOT = path.join(ROOT, "work", "_e2e");
const FFMPEG = path.join(ROOT, "tools", "ffmpeg", "ffmpeg.exe");
const FFPROBE = path.join(ROOT, "tools", "ffmpeg", "ffprobe.exe");
const execFileP = promisify(execFile);

const SRC_URL = "https://archive.org/download/street_angel/street_angel_512kb.mp4";
const SRC_FROM = 2700;
const SRC_SECONDS = 60;
const CLIP_SECONDS = 25; // 高光窗口；太长会让 demucs 那段变慢，25 秒足够覆盖多句对白

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

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// 真实素材：已存在就复用（重跑不再打一次网络）。
async function ensureMaterial(out: string): Promise<void> {
  if (await exists(out)) {
    console.log(`  素材已在盘上，跳过下载：${out}`);
    return;
  }
  console.log(`  从 archive.org 取真实片段（${SRC_FROM}s 起 ${SRC_SECONDS}s，Range 读取）…`);
  await execFileP(FFMPEG, ["-hide_banner", "-v", "error", "-ss", String(SRC_FROM), "-t", String(SRC_SECONDS), "-i", SRC_URL, "-c", "copy", "-y", out], { maxBuffer: 1 << 24 });
}

// 权重按**硬链接**挂进验收根：同卷瞬时完成，不复制 320MB。
async function linkModels(): Promise<string[]> {
  const done: string[] = [];
  for (const [sub, names] of [
    ["asr", ["model.int8.onnx", "tokens.txt", "am.mvn", "config.yaml"]],
    ["demucs", ["htdemucs.yaml", "955717e8-8726e21a.th"]],
  ] as const) {
    const dstDir = path.join(EROOT, "models", sub);
    await mkdir(dstDir, { recursive: true });
    for (const n of names) {
      const src = path.join(ROOT, "models", sub, n);
      const dst = path.join(dstDir, n);
      if (!(await exists(src))) throw new Error(`权重缺失：${src}`);
      if (await exists(dst)) {
        done.push(`${sub}/${n}(已存在)`);
        continue;
      }
      await link(src, dst);
      done.push(`${sub}/${n}`);
    }
  }
  return done;
}

// ---- 本地 LLM 桩：真实 HTTP，按 system 提示分流，返回各家步骤契约要求的 JSON ----
function startLlmStub(): Promise<{ port: number; close: () => void; calls: string[] }> {
  const calls: string[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "e2e-stub" }] }));
        return;
      }
      if (!url.endsWith("/chat/completions")) {
        res.writeHead(404).end("{}");
        return;
      }
      const parsed = JSON.parse(body) as { messages?: { role: string; content: string }[] };
      const sys = parsed.messages?.find((m) => m.role === "system")?.content ?? "";
      const user = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      let content = "{}";
      if (sys.includes("选题助手")) {
        calls.push("s01");
        const u = JSON.parse(user) as { range: { start: number; end: number } };
        const start = u.range.start;
        const end = Math.min(start + CLIP_SECONDS, u.range.end);
        content = JSON.stringify({
          highlights: [{ title: "真实片段", start, end, reason: "桩：取句流起点起的连续对白段" }],
        });
      } else if (sys.includes("剪辑助手")) {
        calls.push("s03");
        content = JSON.stringify({ deletions: [] });
      } else if (sys.includes("配乐")) {
        calls.push("s04");
        const m = sys.match(/：(.+)$/m);
        const moods = (m?.[1] ?? "").split("/").map((s) => s.trim()).filter(Boolean);
        content = JSON.stringify({ mood: moods[0] ?? "", reason: "桩：取值域内第一组" });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => srv.close(), calls });
    });
  });
}

let server: ChildProcess | null = null;
let port = 0;
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, init);
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j;
}

// 超时给到 10 分钟：s02 要真跑 demucs（CPU），s00 要真跑 ASR。
async function runAndWait(owner: string, step: string, mode: string | null): Promise<RunRecord> {
  const rec = await api<RunRecord>("/api/run", { method: "POST", body: JSON.stringify({ owner, step, mode }) });
  for (let i = 0; i < 1200; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const cur = await api<RunRecord>(`/api/runs/${rec.id}`);
    if (cur.status !== "running") return cur;
  }
  throw new Error(`run 超时：${owner} ${step}`);
}

const stepState = (s: Survey, kind: "jobs" | "clips", id: string, step: string): string =>
  s[kind].find((o) => o.id === id)?.steps.find((st) => st.step === step)?.status ?? "missing";

async function probe(file: string): Promise<{ streams: string[]; duration: number; size: number }> {
  const { stdout } = await execFileP(FFPROBE, [
    "-hide_banner", "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=codec_type",
    "-of", "json", file,
  ]);
  const j = JSON.parse(stdout) as { format?: { duration?: string; size?: string }; streams?: { codec_type?: string }[] };
  return {
    streams: (j.streams ?? []).map((s) => s.codec_type ?? ""),
    duration: Number(j.format?.duration ?? 0),
    size: Number(j.format?.size ?? 0),
  };
}

// 全解码一遍：只 stat 文件存在证明不了「能播」。
async function decodesClean(file: string): Promise<string> {
  try {
    await execFileP(FFMPEG, ["-hide_banner", "-v", "error", "-i", file, "-f", "null", "-"], { maxBuffer: 1 << 24 });
    return "";
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 200) : String(e);
  }
}

async function main(): Promise<void> {
  await mkdir(path.join(EROOT, "input"), { recursive: true });
  const video = path.join(EROOT, "input", "street-angel-2700-2760.mp4");
  console.log("准备真实公开素材…");
  await ensureMaterial(video);
  const vp = await probe(video);
  check("素材是真视频（有视频轨 + 音频轨）", vp.streams.includes("video") && vp.streams.includes("audio"), vp.streams.join(","));

  console.log("挂权重（硬链接）与曲库（真实资产）…");
  const linked = await linkModels();
  console.log(`  ${linked.join(" / ")}`);
  await mkdir(path.join(EROOT, "data"), { recursive: true });
  await copyFile(path.join(ROOT, "data", "library.json"), path.join(EROOT, "data", "library.json"));
  const lib = JSON.parse(await readFile(path.join(EROOT, "data", "library.json"), "utf8")) as { items: unknown[] };
  check("曲库是真资产（非空）", lib.items.length > 0, String(lib.items.length));

  const llm = await startLlmStub();
  server = spawn(process.execPath, [path.join(ROOT, "src", "server", "main.ts"), EROOT], { stdio: ["ignore", "pipe", "inherit"] });
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
  console.log(`服务已起：:${port}（数据根 ${EROOT}）\n开始端到端：`);

  // 配 LLM（打到本地桩）——和用户在设置页里配一次是同一个入口、同一份落盘。
  await api("/api/llm", {
    method: "PUT",
    body: JSON.stringify({
      profiles: [{ id: "e2e", name: "端到端桩", base_url: `http://127.0.0.1:${llm.port}/v1`, api_key: "stub-key", model: "e2e-stub" }],
      default_id: "e2e",
    }),
  });

  // ① 建任务：**只给视频，不给 SRT** —— 强制 ASR 兜底
  const { id: jobId } = await api<{ id: string }>("/api/jobs", { method: "POST", body: JSON.stringify({ video_path: video }) });
  const r0 = await runAndWait(`jobs/${jobId}`, "s00", null);
  check("s00 无 SRT 也能出字幕（ASR 兜底真跑）", r0.status === "done", `${r0.status} / ${r0.message}`);
  const sentences = await api<{ sentences: { start: number; end: number; text: string }[] }>(`/api/jobs/${jobId}/sentences`);
  const text = sentences.sentences.map((s) => s.text).join("");
  check("转写出多句真实中文（≥3 句）", sentences.sentences.length >= 3, `仅 ${sentences.sentences.length} 句`);
  check("转写文本是中文（含 CJK 字符）", /[\u4e00-\u9fa5]/.test(text), text.slice(0, 40));
  check("句子时间轴单调且落在素材时长内", sentences.sentences.every((s, i, a) => s.end > s.start && s.start >= 0 && s.end <= vp.duration + 1 && (i === 0 || s.start >= a[i - 1]!.start)), JSON.stringify(sentences.sentences.slice(0, 2)));
  console.log(`  识别文本：${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`);

  // ② s01 抽卡（AI 提案）。mode 只对 s03 的 draft 有意义，s01 跑起来就是抽卡。
  const r1 = await runAndWait(`jobs/${jobId}`, "s01", null);
  check("s01 抽卡走通（LLM 真 HTTP 往返）", r1.status === "done", `${r1.status} / ${r1.message}`);
  const s01 = await api<{ ai: { candidates: { title: string; start: number; end: number }[] } | null }>(`/api/jobs/${jobId}/s01`);
  const cand = s01.ai?.candidates?.[0];
  check("s01 产出可用高光候选", !!cand && cand.end > cand.start, JSON.stringify(cand));

  // ③ 人工定稿 = 建片段（b1 默认人工）
  const { id: clipId } = await api<{ id: string }>("/api/clips", {
    method: "POST",
    body: JSON.stringify({ job_id: jobId, title: "端到端片段", start: cand!.start, end: cand!.end }),
  });
  let sv = await api<Survey>("/api/survey");
  check("建片段即人工定稿，s01 ready", stepState(sv, "jobs", jobId, "s01") === "ready", stepState(sv, "jobs", jobId, "s01"));

  // ④ s02 人声分离（真跑 demucs）
  const r2 = await runAndWait(`clips/${clipId}`, "s02", null);
  check("s02 人声分离真跑成功", r2.status === "done", `${r2.status} / ${r2.message}`);
  const s02dir = path.join(EROOT, "work", "clips", clipId, "s02");
  check("s02 产出 vocals.wav / no_vocals.wav", (await exists(path.join(s02dir, "vocals.wav"))) && (await exists(path.join(s02dir, "no_vocals.wav"))));

  // ⑤ s03 句流（含 LLM 兜底路的删句建议）
  const r3 = await runAndWait(`clips/${clipId}`, "s03", null);
  check("s03 构建成功", r3.status === "done", `${r3.status} / ${r3.message}`);
  const s03 = await api<{ sentences: { keep: boolean }[] }>(`/api/clips/${clipId}/s03`);
  check("片段句流非空且默认全留", s03.sentences.length > 0 && s03.sentences.every((s) => s.keep), String(s03.sentences.length));

  // ⑥ s04 配乐（走 LLM 兜底路 → mood 值域来自真实曲库）
  const r4 = await runAndWait(`clips/${clipId}`, "s04", null);
  check("s04 配乐成功（mood 取自真实曲库值域）", r4.status === "done", `${r4.status} / ${r4.message}`);
  const s04 = await api<{ track: { id: string; title: string } | null; bgm: { track?: { id: string } } | null }>(`/api/clips/${clipId}/s04`);
  check("s04 真的选出了一首曲目", !!s04.track, JSON.stringify(s04.track));

  // ⑦ s05 合成：出真实 mp4
  const r5 = await runAndWait(`clips/${clipId}`, "s05", null);
  check("s05 合成成功", r5.status === "done", `${r5.status} / ${r5.message}`);
  const s05dir = path.join(EROOT, "work", "clips", clipId, "s05");
  const finalMp4 = path.join(s05dir, "final.mp4");
  check("产出 final.mp4", await exists(finalMp4));
  const fp = await probe(finalMp4);
  check("final.mp4 有视频轨 + 音频轨", fp.streams.includes("video") && fp.streams.includes("audio"), fp.streams.join(","));
  // 成片口径 = 保留句区间合并、**丢句间间隙**（s05 的 GAP=0.5），所以时长要跟 kept.json 对，
  // 而不是跟片段区间对——第一版按片段区间断言，25s 的片段出 17s 的片子被误判成 FAIL。
  const kept = JSON.parse(await readFile(path.join(s05dir, "kept.json"), "utf8")) as {
    total_seconds: number;
    ranges: [number, number][];
  };
  check("final.mp4 时长与 kept.json 段表一致（±0.5s）", Math.abs(fp.duration - kept.total_seconds) <= 0.5, `mp4 ${fp.duration.toFixed(2)}s vs kept ${kept.total_seconds}s`);
  check("段表覆盖到片段首尾（没丢句）", kept.ranges.length > 0 && Math.abs(kept.ranges[0]![0] - cand!.start) <= 1.5 && Math.abs(kept.ranges.at(-1)![1] - cand!.end) <= 1.5, JSON.stringify(kept.ranges));
  check("final.mp4 体积非平凡（>200KB）", fp.size > 200_000, String(fp.size));
  const decodeErr = await decodesClean(finalMp4);
  check("final.mp4 全解码无错（不是坏文件）", decodeErr === "", decodeErr);

  // ⑧ 字幕与素材包（同一份 cues 的两个出口）
  const srt = await readFile(path.join(s05dir, "clip.srt"), "utf8");
  const cues = srt.split("\n\n").filter((b) => b.includes("-->"));
  check("clip.srt 有真实 cue（≥1 条）", cues.length >= 1, String(cues.length));
  check("clip.srt 文本是中文", /[\u4e00-\u9fa5]/.test(srt), srt.slice(0, 60).replace(/\n/g, "|"));
  const zip = await readFile(path.join(s05dir, "package.zip"));
  check("package.zip 是合法 ZIP（PK 魔数）", zip[0] === 0x50 && zip[1] === 0x4b, zip.subarray(0, 4).toString("hex"));
  check("package.zip 里确实包了 mp4 与 srt（按体积粗验）", zip.length > fp.size, `${zip.length} vs ${fp.size}`);

  // ⑨ 改上游 → 下游标脏（b18 的「改上游下游自动标脏」在真实素材上再验一次）
  await api(`/api/clips/${clipId}/s03/overlay`, { method: "POST", body: JSON.stringify({ sentence_id: (await api<{ sentences: { id: string }[] }>(`/api/clips/${clipId}/s03`)).sentences[0]!.id, keep: false }) });
  sv = await api<Survey>("/api/survey");
  // overlay.json 是 s05 的输入（当时没有也会登记）。删一句是这份输入自己变了，
  // 所以是 stale（输入已变），不是 suspect（上游步骤脏了、本步输入还没对上）。
  check("删一句后 s05 据实标脏（stale）", stepState(sv, "clips", clipId, "s05") === "stale", stepState(sv, "clips", clipId, "s05"));

  console.log(`\n端到端产物：${finalMp4}`);
  console.log(`识别文本：${text}`);
  console.log(`LLM 桩被调用的步骤：${[...new Set(llm.calls)].join(", ")}`);
}

main()
  .then(async () => {
    console.log(`\n=== ${passed} passed / ${failed} failed ===`);
    server?.kill();
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e: unknown) => {
    console.error(`\n脚本异常中断：${e instanceof Error ? e.message : String(e)}`);
    server?.kill();
    process.exit(2);
  });
