// s00 字幕：解析建任务时快照的 source.srt → sentences.json + 规范化 job.srt
// ASR 本地转写兜底属阶段 3；没有 SRT 时据实报错，不假装能跑（b59）
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { JobFile, Sentence, SentencesFile } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "../server/jsonfile.ts";
import { finishStep, inputRef, progress, stepDir, workDir } from "./lib.ts";

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

export function parseSrt(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, z] = lines[ti]!.split("-->");
    const body = lines.slice(ti + 1).join("\n");
    if (!body) continue;
    out.push({ id: String(out.length), start: parseTime(a!), end: parseTime(z!), text: body });
  }
  return out;
}

export function toSrt(sentences: Sentence[]): string {
  return sentences.map((s, i) => `${i + 1}\n${fmtTime(s.start)} --> ${fmtTime(s.end)}\n${s.text}\n`).join("\n");
}

export async function runS00(root: string, owner: string, runId: string): Promise<string> {
  const jobDir = workDir(root, owner);
  const job = await readJson<JobFile>(path.join(jobDir, "job.json"));
  if (!job) throw new Error("job.json 不存在");
  const raw = await readFile(path.join(jobDir, "source.srt"), "utf8").catch(() => null);
  if (raw === null) throw new Error("未提供 SRT 字幕（建任务时未附；ASR 本地转写属阶段 3）");
  await progress(root, runId, "解析 SRT…");
  const sentences = parseSrt(raw);
  if (sentences.length === 0) throw new Error("SRT 解析结果为空");
  const dir = stepDir(root, owner, "s00");
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(path.join(dir, "sentences.json"), { schema: 1, sentences } satisfies SentencesFile);
  await writeJsonAtomic(path.join(dir, "job.srt"), toSrt(sentences));
  await finishStep(root, owner, "s00", [await inputRef(root, "source.srt", `${owner}/source.srt`)], ["sentences.json", "job.srt"]);
  return `解析 ${sentences.length} 句`;
}
