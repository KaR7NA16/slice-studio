// 验收和截图的临时文件放在项目盘。本文件必须是所在脚本的第一个 import：
// Node 会记住 os.tmpdir() 的第一次结果，等别的模块先读过再改 TEMP，文件仍会落到 C 盘。
import { mkdirSync } from "node:fs";
import path from "node:path";

export const SCRATCH = path.join(path.resolve(import.meta.dirname, ".."), "work", "_scratch");
mkdirSync(SCRATCH, { recursive: true });
process.env.TEMP = SCRATCH;
process.env.TMP = SCRATCH;
