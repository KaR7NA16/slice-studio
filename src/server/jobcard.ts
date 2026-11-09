// 任务名片：显示名和归档标记。单独放 card.json，不写进 job.json。
// s00 / s02 把 job.json 登记进输入指纹，改那个文件会把已跑完的步标脏。
// 删除只挪走任务目录和属于它的片段目录，不碰源视频。
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ClipFile, JobFile } from "../shared/types.ts";
import { readJson, writeJsonAtomic } from "./jsonfile.ts";

export interface JobCardFile {
  schema: 1;
  title: string;
  archived: boolean;
}

const EMPTY: JobCardFile = { schema: 1, title: "", archived: false };

// owner 必须是 jobs/<id> 或 clips/<id> 这一个路径段。多出来的斜杠或 .. 会让 path.join 走出 work/。
export function safeOwner(owner: string): string | null {
  const m = /^(jobs|clips)\/([^/]+)$/.exec(owner);
  if (!m) return null;
  const id = m[2]!;
  if (!id || id.includes("\\") || id.includes("..") || id !== path.basename(id)) return null;
  return `${m[1]}/${id}`;
}

export function safeJobId(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id !== path.basename(id)) return null;
  return id;
}

export async function readCard(jobDir: string): Promise<JobCardFile> {
  const card = await readJson<JobCardFile>(path.join(jobDir, "card.json"));
  if (!card || card.schema !== 1) return { ...EMPTY };
  return {
    schema: 1,
    title: typeof card.title === "string" ? card.title : "",
    archived: card.archived === true,
  };
}

export async function updateCard(
  root: string,
  id: string,
  patch: { title?: string; archived?: boolean },
): Promise<JobCardFile> {
  const dir = path.join(root, "work", "jobs", id);
  const job = await readJson<JobFile>(path.join(dir, "job.json"));
  if (!job) throw new Error(`任务不存在：${id}`);
  const cur = await readCard(dir);
  if (typeof patch.title === "string") cur.title = patch.title.trim().slice(0, 80);
  if (typeof patch.archived === "boolean") cur.archived = patch.archived;
  await writeJsonAtomic(path.join(dir, "card.json"), cur);
  return cur;
}

export async function removeJob(root: string, id: string): Promise<{ id: string; removed_clips: string[] }> {
  const dir = path.join(root, "work", "jobs", id);
  const job = await readJson<JobFile>(path.join(dir, "job.json"));
  if (!job) throw new Error(`任务不存在：${id}`);
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(path.join(root, "work", "clips"));
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name.includes("..") || name !== path.basename(name)) continue;
    const clipDir = path.join(root, "work", "clips", name);
    const clip = await readJson<ClipFile>(path.join(clipDir, "clip.json"));
    if (clip?.job_id !== id) continue;
    await rm(clipDir, { recursive: true, force: true });
    removed.push(name);
  }
  await rm(dir, { recursive: true, force: true });
  return { id, removed_clips: removed };
}
