// demucs 常驻代理：整个数据根一个进程，加载一次权重，串行做分离。
// 各步子进程不自己起 Python（那样 N 条片段就是 N 次加载），只连到这里把任务送进来。
// 启动：node src/steps/demucs_broker.ts <数据根>
// 协议：本机 TCP，一行 JSON 进、一行 JSON 出（done 或 error）。Python 侧协议不变。
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { writeJsonAtomic } from "../server/jsonfile.ts";
import { shipped } from "../server/shipped.ts";
import { pythonChildEnv } from "./toolenv.ts";

const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const PYTHON = path.join(CODE_ROOT, "tools", "python", "venv", "Scripts", "python.exe");
const WORKER_DIR = path.join(CODE_ROOT, "tools");
const IDLE_MS = 120_000;

const rootArg = process.argv[2];
if (!rootArg) {
  console.error("用法：node src/steps/demucs_broker.ts <数据根>");
  process.exit(2);
}
const root: string = rootArg;

const infoPath = path.join(root, "data", "workers", "demucs.json");
const lockPath = path.join(root, "data", "workers", "demucs.lock");

type Task = { id?: string; audio: string; out_dir: string };
type Ev = { type: string; id?: string | null; message?: string };

let port = 0;
let ready = 0;
let tasks = 0;
let lastPeak = 0;
let queued = 0;
let burst = 0;
let pythonReady = false;
let closing = false;
let child: ChildProcess | null = null;
let server: Server | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
let current: { task: Task; socket: Socket } | null = null;
const queue: { task: Task; socket: Socket }[] = [];

async function persist(extra?: { error?: string }): Promise<void> {
  await writeJsonAtomic(infoPath, {
    pid: process.pid,
    port,
    ready,
    tasks,
    last_peak: lastPeak,
    ...(extra?.error ? { error: extra.error } : {}),
  });
}

function armIdle(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (queued === 0 && !current) void shutdown();
  }, IDLE_MS);
}

async function shutdown(error?: string): Promise<void> {
  if (closing) return;
  closing = true;
  if (idle) clearTimeout(idle);
  if (error) await persist({ error }).catch(() => undefined);
  server?.close();
  child?.kill();
  await unlink(lockPath).catch(() => undefined);
  if (!error) await unlink(infoPath).catch(() => undefined);
  process.exit(error ? 1 : 0);
}

function failJob(job: { task: Task; socket: Socket }, message: string): void {
  queued = Math.max(0, queued - 1);
  if (queued === 0) {
    lastPeak = burst;
    burst = 0;
  }
  try {
    job.socket.write(JSON.stringify({ type: "error", id: job.task.id ?? null, message }) + "\n");
    job.socket.end();
  } catch {
    // 调用方已经走了，任务结果无处可送
  }
}

async function noteFinish(): Promise<void> {
  queued = Math.max(0, queued - 1);
  tasks += 1;
  if (queued === 0) {
    lastPeak = burst;
    burst = 0;
  }
  await persist();
}

function pump(): void {
  if (closing || current || !pythonReady || queue.length === 0) return;
  const job = queue.shift()!;
  current = job;
  if (idle) clearTimeout(idle);
  child?.stdin?.write(JSON.stringify(job.task) + "\n");
}

function onWorkerLine(line: string): void {
  let ev: Ev;
  try {
    ev = JSON.parse(line) as Ev;
  } catch {
    return;
  }
  if (ev.type === "ready") {
    pythonReady = true;
    ready = 1;
    void persist().then(() => pump());
    return;
  }
  if (ev.type === "error" && !pythonReady) {
    void shutdown(ev.message || "demucs 加载失败");
    return;
  }
  if (!current) return;
  if (ev.type !== "done" && ev.type !== "error") return;
  const job = current;
  current = null;
  void noteFinish().then(() => {
    try {
      job.socket.write(line + "\n");
      job.socket.end();
    } catch {
      // 同上：调用方断开不影响 worker 继续接下一个
    }
    armIdle();
    pump();
  });
}

const srv = createServer((socket) => {
  const rl = createInterface({ input: socket });
  rl.on("line", (line) => {
    if (closing) return;
    let task: Task;
    try {
      task = JSON.parse(line) as Task;
    } catch {
      socket.write(JSON.stringify({ type: "error", id: null, message: "任务不是合法 JSON" }) + "\n");
      socket.end();
      return;
    }
    queued += 1;
    burst = Math.max(burst, queued);
    queue.push({ task, socket });
    pump();
  });
});
server = srv;

srv.listen(0, "127.0.0.1", () => {
  const addr = srv.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  void persist().then(() => startPython());
});

function startPython(): void {
  const repo = shipped(root, "models/demucs", "htdemucs.yaml");
  const py = spawn(PYTHON, ["-m", "demucs_worker", "--repo", repo], {
    cwd: WORKER_DIR,
    env: pythonChildEnv(process.env, { PYTHONPATH: WORKER_DIR, PYTHONIOENCODING: "utf-8" }, path.join(root, "work", "_scratch")),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child = py;
  let stderrTail = "";
  py.stderr?.on("data", (b: Buffer) => {
    stderrTail = (stderrTail + b.toString()).slice(-600);
  });
  const rl = createInterface({ input: py.stdout! });
  rl.on("line", onWorkerLine);
  py.on("error", (e) => {
    void shutdown(`worker 起不来：${e.message}`);
  });
  py.on("exit", (code) => {
    if (closing) return;
    const tail = stderrTail.trim().split("\n").slice(-2).join(" / ");
    const message = `worker 提前退出（exit ${code}）${tail ? `：${tail}` : ""}`;
    const job = current;
    current = null;
    if (job) failJob(job, message);
    for (const waiting of queue.splice(0)) failJob(waiting, message);
    void shutdown(message);
  });
  armIdle();
}
