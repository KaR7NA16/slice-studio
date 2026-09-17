// 六步注册表（规划 §1 链路表的唯一真相源，前后端共享）
// 依赖边用于 stale 递归传播（b28）；lazyDeps = 惰性依赖（b23：s03 对 s02 vocals 按需）
export type StepLevel = "job" | "clip";

export interface StepSpec {
  id: string;
  title: string;
  level: StepLevel;
  artifact: string; // 主产物文件名（展示用）
  deps: string[]; // 强依赖的步骤 id
  lazyDeps: string[]; // 惰性依赖：未就绪时界面禁用+原因+入口（b59），不阻塞
}

export const STEPS: StepSpec[] = [
  { id: "s00", title: "字幕", level: "job", artifact: "job.srt", deps: [], lazyDeps: [] },
  { id: "s01", title: "选高光", level: "job", artifact: "candidates.json", deps: ["s00"], lazyDeps: [] },
  { id: "s02", title: "人声分离", level: "clip", artifact: "vocals.wav", deps: [], lazyDeps: [] },
  { id: "s03", title: "逐句删留", level: "clip", artifact: "sentences.json", deps: [], lazyDeps: ["s02"] },
  { id: "s04", title: "配乐", level: "clip", artifact: "bgm.json", deps: ["s03"], lazyDeps: [] },
  { id: "s05", title: "成片", level: "clip", artifact: "final.mp4", deps: ["s02", "s03", "s04"], lazyDeps: [] },
];

export const STEP_BY_ID: ReadonlyMap<string, StepSpec> = new Map(STEPS.map((s) => [s.id, s]));

export function stepsFor(level: StepLevel): StepSpec[] {
  return STEPS.filter((s) => s.level === level);
}
