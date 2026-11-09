// demucs 读音频时自己再调一次不带路径的 ffprobe / ffmpeg（audio.py 的回落）。
// 我们切音轨用的是 tools/ffmpeg 的绝对路径，但这一步看不见。机器上没装 ffmpeg 时，
// 回落会报「没安装」，尽管包里有一份。子进程的 PATH 前面放上随包目录，让名字解析到它。
import { mkdirSync } from "node:fs";
import path from "node:path";
import { CODE_ROOT } from "../server/shipped.ts";

const FFMPEG_DIR = path.join(CODE_ROOT, "tools", "ffmpeg");

export function pythonChildEnv(base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}, tempDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  let inherited = "";
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() !== "path") continue;
    inherited = inherited || env[key] || "";
    delete env[key];
  }
  const rest = inherited.split(path.delimiter).filter((p) => p && path.resolve(p) !== path.resolve(FFMPEG_DIR));
  env.PATH = [FFMPEG_DIR, ...rest].join(path.delimiter);
  if (tempDir) {
    mkdirSync(tempDir, { recursive: true });
    env.TEMP = tempDir;
    env.TMP = tempDir;
  }
  return env;
}
