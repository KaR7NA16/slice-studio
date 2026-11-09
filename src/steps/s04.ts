// s04 配乐（b51a/b50c：**mood 值域 = 曲库动态注入**；规则优先，LLM 兜底）。
// 两条路都**不硬编码分组**——值域每次都从 `data/library.json` 现算：
//   ① 规则路（人工已指定 `bgm_mood`）——完全离线：mood 在值域内 → 从该组选曲；
//   ② LLM 兜底路（未指定）——把**现算的值域**注入 prompt，让 LLM 按句流内容挑一个。
// 两条路的 mood 都要过值域校验：**越界直接报错，不回退**。
// 为什么坚持不回退：曲库换血后旧 mood 会失效，回退到某个默认组等于把「你的配置已经不适用了」
// 藏起来，用户拿到风格不对的曲子还不知道为什么（b50c 的判据正是「曲库换血后候选自动更新」）。
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { BgmFile, ClipFile, LibraryItem, S04Params, SentencesFile } from "../shared/types.ts";
import { llmStatus } from "../server/config.ts";
import { readJson, writeJsonAtomic } from "../server/jsonfile.ts";
import { readLibrary } from "../server/library.ts";
import { chatJson } from "./llm.ts";
import { commitVariant, finishStep, inputRef, progress, stepDir, workDir } from "./lib.ts";

// 值域现算：kind=bgm 的 group 去重后排序。**不硬编码**——曲库换血（改分组、增删目录）后这里跟着变，
// 这正是 b51a 要求的「候选自动更新」。导出是为了让验证能直接断言它（而不是绕过它）。
export function moodDomain(items: LibraryItem[]): string[] {
  return [...new Set(items.filter((i) => i.kind === "bgm" && i.group).map((i) => i.group as string))].sort();
}

const systemPrompt = (moods: string[]): string =>
  "你是短视频配乐师。根据片段的逐句字幕，从**给定的风格分组**里挑一个最合适的。\n" +
  `可选分组（只能从中选，不得自创、不得改写）：${moods.join(" / ")}\n` +
  '只返回 JSON：{"mood":"分组名","reason":"中文一句话理由"}。';

export async function runS04(root: string, owner: string, runId: string): Promise<string> {
  const clip = await readJson<ClipFile>(path.join(workDir(root, owner), "clip.json"));
  if (!clip) throw new Error("clip.json 不存在");

  const lib = await readLibrary(root);
  const tracks = (lib?.items ?? []).filter((i) => i.kind === "bgm");
  const moods = moodDomain(lib?.items ?? []);
  if (moods.length === 0) throw new Error("曲库里没有 bgm：在总览页填素材目录，重新入库");

  const dir = stepDir(root, owner, "s04");
  await mkdir(dir, { recursive: true });
  const params = await readJson<S04Params>(path.join(dir, "params.json"));

  let mood: string;
  let source: "human" | "llm";
  let reason: string | null = null;
  let llmModel: string | null = null; // LLM 兜底路才有值；规则路为 null（变体 meta 要记）
  const want = params?.bgm_mood?.trim();

  if (want) {
    // ① 规则路：人工已指定。越界报错，不回退。
    if (!moods.includes(want)) {
      throw new Error(`bgm_mood「${want}」不在曲库分组里（现有：${moods.join(" / ")}）`);
    }
    mood = want;
    source = "human";
  } else {
    // ② LLM 兜底路：未指定 mood，按句流内容挑。缺 LLM 就据实报错，不塞一个默认值糊过去。
    const cur = await readJson<SentencesFile>(path.join(stepDir(root, owner, "s03"), "sentences.json"));
    if (!cur) throw new Error("s03 句流未构建：未指定 bgm_mood 时要按内容挑风格，先跑一次 s03 构建");
    const llm = await llmStatus(root);
    if (!llm.ok) throw new Error(`未指定 bgm_mood，需要 LLM 按内容挑风格：${llm.reason}`);
    await progress(root, runId, `LLM（${llm.llm.model}）从 ${moods.length} 个分组里挑…`);
    const reply = await chatJson(llm.llm, systemPrompt(moods), JSON.stringify(cur.sentences.map((s) => ({ text: s.text }))));
    let parsed: { mood?: string; reason?: string };
    try {
      parsed = JSON.parse(reply) as { mood?: string; reason?: string };
    } catch {
      throw new Error(`LLM 返回不是合法 JSON：${reply.slice(0, 120)}`);
    }
    const picked = (parsed.mood ?? "").trim();
    // LLM 越界**同样报错**：它若自创一个分组名，下面的选曲会选到空集，
    // 那时报「分组下没有曲目」会把人引向「曲库缺文件」，而归因其实是「LLM 没按值域挑」。
    if (!moods.includes(picked)) {
      throw new Error(`LLM 挑了「${picked}」，不在曲库分组里（现有：${moods.join(" / ")}）`);
    }
    mood = picked;
    source = "llm";
    reason = parsed.reason ?? null;
    llmModel = llm.llm.model;
  }

  // 选曲规则：同组内按 id 升序取第一首——**确定性**是刻意的，同输入必须同产物（可复现）。
  // 组内可能有几十首，真正的「挑哪首」留给 s04 工作空间（3.5）让用户换；这里只保证有个确定答案。
  const group = tracks.filter((t) => t.group === mood).sort((a, b) => a.id.localeCompare(b.id));
  const pick = group[0];
  if (!pick) throw new Error(`分组「${mood}」下没有曲目`);
  // 索引里有这条，不代表文件还在。出片时才发现，人已经把前面几步走完了。
  const file = await stat(pick.path).catch(() => null);
  if (!file || file.size <= 0) throw new Error(`选中的曲目文件不存在：${pick.path}（在总览页重新入库）`);

  const bgm: BgmFile = {
    schema: 1,
    mood,
    source,
    reason,
    track: { id: pick.id, title: pick.title, path: pick.path, bytes: pick.bytes },
    candidates: group.length,
    at: new Date().toISOString(),
  };
  // 输入登记：clip.json（区间变了内容就变了）+ params.json（改了 mood 必须重跑）。
  // 句流只在 LLM 路里被真正消费，所以只在那条路上登记——规则路登记它会让「改句流」误标脏。
  const inputs = [
    await inputRef(root, "clip.json", `${owner}/clip.json`),
    await inputRef(root, "s04/params.json", `${owner}/s04/params.json`),
  ];
  if (!want) inputs.push(await inputRef(root, "s03/sentences.json", `${owner}/s03/sentences.json`));

  if (source === "llm") {
    // LLM 兜底路 = 抽卡：另存一版 variants/<id>.json，可回切（b7/b8）。
    // 规则路（人工指定 mood）不产变体——它不是 AI 抽卡，存成「一版」会让人以为换过模型。
    await commitVariant(root, owner, "s04", { model: llmModel, label: `${mood} / ${pick.title}` }, bgm, {
      inputs,
      outputs: ["bgm.json"],
    });
  } else {
    await writeJsonAtomic(path.join(dir, "bgm.json"), bgm);
    // 规则路不读句流。先前 LLM 路登记过的句子 key 要拿掉，否则改一句删留，配乐会一直待重跑。
    await finishStep(root, owner, "s04", inputs, ["bgm.json"], { dropKeys: ["s03/sentences.json"] });
  }

  const how = source === "human" ? "人工指定" : "LLM 按内容挑";
  return `配乐：${mood} / ${pick.title}（${how}，该组 ${group.length} 首）`;
}
