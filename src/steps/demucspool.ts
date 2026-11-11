// 步进程这边的 demucs 入口。数据根上只留一个 broker（见 demucs_broker.ts）。
import { spawn } from "node:child_process";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { readJson } from "../server/jsonfile.ts";

const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");

export interface DemucsPoolStats {
  pid: number;
  port: number;
  ready: number;
  tasks: number;
  last_peak: number;
  error?: string;
}

export interface DemucsResult {
  vocals: string;
  no_vocals: string;
  seconds: number;
}

const infoPath = (root: string): string => path.join(root, "data", "workers", "demucs.json");
const lockPath = (root: string): string => path.join(root, "data", "workers", "demucs.lock");

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readDemucsStats(root: string): Promise<DemucsPoolStats | null> {
  const st = await readJson<DemucsPoolStats>(infoPath(root));
  if (!st || !alive(st.pid)) return null;
  return st;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitPort(root: string, timeoutMs: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const raw = await readJson<DemucsPoolStats>(infoPath(root));
    if (raw?.error && !alive(raw.pid)) throw new Error(raw.error);
    if (raw && alive(raw.pid) && raw.port > 0) return raw.port;
    await sleep(200);
  }
  const raw = await readJson<DemucsPoolStats>(infoPath(root));
  throw new Error(`demucs broker 没有在 ${timeoutMs / 1000}s 内就绪${raw?.error ? `：${raw.error}` : ""}`);
}

// 锁文件只表示「有人正在拉起」。broker 退出时删锁；拉起失败超过 5 秒也删，避免一把死锁卡住后面所有片段。
async function recoverStale(root: string): Promise<void> {
  const st = await readJson<DemucsPoolStats>(infoPath(root));
  if (st && alive(st.pid)) return;
  const age = await stat(lockPath(root)).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
  if (age < 5_000) return;
  await unlink(lockPath(root)).catch(() => undefined);
}

async function ensureBroker(root: string): Promise<number> {
  const dir = path.join(root, "data", "workers");
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    const existing = await readDemucsStats(root);
    if (existing) return existing.port;
    let held = false;
    try {
      const fh = await open(lockPath(root), "wx");
      await fh.close();
      held = true;
      const child = spawn(process.execPath, [path.join(CODE_ROOT, "src", "steps", "demucs_broker.ts"), root], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return await waitPort(root, 90_000);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (held && code !== "EEXIST") await unlink(lockPath(root)).catch(() => undefined);
      if (code !== "EEXIST") throw e;
      await recoverStale(root);
      await sleep(200);
    }
  }
  throw new Error("demucs broker 起不来");
}

export async function demucsSeparate(
  root: string,
  task: { id: string; audio: string; out_dir: string },
): Promise<DemucsResult> {
  const port = await ensureBroker(root);
  try {
    return await talk(port, task);
  } catch (e) {
    // 连不上 / 连上就断，最可能的原因是 pid 被系统**复用**：data/workers/demucs.json 里那个
    // pid 现在归了别的进程，`process.kill(pid, 0)` 于是说「活着」，我们便一直去连一个死端口。
    // 不清记录的话，这个数据根上的 s02 会永久失败，且报错只说「连不上」——用户重装都没用。
    // 清掉再拉一次：真正的故障（模型加载失败等）会在第二次照样失败，错误不会因此被吞。
    if (!(e instanceof Error) || !/连不上|断开|中断/.test(e.message)) throw e;
    await unlink(infoPath(root)).catch(() => undefined);
    await unlink(lockPath(root)).catch(() => undefined);
    return await talk(await ensureBroker(root), task);
  }
}

async function talk(port: number, task: { id: string; audio: string; out_dir: string }): Promise<DemucsResult> {
  return await new Promise((resolve, reject) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const rl = createInterface({ input: sock });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      rl.close();
      sock.end();
      fn();
    };
    sock.on("error", (e) => finish(() => reject(new Error(`连不上 demucs broker：${e.message}`))));
    sock.on("close", () => finish(() => reject(new Error("demucs broker 在返回结果前断开"))));
    // readline 会把 input 的 error 转发成 **Interface 自己的 'error' 事件**，而那个事件没人接
    // 就是 uncaughtException —— 一次「broker 挂了」会变成整个进程消失，连失败原因都留不下。
    // 实测：broker 连不上时，进程崩在 node:internal/readline/interface，只剩一句 ECONNREFUSED。
    rl.on("error", () => finish(() => reject(new Error("demucs broker 连接中断（读端出错）"))));
    rl.on("line", (line) => {
      let ev: { type?: string; message?: string; vocals?: string; no_vocals?: string; seconds?: number };
      try {
        ev = JSON.parse(line) as typeof ev;
      } catch {
        return;
      }
      if (ev.type === "done") {
        finish(() => resolve({ vocals: ev.vocals ?? "", no_vocals: ev.no_vocals ?? "", seconds: ev.seconds ?? 0 }));
      } else if (ev.type === "error") {
        finish(() => reject(new Error(ev.message || "demucs 分离失败")));
      }
    });
    sock.write(JSON.stringify(task) + "\n");
  });
}
