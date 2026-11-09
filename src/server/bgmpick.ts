// 人工选曲覆盖层（b29/b46：人工判断与 AI 产物**分文件存放**）。
//
// s04 的 `bgm.json` 是规则/LLM 的产物；用户在工作空间里换一首 → 写 `s04/pick.json`，
// **不改 bgm.json**。理由与 s03 的 overlay 同源：重跑一次 s04（换 mood、曲库换血后重跑）
// 不该把人工选的曲子抹掉。
//
// 生效曲目 = pick ?? bgm.track。**只在这里算一次**，s05 与界面都读这个合并结果——
// 两处各读一份必然有一天对不上（一处读 pick、一处读 bgm）。
import path from "node:path";
import type { BgmFile, BgmPick, LibraryItem } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";
import { readLibrary } from "./library.ts";

export type { BgmPick };

export interface EffectiveBgm {
  bgm: BgmFile; // s04 的原始产物（界面要显示它的 mood / 理由）
  pick: BgmPick | null; // 人工覆盖（可能指向一首已不在曲库的曲子）
  track: BgmFile["track"]; // 生效曲目
  source: "human" | "ai"; // 生效曲目来自人工还是 s04 产物
  missing_pick: boolean; // 有 pick 但曲库里已找不到它（曲库换血）——调用方必须据此报错，不许静默回落
}

const pickFile = (root: string, owner: string): string => path.join(root, "work", owner, "s04", "pick.json");

export const readPick = (root: string, owner: string): Promise<BgmPick | null> =>
  readJson<BgmPick>(pickFile(root, owner));

// trackId 传 null = 清除人工选曲（回到 s04 产物）。清除即删文件，不留空壳。
export async function savePick(root: string, owner: string, trackId: string | null): Promise<BgmPick | null> {
  const file = pickFile(root, owner);
  if (trackId === null) {
    const { rm } = await import("node:fs/promises");
    await rm(file, { force: true });
    return null;
  }
  const pick: BgmPick = { schema: 1, track_id: trackId, at: new Date().toISOString() };
  await writeJsonAtomic(file, pick);
  return pick;
}

export function findTrack(items: LibraryItem[], id: string): LibraryItem | null {
  return items.find((i) => i.id === id && i.kind === "bgm") ?? null;
}

export async function effectiveBgm(root: string, owner: string): Promise<EffectiveBgm | null> {
  const bgm = await readJson<BgmFile>(path.join(root, "work", owner, "s04", "bgm.json"));
  if (!bgm) return null;
  const pick = await readPick(root, owner);
  if (!pick) return { bgm, pick: null, track: bgm.track, source: "ai", missing_pick: false };
  const lib = await readLibrary(root);
  const item = findTrack(lib?.items ?? [], pick.track_id);
  if (!item) {
    // 不回落：曲库换血后人工选的曲子可能没了，静默回落到 s04 那首等于把
    // 「你选的曲子不在了」藏起来——用户听到风格不对还不知道为什么（b50c 同源要求）。
    return { bgm, pick, track: bgm.track, source: "ai", missing_pick: true };
  }
  return {
    bgm,
    pick,
    track: { id: item.id, title: item.title, path: item.path, bytes: item.bytes },
    source: "human",
    missing_pick: false,
  };
}
