// 服务入口（b55：绑 127.0.0.1、启动时自动挑空闲端口并打印实际地址；重活一律子进程，本进程只做路由+文件读写+状态计算）
// 运行：node src/server/main.ts [项目根]   （Node ≥ 22.18 直接跑 TS）
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AiDraftFile,
  AutomationSettings,
  CandidatesFile,
  ClipFile,
  JobFile,
  NewClip,
  NewJob,
  OverlayFile,
  S01AiFile,
  S03View,
  S04Params,
  SentencesFile,
  StepFile,
} from "../shared/types.ts";
import { automationView, readGlobal, saveGlobal, saveOverride } from "./automation.ts";
import { effectiveBgm, findTrack, readPick, savePick } from "./bgmpick.ts";
import { llmView } from "./config.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";
import { llmModels, llmTest, putLlm } from "./llmroute.ts";
import { streamMedia } from "./media.ts";
import { EMPTY_OVERLAY, mergeDecisions } from "./overrides.ts";
import { preview } from "./preview.ts";
import { getRun, listRuns, RunBusyError, startRun } from "./runs.ts";
import { ingestLibrary } from "./ingest.ts";
import { listDir, statPath } from "./fsbrowse.ts";
import { removeJob, safeJobId, safeOwner, updateCard } from "./jobcard.ts";
import { healPyvenv } from "./portable.ts";
import { readLibrary } from "./library.ts";
import { survey } from "./survey.ts";
import { variantsView } from "./variants.ts";
import { moodDomain } from "../steps/s04.ts";
import { finishStep, inputRef, setActiveVariant } from "../steps/lib.ts";

const ROOT = path.resolve(process.argv[2] ?? process.cwd());
// 代码目录 ≠ 数据根：前端产物与 ffprobe 在仓库里（按本文件位置推导），不随数据根走
const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST = path.join(CODE_ROOT, "dist");
const FFPROBE = path.join(CODE_ROOT, "tools", "ffmpeg", "ffprobe.exe");
const execFileP = promisify(execFile);

const startedAt = performance.now();
if (healPyvenv(CODE_ROOT)) console.log("已把 pyvenv.cfg 指回程序目录里的 Python");

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
  // 同一条视频会落到同一个 id。这次没带字幕，必须清掉上次留下的 source.srt，
  // 否则 s00 看到文件还在，会继续解析旧字幕，走不了转写。
  const snap = path.join(dir, "source.srt");
  if (srt) await copyFile(srt, snap);
  else await rm(snap, { force: true });
  const job: JobFile = { schema: 1, id, video_path: video, srt_path: srt, created_at: new Date().toISOString() };
  await writeJsonAtomic(path.join(dir, "job.json"), job);
  sendJson(res, { id });
}

