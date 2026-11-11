// 打绿色目录 zip。Git 只收源码；能跑的一份是这个产物。
// 清单：启动器、src、dist、三个运行时、两个 worker、两套权重、config.example.json。
// 不带 node_modules、config.json、work、data、曲库。输出在 work/_pack（已忽略）。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const STAGE_ROOT = path.join(ROOT, "work", "_pack");
const STAGE = path.join(STAGE_ROOT, "slice-studio");
const ZIP = path.join(STAGE_ROOT, "slice-studio.zip");
const CSC = path.join("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319", "csc.exe");

const TREES = ["src", "dist", "tools/node", "tools/ffmpeg", "tools/python", "models/asr", "models/demucs"];
const FILES = ["tools/asr_worker.py", "tools/demucs_worker.py", "config.example.json"];
const REQUIRED = [
  "tools/node/node.exe",
  "tools/ffmpeg/ffmpeg.exe",
  "tools/ffmpeg/ffprobe.exe",
  "tools/python/base/python.exe",
  "tools/python/venv/Scripts/python.exe",
  "models/asr/tokens.txt",
  "models/demucs/htdemucs.yaml",
  "launcher/Launcher.cs",
  "node_modules/vite/bin/vite.js",
];

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function exists(rel: string, base = ROOT): boolean {
  return statSync(path.join(base, rel), { throwIfNoEntry: false }) !== undefined;
}

function run(cmd: string, args: string[], cwd = ROOT): number | null {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  return r.status;
}

for (const rel of REQUIRED) {
  if (!exists(rel)) die(`缺少 ${rel}`);
}

console.log("构建前端…");
const built = run(path.join(ROOT, "tools", "node", "node.exe"), [
  path.join(ROOT, "node_modules", "vite", "bin", "vite.js"),
  "build",
]);
if (built !== 0) die("vite build 失败");
if (!exists("dist/index.html")) die("构建后没有 dist/index.html");

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

console.log("编译启动器…");
const exe = path.join(STAGE, "slice-studio.exe");
const compiled = run(CSC, ["/nologo", `/out:${exe}`, path.join(ROOT, "launcher", "Launcher.cs")]);
if (compiled !== 0 || !statSync(exe, { throwIfNoEntry: false })) die("csc 没有编出启动器");

function copyTree(rel: string): void {
  console.log(`复制 ${rel} …`);
  const dest = path.join(STAGE, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  const code = run("robocopy", [path.join(ROOT, rel), dest, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns"]);
  if (code === null || code >= 8) die(`复制 ${rel} 失败（robocopy ${code}）`);
}

for (const rel of TREES) copyTree(rel);
for (const rel of FILES) {
  const dest = path.join(STAGE, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(path.join(ROOT, rel), dest);
}

for (const rel of ["config.json", "node_modules", "assets", "data", "work", ".git"]) {
  if (exists(rel, STAGE)) die(`包里不该有 ${rel}`);
}
for (const rel of ["slice-studio.exe", "src/server/main.ts", "dist/index.html", ...FILES, ...REQUIRED.filter((r) => !r.startsWith("node_modules") && !r.startsWith("launcher"))]) {
  if (!exists(rel, STAGE)) die(`包里缺少 ${rel}`);
}

rmSync(ZIP, { force: true });
console.log("压缩…");
const zipped = run("tar", ["-a", "-c", "-f", ZIP, "-C", STAGE_ROOT, "slice-studio"]);
if (zipped !== 0) die("tar 压缩失败");
const size = statSync(ZIP).size;
console.log(`完成 ${ZIP}`);
console.log(`zip_bytes=${size}`);
