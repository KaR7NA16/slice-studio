// 内容指纹（b31：按内容判定影响；b36 同源思想）
// 小文件（< 8MB：json/srt 等）→ 全量 sha256；大文件（wav/mp4）→ size+mtime（读 484MB 曲库做哈希不现实）
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const FULL_HASH_LIMIT = 8 * 1024 * 1024;

async function sha256File(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve("sha256:" + h.digest("hex")))
      .on("error", reject);
  });
}

// 登记路径有两种：相对 work/ 的产物，或工作区外面的源视频（绝对路径）。
// 绝对路径不能再拼到 work/ 上，否则指纹对的是一个不存在的文件，步会永远 stale。
export function resolveInputPath(workRoot: string, stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(workRoot, stored);
}

// 文件不存在返回 null（调用方据此判 empty/error，不猜）
export async function fingerprint(file: string): Promise<string | null> {
  let st;
  try {
    st = await stat(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size <= FULL_HASH_LIMIT) return await sha256File(file);
  return `meta:${st.size}:${Math.round(st.mtimeMs)}`;
}