async function createClip(res: ServerResponse, body: NewClip): Promise<void> {
  const jobId = safeJobId(body.job_id ?? "");
  if (!jobId) return sendErr(res, 400, "任务 id 非法");
  const jobDir = path.join(ROOT, "work", "jobs", jobId);
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
  // 「没跑过」不是「不存在」：片段在，只是句流还没构建。用 404 表达会让前端无法区分
  // 「没跑 / 片段不存在 / 服务端出错」——catch 一压全变成「句流未构建」，真故障被伪装成
  // 正常空态（N-4）。所以回 200 + built:false，空态由前端据 built 渲染，错误走错误出口。
  if (!cur) return sendJson(res, { clip, sentences: [], orphans: [], ai: null, built: false } satisfies S03View);
  const ai = await readJson<AiDraftFile>(path.join(dir, "s03", "ai.json"));
  const overlay = (await readJson<OverlayFile>(path.join(dir, "s03", "overlay.json"))) ?? EMPTY_OVERLAY;
  const { sentences, orphans } = mergeDecisions(cur.sentences, ai, overlay);
  const view: S03View = { clip, sentences, orphans, ai: ai ? { model: ai.model, at: ai.at } : null, built: true };
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

// 六步都已落地。白名单守的是「这一步属于哪一级」：任务上不能跑片段步，反过来也不行。
const RUNNABLE: Record<string, Set<string>> = {
  "jobs/": new Set(["s00", "s01"]),
  "clips/": new Set(["s02", "s03", "s04", "s05"]),
};

async function triggerRun(res: ServerResponse, req: IncomingMessage): Promise<void> {
  const body = await readBody<{ owner?: string; step?: string; mode?: string }>(req);
  const owner = safeOwner(body.owner ?? "");
  const { step, mode } = body;
  if (!owner || !step) return sendErr(res, 400, "需 owner 与 step，且 owner 只能是 jobs/<id> 或 clips/<id>");
  const kind = owner.startsWith("jobs/") ? "jobs/" : "clips/";
  if (!RUNNABLE[kind]!.has(step)) return sendErr(res, 400, `${step} 不属于${kind === "jobs/" ? "任务" : "片段"}`);
  if (mode && !(step === "s03" && mode === "draft")) return sendErr(res, 400, `未知模式：${mode}`);
  try {
    sendJson(res, await startRun(ROOT, owner, step, mode ?? null));
  } catch (e) {
    if (e instanceof RunBusyError) return sendErr(res, 409, e.message);
    throw e;
  }
}

// ---- 变体 / 主干（b7/b8） ----

// 校验 owner 形如 jobs/<id> 或 clips/<id>。返回规范化 owner，非法则 null。
function parseOwner(kind: string | undefined, id: string | undefined): string | null {
  if (kind !== "jobs" && kind !== "clips") return null;
  if (!id || id !== path.basename(id)) return null;
  return `${kind}/${id}`;
}

async function activateVariant(res: ServerResponse, owner: string, step: string, vid: string): Promise<void> {
  if (vid !== path.basename(vid)) return sendErr(res, 400, `变体 id 非法：${vid}`);
  const { variantFile } = await import("./variants.ts");
  const v = await readJson<{ meta?: { id?: string } }>(variantFile(ROOT, owner, step, vid));
  if (!v?.meta?.id) return sendErr(res, 404, `变体不存在：${owner}/${step}/${vid}`);
  // 物化：把选中那版写回正式 AI 产物名，**不重跑 AI**（b8 判据是「能切回任一侧枝」）。
  // 只写 AI 产物，人工覆盖层（s03 overlay / s04 pick）不碰——那是 b29/b46 的分离要求。
  const { materialize } = await import("./variants.ts");
  const artifact = await materialize(ROOT, owner, step, (v as { payload?: unknown }).payload);
  await setActiveVariant(ROOT, owner, step, vid);
  sendJson(res, { ok: true, active: vid, wrote: artifact });
}

// ---- 自动化档位（b3/b4） ----

async function putAutomation(res: ServerResponse, req: IncomingMessage, owner: string): Promise<void> {
  const body = await readBody<{ settings?: AutomationSettings; scope?: string }>(req);
  const settings = body.settings ?? {};
  // scope=global 写 config.json（所有片段共享的默认）；否则写该片段的 clip.json。
  // job 级 owner 没有覆盖层（clip.json 不存在），传 scope=override 直接报错，不静默改全局。
  try {
    if (body.scope === "global") {
      await saveGlobal(ROOT, settings);
    } else if (owner.startsWith("clips/")) {
      await saveOverride(ROOT, owner, settings);
    } else {
      return sendErr(res, 400, "任务级没有单条覆盖：档位只对片段可覆盖（job 级走全局默认）");
    }
  } catch (e) {
    return sendErr(res, 400, e instanceof Error ? e.message : String(e));
  }
  return sendJson(res, await automationView(ROOT, owner));
}

// ---- 曲库媒体出口（b33/b34：97 首全部可列出、可播） ----
// 与 clip 媒体出口同源的安全口径：只接受曲库里**登记过的 id**，路径从登记项取，不接受任意路径。
async function libraryMedia(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const lib = await readLibrary(ROOT);
  const item = (lib?.items ?? []).find((i) => i.id === id);
  if (!item) return sendErr(res, 404, `曲库条目不存在：${id}`);
  if (!(await exists(item.path))) return sendErr(res, 404, `曲库文件缺失：${item.title}`);
  return await streamMedia(req, res, item.path);
}

// ---- s01 工作空间视图：AI 提案（可选产物）与人工定稿（契约产物）分列，不合并 ----
async function s01View(res: ServerResponse, jobId: string): Promise<void> {
  const dir = path.join(ROOT, "work", "jobs", jobId, "s01");
  if (!(await readJson<JobFile>(path.join(ROOT, "work", "jobs", jobId, "job.json")))) {
    return sendErr(res, 404, `任务不存在：${jobId}`);
  }
  const ai = await readJson<S01AiFile>(path.join(dir, "ai.json"));
  const cand = await readJson<CandidatesFile>(path.join(dir, "candidates.json"));
  sendJson(res, { ai, candidates: cand });
}

// ---- s04 工作空间视图：s04 产物 + 人工换曲覆盖层 + 曲库分组（换一首时用） ----
async function s04View(res: ServerResponse, clipId: string): Promise<void> {
  const owner = `clips/${clipId}`;
  const clip = await readJson<ClipFile>(path.join(ROOT, "work", owner, "clip.json"));
  if (!clip) return sendErr(res, 404, `片段不存在：${clipId}`);
  const eff = await effectiveBgm(ROOT, owner);
  const lib = await readLibrary(ROOT);
  const params = await readJson<S04Params>(path.join(ROOT, "work", owner, "s04", "params.json"));
  const bgmItems = (lib?.items ?? []).filter((i) => i.kind === "bgm");
  const groups = [...new Set(bgmItems.map((i) => i.group ?? "未分组"))].sort().map((g) => ({
    group: g,
    tracks: bgmItems
      .filter((i) => (i.group ?? "未分组") === g)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => ({ id: i.id, title: i.title, bytes: i.bytes })),
  }));
  sendJson(res, {
    bgm: eff?.bgm ?? null,
    pick: eff?.pick ?? (await readPick(ROOT, owner)),
    track: eff?.track ?? null,
    track_source: eff?.source ?? null,
    missing_pick: eff?.missing_pick ?? false,
    groups,
    total: bgmItems.length,
    bgm_mood: params?.bgm_mood ?? null,
    moods: moodDomain(lib?.items ?? []),
  });
}

