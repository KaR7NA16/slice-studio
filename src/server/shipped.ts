// 随安装走的只读文件：模型权重、曲库索引。
// 数据根默认就是程序目录，两处是同一条路径。
// 程序目录不可写时，启动器把数据根改到 %APPDATA%。工作产物去那边，
// 权重和曲库仍从程序目录读，不往 C 盘再复制一份。
import { existsSync } from "node:fs";
import path from "node:path";

export const CODE_ROOT = path.resolve(import.meta.dirname, "..", "..");

// rel 相对数据根。marker 是目录里必须存在的文件；不传就直接看 rel 本身在不在。
// 数据根有就用数据根（用户换过的曲库、另放的权重优先）。没有才回程序目录。
export function shipped(dataRoot: string, rel: string, marker?: string): string {
  const hit = (base: string): boolean => existsSync(marker ? path.join(base, rel, marker) : path.join(base, rel));
  const inData = path.join(dataRoot, rel);
  if (hit(dataRoot)) return inData;
  const inCode = path.join(CODE_ROOT, rel);
  if (hit(CODE_ROOT)) return inCode;
  return inData;
}
