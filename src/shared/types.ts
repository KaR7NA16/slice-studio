// 工作文件类型（前后端共享；A 方案兑现：TS 类型即真相，无 OpenAPI 生成环节）
// 口径：step.json 只存事实（b43）；ready/stale/suspect 全部由 survey 现算，不落盘。

export interface JobFile {
  schema: 1;
  id: string;
  video_path: string;
  srt_path: string | null;
  created_at: string;
}

export interface ClipFile {
  schema: 1;
  id: string;
  job_id: string;
  title: string;
  start: number; // float 秒（b40）
  end: number;
  fps: string | null; // 分数原值，如 "30000/1001"（b50b/b51b：建 clip 探测一次）
  // 该片段的自动化档位覆盖（b3/b4：全局默认 + 单条覆盖）。只记被覆盖的步；缺省不写此键。
  automation?: AutomationSettings;
}

// step.json：一步跑完留下的事实
export interface StepInputRef {
  key: string; // 输入名（如 "job.json" / "s00/job.srt"）
  path: string; // 相对 work/ 的路径；源视频在工作区外时是绝对路径
  fingerprint: string; // 写入时的内容指纹
}

export interface StepFile {
  schema: 1;
  step: string;
  finished_at: string;
  inputs: StepInputRef[];
  outputs: string[]; // 相对本步目录的产物名
  error?: string; // 失败事实（b59：界面据实呈现）
  // 主干变体（b8「选中成主干、落选作侧枝」）：指向 variants/<id>.json。
  // 只对**有 AI 抽卡**的步有意义（s01/s03/s04）；人工路径的步永远为 null。
  // 它记录的是「哪一版 AI 产物当前生效」——是事实，不是派生状态。
  active_variant?: string | null;
}

// ---- survey 读模型（现算，不落盘） ----

// 判定次序（survey.stepRawState 严格按此短路；类型书写顺序即判定顺序）：
//   empty → error → stale → missing → ready
// missing 排在 stale 之后是刻意的：输入指纹都不符了，本步本来就不算「已完成」，
// 不存在说谎问题，先报更靠上游的原因；missing 只补在原本会误判 ready 的那条路上。
// 语义：missing = step.json 在（这一步确实跑过）但 STEPS[].artifacts 契约产物有缺失。
// 不并入 error（这一步是成功过的）、不并入 empty（step.json 还在，说「未跑」是撒谎）。
export type StepStatus = "empty" | "error" | "stale" | "missing" | "ready" | "suspect";

// 惰性依赖的就绪情况（b23/b59）：只回答「有没有能用的产物」，不参与 stale 传播、不阻塞。
// 判据与 status **刻意不同源**：status 问「新鲜不新鲜」，lazy 问「能不能用」。
// 若拿 status === "ready" 当 available，上游一改就把试听区禁掉——可 vocals.wav 还在磁盘上、
// 照样能听，只是可能过期（过期该由 status 亮出来，不该让按钮消失）。
export interface LazyDep {
  step: string;
  title: string;
  available: boolean; // STEPS[].artifacts 契约产物全部存在（**不是** step.json.outputs——那是事实登记，含可选产物）
}

export interface StepState {
  step: string;
  title: string;
  status: StepStatus;
  reason: string | null; // 状态原因（界面直接展示，不猜）
  // 强依赖的步 id（来自 STEPS[].deps）。下发它是为了让界面算「能不能跑」时**不自己再抄一份依赖表**——
  // 抄一份就是第二个真相源，注册表改了前端不改，界面就会允许跑一个必然失败的步。
  deps: string[];
  // 本步目录下**确实存在**的产物名（契约产物 ∪ step.json.outputs 里文件真在的那些）。
  // 下发它是为了让界面只对真能取到的文件渲染「试听 / 下载」——
  // 否则按钮会指向一个 404，而界面显示得像能用（判据与媒体出口白名单同源）。
  present: string[];
  lazy?: LazyDep[]; // 仅声明了 lazyDeps 的步有（现算不落盘）
}

