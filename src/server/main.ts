// 服务入口（b55：绑 127.0.0.1、启动时自动挑空闲端口并打印实际地址；重活一律子进程，本进程只做路由+文件读写+状态计算）
// 运行：node src/server/main.ts [项目根]   （Node ≥ 22.18 直接跑 TS）
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AiDraftFile,
  CandidatesFile,
  ClipFile,
  JobFile,
  Library,
  NewClip,
  NewJob,
  OverlayFile,
  S03View,
  SentencesFile,
} from "../shared/types.ts";
import { llmStatus } from "./config.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";
import { streamMedia } from "./media.ts";
import { EMPTY_OVERLAY, mergeDecisions } from "./overrides.ts";
import { getRun, listRuns, startRun } from "./runs.ts";
import { survey } from "./survey.ts";
import { finishStep, inputRef } from "../steps/lib.ts";

const ROOT = path.resolve(process.argv[2] ?? process.cwd());
// 代码目录 ≠ 数据根：前端产物与 ffprobe 在仓库里（按本文件位置推导），不随数据根走
const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST = path.join(CODE_ROOT, "dist");
const FFPROBE = path.join(CODE_ROOT, "tools", "ffmpeg", "ffprobe.exe");
const execFileP = promisify(execFile);

const startedAt = performance.now();

// ---- 小工具 ----

function sendJson(res: ServerResponse, data: unknown, code = 200): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const sendErr = (res: ServerResponse, code: number, message: string): void => sendJson(res, { error: message }, code);

async function readBody<T>(req: IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}") as T;
}

const shortHash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 6);

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

// 建片段时探测一次 fps 存 clip.json（b50b/b51b：原样记分数，不换算）
async function probeFps(video: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(FFPROBE, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", video,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ---- 路由处理 ----

async function createJob(res: ServerResponse, body: NewJob): Promise<void> {
  const video = path.resolve(body.video_path ?? "");
  if (!(await exists(video))) return sendErr(res, 400, `视频不存在：${video}`);
  const srt = body.srt_path ? path.resolve(body.srt_path) : null;
  if (srt && !(await exists(srt))) return sendErr(res, 400, `字幕不存在：${srt}`);
  const base = path.basename(video, path.extname(video)).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 24) || "job";
  const id = `${base}-${shortHash(video)}`;
  const dir = path.join(ROOT, "work", "jobs", id);
  await mkdir(dir, { recursive: true });
  if (srt) await copyFile(srt, path.join(dir, "source.srt")); // 事实快照：之后的解析都以这份为准
  const job: JobFile = { schema: 1, id, video_path: video, srt_path: srt, created_at: new Date().toISOString() };
  await writeJsonAtomic(path.join(dir, "job.json"), job);
  sendJson(res, { id });
}

async function createClip(res: ServerResponse, body: NewClip): Promise<void> {
  const jobDir = path.join(ROOT, "work", "jobs", body.job_id ?? "");
  const job = await readJson<JobFile>(path.join(jobDir, "job.json"));
  if (!job) return sendErr(res, 404, `任务不存在：${body.job_id}`);
  const { start, end } = body;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return sendErr(res, 400, "区间非法：需 0 ≤ start < end");
  }
  const title = (body.title ?? "").trim() || `片段 ${start.toFixed(1)}s`;
  let id = `c-${shortHash(`${job.id}|${start}|${end}|${title}`)}`;
  let n = 2;
  while ((await stat(path.join(ROOT, "work", "clips", id)).catch(() => null)) !== null) id = `c-${shortHash(`${job.id}|${start}|${end}|${title}|${n++}`)}`;
  const dir = path.join(ROOT, "work", "clips", id);
  await mkdir(dir, { recursive: true });
  const clip: ClipFile = {
    schema: 1, id, job_id: job.id, title, start, end,
    fps: await probeFps(job.video_path),
  };
  await writeJsonAtomic(path.join(dir, "clip.json"), clip);
  // s01 候选 = 人工定稿事实（b1 默认人工）：建片段即定稿一条候选
  const candPath = path.join(jobDir, "s01", "candidates.json");
  const cand = (await readJson<CandidatesFile>(candPath)) ?? { schema: 1, source: "human", clips: [] } as CandidatesFile;
  cand.clips.push({ clip_id: id, title, start, end, created_at: new Date().toISOString() });
  await mkdir(path.dirname(candPath), { recursive: true });
  await writeJsonAtomic(candPath, cand);
  // s01 step.json 落事实（b43）：人工定稿也是一步的执行记录；输入登记 s00 句流指纹，供 stale 判定
  const s00rel = `jobs/${job.id}/s00/sentences.json`;
  const s01inputs = (await exists(path.join(ROOT, "work", s00rel))) ? [await inputRef(ROOT, "s00/sentences.json", s00rel)] : [];
  await finishStep(ROOT, `jobs/${job.id}`, "s01", s01inputs, ["candidates.json"]);
  sendJson(res, { id });
}

