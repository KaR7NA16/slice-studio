// 播放联动：句流高亮 + 跟随滚动 + 成片预览跳段。
//
// 这段逻辑原先只存在于片段页（s03），任务页只有时间码可读——b9 的「点句跳转、播到哪句高亮哪句」
// 只兑现了一半。抽出来给两页共用，是因为两页各写一份必然在某天分叉：一边修了 seek 抖动，
// 另一边没修，而错位的表现看起来都「像那么回事」，最难发现。
import type { CutSentence } from "../shared/cut.ts";
import { filmRanges, previewJump } from "../shared/cut.ts";

export interface PlaybackCtl {
  follow: () => void;
  highlight: () => void;
  seekTo: (t: number) => void;
  reset: () => void;
  dispose: () => void;
}

/**
 * 当前时刻对应哪一句。
 *
 * 精确命中优先；落在两句之间的停顿里时，退回「刚过去、且后面还有句子」的那一句。
 * 真实字幕之间普遍有 0.3–1 秒空隙，暂停恰好停在那里时，宁可继续指着上一句，
 * 也不要整列清空——「一句都不高亮」等于用户失去了自己播到哪里的唯一线索。
 * 字幕的阅读习惯本来也是上一句留到下句出现。
 *
 * 末句之后再没有下句可接，才真正清空（片子尾巴上没有台词，硬指着末句是撒谎）。
 */
function locate(sents: readonly CutSentence[], t: number): number {
  const exact = sents.findIndex((s) => s.start <= t && t < s.end);
  if (exact >= 0) return exact;
  let prev = -1;
  for (let i = 0; i < sents.length; i++) if (sents[i]!.start <= t) prev = i;
  return prev >= 0 && prev < sents.length - 1 ? prev : -1;
}

export function mountPlayback(opts: {
  player: HTMLVideoElement;
  /** 现算：覆盖层改判后句子会变，不能缓存 */
  sentences: () => CutSentence[];
  /** 与 sentences 一一对应的行元素；列表重画后由调用方更新 */
  rows: () => HTMLElement[];
  /** 片段页传 clip 区间；任务页没有成片预览，可不传 */
  bounds?: () => { start: number; end: number } | undefined;
  list?: () => HTMLElement | null;
  /** 成片预览开关；不传 = 不做跳段（任务页） */
  preview?: () => boolean;
}): PlaybackCtl {
  const player = opts.player;
  const previewOn = (): boolean => opts.preview?.() ?? false;

  let curIdx = -1;
  let holdEnd = false;
  let armTimer = 0;
  let lastSeekTo = -1;
  let lastSeekFrom = -1;
  let lastSeekAt = 0;

  // 到点再跳，而不是等 timeupdate（约 4 次/秒）才发现已经播进被删的句子。
  // 400ms 内不重复跳同一个点：视频 seek 不了的时候，否则会在同一处空转。
  const guardedSeek = (t: number): void => {
    if (Math.abs(player.currentTime - t) < 0.03) return;
    const now = performance.now();
    if (Math.abs(lastSeekTo - t) < 0.02 && Math.abs(lastSeekFrom - player.currentTime) < 0.02 && now - lastSeekAt < 400) return;
    lastSeekFrom = player.currentTime;
    lastSeekTo = t;
    lastSeekAt = now;
    player.currentTime = t;
  };

  const follow = (): void => {
    window.clearTimeout(armTimer);
    if (holdEnd) {
      holdEnd = false;
      player.pause();
      return;
    }
    if (!previewOn() || player.paused) return;
    const rs = filmRanges(opts.sentences(), opts.bounds?.());
    const jump = previewJump(player.currentTime, rs);
    if (jump === "end") {
      const last = rs[rs.length - 1];
      if (last && player.currentTime > last[1] + 0.02) {
        const back = Math.max(last[0], last[1] - 0.04);
        if (Math.abs(player.currentTime - back) >= 0.03) {
          holdEnd = true;
          guardedSeek(back);
          return;
        }
      }
      player.pause();
      return;
    }
    if (typeof jump === "number") {
      guardedSeek(jump);
      return;
    }
    const hit = rs.find(([a, b]) => player.currentTime >= a && player.currentTime < b);
    if (!hit) return;
    armTimer = window.setTimeout(follow, Math.max(16, (hit[1] - player.currentTime) * 1000));
  };

  // 高亮当前句，并保持上下各两句在视口内（b9）
  const highlight = (): void => {
    const rows = opts.rows();
    const sents = opts.sentences();
    if (rows.length === 0 || sents.length === 0) return;
    const idx = locate(sents, player.currentTime);
    // 下相同只是必要条件：整列被重画过（片段页改留删会重建 DOM）时类名已经丢了，
    // 只比下标就会提前 return，高亮再也回不来，而 mem 里还记着「当前是第几句」。
    const painted = rows.every((el, i) => el.classList.contains("cur") === (i === idx));
    if (idx === curIdx && painted) return;
    curIdx = idx;
    rows.forEach((el, i) => el.classList.toggle("cur", i === idx));
    const list = opts.list?.() ?? null;
    if (idx >= 0 && !player.paused && list) {
      const anchor = rows[Math.max(0, idx - 2)];
      if (anchor) list.scrollTo({ top: anchor.offsetTop, behavior: "smooth" });
    }
  };

  const onTime = (): void => {
    follow();
    highlight();
  };
  player.addEventListener("timeupdate", onTime);
  player.addEventListener("play", follow);
  player.addEventListener("seeked", follow);
  player.addEventListener("pause", () => window.clearTimeout(armTimer));

  return {
    follow,
    highlight,
    seekTo: (t: number) => {
      player.currentTime = t;
    },
    reset: () => {
      curIdx = -1;
      holdEnd = false;
      window.clearTimeout(armTimer);
    },
    dispose: () => {
      window.clearTimeout(armTimer);
      player.removeEventListener("timeupdate", onTime);
      player.removeEventListener("play", follow);
      player.removeEventListener("seeked", follow);
    },
  };
}
