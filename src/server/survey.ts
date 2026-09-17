// survey：扫描 work/ 现算三态（b43 只存事实其余派生；b35 stale+suspect 双态；b28 递归传播）
// 判定口径：
//   empty   无 step.json
//   error   step.json 记了 error 事实
//   stale   step.json 记录的输入指纹 与 当前重算不符（上游变了）
//   suspect 自身输入指纹仍符，但强依赖里有 stale/suspect（上游变了、影响未定）
//   ready   指纹全符且依赖干净
// 只标脏、不自动跑（b27）；待办条与三态同源（b5），只列事实不估时长（b39）。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { stepsFor } from "../shared/steps.ts";
import type {
  ClipFile,
  ClipSurvey,
  JobFile,
  JobSurvey,
  StepFile,
  StepState,
  StepStatus,
  Survey,
  TodoItem,
} from "../shared/types.ts";
import { fingerprint } from "./fingerprint.ts";

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// 算一个 owner（job 或 clip 目录）下某步的原始状态（不含传播）
async function stepRawState(
  workRoot: string,
  ownerDir: string,
  stepId: string,
): Promise<{ status: StepStatus; reason: string | null }> {
  const stepFile = await readJson<StepFile>(path.join(ownerDir, stepId, "step.json"));
  if (!stepFile) return { status: "empty", reason: null };
  if (stepFile.error) return { status: "error", reason: stepFile.error };
  for (const input of stepFile.inputs ?? []) {
    const now = await fingerprint(path.join(workRoot, input.path));
    if (now !== input.fingerprint) {
      return { status: "stale", reason: `输入已变：${input.key}` };
    }
  }
  return { status: "ready", reason: null };
}

// 传播：自身 ready 但强依赖含 stale/suspect → suspect，递归到底（b28）
function propagate(
  states: Map<string, StepState>,
  depsOf: (stepId: string) => string[],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, st] of states) {
      if (st.status !== "ready") continue;
      const dirty = depsOf(id).find((d) => {
        const ds = states.get(d);
        return ds && (ds.status === "stale" || ds.status === "suspect");
      });
      if (dirty) {
        st.status = "suspect";
        st.reason = `上游 ${dirty} 已变，影响未定`;
        changed = true;
      }
    }
  }
}

async function surveyOwner(
  workRoot: string,
  ownerDir: string,
  level: "job" | "clip",
): Promise<StepState[]> {
  const specs = stepsFor(level);
  const states = new Map<string, StepState>();
  for (const spec of specs) {
    const raw = await stepRawState(workRoot, ownerDir, spec.id);
    states.set(spec.id, { step: spec.id, title: spec.title, status: raw.status, reason: raw.reason });
  }
  propagate(states, (id) => specs.find((s) => s.id === id)?.deps ?? []);
  return specs.map((s) => states.get(s.id)!);
}

export async function survey(root: string): Promise<Survey> {
  const workRoot = path.join(root, "work");
  const jobs: JobSurvey[] = [];
  const clips: ClipSurvey[] = [];
  const todo: TodoItem[] = [];

  for (const jobId of await listDirs(path.join(workRoot, "jobs"))) {
    const dir = path.join(workRoot, "jobs", jobId);
    const job = await readJson<JobFile>(path.join(dir, "job.json"));
    if (!job) continue; // 外来目录不猜（b38：显式收养另行触发）
    const steps = await surveyOwner(workRoot, dir, "job");
    jobs.push({ id: job.id, video_path: job.video_path, steps });
    collectTodo(todo, job.id, steps);
  }

  for (const clipId of await listDirs(path.join(workRoot, "clips"))) {
    const dir = path.join(workRoot, "clips", clipId);
    const clip = await readJson<ClipFile>(path.join(dir, "clip.json"));
    if (!clip) continue;
    const steps = await surveyOwner(workRoot, dir, "clip");
    clips.push({ id: clip.id, job_id: clip.job_id, title: clip.title, steps });
    collectTodo(todo, clip.id, steps);
  }

  if (jobs.length === 0) {
    todo.push({ text: "还没有任务——放入一个视频开始", owner: "-", step: null });
  }
  return { jobs, clips, todo };
}

function collectTodo(todo: TodoItem[], owner: string, steps: StepState[]): void {
  for (const st of steps) {
    if (st.status === "error") {
      todo.push({ text: `${st.title} 出错：${st.reason ?? "未知原因"}`, owner, step: st.step });
    } else if (st.status === "stale") {
      todo.push({ text: `${st.title} 待重跑（${st.reason ?? "上游已变"}）`, owner, step: st.step });
    } else if (st.status === "empty") {
      // 只提最靠前的未跑步，不刷屏
      todo.push({ text: `${st.title} 未跑`, owner, step: st.step });
      break;
    }
  }
}
