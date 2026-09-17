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
}

// step.json：一步跑完留下的事实
export interface StepInputRef {
  key: string; // 输入名（如 "job.json" / "s00/job.srt"）
  path: string; // 相对 work/ 根的路径
  fingerprint: string; // 写入时的内容指纹
}

export interface StepFile {
  schema: 1;
  step: string;
  finished_at: string;
  inputs: StepInputRef[];
  outputs: string[]; // 相对本步目录的产物名
  error?: string; // 失败事实（b59：界面据实呈现）
}

// ---- survey 读模型（现算，不落盘） ----

export type StepStatus = "empty" | "ready" | "stale" | "suspect" | "error";

export interface StepState {
  step: string;
  title: string;
  status: StepStatus;
  reason: string | null; // 状态原因（界面直接展示，不猜）
}

export interface JobSurvey {
  id: string;
  video_path: string;
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

// s01 候选 = 人工定稿事实（b1 默认人工；AI 候选属阶段 3）
export interface CandidatesFile {
  schema: 1;
  source: "human";
  clips: { clip_id: string; title: string; start: number; end: number; created_at: string }[];
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
