// 成片时间轴的唯一口径。s05 出片和 s03 播放器预览都走这里：
// 两处各写一遍的话，工作台听到的和导出的会悄悄岔开。
//
// 相邻保留句间隔小于 CUT_GAP 就并成一段（避免逐句硬切的碎跳），
// 段与段之间的空隙丢掉。给了 bounds 就把句子夹回片段区间，夹完为空的整句丢掉。

export const CUT_GAP = 0.5;

export interface CutSentence {
  start: number;
  end: number;
  keep: boolean;
}

export function filmRanges(
  sentences: CutSentence[],
  bounds?: { start: number; end: number },
): [number, number][] {
  const kept = sentences.filter((s) => s.keep).sort((a, b) => a.start - b.start);
  const ranges: [number, number][] = [];
  for (const s of kept) {
    const a = bounds ? Math.max(s.start, bounds.start) : s.start;
    const b = bounds ? Math.min(s.end, bounds.end) : s.end;
    if (b - a <= 0) continue;
    const last = ranges[ranges.length - 1];
    if (last && a <= last[1] + CUT_GAP) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
  }
  return ranges;
}

export function filmSeconds(ranges: [number, number][]): number {
  let n = 0;
  for (const [a, b] of ranges) n += b - a;
  return n;
}

// 播放头不在任一保留段里时，下一次该跳到哪。
// null = 就在保留段内，继续播。number = 跳到这段起点。"end" = 已经播过最后一段。
// 段起点前 30ms 内不算「还没到」：刚 seek 过去时 currentTime 可能略早于目标，再跳一次会抖。
export function previewJump(t: number, ranges: [number, number][]): number | "end" | null {
  if (ranges.length === 0) return "end";
  for (const [a, b] of ranges) {
    if (t < a - 0.03) return a;
    if (t < b) return null;
  }
  return "end";
}
