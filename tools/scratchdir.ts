// 临时件的两条通道，别混用。本文件必须是所在脚本的第一个 import：
// Node 会记住 os.tmpdir() 的第一次结果，等别的模块先读过再改 TEMP，文件仍会落到 C 盘。
//
//   ① SYSTEM_TEMP = 真正的系统临时目录，给「一次跑完就该整棵删掉」的夹具用
//      （verify-stage2 的 VROOT、verify-ui 的夹具根与截图）。为什么不在项目盘：
//      这类夹具是 67 个条目这一量级，删除受环境配额限制（单 turn 累计 50 个条目），
//      **结构性删不净**，留在项目里就变成一跑一份地堆（第 27 轮清理时已堆到 23MB）。
//   ② SCRATCH = 项目盘上的 work/_scratch，只作为子进程的 TEMP/TMP。
//      ASR / demucs 的 Python 侧解包临时文件落在这里、用完自己删（实测跑完为空），
//      所以它只需要存在、不需要谁去清理；反过来拿它当夹具根，就会重新长出一堆东西。
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCRATCH = path.join(path.resolve(import.meta.dirname, ".."), "work", "_scratch");
mkdirSync(SCRATCH, { recursive: true });
// 必须在下面改写 TEMP 之前求值——os.tmpdir() 在 Windows 上读的就是 TEMP/TMP。
export const SYSTEM_TEMP = os.tmpdir();
process.env.TEMP = SCRATCH;
process.env.TMP = SCRATCH;
