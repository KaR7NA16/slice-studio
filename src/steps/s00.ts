// s00 字幕：**SRT 优先、ASR 兜底**（b2/b14/b41/b42）。
//   有 SRT → 解析建任务时快照的 source.srt → sentences.json + 规范化 job.srt；
//   没有 SRT → ffmpeg 抽 16k 单声道音轨 → 本地 Paraformer 转写（子进程 tools/asr_worker.py）。
// 有 SRT 时**绝不触发 ASR**：那是判据本身（b42），不是优化。
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { JobFile, Sentence, SentencesFile } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "../server/jsonfile.ts";
import { shipped } from "../server/shipped.ts";
import { finishStep, inputRef, progress, removeQuietly, reportProgress, stepDir, workDir } from "./lib.ts";
import { pythonChildEnv } from "./toolenv.ts";

// 「已处理 2:15」用分:秒，与界面上的已用时长同一口径，不出现 135.4 秒这种读数。
const mmss = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const execFileP = promisify(execFile);
// 代码目录 ≠ 数据根：解释器与 ffmpeg 在仓库里。权重优先数据根，没有就用程序目录里随包的那份。
const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PYTHON = path.join(CODE_ROOT, "tools", "python", "venv", "Scripts", "python.exe");
const WORKER_DIR = path.join(CODE_ROOT, "tools"); // asr_worker.py 所在目录
const FFMPEG = path.join(CODE_ROOT, "tools", "ffmpeg", "ffmpeg.exe");

function parseTime(s: string): number {
  const m = s.trim().match(/(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!m) throw new Error(`时间码无法解析：${s}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, "0")) / 1000;
}

function fmtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(r, 3)}`;
}

// id 跟时间码和文本走，不跟出现序号走。SRT 开头插一句时，后面的人工删留还指着原来那句。
// 完全相同的两条会加后缀，避免撞键。旧的序号 id 在重跑后进 orphans，不会悄悄套到别的句子上。
export function sentenceId(start: number, end: number, text: string): string {
  return createHash("sha1").update(`${start.toFixed(3)}\n${end.toFixed(3)}\n${text}`).digest("hex").slice(0, 12);
}

export function withSentenceIds(rows: { start: number; end: number; text: string }[]): Sentence[] {
  const seen = new Map<string, number>();
  return rows.map((s) => {
    const base = sentenceId(s.start, s.end, s.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { id: n === 0 ? base : `${base}-${n}`, start: s.start, end: s.end, text: s.text };
  });
}

export function parseSrt(text: string): Sentence[] {
  const rows: { start: number; end: number; text: string }[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, z] = lines[ti]!.split("-->");
    const body = lines.slice(ti + 1).join("\n");
    if (!body) continue;
    rows.push({ start: parseTime(a!), end: parseTime(z!), text: body });
  }
  return withSentenceIds(rows);
}

export function toSrt(sentences: Sentence[]): string {
  return sentences.map((s, i) => `${i + 1}\n${fmtTime(s.start)} --> ${fmtTime(s.end)}\n${s.text}\n`).join("\n");
}

// 本地转写：抽音轨 → 起 worker（一律 `-m`，禁止 venv 的 .exe launcher，§6）→ 解析最后一行 JSON。
// 权重目录在数据根（`models/asr`），默认**零网络**；首次准备权重时用环境变量放行下载。
async function transcribe(root: string, runId: string, video: string, tmpDir: string): Promise<{ sentences: Sentence[]; model: string }> {
  await mkdir(tmpDir, { recursive: true });
  const wav = path.join(tmpDir, "asr-16k.wav");
  await progress(root, runId, "提取音轨（16 kHz 单声道）…");
  // Paraformer 要 16k 单声道 PCM；-vn 丢掉视频轨，重采样交给 ffmpeg（不要在 Python 侧做，那要多引一个 librosa 通路）
  await execFileP(FFMPEG, ["-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);

  const modelDir = shipped(root, "models/asr", "tokens.txt");
  const allowDownload = process.env["SLICE_ASR_ALLOW_DOWNLOAD"] === "1";
  const args = ["-m", "asr_worker", "--audio", wav, "--model-dir", modelDir];
  if (allowDownload) args.push("--allow-download");
  // 只有验证要改切块粒度：10s 音频按默认 30s 切只出一块、只报一次进度，
  // 「进度在动」这件事在那种场景下无论怎么写都证明不了自己。
  const chunkSec = process.env["SLICE_ASR_CHUNK_SEC"];
  if (chunkSec) args.push("--chunk-sec", chunkSec);
  await progress(root, runId, "本地转写（Paraformer）…");

  // 进度上报必须串行：patchRun 是「读→改→原子写」，两次并发就是后写的覆盖先写的，
  // 界面上表现为进度来回跳。用一条 promise 链排队，收尾前 await 掉。
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): void => {
    queue = queue.then(fn).catch(() => undefined); // 写进度失败不该让转写失败
  };

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      cwd: WORKER_DIR,
      env: pythonChildEnv(process.env, { PYTHONPATH: WORKER_DIR, PYTHONIOENCODING: "utf-8" }, path.join(root, "work", "_scratch")),
    });
    let out = ""; // 全量留底：解析失败时要拿它拼错误文案
    let buf = ""; // 还没凑成一行的尾巴
    let err = "";
    const handleLine = (line: string): void => {
      const t = line.trim();
      if (!t.startsWith("{")) return; // 库日志混进来，忽略
      let o: { progress?: string; done_sec?: number; total_sec?: number };
      try {
        o = JSON.parse(t) as typeof o;
      } catch {
        return; // 半行/坏行不该让整次转写失败
      }
      if (typeof o.done_sec === "number" && typeof o.total_sec === "number") {
        enqueue(() => reportProgress(root, runId, `${mmss(o.done_sec!)} / ${mmss(o.total_sec!)}`));
      } else if (typeof o.progress === "string") {
        // 阶段文案（下载权重、权重落位）是**事件**，进 message → 读屏该念。
        enqueue(() => progress(root, runId, o.progress!));
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      out += s;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (buf.trim()) handleLine(buf); // 最后一行没带换行符
      if (code !== 0) {
        reject(new Error(`ASR 进程退出 ${code}：${(err || out).trim().slice(0, 300)}`));
        return;
      }
      resolve(out || err);
    });
  });
  await queue; // 不 await 的话，进度可能写在 finishRun 之后，界面上留一条永远停在 1:20 的旁注

  // worker 的 stdout 是 JSON lines（它把真 fd 1 让给了 JSON，库日志走 stderr）。
  // 取**最后一行**能解析的：任何库在退出前多打一行都不该让整次转写失败。
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  const last = lines.at(-1);
  if (!last) throw new Error(`ASR 没有返回结果：${raw.trim().slice(0, 300)}`);
  const parsed = JSON.parse(last) as { ok?: boolean; error?: string; sentences?: { start: number; end: number; text: string }[]; model?: string };
  if (!parsed.ok) throw new Error(`ASR 失败：${parsed.error ?? "未知原因"}`);
  const segs = parsed.sentences ?? [];
  if (segs.length === 0) throw new Error("ASR 没有识别出任何句子");
  const sentences = withSentenceIds(segs.map((s) => ({ start: s.start, end: Math.max(s.end, s.start), text: s.text })));
  return { sentences, model: parsed.model ?? "paraformer" };
}

