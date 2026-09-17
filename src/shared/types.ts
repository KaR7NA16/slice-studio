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
