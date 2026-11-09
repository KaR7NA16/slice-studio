// s03 波形气口：把 s02 的人声轨画成波形，叠上句子边界与「删/留」，
// 让「删掉一段」这件事看得见——否则逐句删留只能靠读文本猜气口。
//
// 数据来源是 s02 的 vocals.wav（惰性依赖 b23）：没有它就不画，也不禁用 s03——
// 波形是**辅助**，不是删留的必要条件。
export interface WaveOpts {
  sentences: { start: number; end: number; keep: boolean }[];
  span: { start: number; end: number }; // 片段区间（时间轴 0 点 = clip.start）
  onSeek: (t: number) => void; // 点波形跳播放器（t 是视频绝对秒）
}

// 峰值包络：每像素列取该列覆盖样本的 min/max。比逐样本画线快一个数量级，
// 且对短视频（几千到几十万样本/列）视觉上完全等价。
function peaks(data: Float32Array, cols: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const per = Math.max(1, Math.floor(data.length / cols));
  for (let c = 0; c < cols; c++) {
    const lo = c * per;
    const hi = Math.min(data.length, lo + per);
    let mn = 1;
    let mx = -1;
    for (let i = lo; i < hi; i++) {
      const v = data[i]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    min[c] = mn === 1 && mx === -1 ? 0 : mn;
    max[c] = mn === 1 && mx === -1 ? 0 : mx;
  }
  return { min, max };
}

const pcmCache = new Map<string, Float32Array>();

type WaveCanvas = HTMLCanvasElement & { __seek?: (t: number) => void };

export async function drawWave(canvas: HTMLCanvasElement, url: string, opts: WaveOpts): Promise<void> {
  let data = pcmCache.get(url);
  if (!data) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const buf = await res.arrayBuffer();
    // decodeAudioData 需要 AudioContext；采样率随便（只要不是 0），解码后我们只读样本。
    const ctx = new AudioContext({ sampleRate: 16000 });
    const audio = await ctx.decodeAudioData(buf);
    await ctx.close();
    data = audio.getChannelData(0).slice();
    pcmCache.set(url, data);
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth || 900;
  const cssH = 120;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const g = canvas.getContext("2d")!;
  g.scale(dpr, dpr);

  const style = getComputedStyle(document.documentElement);
  // 颜色一律取自令牌（tokens.css 是唯一来源）；兜底值也是中性色，不再有「蓝色线条」这种第二身份。
  // 兜底值重复了一份色值，因此逐行标注来源，让「重复」在仓库里可 grep（tools/verify-tokens.ts 会扫）。
  const cLine = style.getPropertyValue("--accent").trim() || "#1a1916"; // token-fallback: --accent
  const cDim = style.getPropertyValue("--text-muted").trim() || "#6f6c63"; // token-fallback: --text-muted
  const cCut = style.getPropertyValue("--st-error").trim() || "#8d342c"; // token-fallback: --st-error
  const cSep = style.getPropertyValue("--border").trim() || "#e4e2da"; // token-fallback: --border

  g.clearRect(0, 0, cssW, cssH);
  // 时间轴：x = (t - span.start) / span 长度 * 宽
  const dur = Math.max(0.001, opts.span.end - opts.span.start);
  const x = (t: number): number => ((t - opts.span.start) / dur) * cssW;

  // 被删区间先铺底（红淡色）——「这一段在成片里没有了」
  for (const s of opts.sentences) {
    if (s.keep) continue;
    g.fillStyle = cCut;
    g.globalAlpha = 0.12;
    g.fillRect(x(s.start), 0, Math.max(1, x(s.end) - x(s.start)), cssH);
  }
  g.globalAlpha = 1;

  const { min, max } = peaks(data, Math.round(cssW));
  const mid = cssH / 2;
  for (let c = 0; c < cssW; c++) {
    const t = opts.span.start + (c / cssW) * dur;
    // 落在「删掉」的句子里就画灰，留着就画主色——一眼看出哪段会进成片
    const cut = opts.sentences.some((s) => !s.keep && s.start <= t && t < s.end);
    g.strokeStyle = cut ? cDim : cLine;
    g.globalAlpha = cut ? 0.5 : 0.95;
    g.beginPath();
    g.moveTo(c + 0.5, mid - max[c]! * mid * 0.92);
    g.lineTo(c + 0.5, mid - min[c]! * mid * 0.92);
    g.stroke();
  }
  g.globalAlpha = 1;

  // 句子边界竖线（气口位置）
  g.strokeStyle = cSep;
  g.lineWidth = 1;
  for (const s of opts.sentences) {
    for (const t of [s.start, s.end]) {
      if (t < opts.span.start || t > opts.span.end) continue;
      g.beginPath();
      g.moveTo(x(t), 0);
      g.lineTo(x(t), cssH);
      g.stroke();
    }
  }

  const el = canvas as WaveCanvas;
  el.__seek = opts.onSeek;
  el.dataset.waveStart = String(opts.span.start);
  el.dataset.waveDur = String(dur);
  if (!el.dataset.waveBound) {
    el.dataset.waveBound = "1";
    el.addEventListener("click", (e) => {
      const seek = (el as WaveCanvas).__seek;
      if (!seek) return;
      const rect = el.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      seek(Number(el.dataset.waveStart ?? "0") + ratio * Number(el.dataset.waveDur ?? "0"));
    });
  }
}
