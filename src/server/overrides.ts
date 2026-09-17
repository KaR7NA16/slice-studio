// 覆盖层（b29/b46）：人工判断与 AI 产物分离存放，合并现算不落盘。
// 优先级：人工 > AI > 默认保留。覆盖层按句子 id 键控；s00 重解析后对不上的键亮为 orphans，不静默丢弃。
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
  const orphans: string[] = [];
  for (const [id, d] of Object.entries(overlay?.decisions ?? {})) {
    const m = byId.get(id);
    if (!m) {
      orphans.push(id);
      continue;
    }
    m.keep = d.keep;
    m.source = "human";
  }
  return { sentences: merged, orphans };
}
