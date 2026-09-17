// run 触发与心跳（b53）：一步一子进程，记录落 data/runs/<id>.json。
// 心跳 = updated_at（子进程每次进展都刷新）；失联判定在读侧现算（b43：盘上是事实，状态是派生）。
import { spawn } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";

const LOST_AFTER_MS = 30_000; // 30 秒无心跳判失联
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

export async function startRun(root: string, owner: string, step: string, mode: string | null): Promise<RunRecord> {
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
  const child = spawn(
    process.execPath,
    [path.join(CODE_ROOT, "src", "steps", "run.ts"), root, owner, step, mode ?? "", rec.id],
    { stdio: "ignore" },
  );
  // 进程级失败兜底：步代码自己会写 error；只有「根本没跑起来/崩了」才由这里据实补记
  child.on("exit", (code) => {
    void (async () => {
      const cur = await readJson<RunRecord>(runFile(root, rec.id));
      if (cur && cur.status === "running") {
        await writeJsonAtomic(runFile(root, rec.id), {
          ...cur,
          status: "error",
          error: `进程异常退出（code ${String(code)}）`,
          message: `进程异常退出（code ${String(code)}）`,
          updated_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
        });
      }
    })();
  });
  child.unref();
  return rec;
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
