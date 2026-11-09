// 启动器：pyvenv 自愈、数据根回落、拉起服务并读到实际端口。不打开浏览器。
// 运行：node tools/verify-launch.ts
import { SCRATCH } from "./scratchdir.ts";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { shipped } from "../src/server/shipped.ts";

const execFileP = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const EXE = path.join(ROOT, "slice-studio.exe");
const CSC = path.join("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319", "csc.exe");
const PY = path.join(ROOT, "tools", "python", "venv", "Scripts", "python.exe");
const CFG = path.join(ROOT, "tools", "python", "venv", "pyvenv.cfg");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

// torch / onnxruntime 需要 VC 运行库。它们必须躺在 python base 旁边，不能只靠系统目录里那份。
function msvcpPaths(): Promise<Record<string, string>> {
  const code = [
    "import onnxruntime",
    "import ctypes",
    "from ctypes import wintypes",
    "k=ctypes.WinDLL('kernel32')",
    "k.GetModuleFileNameW.argtypes=[wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]",
    "k.GetModuleHandleW.argtypes=[wintypes.LPCWSTR]",
    "k.GetModuleHandleW.restype=wintypes.HMODULE",
    "names=['msvcp140.dll','msvcp140_1.dll']",
    "buf=ctypes.create_unicode_buffer(32768)",
    "out=[]",
    "for n in names:",
    "    h=k.GetModuleHandleW(n)",
    "    got=''",
    "    if h and k.GetModuleFileNameW(h, buf, 32768):",
    "        got=buf.value",
    "    out.append(n+'='+got)",
    "print('\\n'.join(out))",
  ].join("\n");
  return new Promise((resolve) => {
    const c = spawn(PY, ["-c", code], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      c.kill();
      resolve({});
    }, 30_000);
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.on("error", () => {
      clearTimeout(timer);
      resolve({});
    });
    c.on("exit", () => {
      clearTimeout(timer);
      const rec: Record<string, string> = {};
      for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf("=");
        if (i > 0) rec[line.slice(0, i)] = line.slice(i + 1).trim().toLowerCase();
      }
      resolve(rec);
    });
  });
}

function pythonPrintsOne(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = spawn(PY, ["-c", "print(1)"], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      c.kill();
      resolve(false);
    }, 20_000);
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    c.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.includes("1"));
    });
  });
}

function runExe(args: string[], env?: NodeJS.ProcessEnv, exe = EXE): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn(exe, args, { env: { ...process.env, ...env }, windowsHide: true });
    let out = "";
    let err = "";
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.stderr.on("data", (d: Buffer) => (err += d.toString()));
    c.on("error", reject);
    c.on("exit", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

function homeOf(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("home "));
  return line?.split("=").slice(1).join("=").trim() ?? "";
}

// 程序目录不可写时数据根会改到别处。权重和曲库索引留在程序目录，不能跟着丢。
const isolated = await mkdtemp(path.join(SCRATCH, "slice-ship-"));
try {
  const demucs = shipped(isolated, "models/demucs", "htdemucs.yaml");
  const asr = shipped(isolated, "models/asr", "tokens.txt");
  const lib = shipped(isolated, "data/library.json");
  check(
    "数据根换地方后 demucs 权重仍从程序目录读",
    demucs.toLowerCase() === path.join(ROOT, "models", "demucs").toLowerCase()
      && (await readFile(path.join(demucs, "htdemucs.yaml"), "utf8")).includes("955717e8"),
    demucs,
  );
  check(
    "数据根换地方后 ASR 权重仍从程序目录读",
    asr.toLowerCase() === path.join(ROOT, "models", "asr").toLowerCase()
      && (await readFile(path.join(asr, "tokens.txt"), "utf8")).length > 0,
    asr,
  );
  check(
    "数据根换地方后曲库索引仍从程序目录读",
    lib.toLowerCase() === path.join(ROOT, "data", "library.json").toLowerCase()
      && (await readFile(lib, "utf8")).includes("\"bgm\""),
    lib,
  );
  await mkdir(path.join(isolated, "data"), { recursive: true });
  const own = path.join(isolated, "data", "library.json");
  await writeFile(own, "{}");
  check(
    "数据根自己有曲库时不回退到程序目录",
    shipped(isolated, "data/library.json").toLowerCase() === own.toLowerCase(),
    shipped(isolated, "data/library.json"),
  );
} finally {
  await rm(isolated, { recursive: true, force: true }).catch((e: unknown) => {
    console.log(`  清理临时数据根失败：${e instanceof Error ? e.message : String(e)}`);
  });
}

