// 服务端目录浏览（规划 v2.8 / b1 入口）。
//
// 为什么由服务端列目录，而不是浏览器 input[type=file] 或拖放：
// 浏览器出于安全不暴露文件的真实绝对路径（只有 File 对象，读完就是「整段上传」）。
// 本项目「只登记路径、不复制文件」，几 GB 的素材更不能复制一遍。
// 所以入口 = 本机服务列目录 + 界面点选，全程只传路径字符串。
//
// 纪律：只读。不删除、不写入、不递归、不返回文件内容；单层最多 800 条。
// 端口绑 127.0.0.1，且不设 CORS 头——其他本地页面读不到响应内容。
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type BrowseMode = "video" | "srt" | "dir";

const VIDEO = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const SUB = new Set([".srt", ".ass", ".vtt"]);
const LIMIT = 800;

export interface BrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
}

export interface BrowseResult {
  path: string | null;
  parent: string | null;
  entries: BrowseEntry[];
  truncated: boolean;
  roots: boolean; // true = 没有给路径，返回的是盘符/主目录入口
}

const matches = (mode: BrowseMode, ext: string): boolean =>
  mode === "video" ? VIDEO.has(ext) : mode === "srt" ? SUB.has(ext) : false;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function roots(): Promise<BrowseEntry[]> {
  const out: BrowseEntry[] = [];
  const home = os.homedir();
  if (process.platform === "win32") {
    // 盘符探测：A/B 是软驱位，从 C 起；只列真实存在的
    for (let i = 67; i <= 90; i++) {
      const p = `${String.fromCharCode(i)}:\\`;
      if (await isDir(p)) out.push({ name: p, path: p, is_dir: true, size: null });
    }
  } else {
    out.push({ name: "/", path: "/", is_dir: true, size: null });
  }
  if (await isDir(home)) out.push({ name: "主目录", path: home, is_dir: true, size: null });
  return out;
}

export async function listDir(raw: string | null, mode: BrowseMode): Promise<BrowseResult> {
  if (!raw || !raw.trim()) {
    return { path: null, parent: null, entries: await roots(), truncated: false, roots: true };
  }
  const dir = path.resolve(raw.trim());
  if (!(await isDir(dir))) {
    const e = new Error(`目录不存在：${dir}`);
    (e as Error & { code?: number }).code = 400;
    throw e;
  }

  let names: { name: string; isDir: boolean }[];
  try {
    const list = await readdir(dir, { withFileTypes: true });
    names = list
      .filter((d) => !d.name.startsWith(".")) // 隐藏项不列：这里不是文件管理器
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch (e) {
    const err = new Error(`读不了这个目录：${e instanceof Error ? e.message : String(e)}`);
    (err as Error & { code?: number }).code = 400;
    throw err;
  }

  const entries: BrowseEntry[] = [];
  for (const n of names) {
    if (n.isDir) {
      entries.push({ name: n.name, path: path.join(dir, n.name), is_dir: true, size: null });
      continue;
    }
    if (mode === "dir") continue;
    if (!matches(mode, path.extname(n.name).toLowerCase())) continue;
    const full = path.join(dir, n.name);
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    entries.push({ name: n.name, path: full, is_dir: false, size: st.size });
  }

  // 目录优先；中文按拼音序，和资源管理器的心智一致
  entries.sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name, "zh") : a.is_dir ? -1 : 1));
  const truncated = entries.length > LIMIT;
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    entries: truncated ? entries.slice(0, LIMIT) : entries,
    truncated,
    roots: false,
  };
}

export interface StatResult {
  path: string;
  name: string;
  exists: boolean;
  is_dir: boolean;
  size: number | null;
}

// 建任务前的就地校验：路径填错要在这里就报，而不是发一次 POST 再由服务端回显
export async function statPath(raw: string): Promise<StatResult> {
  const p = path.resolve((raw ?? "").trim());
  const name = path.basename(p);
  try {
    const st = await stat(p);
    return { path: p, name, exists: true, is_dir: st.isDirectory(), size: st.isDirectory() ? null : st.size };
  } catch {
    return { path: p, name, exists: false, is_dir: false, size: null };
  }
}
