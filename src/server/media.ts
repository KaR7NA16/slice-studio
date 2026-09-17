// 媒体流式响应：支持 HTTP Range（播放器拖进度条必需）。
// 只服务白名单内的确切路径（job.json 登记的视频），不接受任意路径参数。
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

export async function streamMedia(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  const st = await stat(file);
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "content-length": st.size, "accept-ranges": "bytes", "content-type": type });
    createReadStream(file).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = st.size - 1;
  if (m?.[1]) {
    start = parseInt(m[1], 10);
    if (m[2]) end = Math.min(parseInt(m[2], 10), st.size - 1);
  } else if (m?.[2]) {
    start = Math.max(0, st.size - parseInt(m[2], 10)); // 后缀区间：最后 N 字节
  }
  if (start > end || start >= st.size) {
    res.writeHead(416, { "content-range": `bytes */${st.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    "content-range": `bytes ${start}-${end}/${st.size}`,
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    "content-type": type,
  });
  createReadStream(file, { start, end }).pipe(res);
}
