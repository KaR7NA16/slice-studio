// 覆盖层（b29/b46）：人工判断与 AI 产物分离存放，合并现算不落盘。
// 优先级：人工 > AI > 默认保留。覆盖层按句子 id 键控；s00 重解析后对不上的键亮为 orphans，不静默丢弃。
// 「不静默丢」不分来源（P3-3）：ai.json 里对不上句流的键同样进 orphans——
// 它和人工键一样是「有人（或 AI）对某个句子做过的判断」，s00 重解析后凭空消失就是留痕丢失。
import type { AiDraftFile, MergedSentence, OverlayFile, Sentence } from "../shared/types.ts";

export const EMPTY_OVERLAY: OverlayFile = { schema: 1, decisions: {} };

export function mergeDecisions(
  base: Sentence[],
  ai: AiDraftFile | null,
  overlay: OverlayFile | null,
): { sentences: MergedSentence[]; orphans: string[] } {
  const aiMap = new Map((ai?.decisions ?? []).map((d) => [d.id, d]));
  const merged: MergedSentence[] = base.map((s) => {
    const a = aiMap.get(s.id);
    return {
      ...s,
      keep: a ? a.keep : true,
      source: a ? "ai" : "default",
      reason: a?.reason ?? null,
    };
  });
  const byId = new Map(merged.map((m) => [m.id, m]));
  // Set 去重：同一个 id 可能同时出现在 ai.json 与 overlay.json，两边都对不上时只报一次
  const orphanSet = new Set<string>();
  for (const id of aiMap.keys()) {
    if (!byId.has(id)) orphanSet.add(id);
  }
  for (const [id, d] of Object.entries(overlay?.decisions ?? {})) {
    const m = byId.get(id);
    if (!m) {
      orphanSet.add(id);
      continue;
    }
    m.keep = d.keep;
    m.source = "human";
  }
  return { sentences: merged, orphans: [...orphanSet] };
}