// 人工指定风格（b50c 规则优先）。空 mood = 删掉 params，回到 LLM 兜底。
// 不在这里跑 s04：写参数和跑是两件事，界面先定风格，再点「跑一次」。
async function s04Params(res: ServerResponse, req: IncomingMessage, clipId: string): Promise<void> {
  const owner = `clips/${clipId}`;
  if (!(await readJson<ClipFile>(path.join(ROOT, "work", owner, "clip.json")))) {
    return sendErr(res, 404, `片段不存在：${clipId}`);
  }
  const mood = ((await readBody<{ bgm_mood?: string | null }>(req)).bgm_mood ?? "").trim();
  const file = path.join(ROOT, "work", owner, "s04", "params.json");
  if (!mood) {
    await rm(file, { force: true });
  } else {
    const moods = moodDomain((await readLibrary(ROOT))?.items ?? []);
    if (!moods.includes(mood)) return sendErr(res, 400, `bgm_mood「${mood}」不在曲库分组里（现有：${moods.join(" / ")}）`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomic(file, { schema: 1, bgm_mood: mood } satisfies S04Params);
  }
  return await s04View(res, clipId);
}

// 人工换曲（b29/b46：写覆盖层 pick.json，不改 s04 的 bgm.json）。
// track_id 传 null = 清除人工选择，回到 s04 产物。
async function s04Pick(res: ServerResponse, req: IncomingMessage, clipId: string): Promise<void> {
  const owner = `clips/${clipId}`;
  const body = await readBody<{ track_id?: string | null }>(req);
  if (!(await readJson<ClipFile>(path.join(ROOT, "work", owner, "clip.json")))) {
    return sendErr(res, 404, `片段不存在：${clipId}`);
  }
  const id = body.track_id ?? null;
  if (id !== null) {
    const lib = await readLibrary(ROOT);
    // 入库校验：选一个曲库里没有的 id 会让 s05 在出片时才报错，归因太远——在这里就拒掉。
    if (!findTrack(lib?.items ?? [], id)) return sendErr(res, 400, `曲库里没有这首：${id}`);
  }
  try {
    await savePick(ROOT, owner, id);
  } catch (e) {
    return sendErr(res, 500, e instanceof Error ? e.message : String(e));
  }
  return await s04View(res, clipId);
}

// ---- 重跑预览（b39） ----
async function previewGet(res: ServerResponse, owner: string, step: string, mode: string | null): Promise<void> {
  try {
    sendJson(res, await preview(ROOT, owner, step, mode));
  } catch (e) {
    sendErr(res, 400, e instanceof Error ? e.message : String(e));
  }
}

// clip 级媒体出口（P1-2）：s02 试听 / s03 波形 / s05 成片播放三者共用。
// 白名单 = 该步 step.json 里**自己登记的** outputs（不另建配置表）：
// 产物没登记取不到，登记了但文件不在也取不到。这与 survey 的 lazy.available 同源判据
// （outputs 登记 + 文件存在），所以界面显示「可试听」而接口 404 的情况不会出现。
// 安全：只接受纯文件名。带分隔符、"." 或 ".." 一律拒，杜绝穿越出步目录。
async function clipMedia(
  req: IncomingMessage,
  res: ServerResponse,
  clipId: string,
  stepId: string,
  rawName: string,
): Promise<void> {
  const dir = path.join(ROOT, "work", "clips", clipId);
  if (!(await readJson<ClipFile>(path.join(dir, "clip.json")))) return sendErr(res, 404, `片段不存在：${clipId}`);
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return sendErr(res, 400, `产物名编码非法：${rawName}`);
  }
  // path.basename 在 win32 语义下同时处理 "/" 与 "\\"；"." / ".." 单独挡
  if (!name || name === "." || name === ".." || name !== path.basename(name)) {
    return sendErr(res, 400, `产物名非法：${rawName}`);
  }
  const step = await readJson<StepFile>(path.join(dir, stepId, "step.json"));
  if (!step) return sendErr(res, 404, `${stepId} 未跑`);
  if (step.error) return sendErr(res, 409, `${stepId} 失败：${step.error}`);
  if (!(step.outputs ?? []).includes(name)) return sendErr(res, 404, `${stepId} 未登记产物：${name}`);
  const file = path.join(dir, stepId, name);
  if (!(await exists(file))) return sendErr(res, 404, `产物文件缺失：${stepId}/${name}`);
  return await streamMedia(req, res, file);
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;
  try {
    if (url === "/api/survey") return sendJson(res, await survey(ROOT));
    if (url === "/api/library") {
      return sendJson(res, await readLibrary(ROOT));
    }
    if (url === "/api/library/ingest" && req.method === "POST") {
      const body = await readBody<{ source_root?: string }>(req);
      try {
        const lib = await ingestLibrary(ROOT, (body.source_root ?? "").trim());
        return sendJson(res, {
          source_root: lib.source_root,
          count: lib.items.length,
          bgm: lib.items.filter((i) => i.kind === "bgm").length,
        });
      } catch (e) {
        return sendErr(res, 400, e instanceof Error ? e.message : String(e));
      }
    }
    // 目录浏览（b1 入口）：只读、单层、不递归。浏览器拿不到真实路径，入口只能走这里。
    if (url === "/api/fs/list" && req.method === "GET") {
      const sp = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const modeRaw = sp.get("mode") ?? "video";
      const mode = modeRaw === "video" || modeRaw === "srt" || modeRaw === "dir" ? modeRaw : null;
      if (!mode) return sendErr(res, 400, `mode 非法：${modeRaw}`);
      try {
        return sendJson(res, await listDir(sp.get("path"), mode));
      } catch (e) {
        const err = e as Error & { code?: number };
        return sendErr(res, err.code ?? 500, err.message);
      }
    }
    if (url === "/api/fs/stat" && req.method === "GET") {
      const sp = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const p = sp.get("path") ?? "";
      if (!p.trim()) return sendErr(res, 400, "path 必填");
      return sendJson(res, await statPath(p));
    }
    if (url === "/api/llm") {
      // 密钥不出进程：GET 只回掩码视图（key_hint），不回明文
      if (req.method === "PUT") return await putLlm(ROOT, res, req);
      return sendJson(res, await llmView(ROOT));
    }
    if (url === "/api/llm/test" && req.method === "POST") return await llmTest(ROOT, res, req);
    if (url === "/api/llm/models" && req.method === "POST") return await llmModels(ROOT, res, req);
    if (url === "/api/jobs" && req.method === "POST") return await createJob(res, await readBody<NewJob>(req));
    const jobCard = url.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobCard && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = safeJobId(jobCard[1]!);
      if (!id) return sendErr(res, 400, "任务 id 非法");
      try {
        if (req.method === "DELETE") return sendJson(res, await removeJob(ROOT, id));
        return sendJson(res, await updateCard(ROOT, id, await readBody(req)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return sendErr(res, msg.includes("不存在") ? 404 : 400, msg);
      }
    }
    if (url === "/api/clips" && req.method === "POST") return await createClip(res, await readBody<NewClip>(req));
    if (url === "/api/run" && req.method === "POST") return await triggerRun(res, req);
    if (url === "/api/runs") return sendJson(res, await listRuns(ROOT));

    // 变体 / 档位 / 预览 / 各步工作空间视图。顺序上长路径必须在短路径之前，
    // 否则 `/api/variants/jobs/x/s01/v2/activate` 会先被 `/api/variants/jobs/x` 那条吃掉。
    let m: RegExpMatchArray | null;
    // 全局档位（b3/b4 的「全局默认」）：与片段覆盖层分开的两个入口。
    // 放在 (jobs|clips) 那两条之前——"global" 不匹配那两个正则，但先写更不容易被将来的正则误吃。
    if (url === "/api/automation/global") {
      if (req.method === "PUT") {
        const body = await readBody<{ settings?: AutomationSettings }>(req);
        return sendJson(res, { global: await saveGlobal(ROOT, body.settings ?? {}) });
      }
      return sendJson(res, { global: await readGlobal(ROOT) });
    }
    if ((m = url.match(/^\/api\/variants\/(jobs|clips)\/([^/]+)\/([^/]+)\/([^/]+)\/activate$/)) && req.method === "POST") {
      const owner = parseOwner(m[1], m[2]);
      if (!owner) return sendErr(res, 400, `owner 非法：${url}`);
      return await activateVariant(res, owner, m[3]!, m[4]!);
    }
    if ((m = url.match(/^\/api\/variants\/(jobs|clips)\/([^/]+)$/))) {
      const owner = parseOwner(m[1], m[2]);
      if (!owner) return sendErr(res, 400, `owner 非法：${url}`);
      return sendJson(res, await variantsView(ROOT, owner));
    }
    if ((m = url.match(/^\/api\/automation\/(jobs|clips)\/([^/]+)$/))) {
      const owner = parseOwner(m[1], m[2]);
      if (!owner) return sendErr(res, 400, `owner 非法：${url}`);
      if (req.method === "PUT") return await putAutomation(res, req, owner);
      return sendJson(res, await automationView(ROOT, owner));
    }
    if ((m = url.match(/^\/api\/preview\/(jobs|clips)\/([^/]+)\/([^/]+)$/))) {
      const owner = parseOwner(m[1], m[2]);
      if (!owner) return sendErr(res, 400, `owner 非法：${url}`);
      const mode = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("mode");
      return await previewGet(res, owner, m[3]!, mode);
    }
    if ((m = url.match(/^\/api\/jobs\/([^/]+)\/s01$/))) return await s01View(res, m[1]!);
    if ((m = url.match(/^\/api\/clips\/([^/]+)\/s04$/))) return await s04View(res, m[1]!);
    if ((m = url.match(/^\/api\/clips\/([^/]+)\/s04\/params$/)) && req.method === "POST") {
      return await s04Params(res, req, m[1]!);
    }
    if ((m = url.match(/^\/api\/clips\/([^/]+)\/s04\/pick$/)) && req.method === "POST") {
      return await s04Pick(res, req, m[1]!);
    }
    if ((m = url.match(/^\/api\/media\/library\/([^/]+)$/))) return await libraryMedia(req, res, m[1]!);

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
      if (!(await exists(job.video_path))) return sendErr(res, 404, `源视频文件不在：${job.video_path}`);
      return await streamMedia(req, res, job.video_path);
    }
    if ((m = url.match(/^\/api\/media\/clip\/([^/]+)\/([^/]+)\/([^/]+)$/))) {
      return await clipMedia(req, res, m[1]!, m[2]!, m[3]!);
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