export interface JobSurvey {
  id: string;
  video_path: string;
  title: string; // 显示名，空则界面用视频文件名。存在 card.json，不进 job.json（避免改名把 s00/s02 标脏）
  archived: boolean; // 归档后留在磁盘，从待办和「进行中」里拿掉，可以恢复
  steps: StepState[]; // job 级步骤
}

export interface ClipSurvey {
  id: string;
  job_id: string;
  title: string;
  start: number; // float 秒（b40）
  end: number;
  steps: StepState[]; // clip 级步骤
}

export interface TodoItem {
  text: string; // 待办条只回答「现在该干什么」（b5），只列事实不估时长（b39）
  owner: string; // job id 或 clip id
  step: string | null;
  // 来源判据，供界面配色/配图标。此前界面靠嗅探 text（includes("出错") / includes("待重跑")）
  // 决定样式，新增 missing 一类后这个模式会静默失效（新文案不含旧关键词），改为直接传判据本身。
  kind: "error" | "stale" | "missing" | "empty";
}

export interface Survey {
  jobs: JobSurvey[];
  clips: ClipSurvey[];
  todo: TodoItem[];
}

// ---- 句子事实（s00 解析 / s03 句级输出，b21；b40 float 秒） ----

export interface Sentence {
  id: string; // 在 job 字幕内的序号，s00 重解析前稳定，覆盖层按它键控
  start: number;
  end: number;
  text: string;
}

export interface SentencesFile {
  schema: 1;
  sentences: Sentence[];
}

// s01 候选 = 人工定稿事实（b1 默认人工）：建片段即定稿一条候选。
// AI 抽卡出的提案**不写这里**——按 b29/b46「AI 产物与人工判断分文件存放」放 s01/ai.json，
// 否则重跑一次 AI 就把人工定稿的清单抹了。契约产物是这份（定稿），AI 提案是可选产物。
export interface CandidatesFile {
  schema: 1;
  source: "human";
  clips: { clip_id: string; title: string; start: number; end: number; created_at: string }[];
}

// s01 的 AI 抽卡产物（可选）：LLM 从 s00 句流里挑出的高光区间提案。
// 采纳方式 = 用候选建片段（前端点一下就走 POST /api/clips），不在这里回写。
export interface HighlightCandidate {
  id: string;
  title: string;
  start: number;
  end: number;
  reason: string;
}

export interface S01AiFile {
  schema: 1;
  model: string;
  at: string;
  candidates: HighlightCandidate[];
}

// ---- 变体（b26「变体存各步 variants/」+ b7/b8 抽卡多版 / 主干侧枝） ----
// 一次 AI 抽卡 = 一个变体。落 `<step>/variants/<id>.json`，与正式产物分开存：
// 正式产物是「当前生效的那一版」（切主干时由变体物化而来），变体目录是全部存档。
// 这样「切回任一侧枝」就是一次物化，不需要重跑 AI（b8 判据：界面能切回任一侧枝）。

export interface VariantMeta {
  id: string; // 步内唯一，v1/v2…（按创建序递增）
  step: string;
  created_at: string;
  model: string | null; // 人工路径的变体为 null
  label: string; // 一行摘要，界面直接显示（不猜）
  // 分叉树的边：创建这一版时，上游 AI 步的生效变体是哪个（形如 "s01/v2"）。
  // 没有上游 AI 步时为 null。有了它，「每版的后续步骤选择」才串得成树（b7）。
  parent: string | null;
}

export interface VariantFile {
  schema: 1;
  meta: VariantMeta;
  payload: unknown; // 该次 AI 产物的原文（形态随步而定）
}

// 分叉树视图（b7/b8）：按步分组，每步列出全部变体并标出哪一个是主干。
export interface VariantsView {
  owner: string;
  steps: {
    step: string;
    title: string;
    active: string | null;
    variants: VariantMeta[];
  }[];
}