const csc = await execFileP(CSC, ["/nologo", `/out:${EXE}`, path.join(ROOT, "launcher", "Launcher.cs")]).then(
  () => "",
  (e: { stderr?: string; message?: string }) => e.stderr || e.message || String(e),
);
check("csc 编出启动器", csc === "" && true, csc);
if (csc) {
  console.log(`\n结果: ${passed} passed / ${failed} failed`);
  process.exit(1);
}

const base = path.join(ROOT, "tools", "python", "base");
const original = await readFile(CFG, "utf8");
try {
  check("自愈前 venv 的 python 能跑", await pythonPrintsOne());
  const bad = original.replace(/^home = .*$/m, "home = C:\\no\\such\\python-slice");
  await writeFile(CFG, bad, "utf8");
  check("home 指到不存在的路径后 python 起不来", !(await pythonPrintsOne()));
  const healed = await runExe(["--heal-only"]);
  check("自愈退出码 0", healed.code === 0, healed.err || healed.out);
  const after = await readFile(CFG, "utf8");
  check("home 被写回当前 base", homeOf(after).toLowerCase() === path.resolve(base).toLowerCase(), homeOf(after));
  check("自愈后 python 又能跑", await pythonPrintsOne());
  const msvcp = await msvcpPaths();
  const want140 = path.join(base, "msvcp140.dll").toLowerCase();
  const want1401 = path.join(base, "msvcp140_1.dll").toLowerCase();
  check(
    "msvcp140 从目录里的 python base 加载，不靠系统目录",
    msvcp["msvcp140.dll"] === want140 && msvcp["msvcp140_1.dll"] === want1401,
    JSON.stringify(msvcp),
  );
  const again = await runExe(["--heal-only"]);
  const twice = await readFile(CFG, "utf8");
  check("再跑一次不改文件（幂等）", again.code === 0 && twice === after, again.err);
  check("数据根默认是程序目录", healed.out.includes(`data=${ROOT}`), healed.out.trim());
} finally {
  if (!(await pythonPrintsOne())) {
    await writeFile(CFG, original, "utf8");
    console.log("  已把 pyvenv.cfg 恢复成测试前的内容");
  }
}

const scratch = await mkdtemp(path.join(SCRATCH, "slice-launch-"));
try {
  const cfgDir = path.join(scratch, "tools", "python", "venv");
  await mkdir(path.join(scratch, "tools", "python", "base"), { recursive: true });
  await mkdir(cfgDir, { recursive: true });
  await writeFile(
    path.join(cfgDir, "pyvenv.cfg"),
    "home = C:\\no\\such\\python-slice\ninclude-system-site-packages = false\nversion = 3.13.14\nexecutable = C:\\no\\such\\python-slice\\python.exe\ncommand = C:\\no\\such\\python-slice\\python.exe -m venv C:\\old\\venv\n",
    "utf8",
  );
  const moved = await runExe(["--heal-only", "--root", scratch]);
  const text = await readFile(path.join(cfgDir, "pyvenv.cfg"), "utf8");
  const expectBase = path.resolve(scratch, "tools", "python", "base");
  check("--root 下的 home 指到那份 base", homeOf(text).toLowerCase() === expectBase.toLowerCase(), homeOf(text));
  check("executable 跟着改", text.includes(`executable = ${path.join(expectBase, "python.exe")}`), text);
  check("换目录后数据根就是那个目录", moved.out.includes(`data=${path.resolve(scratch)}`), moved.out.trim());

  const locked = await mkdtemp(path.join(SCRATCH, "slice-launch-ro-"));
  const lockedCfg = path.join(locked, "tools", "python", "venv");
  await mkdir(path.join(locked, "tools", "python", "base"), { recursive: true });
  await mkdir(lockedCfg, { recursive: true });
  const goodHome = path.resolve(locked, "tools", "python", "base");
  await writeFile(
    path.join(lockedCfg, "pyvenv.cfg"),
    `home = ${goodHome}\ninclude-system-site-packages = false\nversion = 3.13.14\n`,
    "utf8",
  );
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  const deny = await execFileP("icacls", [locked, "/deny", `${user}:(W)`]).then(
    () => "",
    (e: { stderr?: string; message?: string }) => e.stderr || e.message || String(e),
  );
  if (deny) {
    check("能给临时目录去掉写权限", false, deny);
  } else {
    const appdata = path.join(process.env.APPDATA ?? "", "slice-studio");
    const appdataExisted = await stat(appdata).then(() => true, () => false);
    const ro = await runExe(["--heal-only", "--root", locked]);
    check("程序目录不可写时数据根回落 APPDATA", ro.code === 0 && ro.out.includes(`data=${appdata}`), ro.out + ro.err);
    if (!appdataExisted) await rm(appdata, { recursive: true, force: true }).catch(() => undefined);
    await execFileP("icacls", [locked, "/remove:d", user]).catch(() => undefined);
  }
  await rm(locked, { recursive: true, force: true }).catch(() => undefined);
} finally {
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}