// s03 合并视图：句流（事实）+ AI 初稿 + 人工覆盖层 → 现算（不落盘）
async function s03View(res: ServerResponse, clipId: string): Promise<void> {
  const dir = path.join(ROOT, "work", "clips", clipId);
  const clip = await readJson<ClipFile>(path.join(dir, "clip.json"));
  if (!clip) return sendErr(res, 404, `片段不存在：${clipId}`);
  const cur = await readJson<SentencesFile>(path.join(dir, "s03", "sentences.json"));
  if (!cur) return sendErr(res, 404, "句流未构建：先跑一次构建");
  const ai = await readJson<AiDraftFile>(path.join(dir, "s03", "ai.json"));
  const overlay = (await readJson<OverlayFile>(path.join(dir, "s03", "overlay.json"))) ?? EMPTY_OVERLAY;
  const { sentences, orphans } = mergeDecisions(cur.sentences, ai, overlay);
  const view: S03View = { clip, sentences, orphans, ai: ai ? { model: ai.model, at: ai.at } : null };
  sendJson(res, view);
}

async function writeOverlay(res: ServerResponse, req: IncomingMessage, clipId: string): Promise<void> {
  const file = path.join(ROOT, "work", "clips", clipId, "s03", "overlay.json");
  const body = await readBody<{ sentence_id?: string; keep?: boolean }>(req);
  if (!body.sentence_id || typeof body.keep !== "boolean") return sendErr(res, 400, "需 sentence_id 与 keep");
  const overlay = (await readJson<OverlayFile>(file)) ?? EMPTY_OVERLAY;
  overlay.decisions[body.sentence_id] = { keep: body.keep, at: new Date().toISOString() };
  await mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, overlay);
  await s03View(res, clipId);
}

// 已实现的步白名单；其余据实报「属阶段 3」，不假装能跑
const RUNNABLE: Record<string, Set<string>> = {
  "jobs/": new Set(["s00"]),
  "clips/": new Set(["s03"]),
};

async function triggerRun(res: ServerResponse, req: IncomingMessage): Promise<void> {
  const body = await readBody<{ owner?: string; step?: string; mode?: string }>(req);
  const { owner, step, mode } = body;
  if (!owner || !step) return sendErr(res, 400, "需 owner 与 step");
  const kind = Object.keys(RUNNABLE).find((k) => owner.startsWith(k));
  if (!kind || !RUNNABLE[kind]!.has(step)) return sendErr(res, 400, `${step} 尚未实现（属阶段 3）`);
  if (mode && !(step === "s03" && mode === "draft")) return sendErr(res, 400, `未知模式：${mode}`);
  sendJson(res, await startRun(ROOT, owner, step, mode ?? null));
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;
  try {
    if (url === "/api/survey") return sendJson(res, await survey(ROOT));
    if (url === "/api/library") {
      return sendJson(res, await readJson<Library>(path.join(ROOT, "data", "library.json")));
    }
    if (url === "/api/llm") {
      const st = await llmStatus(ROOT);
      // 密钥不出进程：只回 ok / model / reason
      return sendJson(res, st.ok ? { ok: true, model: st.llm.model } : { ok: false, reason: st.reason });
    }
    if (url === "/api/jobs" && req.method === "POST") return await createJob(res, await readBody<NewJob>(req));
    if (url === "/api/clips" && req.method === "POST") return await createClip(res, await readBody<NewClip>(req));
    if (url === "/api/run" && req.method === "POST") return await triggerRun(res, req);
    if (url === "/api/runs") return sendJson(res, await listRuns(ROOT));

    let m: RegExpMatchArray | null;
    if ((m = url.match(/^\/api\/jobs\/([^/]+)\/sentences$/))) {
      const file = await readJson<SentencesFile>(path.join(ROOT, "work", "jobs", m[1]!, "s00", "sentences.json"));
      return file ? sendJson(res, file) : sendErr(res, 404, "s00 未跑：先导入字幕");
    }
    if ((m = url.match(/^\/api\/clips\/([^/]+)\/s03$/))) return await s03View(res, m[1]!);
    if ((m = url.match(/^\/api\/clips\/([^/]+)\/s03\/overlay$/)) && req.method === "POST") {
      return await writeOverlay(res, req, m[1]!);
    }
    if ((m = url.match(/^\/api\/runs\/([^/]+)$/))) {
      const rec = await getRun(ROOT, m[1]!);
      return rec ? sendJson(res, rec) : sendErr(res, 404, `run 不存在：${m[1]}`);
    }
    if ((m = url.match(/^\/api\/media\/job\/([^/]+)\/video$/))) {
      const job = await readJson<JobFile>(path.join(ROOT, "work", "jobs", m[1]!, "job.json"));
      if (!job) return sendErr(res, 404, `任务不存在：${m[1]}`);
      return await streamMedia(req, res, job.video_path);
    }

    if (req.method !== "GET") return sendErr(res, 404, `不存在：${url}`);
    // 静态：产物是单个 index.html（vite-plugin-singlefile），一律回它
    const html = await import("node:fs/promises").then((fs) => fs.readFile(path.join(DIST, "index.html")));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    sendErr(res, 500, String(err));
  }
});

// 端口 0 = 系统自动分配空闲端口（b55：不固定默认端口）
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const ms = (performance.now() - startedAt).toFixed(0);
  console.log(`slice-studio 已启动: http://127.0.0.1:${port}  (冷启动 ${ms}ms, 项目根 ${ROOT})`);
});
