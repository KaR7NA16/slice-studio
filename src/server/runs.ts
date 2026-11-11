// run 触发与心跳（b53）：一步一子进程，记录落 data/runs/<id>.json。
// 心跳 = updated_at（子进程每次进展都刷新）；失联判定在读侧现算（b43：盘上是事实，状态是派生）。
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { STEP_BY_ID, stepsFor } from "../shared/steps.ts";
import type { RunRecord } from "../shared/types.ts";
import { effective } from "./automation.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";
import { acquire, resourceOf } from "./slots.ts";
import { survey } from "./survey.ts";

const LOST_AFTER_MS = 30_000; // 30 秒无心跳判失联

// 同一步已经在跑时再起一个，两个子进程会写同一对产物。HTTP 与自动链都走 startRun，锁放在这里。
export class RunBusyError extends Error {
  constructor(step: string) {
    super(`${step} 已在运行`);
    this.name = "RunBusyError";
  }
}

const inflight = new Set<string>();
// run.id → 子进程。取消时要用 pid 杀**整棵**进程树，光有 inflight 的 key 不够。
// 进程退出时删掉：服务重启后这张表是空的，此时取消只能改记录、杀不到进程——如实报，不假装。
const procs = new Map<string, ReturnType<typeof spawn>>();
// 代码目录 ≠ 数据根：root 是用户数据根，步执行体在本仓库里（按本文件位置推导）
const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");

const runsDir = (root: string): string => path.join(root, "data", "runs");
export const runFile = (root: string, id: string): string => path.join(runsDir(root), id + ".json");

// 读侧现算：running 但心跳超时 → 呈现为 error（不改写盘上事实）
function derive(rec: RunRecord): RunRecord {
  if (rec.status === "running" && Date.now() - Date.parse(rec.updated_at) > LOST_AFTER_MS) {
    return { ...rec, status: "error", error: "失联：30 秒无心跳（进程可能已退出）", finished_at: null };
  }
  return rec;
}

// 自动链（b3/b4 的兑现处）：一步跑完，看它的**直接下游**里有没有「档位 = auto 且输入齐备」的，有就接着跑。
// 三个刻意的约束：
// ① **一次只起一个**——不在这里递归起一串子进程。下一个跑完会再走一遍这里，链条自然往下推；
//    递归起链会让「哪一步失败」与「谁起的它」在运行记录里对不上。
// ② **严格门：强依赖的契约产物必须齐备**。auto 不该去跑一个输入还没准备好的步——
//    那只会得到一个 error，还把「是你没跑上游」伪装成「这步坏了」。
//    代价是：只把 s05 设成 auto 而没跑 s02 时它不会自动跑（依赖没齐）。这是刻意的保守，不是漏。
// ③ **已经 ready 的不重跑**。档位管的是「上游好了就往下走」，不是「每次都重算」。
async function artifactsPresent(root: string, owner: string, step: string): Promise<boolean> {
  const spec = STEP_BY_ID.get(step);
  if (!spec) return false;
  for (const name of spec.artifacts) {
    const ok = await stat(path.join(root, "work", owner, step, name)).then((s) => s.isFile()).catch(() => false);
    if (!ok) return false;
  }
  return true;
}

async function hasRunning(root: string, owner: string, step: string): Promise<boolean> {
  return (await listRuns(root)).some((r) => r.owner === owner && r.step === step && r.status === "running");
}

export async function autoChain(root: string, owner: string, justFinished: string): Promise<void> {
  const level = owner.startsWith("jobs/") ? "job" : "clip";
  const [eff, sv] = await Promise.all([effective(root, owner), survey(root)]);
  const ownerId = owner.slice(owner.indexOf("/") + 1);
  const steps = level === "job"
    ? sv.jobs.find((j) => j.id === ownerId)?.steps
    : sv.clips.find((c) => c.id === ownerId)?.steps;
  if (!steps) return;
  for (const s of stepsFor(level)) {
    if (!s.deps.includes(justFinished)) continue; // 只看直接下游
    if (eff[s.id] !== "auto") continue;
    if (steps.find((x) => x.step === s.id)?.status === "ready") continue;
    if (await hasRunning(root, owner, s.id)) continue;
    let ready = true;
    for (const d of s.deps) {
      if (!(await artifactsPresent(root, owner, d))) {
        ready = false;
        break;
      }
    }
    if (!ready) continue;
    await startRun(root, owner, s.id, null);
    return;
  }
}

