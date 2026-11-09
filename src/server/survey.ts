// survey：扫描 work/ 现算三态（b43 只存事实其余派生；b35 stale+suspect 双态；b28 递归传播）
// 判定口径（严格按此顺序短路，见 stepRawState）：
//   empty   无 step.json
//   error   step.json 记了 error 事实
//   stale   step.json 记录的输入指纹 与 当前重算不符（上游变了 / 输入文件没了）
//   missing step.json 在，但 STEPS[].artifacts 契约产物有缺失（P1-4：产物被删/被隔离）
//   suspect 自身输入指纹仍符，但强依赖里有 stale/suspect/missing（上游变了、影响未定）
//   ready   指纹全符、契约产物齐备、且依赖干净
// 只标脏、不自动跑（b27）；待办条与三态同源（b5），只列事实不估时长（b39）。
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { STEP_BY_ID, stepsFor } from "../shared/steps.ts";
import type {
  ClipFile,
  ClipSurvey,
  JobFile,
  JobSurvey,
  LazyDep,
  StepFile,
  StepState,
  StepStatus,
  Survey,
  TodoItem,
} from "../shared/types.ts";
import { fingerprint, resolveInputPath } from "./fingerprint.ts";
import { readCard } from "./jobcard.ts";

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

// 契约产物齐备性检查（P1-4）。返回第一个缺失的产物名；全在则返回 null。
// 判据取 STEPS[].artifacts（契约），**不取** step.json.outputs（事实登记）——
// outputs 是跨模式并集累积的「实际产出过什么」，含可选产物：s03 跑过 draft 后它里面就有 ai.json，
// 拿它当「必须有」会在 ai.json 被删时误报（S03View.ai === null 本是合法态）。
// 注册表里没有的步返回 null（不猜、不拦）：lazyDeps 的取值必然来自注册表，未知步属数据错误。
async function artifactsMissing(ownerDir: string, stepId: string): Promise<string | null> {
  const spec = STEP_BY_ID.get(stepId);
  if (!spec) return null;
  for (const name of spec.artifacts) {
    try {
      if (!(await stat(path.join(ownerDir, stepId, name))).isFile()) return name;
    } catch {
      return name;
    }
  }
  return null;
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
    const now = await fingerprint(resolveInputPath(workRoot, input.path));
    // 缺席有两种写法，必须当成同一回事：
    //   fingerprint() 对缺失文件返回 null；
    //   inputRef 在登记时文件还不存在，落盘的是空串（「以后出现才算变」）。
    // 若拿 null !== "" 当不符，s04 的 LLM 路（不写 params.json）一跑完就假 stale，
    // s05 又把 s04 当强依赖，出片按钮会被关掉。
    const absent = (v: string | null): boolean => v === null || v === "";
    if (absent(now) && absent(input.fingerprint)) continue;
    if (now !== input.fingerprint) {
      // 指纹为 null 表示文件根本不在了（fingerprint 对缺失/非文件返回 null）。
      // 报「输入已变」会把用户引向「上游为什么改了」，而实际是他自己删了文件——归因不准（P1-4）。
      return {
        status: "stale",
        reason: now === null ? `输入已丢失：${input.key}` : `输入已变：${input.key}`,
      };
    }
  }
  const missing = await artifactsMissing(ownerDir, stepId);
  if (missing) return { status: "missing", reason: `缺少 ${missing}` };
  return { status: "ready", reason: null };
}

// 惰性依赖的判据（b23）：契约产物都在，就算「能用」。
// 刻意不看 status：status 的 ready/stale 说的是新鲜度，而惰性依赖要问的是可用性。
// 上游一改（s02 → stale）不等于产物消失——vocals.wav 还能听，此时禁用试听区是错的。
// 判据与 stepRawState 同源（P1-4 之前是分叉的：那边什么都不看、这边看 outputs）：
// 两处都问「STEPS[].artifacts 在不在」，于是可选产物（s03 的 ai.json）删了不影响任何一处。
// step.json 记了 error 说明这一步没跑成，即便文件凑巧在也不算可用。
async function outputsAvailable(ownerDir: string, stepId: string): Promise<boolean> {
  const stepFile = await readJson<StepFile>(path.join(ownerDir, stepId, "step.json"));
  if (!stepFile || stepFile.error) return false;
  return (await artifactsMissing(ownerDir, stepId)) === null;
}

// 本步目录下确实存在的产物名。取「契约产物 ∪ step.json.outputs」再逐个 stat——
// 与媒体出口的白名单同源（出口查 outputs 含不含 + 文件在不在），所以界面显示「可试听」而接口 404 的情况不会出现。
async function presentFiles(ownerDir: string, stepId: string, stepFile: StepFile | null): Promise<string[]> {
  const spec = STEP_BY_ID.get(stepId);
  const names = [...new Set([...(spec?.artifacts ?? []), ...(stepFile?.outputs ?? [])])];
  const out: string[] = [];
  for (const n of names) {
    if (n.includes("/") || n.includes("\\")) continue; // 只认本步目录下的文件
    try {
      if ((await stat(path.join(ownerDir, stepId, n))).isFile()) out.push(n);
    } catch {
      // 不在就是不在——不猜、不补
    }
  }
  return out;
}

