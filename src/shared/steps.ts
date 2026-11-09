// 六步注册表（规划 §1 链路表的唯一真相源，前后端共享）
// 依赖边用于 stale 递归传播（b28）；lazyDeps = 惰性依赖（b23：s03 对 s02 vocals 按需）
export type StepLevel = "job" | "clip";

export interface StepSpec {
  id: string;
  title: string;
  level: StepLevel;
  // 契约产物：这一步跑完**必须存在**的文件，缺一即 missing（P1-4）。
  // 与 step.json.outputs 的区别是这条字段的全部意义——outputs 是「实际产出过什么」的并集登记
  // （跨模式累积、含可选产物，如 s03 的 ai.json），artifacts 是「必须有什么」的契约。
  // 拿事实当契约是范畴错误：会因可选产物被删而误报（S03View.ai === null 本是合法态）。
  artifacts: string[];
  deps: string[]; // 强依赖的步骤 id
  lazyDeps: string[]; // 惰性依赖：未就绪时界面禁用+原因+入口（b59），不阻塞
  // AI 抽卡产物名（b26/b7/b8）。非空 = 这一步能「抽卡多版」，变体物化后写的就是这个文件。
  // 空 = 这一步没有 AI 产物（人工路径或纯计算），也就没有主干/侧枝可言。
  aiArtifact?: string;
}

export const STEPS: StepSpec[] = [
  { id: "s00", title: "字幕", level: "job", artifacts: ["sentences.json", "job.srt"], deps: [], lazyDeps: [] },
  { id: "s01", title: "选高光", level: "job", artifacts: ["candidates.json"], deps: ["s00"], lazyDeps: [], aiArtifact: "ai.json" },
  // s05 是 **b24 两出口并列**：成片（final.mp4）+ 素材包（package.zip）——两个都是必需产物，
  // 少任何一个都算 missing（只出一个出口等于没兑现「两出口并列」）。clip.srt / kept.json 是包内件，
  // 落步目录只为便于单独下载，**不进契约**（它们是可选产物，删了不影响成片可用）。
  { id: "s02", title: "人声分离", level: "clip", artifacts: ["vocals.wav", "no_vocals.wav"], deps: [], lazyDeps: [] },
  // s03 只列 sentences.json：ai.json 是**可选**产物（不跑 AI 初稿就没有），列进去会误报。
  { id: "s03", title: "逐句删留", level: "clip", artifacts: ["sentences.json"], deps: [], lazyDeps: ["s02"], aiArtifact: "ai.json" },
  // s04 的 aiArtifact = bgm.json：LLM 兜底路产出的就是最终配乐产物（没有「提案」与「定稿」之分），
  // 所以它的变体物化直接写 bgm.json。规则路（人工指定 mood）不产变体。
  { id: "s04", title: "配乐", level: "clip", artifacts: ["bgm.json"], deps: ["s03"], lazyDeps: [], aiArtifact: "bgm.json" },
  { id: "s05", title: "成片", level: "clip", artifacts: ["final.mp4", "package.zip"], deps: ["s02", "s03", "s04"], lazyDeps: [] },
];

export const STEP_BY_ID: ReadonlyMap<string, StepSpec> = new Map(STEPS.map((s) => [s.id, s]));

export function stepsFor(level: StepLevel): StepSpec[] {
  return STEPS.filter((s) => s.level === level);
}
