// 读曲库时把相对路径拼成当前机器上的绝对路径。磁盘上仍是相对路径，搬走目录不用改索引。
import type { Library } from "../shared/types.ts";
import { readJson } from "./jsonfile.ts";
import { resolveStoredPath } from "./portable.ts";
import { shipped } from "./shipped.ts";

export async function readLibrary(dataRoot: string): Promise<Library | null> {
  const raw = await readJson<Library>(shipped(dataRoot, "data/library.json"));
  if (!raw) return null;
  return {
    ...raw,
    source_root: raw.source_root ? resolveStoredPath(dataRoot, raw.source_root) : raw.source_root,
    items: (raw.items ?? []).map((it) => ({ ...it, path: resolveStoredPath(dataRoot, it.path) })),
  };
}
