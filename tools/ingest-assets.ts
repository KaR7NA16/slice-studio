// 素材入库（原话#13 / b33 / b34）：扫旧项目 assets/ → data/library.json
// 口径：登记不搬文件；入库分配索引内 id（b33）；重跑时按内容指纹保留已分配 id，id 不复用。
// 运行：node tools/ingest-assets.ts（在 slice-studio 根目录下）
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const ASSETS = "<old-repo>/assets";
const OUT = path.join(ROOT, "data", "library.json");

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

async function sha256(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
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

type Item = {
  id: string;
  kind: string;
  group: string | null;
  title: string;
  path: string;
  sha256: string;
  bytes: number;
};

// 已分配 id 的稳定性：按指纹找回旧 id；新文件取该前缀下最小空闲号，id 永不复用
let existing: { items?: Item[] } = {};
try {
  existing = JSON.parse(await readFile(OUT, "utf8"));
} catch {}
const idBySha = new Map((existing.items ?? []).map((it) => [it.sha256, it.id]));
const usedIds = new Set((existing.items ?? []).map((it) => it.id));

function nextId(prefix: string): string {
  let max = 0;
  for (const id of usedIds) {
    const m = id.match(/^([a-z]+)-(\d+)$/);
    if (m && m[1] === prefix && m[2]) max = Math.max(max, parseInt(m[2], 10));
  }
  let n = max + 1;
  let id = `${prefix}-${String(n).padStart(3, "0")}`;
  while (usedIds.has(id)) {
    n++;
    id = `${prefix}-${String(n).padStart(3, "0")}`;
  }
  usedIds.add(id);
  return id;
}

const items: Item[] = [];
const skipped: string[] = [];

for (const k of KINDS) {
  const base = path.join(ASSETS, k.dir);
  const files: string[] = [];
  try {
    for await (const f of walk(base)) files.push(f);
  } catch {
    continue; // 目录不存在则跳过该类
  }
  files.sort();
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!k.exts.has(ext)) {
      skipped.push(f);
      continue;
    }
    const rel = path.relative(base, f);
    const sep = rel.includes("/") ? "/" : path.sep;
    const group = rel.includes(sep) ? (rel.split(sep)[0] ?? null) : null;
    const hash = await sha256(f);
    const id = idBySha.get(hash) ?? nextId(k.prefix);
    items.push({
      id,
      kind: k.kind,
      group,
      title: path.basename(f, ext),
      path: f.split(path.sep).join("/"),
      sha256: hash,
      bytes: (await stat(f)).size,
    });
  }
}

items.sort((a, b) => a.id.localeCompare(b.id));
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  JSON.stringify({ schema: 1, source_root: ASSETS, items }, null, 2) + "\n",
  "utf8",
);

// 摘要（供核验）
const byKind = new Map<string, number>();
const bgmGroups = new Map<string, number>();
for (const it of items) {
  byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
  if (it.kind === "bgm" && it.group) bgmGroups.set(it.group, (bgmGroups.get(it.group) ?? 0) + 1);
}
console.log("== 入库摘要 ==");
for (const [k, n] of [...byKind.entries()].sort()) console.log(`${k}: ${n}`);
console.log("== bgm 分组（mood 值域，b51a） ==");
for (const [g, n] of [...bgmGroups.entries()].sort()) console.log(`${g}: ${n}`);
console.log(`跳过（扩展名不在登记范围）: ${skipped.length}`);
for (const s of skipped) console.log(`  skip: ${s}`);
console.log(`总计: ${items.length} -> ${OUT}`);
