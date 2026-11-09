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
    const t = player.currentTime;
    const idx = sents.findIndex((s) => s.start <= t && t < s.end);
    if (idx === curIdx) return;
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
