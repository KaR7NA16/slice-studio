// 打包之后目录会换位置。程序自己的文件用相对路径记，用的时候再按当前程序目录拼回去。
// 用户磁盘上、安装目录外面的视频和音乐仍记绝对路径。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODE_ROOT } from "./shipped.ts";

export function toPortable(dataRoot: string, abs: string): string {
  const full = path.resolve(abs);
  for (const base of [dataRoot, CODE_ROOT]) {
    const rel = path.relative(base, full);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return full.split(path.sep).join("/");
}

export function resolveStoredPath(dataRoot: string, stored: string): string {
  if (path.isAbsolute(stored)) return stored;
  const rel = stored.split("/").join(path.sep);
  const inData = path.join(dataRoot, rel);
  if (existsSync(inData)) return inData;
  const inCode = path.join(CODE_ROOT, rel);
  if (existsSync(inCode)) return inCode;
  return inData;
}

// 相对路径先在数据根找，再在程序目录找。用户粘贴的绝对路径原样用。
export function resolveAssetsDir(dataRoot: string, input: string): string {
  const raw = input.trim();
  if (path.isAbsolute(raw)) return path.resolve(raw);
  for (const base of [dataRoot, CODE_ROOT]) {
    const p = path.resolve(base, raw);
    if (existsSync(p)) return p;
  }
  return path.resolve(dataRoot, raw);
}

// venv 的 pyvenv.cfg 把解释器写成绝对路径。目录搬走后不改这一份，Python 直接起不来。
// 启动器也会做同样的事；这里再做一次，是为了不经过 exe、直接用包内 node 启动也成立。
export function healPyvenv(codeRoot: string): boolean {
  const cfg = path.join(codeRoot, "tools", "python", "venv", "pyvenv.cfg");
  if (!existsSync(cfg)) return false;
  const base = path.resolve(codeRoot, "tools", "python", "base");
  const py = path.join(base, "python.exe");
  const venv = path.resolve(codeRoot, "tools", "python", "venv");
  const text = readFileSync(cfg, "utf8");
  const lines = text.split(/\r?\n/);
  let hasHome = false;
  const next = lines.map((line) => {
    const eq = line.indexOf("=");
    const key = (eq < 0 ? "" : line.slice(0, eq)).trim().toLowerCase();
    if (key === "home") {
      hasHome = true;
      return `home = ${base}`;
    }
    if (key === "executable") return `executable = ${py}`;
    if (key === "command") return `command = ${py} -m venv ${venv}`;
    return line;
  });
  if (!hasHome) next.unshift(`home = ${base}`);
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  const out = next.join("\n") + "\n";
  if (out === text || out === text.replace(/\r\n/g, "\n")) return false;
  writeFileSync(cfg, out, "utf8");
  return true;
}