async function lazyDepsOf(ownerDir: string, depIds: string[]): Promise<LazyDep[] | undefined> {
  if (depIds.length === 0) return undefined;
  const out: LazyDep[] = [];
  for (const depId of depIds) {
    out.push({
      step: depId,
      title: STEP_BY_ID.get(depId)?.title ?? depId,
      available: await outputsAvailable(ownerDir, depId),
    });
  }
  return out;
}

// 传播：自身 ready 但强依赖含 stale/suspect/missing → suspect，递归到底（b28）
function propagate(
  states: Map<string, StepState>,
  depsOf: (stepId: string) => string[],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, st] of states) {
      if (st.status !== "ready") continue;
      // missing 进触发集（P1-4）：上游产物丢了，本步的输入必然也没了，不能当它干净。
      // 这里只改写 status === "ready" 的步，所以已经 missing 的步不会被盖成 suspect——
      // missing 比「影响未定」更具体，不该被降级成后者。
      let dirty: { id: string; status: StepStatus } | null = null;
      for (const d of depsOf(id)) {
        const ds = states.get(d);
        if (ds && (ds.status === "stale" || ds.status === "suspect" || ds.status === "missing")) {
          dirty = { id: d, status: ds.status };
          break;
        }
      }
      if (dirty) {
        st.status = "suspect";
        st.reason = dirty.status === "missing"
          ? `上游 ${dirty.id} 产物已丢失，影响未定`
          : `上游 ${dirty.id} 已变，影响未定`;
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
    const lazy = await lazyDepsOf(ownerDir, spec.lazyDeps);
    const stepFile = await readJson<StepFile>(path.join(ownerDir, spec.id, "step.json"));
    states.set(spec.id, {
      step: spec.id,
      title: spec.title,
      status: raw.status,
      reason: raw.reason,
      deps: spec.deps,
      present: await presentFiles(ownerDir, spec.id, stepFile),
      ...(lazy ? { lazy } : {}),
    });
  }
  // 注意：lazyDeps 刻意不进 propagate——惰性依赖不阻塞（b23），上游脏不把本步标 suspect。
  propagate(states, (id) => specs.find((s) => s.id === id)?.deps ?? []);
  return specs.map((s) => states.get(s.id)!);
}

export async function survey(root: string): Promise<Survey> {
  const workRoot = path.join(root, "work");
  const jobs: JobSurvey[] = [];
  const clips: ClipSurvey[] = [];
  const todo: TodoItem[] = [];

  const archivedJobs = new Set<string>();
  for (const jobId of await listDirs(path.join(workRoot, "jobs"))) {
    const dir = path.join(workRoot, "jobs", jobId);
    const job = await readJson<JobFile>(path.join(dir, "job.json"));
    if (!job) continue; // 外来目录不猜（b38：显式收养另行触发）
    const card = await readCard(dir);
    const steps = await surveyOwner(workRoot, dir, "job");
    jobs.push({ id: job.id, video_path: job.video_path, title: card.title, archived: card.archived, steps });
    if (card.archived) archivedJobs.add(job.id);
    else collectTodo(todo, job.id, steps);
  }

  for (const clipId of await listDirs(path.join(workRoot, "clips"))) {
    const dir = path.join(workRoot, "clips", clipId);
    const clip = await readJson<ClipFile>(path.join(dir, "clip.json"));
    if (!clip) continue;
    const steps = await surveyOwner(workRoot, dir, "clip");
    clips.push({ id: clip.id, job_id: clip.job_id, title: clip.title, start: clip.start, end: clip.end, steps });
    // 任务归档后，它的片段也不再催待办；文件还在，恢复任务就回来
    if (!archivedJobs.has(clip.job_id)) collectTodo(todo, clip.id, steps);
  }

  if (jobs.length === 0) {
    todo.push({ text: "还没有任务——放入一个视频开始", owner: "-", step: null, kind: "empty" });
  }
  return { jobs, clips, todo };
}

// 待办条只回答「现在该干什么」（b5），所以异常优先于「未跑」：
// 先收全部 error/stale/missing（它们说明有东西坏了、过期了或丢了，必须被看见），
// 一条异常都没有时，才提示最靠前的未跑步——只提一条，不刷屏。
// 为什么不能边走边 break（P3-1）：steps 是有序的，排在前面的未跑步会把
// 排在后面的 error/stale 挡在待办条外，而卡片视图照样能看见 → 两处视图不一致。
function collectTodo(todo: TodoItem[], owner: string, steps: StepState[]): void {
  const before = todo.length;
  for (const st of steps) {
    if (st.status === "error") {
      todo.push({ text: `${st.title} 出错：${st.reason ?? "未知原因"}`, owner, step: st.step, kind: "error" });
    } else if (st.status === "stale") {
      todo.push({ text: `${st.title} 待重跑（${st.reason ?? "上游已变"}）`, owner, step: st.step, kind: "stale" });
    } else if (st.status === "missing") {
      // 产物丢失比「上游已变」更硬：文件不在了，本步与它的下游都不可用（P1-4）。
      // 单列一类而不并进 stale，是为了让文案指向「东西没了」而不是「东西变了」。
      todo.push({ text: `${st.title} 产物丢失，需重跑（${st.reason ?? "产物缺失"}）`, owner, step: st.step, kind: "missing" });
    }
  }
  if (todo.length > before) return; // 本 owner 已有条目，不再提示「未跑」
  const first = steps.find((s) => s.status === "empty");
  if (first) todo.push({ text: `${first.title} 未跑`, owner, step: first.step, kind: "empty" });
}