// ---- 自动化档位（b3/b4：每步独立开关；全局默认 + 单条覆盖） ----
// 存两份：config.json 的 automation = 全局默认（按步）；automation.json = 该片段的覆盖。
// clip.json 上的 automation 只是旧文件还没搬走时的读法。
// 只记被显式设置过的步，缺省一律「人工」（b5/b6「默认人工」）。
// 生效值 = 覆盖 ?? 全局 ?? 人工。分开存是为了让「改了全局」能立刻反映到所有没覆盖的片段上。

export type AutomationLevel = "manual" | "auto";
export type AutomationSettings = Record<string, AutomationLevel>;

export interface AutomationView {
  effective: AutomationSettings; // 该 owner 实际生效的档位（每步都有值）
  global: AutomationSettings; // config.json 里的全局默认（只含显式设置过的）
  override: AutomationSettings; // 该片段的覆盖（只含显式设置过的）
}

// ---- 重跑预览（b39：重跑前不估时长，只列将动哪些文件） ----

export interface RunPreview {
  owner: string;
  step: string;
  title: string;
  writes: string[]; // 将写入/覆盖的路径（相对 work/）
  marks_stale: { owner: string; step: string; title: string }[]; // 重跑后会被标脏的下游（当前 ready/suspect 的）
  warnings: string[]; // 例如「未配 LLM」「s04 未跑，成片将不带 BGM」
}

// ---- s03：AI 初稿 与 人工覆盖层（b29/b46：分离存放，重跑 AI 不丢人工） ----

export interface AiDraftFile {
  schema: 1;
  model: string;
  at: string;
  decisions: { id: string; keep: boolean; reason: string }[];
}

export interface OverlayFile {
  schema: 1;
  decisions: Record<string, { keep: boolean; at: string }>;
}

// 合并读模型（现算不落盘）：人工 > AI > 默认保留
export interface MergedSentence extends Sentence {
  keep: boolean;
  source: "human" | "ai" | "default";
  reason: string | null; // AI 给的理由（人工改判后仍留作上下文）
}

export interface S03View {
  clip: ClipFile;
  sentences: MergedSentence[];
  orphans: string[]; // 已对不上句子的键（人工覆盖层 + AI 决策两侧都收；s00 重解析后可能出现），据实亮出
  ai: { model: string; at: string } | null;
}

// ---- s04：配乐（b51a/b50c：**mood 值域 = 曲库动态注入**；规则优先，LLM 兜底） ----

// 本步的渲染参数（b22「渲染参数严格按步切，连 bgm_mood」）：放在**本步目录**下，
// s04 只认自己的键、不读别步的参数；文件不存在 = 未指定（走 LLM 兜底）。
export interface S04Params {
  schema: 1;
  bgm_mood: string | null;
}

// 配乐产物。`mood` 一定落在「曲库现算出的分组」里——**越界直接报错，不回退到默认组**。
// 不回退的理由：曲库换血后旧 mood 会失效，回退等于把「你的配置已经不适用了」藏起来，
// 用户拿到风格不对的曲子还不知道为什么（b50c 的判据正是「曲库换血后候选自动更新」）。
export interface BgmFile {
  schema: 1;
  mood: string;
  source: "human" | "llm"; // 这个 mood 是人工指定的，还是 LLM 按内容挑的
  reason: string | null; // source=llm 时的理由
  track: { id: string; title: string; path: string; bytes: number };
  candidates: number; // 该 mood 组下共几首（界面展示「33 首里选了这首」用）
  at: string;
}

// ---- s04 工作空间：人工换曲覆盖层 + 曲库分组 ----
//
// 人工换曲与 s03 的人工删留同源（b29/b46）：写**单独的文件** pick.json，不改 s04 的 bgm.json。
// 生效曲目 = pick ?? bgm.track，只在服务端的 effectiveBgm 里算一次（s05 与界面共用）。
export interface BgmPick {
  schema: 1;
  track_id: string;
  at: string;
}

