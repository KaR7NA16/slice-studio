// s05 成片（b24：**成片 + 素材包两出口并列**，判据「两出口可分别产出」）。
// 已接：保留句成片 + 素材包 + 字幕出口（`clip.srt`）+ **字幕烧录**（s05/params.json 的 burn_subtitles，默认烧）
//       + **BGM 叠加**（消费 s04 的 bgm.json，含人工换曲覆盖层）。
// 字幕与烧录共用同一份 cues：两个出口的字幕必须逐字一致，各算一遍早晚对不上。
//
// 成片口径在 shared/cut.ts（filmRanges）：保留句按时间排序，相邻间隔小于 CUT_GAP 并成一段，
// 段间空隙丢掉。s03 的成片预览调用同一个函数，工作台听到的和这里导出的是同一条时间轴。
//
// BGM 是**可选消费**：s04 跑过就叠，没跑过就不叠——`STEPS[].deps` 在本项目只用于 stale 传播，
// 不阻塞运行（b24 的两出口不该因为没配乐就产不出来）。但 bgm.json 在、曲目文件不在 → 必须报错：
// 配乐是用户显式选的，静默出个没音乐的片子等于让他自己去发现。
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { filmRanges } from "../shared/cut.ts";
import type { AiDraftFile, ClipFile, JobFile, OverlayFile, S05Params, SentencesFile } from "../shared/types.ts";
import { effectiveBgm } from "../server/bgmpick.ts";
import { readJson, writeJsonAtomic } from "../server/jsonfile.ts";
import { EMPTY_OVERLAY, mergeDecisions } from "../server/overrides.ts";
import { finishStep, inputRef, progress, stepDir, workDir } from "./lib.ts";

const execFileP = promisify(execFile);

const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FFMPEG = path.join(CODE_ROOT, "tools", "ffmpeg", "ffmpeg.exe");
const FFPROBE = path.join(CODE_ROOT, "tools", "ffmpeg", "ffprobe.exe");

const HEARTBEAT_MS = 10_000; // runs.ts 是「30 秒无心跳判失联」

// BGM 相对人声的电平。0.15 ≈ -16.5dB：口播里配乐要「听得出、但盖不住人声」。
// 现在是常量而不是参数：还没有让用户调它的入口，先不造结构；3.5 加 s05 工作空间时
// 按 b22「渲染参数严格按步切」升成 `s05/params.json` 的 `bgm_gain`。
const BGM_GAIN = 0.15;
// 结尾淡出时长（秒）。短视频收尾硬切会「啪」一下，1s 是听不出突兀又确实收干净的量级。
const BGM_FADE = 1.0;

// 烧录字幕的字幕样式（ASS force_style）。写成常量而不是参数：还没有让用户调它的入口，
// 先不造结构；要开放时按 b22 升成 s05/params.json 的 subtitle_style。
// 白字黑描边、无阴影——在任意画面上都能读，且不会因为半透明背景在浅色画面里糊掉。
const SUB_STYLE =
  "FontName=Microsoft YaHei,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000," +
  "BorderStyle=1,Outline=2,Shadow=0,MarginV=24,Alignment=2";

// ffmpeg 滤镜的路径转义。三条都是必需的，少一条就在 Windows 上炸：
//   ① `:` 是滤镜的选项分隔符 → 盘符要写成 `C\:`；
//   ② 反斜杠是滤镜的转义字符 → 路径分隔符统一换正斜杠；
//   ③ 单引号会截断 `'...'` 段 → 转义掉（路径里出现单引号很罕见，但一旦出现就是个难查的错）。
const escFilterPath = (p: string): string => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

// 素材包清单（b24 第二出口）。刻意**不含**成片以外的中间件（vocals.wav 等）——
// 素材包回答的是「这条片子要发出去，得带上哪些东西」，不是「跑过的所有文件」。
interface KeptFile {
  schema: 1;
  clip_id: string;
  total_seconds: number; // 成片时长 = 各保留段长度之和
  ranges: [number, number][]; // 每段对应的原视频绝对区间（秒）
  sentences: { id: string; start: number; end: number; text: string }[];
}

type Range = [number, number];

// 长成片重编码会超过 30 秒失联判定 → 定时刷心跳（与 s02 同一手法）
// 心跳失败不得带死这一步：best-effort，写不进去只留痕（降级为警告，不静默）。
async function withHeartbeat<T>(root: string, runId: string, msg: string, fn: () => Promise<T>): Promise<T> {
  const beat = setInterval(
    () =>
      void progress(root, runId, msg).catch((e: unknown) =>
        console.error(`[s05] 心跳写入失败：${e instanceof Error ? e.message : String(e)}`),
      ),
    HEARTBEAT_MS,
  );
  try {
    return await fn();
  } finally {
    clearInterval(beat);
  }
}

