// s02 人声分离：ffmpeg 切出片段音轨 → 常驻 demucs 分离 → vocals.wav / no_vocals.wav 落步目录。
// 形态约束（docs/项目规划.md §6，都是硬约束）：
//   ② broker 里一律 `python.exe -m demucs_worker`，禁止调 venv 的 .exe launcher；
//   ⑥ 权重走数据根 models/demucs，零网络。
// 多条片段共用数据根上的一个 broker，权重只加载一次（b44/b45）。
import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ClipFile, JobFile } from "../shared/types.ts";
import { readJson } from "../server/jsonfile.ts";
import { demucsSeparate } from "./demucspool.ts";
import { finishStep, inputRef, progress, removeQuietly, stepDir, workDir } from "./lib.ts";

const execFileP = promisify(execFile);

// 代码目录 ≠ 数据根：ffmpeg 在仓库里，不随数据根走。demucs 不在这一步里起进程，
// 走数据根上的常驻 broker（权重只加载一次，多条片段共用）。
const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FFMPEG = path.join(CODE_ROOT, "tools", "ffmpeg", "ffmpeg.exe");

// run 心跳间隔：runs.ts 是「30 秒无心跳判失联」，10 秒留足余量
const HEARTBEAT_MS = 10_000;

export async function runS02(root: string, owner: string, runId: string): Promise<string> {
  const clip = await readJson<ClipFile>(path.join(workDir(root, owner), "clip.json"));
  if (!clip) throw new Error("clip.json 不存在");
  const job = await readJson<JobFile>(path.join(workDir(root, `jobs/${clip.job_id}`), "job.json"));
  if (!job) throw new Error(`job.json 不存在（jobs/${clip.job_id}）`);
  const dur = clip.end - clip.start;
  if (!(dur > 0)) throw new Error(`片段区间无效：start=${clip.start} end=${clip.end}`);

  const dir = stepDir(root, owner, "s02");
  await mkdir(dir, { recursive: true });

  // 1. 切出片段音轨。demucs 的 API 不吃「区间」（separate_audio_file 读整个文件），区间必须自己切。
  //    -ss 放在 -i 前是快速 seek；float 秒精度足够（b40）。
  const inputWav = path.join(dir, "_input.wav");
  await progress(root, runId, `切出片段音轨（${clip.start}s–${clip.end}s）…`);
  await execFileP(FFMPEG, [
    "-y",
    "-ss", String(clip.start),
    "-t", String(dur),
    "-i", job.video_path,
    "-vn", "-ac", "2", "-ar", "44100",
    "-f", "wav", inputWav,
  ]);

  // 2. 交给常驻 broker。这一步不持有 Python 进程，跑完也不杀掉它——下一条片段还要用已加载的权重。
  await progress(root, runId, "分离人声（demucs，本地权重）…");
  const beat = setInterval(
    () =>
      void progress(root, runId, "分离人声…").catch((e: unknown) =>
        console.error(`[s02] 心跳写入失败：${e instanceof Error ? e.message : String(e)}`),
      ),
    HEARTBEAT_MS,
  );

  try {
    const res = await demucsSeparate(root, { id: runId, audio: inputWav, out_dir: dir });
    // 3. 不能只信 worker 的回执（铁律：形式不构成实质）——产物必须真在盘上
    for (const name of ["vocals.wav", "no_vocals.wav"]) {
      const ok = await stat(path.join(dir, name))
        .then((s) => s.isFile())
        .catch(() => false);
      if (!ok) throw new Error(`worker 报告完成但 ${name} 不在：${path.join(dir, name)}`);
    }
    await finishStep(
      root,
      owner,
      "s02",
      [
        await inputRef(root, "clip.json", `${owner}/clip.json`),
        await inputRef(root, "job.json", `jobs/${clip.job_id}/job.json`),
        await inputRef(root, "video", job.video_path),
      ],
      ["vocals.wav", "no_vocals.wav"],
    );
    return `分离出 ${res.seconds}s 人声与伴奏`;
  } finally {
    clearInterval(beat);
    // 临时音轨的善后：**失败不改 run 的结论**（产物与 step.json 此时都已就绪），
    // 但也不静默——文件还被占着就留痕，不把善后失败算成这一步失败（见 lib.removeQuietly）。
    const leftErr = await removeQuietly(inputWav);
    if (leftErr) console.log(`⚠️ 临时音轨未清掉（不影响本次结果）：${inputWav}（${leftErr}）`);
  }
}