export interface S04View {
  bgm: BgmFile | null; // s04 产物（界面要显示它的 mood 与理由）
  pick: BgmPick | null; // 人工换曲（可能指向一首已不在曲库的曲子）
  track: BgmFile["track"] | null; // 生效曲目
  track_source: "human" | "ai" | null; // 生效曲目来自人工还是 s04
  missing_pick: boolean; // pick 指向的曲子已不在曲库（曲库换血）——必须亮出来，不许静默回落
  groups: { group: string; tracks: { id: string; title: string; bytes: number }[] }[];
  total: number; // 曲库里 bgm 总数（b33/b34：全部可列出、可播）
  bgm_mood: string | null; // 人工指定的风格；null = 没写 params，跑 s04 时走 LLM 兜底
  moods: string[]; // 曲库现算的值域，界面只许从这里挑
}

// s05 的渲染参数（b22「渲染参数严格按步切」）：放本步目录下，只认自己的键。
// burn_subtitles 默认 true（用户拍板的顺序：最小成片 → 叠字幕 → 叠 BGM，字幕这一档要真烧进去）。
// 烧录只影响**画面**，不影响 clip.srt 出口——两个出口并列（b24），字幕在包里照样有。
export interface S05Params {
  schema: 1;
  burn_subtitles: boolean;
}

// ---- run 记录（b53 触发 + 心跳：updated_at 即心跳，失联由读侧现算，不落盘） ----

export interface RunRecord {
  id: string;
  owner: string; // "jobs/<id>" | "clips/<id>"
  step: string;
  mode: string | null;
  status: "running" | "done" | "error";
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  message: string;
  error: string | null;
}

// ---- 创建请求 ----

export interface NewJob {
  video_path: string;
  srt_path: string | null;
}

export interface NewClip {
  job_id: string;
  title: string;
  start: number;
  end: number;
}

// ---- 素材库（data/library.json，b33） ----

export interface LibraryItem {
  id: string;
  kind: string;
  group: string | null;
  title: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface Library {
  schema: 1;
  source_root: string;
  items: LibraryItem[];
}

// ---- LLM 配置（config.json 的 llm 块；多配置档） ----
// 存储：llm.profiles[] + default_id。旧版单块 {base_url, api_key, model} 读取时自动升级为单档。
// 协议：只走 OpenAI 兼容单通路（{base_url}/chat/completions 与 {base_url}/models），无 provider 分支。
// 密钥纪律：api_key 明文只存在于数据根 config.json 与调用它的子进程内存；
//           HTTP 只回 key_hint（尾 4 位掩码），明文永不出服务端进程。

export interface LlmProfile {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
}

export interface LlmConfig {
  profiles: LlmProfile[];
  default_id: string | null;
}

// 调用侧需要的三要素：服务端解析「默认档」后的结果，steps/llm.ts 用它发请求。
// 与 LlmProfile 分开，是为了让调用点拿不到 id/name 这类配置管理概念。
export interface LlmCall {
  base_url: string;
  api_key: string;
  model: string;
}

// 非敏感视图：api_key 换成 key_hint
export interface LlmProfileView {
  id: string;
  name: string;
  base_url: string;
  model: string;
  key_hint: string; // "••••abcd"；未存 key 时为空串
  configured: boolean; // base_url + model 齐全就能跑；免密钥接口的 api_key 可以是空的
}

export interface LlmView {
  profiles: LlmProfileView[];
  default_id: string | null;
  ok: boolean; // 默认档可用
  model: string | null; // 默认档的 model（ok=true 时非空）——「AI 出初稿」按钮直接显示它
  reason: string | null; // ok=false 的原因（界面直接展示，不猜）
}

// PUT /api/llm 入参：全量列表，一次替换（避免「改了一半」的中间态）。
// api_key 空串 = 保持该档原有密钥不变——防「掩码回显 → 保存 → key 被写成掩码」。
// 要清空某档密钥就删掉该档（不做「清空但保留」这种半状态）。
export interface LlmSaveProfile {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
}

export interface LlmSave {
  profiles: LlmSaveProfile[];
  default_id: string | null;
}
