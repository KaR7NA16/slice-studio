// JSON 文件读写：读容错（不存在/坏 JSON 返回 null，由调用方据实处理），写一律 tmp+rename 原子落盘
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// tmp 名必须**每次唯一**。固定用 `<file>.tmp` 在并发写下会互相抢：甲 rename 成功就把 tmp 挪走了，
// 乙的 rename 随即 ENOENT。而乙如果是「不 await 的 fire-and-forget」（心跳就是），
// 那个异常就是未捕获 rejection → **整个步进程退出 1**，run 记录里只剩「进程异常退出（code 1）」。
// 2026-09-18 端到端验收实测到的正是这起：s02 的 10 秒心跳与 demucs 的 progress 事件撞车。
//
// 唯一 tmp 名还不够：**同一个目标路径的并发 rename 在 Windows 上仍会 EPERM**
// （实测 C 盘临时目录 24 路并发 → 7 路 `EPERM: operation not permitted, rename`）。
// 所以再按目标路径**串行化**：同一文件的写排队执行，跨文件的写互不阻塞。
// 跨进程写同一文件不由这里管——调用方里只有「子进程写心跳 / 父进程在子进程退出后补记」这一对，
// 后者发生在子进程结束之后，本来就不重叠。
const chains = new Map<string, Promise<void>>();
let tmpSeq = 0;

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(data, null, 2);
  const prev = chains.get(file) ?? Promise.resolve();
  const next: Promise<void> = prev
    .catch(() => undefined) // 前一次失败不该拖死后续写
    .then(async () => {
      const tmp = `${file}.${process.pid.toString(36)}-${(tmpSeq++).toString(36)}.tmp`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, file);
    })
    .finally(() => {
      // 只有当自己是这条链的尾巴时才摘掉，否则会把后来者的排队信息一起抹掉
      if (chains.get(file) === next) chains.delete(file);
    });
  chains.set(file, next);
  return next;
}