export async function startRun(root: string, owner: string, step: string, mode: string | null): Promise<RunRecord> {
  // 先占坑再 await。两个请求若都先查磁盘再落盘，会同时看见「没有在跑」然后各起一份。
  const key = `${root}\0${owner}\0${step}`;
  if (inflight.has(key)) throw new RunBusyError(step);
  inflight.add(key);
  let releaseSlot: (() => void) | null = null;
  let freed = false;
  const release = (): void => {
    if (freed) return;
    freed = true;
    inflight.delete(key);
    releaseSlot?.();
  };
  try {
    if (await hasRunning(root, owner, step)) throw new RunBusyError(step);
    // 槽满就在这里等。返回时子进程已经占着槽，调用方看到的 running 不是还在排队。
    releaseSlot = await acquire(await resourceOf(root, owner, step, mode));
    await mkdir(runsDir(root), { recursive: true });
  const now = new Date().toISOString();
  const rec: RunRecord = {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    owner,
    step,
    mode,
    status: "running",
    started_at: now,
    updated_at: now,
    finished_at: null,
    message: "已启动",
    error: null,
  };
  await writeJsonAtomic(runFile(root, rec.id), rec);
  // 步执行体的 stdout/stderr **必须留痕**。原先是 `stdio: "ignore"`，代价是：
  // 子进程硬崩时 run 记录里只有「进程异常退出（code 1）」，一条线索都没有——
  // 2026-09-18 端到端验收撞上 s02 崩溃，就因为这个盲区，只能靠手工绕过服务重跑才定位。
  // 现在保留末尾 8KB，落 data/runs/<id>.log（有输出才落，空输出不产生文件）。
  const child = spawn(
    process.execPath,
    [path.join(CODE_ROOT, "src", "steps", "run.ts"), root, owner, step, mode ?? "", rec.id],
    // POSIX 下必须 detached 才能自成进程组，取消时用负 pid 一次带走整棵树；
    // Windows 的 detached 是「新控制台窗口」，语义不同，那边靠 taskkill /T。
    { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
  );
  procs.set(rec.id, child);
  let tail = "";
  const collect = (b: Buffer): void => {
    tail = (tail + b.toString()).slice(-8192);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  // 进程级失败兜底：步代码自己会写 error；只有「根本没跑起来/崩了」才由这里据实补记。
  // 跑成了才推自动链。失败不推——上游没产出，下游的严格门本来也会拦住，
  // 而且「失败后还自动往下跑」会让人以为链条是通的。
    child.on("error", () => {
      procs.delete(rec.id);
      release();
    });
  child.on("exit", (code) => {
    procs.delete(rec.id);
    release();
    void (async () => {
      // 有输出才落日志：空输出不产生空文件（多数步是静默的）
      let hint = "";
      if (tail.trim()) {
        const logPath = path.join(runsDir(root), rec.id + ".log");
        await writeFile(logPath, tail, "utf8").catch(() => {
          console.error(`[run] 无法写运行日志：${logPath}`);
        });
        const inline = tail.trim().split("\n").slice(-3).join(" / ").slice(-300);
        hint = `；末尾输出：${inline}（详见 data/runs/${rec.id}.log）`;
      }
      const cur = await readJson<RunRecord>(runFile(root, rec.id));
      if (!cur) return;
      if (cur.status === "running") {
        const msg = `进程异常退出（code ${String(code)}）${hint}`;
        await writeJsonAtomic(runFile(root, rec.id), {
          ...cur,
          status: "error",
          error: msg,
          message: msg,
          updated_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        });
        return;
      }
      if (cur.status === "done") {
        try {
          await autoChain(root, owner, step);
        } catch (e) {
          // 不静默：自动链坏了必须留痕；但**不得**改写本次 run 已落盘的成功事实（善后不推翻主操作）
          console.error(`[autoChain] ${owner} ${step} 之后的自动链失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();
  });
    child.unref();
    return rec;
  } catch (e) {
    release();
    throw e;
  }
}

// 杀进程树，不是杀进程。链路是三层：服务 → run.ts → ffmpeg / python。
// child.kill() 只带走中间那层，ffmpeg 会变孤儿继续吃 CPU、继续占着资源槽——
// 那种「按钮点了、记录也显示已取消、机器还在满负荷」的状态比不做取消更糟。
// 导出是为了能被单独验证：这是整个取消功能里唯一「点了没反应也看不出来」的部分。
export function killTree(pid: number): boolean {
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return r.status === 0;
  }
  try {
    process.kill(-pid, "SIGTERM"); // 负号 = 整个进程组（spawn 时已 detached）
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

// 取消一次运行。返回落盘后的记录；run 不存在返回 null。
export async function cancelRun(root: string, id: string): Promise<RunRecord | null> {
  const file = runFile(root, id);
  const rec = await readJson<RunRecord>(file);
  if (!rec) return null;
  // 已经结束的不报错，如实返回现状——「取消失败」和「本来就没在跑」是两件事
  if (rec.status !== "running") return rec;
  const now = new Date().toISOString();
  // 先落盘再杀。exit 回调只在 status 仍是 running 时补记 error，
  // 先写 cancelled 才能保证它不把一次主动取消改写成「进程异常退出（code 1）」。
  const next: RunRecord = {
    ...rec,
    status: "cancelled",
    message: "已取消",
    // 取消也得把连续进度抹掉，否则界面上会留一条「已处理 3:40」配着「已取消」，
    // 读起来像「它还在跑到 3:40」。
    progress_detail: null,
    updated_at: now,
    finished_at: now,
  };
  await writeJsonAtomic(file, next);
  const child = procs.get(id);
  if (!child?.pid) {
    // 服务重启过：盘上还写着 running，但本进程没有它的 pid。改记录已尽力，杀不到。
    const honest: RunRecord = { ...next, message: "已取消（进程句柄已丢，可能仍在运行）" };
    await writeJsonAtomic(file, honest);
    return honest;
  }
  if (killTree(child.pid)) return next;
  // 杀不掉就如实说。把「记录已取消」当成「任务真的停了」，是这里最容易犯的错。
  const failed: RunRecord = { ...next, message: "已取消，但进程未能终止（仍在占用资源）" };
  await writeJsonAtomic(file, failed);
  return failed;
}

export async function getRun(root: string, id: string): Promise<RunRecord | null> {
  const rec = await readJson<RunRecord>(runFile(root, id));
  return rec ? derive(rec) : null;
}

export async function listRuns(root: string, limit = 50): Promise<RunRecord[]> {
  let names: string[] = [];
  try {
    names = await readdir(runsDir(root));
  } catch {
    return [];
  }
  const recs: RunRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const rec = await readJson<RunRecord>(path.join(runsDir(root), n));
    if (rec) recs.push(derive(rec));
  }
  return recs.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}