const srtTime = (t: number): string => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
};

function toSrt(cues: { start: number; end: number; text: string }[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join("\n");
}

// 手写 ZIP（stored，不压缩）：mp4/srt 本身已压缩，deflate 收益近乎零，而零依赖是这里的价值。
// 只实现必要字段，日期固定为 1980-01-01（产物可复现，不因运行时刻变化——同一条片重跑出同样的包）。
function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    const size = e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // method = stored
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x0021, 12); // dos date = 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x0021, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + size;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, central, eocd]);
}

export async function runS05(root: string, owner: string, runId: string): Promise<string> {
  const clip = await readJson<ClipFile>(path.join(workDir(root, owner), "clip.json"));
  if (!clip) throw new Error("clip.json 不存在");
  const job = await readJson<JobFile>(path.join(workDir(root, `jobs/${clip.job_id}`), "job.json"));
  if (!job) throw new Error(`job.json 不存在（jobs/${clip.job_id}）`);

  // 1. 句流 + AI 初稿 + 人工覆盖层 → 现算保留句（判据与 s03 工作台同一处，不另起一套）
  const s03dir = stepDir(root, owner, "s03");
  const cur = await readJson<SentencesFile>(path.join(s03dir, "sentences.json"));
  if (!cur) throw new Error("s03 句流未构建：先跑一次 s03 构建");
  const ai = await readJson<AiDraftFile>(path.join(s03dir, "ai.json"));
  const overlay = (await readJson<OverlayFile>(path.join(s03dir, "overlay.json"))) ?? EMPTY_OVERLAY;
  const { sentences } = mergeDecisions(cur.sentences, ai, overlay);

  // s03 的句流是「与片段区间有交叠就收进来」（build 口径），句子可能跨出片段边界。
  // filmRanges 会夹回区间；夹完为空的整句丢掉，避免 trim 取到圈定范围之外。
  const kept = sentences.filter((s) => s.keep).sort((a, b) => a.start - b.start);
  if (kept.length === 0) throw new Error(`全部 ${sentences.length} 句都被删了，没有可成片的内容`);
  const ranges: Range[] = filmRanges(sentences, { start: clip.start, end: clip.end });
  if (ranges.length === 0) throw new Error("保留句全部落在片段区间之外，无可成片内容");

  // 2. 成片时间轴：各段首尾相接，累计偏移即每段在成片里的起点
  const offsets: number[] = [];
  let total = 0;
  for (const [a, b] of ranges) {
    offsets.push(total);
    total += b - a;
  }

  // 3. 音轨探测：**一次 ffprobe 同时拿「有没有音轨」和「几声道」**。
  //    有没有：屏幕录制静音是真实存在的形态，直接假设有音轨会让 s05 在那类素材上崩（两条路都支持，而不是报错推给用户）。
  //    几声道：BGM 必须**迁就人声的声道布局**，否则 amix 会偏好立体声、把 mono 人声上混成 stereo，
  //    而 ffmpeg 的 mono→stereo rematrix 默认给 -3 dB —— 实测「加了配乐，人声反而小 3 dB」。
  //    这个坑只在**真跑**里看得见：编译过、文件也生成、时长也对，只有量电平才暴露。
  const probe = await execFileP(FFPROBE, [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", job.video_path,
  ]);
  const channels = Number(probe.stdout.trim());
  const hasAudio = Number.isFinite(channels) && channels > 0;
  // >2 声道（如 5.1）按 stereo 处理：本项目素材是屏幕录制/手机口播，不为此造结构。
  const voiceLayout = channels === 1 ? "mono" : "stereo";

  const dir = stepDir(root, owner, "s05");
  await mkdir(dir, { recursive: true });

  // 3.2 字幕（成片时间轴）：每句一条，落在它所属段的偏移上。
  //     **先算先落盘**，因为烧录要用它——同一份 cues 供两个出口（包里的 clip.srt、画面上的烧录），
  //     各算一遍的话，算法一旦有一天不同，包里的字幕和画面上的字幕就会对不上。
  const s05params = await readJson<S05Params>(path.join(dir, "params.json"));
  const burn = s05params?.burn_subtitles ?? true; // 默认烧（见 S05Params 注释）
  const cues = kept
    .map((s) => {
      const a = Math.max(s.start, clip.start);
      const b = Math.min(s.end, clip.end);
      if (b - a <= 0) return null;
      const i = ranges.findIndex(([ra, rb]) => a >= ra - 1e-6 && a <= rb + 1e-6);
      if (i < 0) return null;
      const base = offsets[i]!;
      return { start: base + (a - ranges[i]![0]), end: base + Math.min(b, ranges[i]![1]) - ranges[i]![0], text: s.text };
    })
    .filter((c): c is { start: number; end: number; text: string } => c !== null && c.end > c.start);
  const srtPath = path.join(dir, "clip.srt");
  await writeFile(srtPath, toSrt(cues), "utf8");

  // 3.5 BGM：读 s04 的选曲结果（**含人工换曲覆盖层**，可选消费，见文件头）。
  //     这里只认「产物在不在」，不认 s04 的 status——判据是文件本身，不是状态字段。
  //     `effectiveBgm` 是唯一的合并点：人工 pick.json 优先于 s04 的 bgm.json。
  const eff = await effectiveBgm(root, owner);
  let bgmPath: string | null = null;
  if (eff) {
    if (eff.missing_pick) {
      // 不回落：曲库换血后人工选的曲子可能没了，静默换成 s04 那首等于把「你选的没了」藏起来。
      throw new Error(`s04 里人工选的曲目已不在曲库：${eff.pick!.track_id}（重新入库，或在 s04 换一首 / 清除选择）`);
    }
    const size = await stat(eff.track.path).then((s) => (s.isFile() ? s.size : -1)).catch(() => -1);
    if (size <= 0) throw new Error(`s04 选的曲目文件不存在：${eff.track.path}（重新入库，或在 s04 换一首）`);
    bgmPath = eff.track.path;
  }

  // 4. 一次 filter_complex 拼完：每段 trim + 时间戳归零，再 concat。
  //    不用「逐段切片 + concat demuxer」是因为那要落 N 个中间文件（N 可达数十），
  //    中间件越多越难清理，而这里一次编码就能出片。
  await progress(root, runId, `拼 ${ranges.length} 段（共 ${total.toFixed(1)}s，原片 ${clip.start}s–${clip.end}s）…`);
  const parts: string[] = [];
  ranges.forEach(([a, b], i) => {
    const s = (a - clip.start).toFixed(3);
    const e = (b - clip.start).toFixed(3);
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) parts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const pairList = ranges.map((_, i) => (hasAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join("");
  parts.push(`${pairList}concat=n=${ranges.length}:v=1:a=${hasAudio ? 1 : 0}[outv]${hasAudio ? "[outa]" : ""}`);

  // 4.2 字幕烧录：接在 concat **之后**，对成片时间轴上的画面烧（先烧再叠 BGM 与顺序无关，音频不动）。
  //     路径必须按滤镜的规矩转义——`:` 是滤镜的选项分隔符，Windows 盘符要写成 `C\:`，反斜杠换正斜杠。
  //     不转义时 ffmpeg 报的是「No such filter」之类，归因完全跑偏（会让人以为是没编 libass）。
  if (burn) {
    parts.push(`[outv]subtitles='${escFilterPath(srtPath)}':force_style='${SUB_STYLE}'[vfinal]`);
  }

  // 4.5 BGM 混音。配乐输入带 `-stream_loop -1`（曲子常短于成片，不循环就只响前几秒）。
  //     长度由**有限的那一路**决定，不能让无限输入定：有人声时靠 amix 的 `duration=first`
  //     （first = 人声），无人声时靠 `atrim=0:总长`。少了这层约束 ffmpeg 会一直等配乐读不完。
  //     `normalize=0` 是必须的：amix 默认按输入路数均分音量（实测 2 路各降 6 dB）→ 人声与配乐一起变小。
  //     `aformat=channel_layouts=<人声布局>` 同样是必须的，且原因不直观：
  //     两路布局不一致时 amix 会挑声道多的那个（stereo），把 mono 人声上混，而 rematrix 的上混默认 -3 dB。
  //     实测：人声分支 -21.1 dB，叠了 BGM 之后成片 -24.1 dB —— 配乐没让片子更响，反而把人声压了 3 dB。
  //     让配乐来迁就人声（而不是反过来）才对：人声是主体，配乐是可替换的那一路。
  if (bgmPath) {
    const fade = total > BGM_FADE * 2 ? `,afade=t=out:st=${(total - BGM_FADE).toFixed(3)}:d=${BGM_FADE}` : "";
    const chain = `[1:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aformat=channel_layouts=${voiceLayout},volume=${BGM_GAIN}${fade}`;
    if (hasAudio) parts.push(`${chain}[bgm]`, `[outa][bgm]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[finala]`);
    else parts.push(`${chain}[finala]`); // 源片无音轨：配乐就是唯一音轨，不需要 amix
    await progress(root, runId, `叠 BGM：${eff!.track.title}（${eff!.bgm.mood}${eff!.source === "human" ? "，人工换曲" : ""}）…`);
  }

  const finalMp4 = path.join(dir, "final.mp4");
  const args = [
    "-y",
    "-ss", String(clip.start),
    "-t", String(clip.end - clip.start + 0.5), // 半秒余量：末段 end 恰好压边界时避免丢最后一帧（trim 会截掉多余部分）
    "-i", job.video_path,
  ];
  if (bgmPath) args.push("-stream_loop", "-1", "-i", bgmPath);
  args.push("-filter_complex", parts.join(";"), "-map", burn ? "[vfinal]" : "[outv]");
  if (hasAudio || bgmPath) args.push("-map", bgmPath ? "[finala]" : "[outa]");
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p");
  if (hasAudio || bgmPath) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart", finalMp4);
  await withHeartbeat(root, runId, "拼接成片…", () => execFileP(FFMPEG, args));

  // 5. 字幕已在 3.2 算好落盘（`clip.srt`），这里不再重算——两个出口共用同一份 cues。
  const keptFile: KeptFile = {
    schema: 1,
    clip_id: clip.id,
    total_seconds: Number(total.toFixed(3)),
    ranges: ranges.map(([a, b]) => [Number(a.toFixed(3)), Number(b.toFixed(3))]),
    sentences: kept.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text })),
  };
  const keptPath = path.join(dir, "kept.json");
  await writeJsonAtomic(keptPath, keptFile);

  // 6. 素材包（b24 第二出口）：能直接发走的一套东西。
  //    成片一并放进去是刻意的——「素材包」回答的是「这条片子要交出去得带什么」，
  //    一个只含字幕、还得另外去别处取视频的包不算出口。
  //    ⚠️ 已知限制：走内存拼包（Buffer），成片若到数百 MB 会吃内存。短视频（几十秒～几分钟）无碍；
  //    真要做长成片分发，阶段 5 改成流式写（先算 CRC 再回写）——登记在此，不假装已解决。
  const zipPath = path.join(dir, "package.zip");
  const zip = makeZip([
    { name: "final.mp4", data: await readFile(finalMp4) },
    { name: "clip.srt", data: await readFile(srtPath) },
    { name: "kept.json", data: await readFile(keptPath) },
  ]);
  await writeFile(zipPath, zip);

  // 7. 不能只信 ffmpeg 的退出码（铁律：形式不构成实质）——产物必须真在盘上
  for (const [name, min] of [["final.mp4", 1000], ["package.zip", 100], ["clip.srt", 1]] as const) {
    const size = await stat(path.join(dir, name))
      .then((s) => (s.isFile() ? s.size : -1))
      .catch(() => -1);
    if (size < min) throw new Error(`${name} 未落盘或过小（${size} B）`);
  }

  // 这些输入无论当时在不在都要登记。inputRef 对缺失文件记空串，survey 把它和「文件不在」
  // 当成同一回事：一直没有就不标脏；出片之后才出现的 AI 初稿、人工删留、烧录开关、配乐、换曲
  // 会让指纹从空串变成内容哈希 → stale。只在「当时文件已在」才登记，后来的修改就永远看不见。
  const inputs = [
    await inputRef(root, "clip.json", `${owner}/clip.json`),
    await inputRef(root, "s03/sentences.json", `${owner}/s03/sentences.json`),
    await inputRef(root, "s03/ai.json", `${owner}/s03/ai.json`),
    await inputRef(root, "s03/overlay.json", `${owner}/s03/overlay.json`),
    await inputRef(root, "s05/params.json", `${owner}/s05/params.json`),
    await inputRef(root, "s04/bgm.json", `${owner}/s04/bgm.json`),
    await inputRef(root, "s04/pick.json", `${owner}/s04/pick.json`),
    await inputRef(root, "video", job.video_path),
  ];
  await finishStep(root, owner, "s05", inputs, ["final.mp4", "package.zip", "clip.srt", "kept.json"]);

  const audioNote = bgmPath ? `，BGM ${eff!.bgm.mood}/${eff!.track.title}` : hasAudio ? "" : "，源片无音轨";
  const subNote = burn ? `，字幕 ${cues.length} 条已烧录` : "，字幕未烧录（仅出 clip.srt）";
  return `成片 ${total.toFixed(1)}s（${ranges.length} 段 / 保留 ${kept.length} 句${subNote}${audioNote}）`;
}