// 系统 PATH 里有 node/python 也不许用。启动器必须拉目录里的 node.exe。
const barePath = "C:\\Windows\\System32;C:\\Windows";

// 整个目录换一条路径：联接过去，home 必须改到新位置，python 才起得来。测完指回原处再拆联接。
const link = path.join(SCRATCH, "slice-green-link");
await rmdir(link).catch(() => undefined);
await symlink(ROOT, link, "junction");
const linkExe = path.join(link, "slice-studio.exe");
const linkBase = path.join(link, "tools", "python", "base");
try {
  const moved = await runExe(["--heal-only"], undefined, linkExe);
  const movedCfg = await readFile(CFG, "utf8");
  check("换路径后 home 指到新位置的 base", homeOf(movedCfg).toLowerCase() === linkBase.toLowerCase(), homeOf(movedCfg));
  check("换路径后数据根就是新位置", moved.out.includes(`data=${link}`), moved.out.trim());
  const pyOk = await new Promise<boolean>((resolve) => {
    const c = spawn(path.join(link, "tools", "python", "venv", "Scripts", "python.exe"), ["-c", "print(1)"], {
      env: { ...process.env, PATH: barePath },
      windowsHide: true,
    });
    let out = "";
    const timer = setTimeout(() => {
      c.kill();
      resolve(false);
    }, 20_000);
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    c.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.includes("1"));
    });
  });
  check("换路径后 venv 的 python 能跑", pyOk);
} finally {
  await runExe(["--heal-only"]);
  await rmdir(link).catch(() => undefined);
}
const restoredHome = homeOf(await readFile(CFG, "utf8"));
check("换路径测试结束后 home 回到原目录", restoredHome.toLowerCase() === path.resolve(path.join(ROOT, "tools", "python", "base")).toLowerCase(), restoredHome);

const server = spawn(EXE, [], { env: { ...process.env, PATH: barePath, SLICE_NO_BROWSER: "1" }, windowsHide: true });
let serverOut = "";
let serverErr = "";
server.stdout.on("data", (d: Buffer) => (serverOut += d.toString()));
server.stderr.on("data", (d: Buffer) => (serverErr += d.toString()));
const url = await new Promise<string>((resolve) => {
  const timer = setTimeout(() => resolve(""), 30_000);
  server.stdout.on("data", () => {
    const m = serverOut.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
    if (!m) return;
    clearTimeout(timer);
    resolve(m[1]!);
  });
  server.on("exit", () => {
    clearTimeout(timer);
    resolve("");
  });
});
check("启动器读到服务实际端口", url.startsWith("http://127.0.0.1:"), serverOut + serverErr);
let surveyOk = false;
if (url) {
  try {
    const res = await fetch(`${url}/api/survey`);
    surveyOk = res.status === 200;
  } catch {
    surveyOk = false;
  }
}
check("浏览器会打开的那个地址真能答 /api/survey", surveyOk, url);
const nodePid = Number(serverOut.match(/pid=(\d+)/)?.[1] ?? "0");
let image = "";
if (nodePid > 0) {
  const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const queried = await execFileP(ps, [
    "-NoProfile",
    "-Command",
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter "ProcessId=${nodePid}").ExecutablePath`,
  ]).then(
    (r) => r.stdout.trim(),
    (e: { stdout?: string; stderr?: string; message?: string }) => `ERR ${e.stderr || e.stdout || e.message || ""}`,
  );
  image = queried;
}
check(
  "服务进程是目录里的 node，不靠系统 PATH",
  image.toLowerCase() === path.join(ROOT, "tools", "node", "node.exe").toLowerCase(),
  `pid=${nodePid} image=${image}`,
);
server.kill();
await new Promise((r) => setTimeout(r, 800));
let stillUp = false;
if (url) {
  try {
    stillUp = (await fetch(`${url}/api/survey`)).status === 200;
  } catch {
    stillUp = false;
  }
}
if (stillUp && nodePid > 0) {
  try { process.kill(nodePid); } catch { /* 已经没了 */ }
}
check("关掉启动器后服务一起退出", !stillUp, `pid=${nodePid} url=${url}`);

console.log(`\n结果: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
