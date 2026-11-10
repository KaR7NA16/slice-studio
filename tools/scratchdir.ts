// 验收和截图的临时文件放在项目盘。本文件必须是所在脚本的第一个 import：
// Node 会记住 os.tmpdir() 的第一次结果，等别的模块先读过再改 TEMP，文件仍会落到 C 盘。
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCRATCH = path.join(path.resolve(import.meta.dirname, ".."), "work", "_scratch");
mkdirSync(SCRATCH, { recursive: true });
// 必须在下面改写 TEMP 之前求值——os.tmpdir() 在 Windows 上读的就是 TEMP/TMP。
// 给「一次跑完就该丢掉」的夹具用：项目盘上的删除受环境配额限制（单 turn 累计 50 个条目），
// 而 verify-ui 的夹具是 67 个条目（38 文件 + 29 目录），**结构性删不净**，留在项目里就是一跑一份地堆。
export const SYSTEM_TEMP = os.tmpdir();
process.env.TEMP = SCRATCH;
process.env.TMP = SCRATCH;
