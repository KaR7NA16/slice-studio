// 素材入库（b33/b34）：扫一个目录，登记进数据根的 data/library.json。
// 只登记路径，不复制文件。已有条目按内容指纹保留 id，id 不复用。
// 扫不到任何可登记文件时不写盘，避免把一份好曲库覆盖成空的。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Library, LibraryItem } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";
import { resolveAssetsDir, toPortable } from "./portable.ts";
import { shipped } from "./shipped.ts";

const AUDIO = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"]);
const VIDEO = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const FONT = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);

const KINDS = [
  { kind: "bgm", dir: "bgm", prefix: "bgm", exts: new Set([...AUDIO]) },
  { kind: "font", dir: "fonts", prefix: "font", exts: FONT },
  { kind: "material", dir: "materials", prefix: "mat", exts: new Set([...VIDEO]) },
  { kind: "meme", dir: "memes", prefix: "meme", exts: new Set([...IMAGE, ...VIDEO]) },
  { kind: "sfx", dir: "sfx", prefix: "sfx", exts: new Set([...AUDIO]) },
];

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

function nextId(prefix: string, used: Set<string>): string {
  let max = 0;
  for (const id of used) {
    const m = id.match(/^([a-z]+)-(\d+)$/);
    if (m && m[1] === prefix && m[2]) max = Math.max(max, parseInt(m[2], 10));
  }
  let n = max + 1;
  let id = `${prefix}-${String(n).padStart(3, "0")}`;
  while (used.has(id)) {
    n++;
    id = `${prefix}-${String(n).padStart(3, "0")}`;
  }
  used.add(id);
  return id;
}

export async function ingestLibrary(dataRoot: string, assetsDir: string): Promise<Library> {
  const root = resolveAssetsDir(dataRoot, assetsDir);
  if (!assetsDir.trim()) throw new Error("素材目录必填");
  const dirStat = await stat(root).catch(() => null);
  if (!dirStat?.isDirectory()) throw new Error(`素材目录不存在：${assetsDir}`);

  const current = await readJson<Library>(shipped(dataRoot, "data/library.json"));
  const idBySha = new Map((current?.items ?? []).map((it) => [it.sha256, it.id]));
  // 同一份音频常被放进多个 mood 目录（同 sha、不同路径）。只按 sha 找回 id 会让这些条目
  // 在「重新入库」时塌缩成同一个 id，所以先按路径认领，sha 只作路径变动时的兜底。
  const idByPath = new Map((current?.items ?? []).map((it) => [it.path, it.id]));
  const usedIds = new Set((current?.items ?? []).map((it) => it.id));
  const claimed = new Set<string>();
  const items: LibraryItem[] = [];

  for (const k of KINDS) {
    const base = path.join(root, k.dir);
    const files: string[] = [];
    try {
      for await (const f of walk(base)) files.push(f);
    } catch {
      continue;
    }
    files.sort();
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!k.exts.has(ext)) continue;
      const rel = path.relative(base, f);
      const sep = rel.includes("/") ? "/" : path.sep;
      const group = rel.includes(sep) ? (rel.split(sep)[0] ?? null) : null;
      const hash = await sha256(f);
      const portablePath = toPortable(dataRoot, f);
      // 旧索引里可能已经有重复 id（早期按 sha 找回时塌缩过）。候选 id 若本轮已发出，
      // 就重新分配一个，让「重新入库」本身把坏索引自愈回来，而不是永久保留坏状态。
      const candidate = idByPath.get(portablePath) ?? idBySha.get(hash);
      const id = candidate && !claimed.has(candidate) ? candidate : nextId(k.prefix, usedIds);
      claimed.add(id);
      items.push({
        id,
        kind: k.kind,
        group,
        title: path.basename(f, ext),
        path: portablePath,
        sha256: hash,
        bytes: (await stat(f)).size,
      });
    }
  }

  if (items.length === 0) {
    throw new Error("这个目录里没有可登记的素材（需要 bgm、fonts、materials、memes 或 sfx 子目录）");
  }

  items.sort((a, b) => a.id.localeCompare(b.id));
  const lib: Library = { schema: 1, source_root: toPortable(dataRoot, root), items };
  await writeJsonAtomic(path.join(dataRoot, "data", "library.json"), lib);
  return lib;
}
