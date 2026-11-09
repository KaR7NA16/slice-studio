// 素材入库的命令行入口。界面走 POST /api/library/ingest，逻辑在 src/server/ingest.ts。
// 运行：node tools/ingest-assets.ts [素材目录] [数据根]
// 不传参时用项目内 assets/，数据根是当前目录；指向可改，界面走 POST /api/library/ingest。
import { ingestLibrary } from "../src/server/ingest.ts";

const assets = process.argv[2] ?? "assets";
const dataRoot = process.argv[3] ?? process.cwd();
const lib = await ingestLibrary(dataRoot, assets);
const byKind = new Map<string, number>();
for (const it of lib.items) byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
console.log("== 入库摘要 ==");
for (const [k, n] of [...byKind.entries()].sort()) console.log(`${k}: ${n}`);
console.log(`总计: ${lib.items.length} -> ${dataRoot}/data/library.json`);