export async function runS00(root: string, owner: string, runId: string): Promise<string> {
  const jobDir = workDir(root, owner);
  const job = await readJson<JobFile>(path.join(jobDir, "job.json"));
  if (!job) throw new Error("job.json 不存在");
  const dir = stepDir(root, owner, "s00");
  await mkdir(dir, { recursive: true });
  // 先清上次的转写临时件（`jobDir/_asr`，里面是 16k 单声道 wav）。
  // 为什么在这里而不是在取消路径上：取消是**整棵进程树被杀**，本文件末尾那句
  // removeQuietly 根本跑不到，所以中断的 run 一定留一份原文 wav（8 分钟约 15MB）。
  // 放在 runS00 开头有两层好处：① 不用把「步内部临时件叫什么」泄漏给调度层（cancelRun）；
  // ② 这次走 SRT 也会清掉上次转写留下的那份——只清转写路径就漏了这种换源场景。
  // 并发上安全：同一 owner+step 起跑前有 inflight 与 hasRunning 两道守卫，不会误删在跑的。
  const stale = await removeQuietly(path.join(jobDir, "_asr"));
  if (stale) console.log(`  ⚠️ 上次转写临时件清理失败：${stale}`);

  const raw = await readFile(path.join(jobDir, "source.srt"), "utf8").catch(() => null);
  // 输入登记：SRT 路径挂 source.srt，ASR 路径挂 job.json（它钉住了 video_path）——
  // 两路挂不同的输入，才不会有「换了字幕源却不重跑」的盲区。
  // SRT 路只钉字幕快照。转写路钉 job.json 和源视频字节（大文件是 size+mtime）。
  // 换路时丢掉另一路的 key，否则「视频改了」会把一份只解析 SRT 的结果永远标脏。
  const inputs = raw !== null
    ? [await inputRef(root, "source.srt", `${owner}/source.srt`)]
    : [
        await inputRef(root, "job.json", `${owner}/job.json`),
        await inputRef(root, "video", job.video_path),
      ];

  let sentences: Sentence[];
  let how: string;
  if (raw !== null) {
    await progress(root, runId, "解析 SRT…");
    sentences = parseSrt(raw);
    if (sentences.length === 0) throw new Error("SRT 解析结果为空");
    how = `解析 ${sentences.length} 句`;
  } else {
    const r = await transcribe(root, runId, job.video_path, path.join(jobDir, "_asr"));
    sentences = r.sentences;
    how = `本地转写 ${sentences.length} 句（${r.model}）`;
    const e = await removeQuietly(path.join(jobDir, "_asr"));
    if (e) console.log(`  ⚠️ 转写临时件清理失败（work/ 会留残留）：${e}`);
  }

  await writeJsonAtomic(path.join(dir, "sentences.json"), { schema: 1, sentences } satisfies SentencesFile);
  await writeJsonAtomic(path.join(dir, "job.srt"), toSrt(sentences));
  await finishStep(root, owner, "s00", inputs, ["sentences.json", "job.srt"], {
    dropKeys: raw !== null ? ["video", "job.json"] : [],
  });
  return how;
}
