// 服务入口（b55：绑 127.0.0.1、启动时自动挑空闲端口并打印实际地址；重活一律子进程，本进程只做路由+文件读写+状态计算）
// 运行：node src/server/main.ts [项目根]   （Node ≥ 22.18 直接跑 TS）
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { survey } from "./survey.ts";
import type { Library } from "../shared/types.ts";

const ROOT = path.resolve(process.argv[2] ?? process.cwd());
const DIST = path.join(ROOT, "dist");

const startedAt = performance.now();

function sendJson(res: import("node:http").ServerResponse, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0]!;
  try {
    if (url === "/api/survey") return sendJson(res, await survey(ROOT));
    if (url === "/api/library") {
      const lib = JSON.parse(await readFile(path.join(ROOT, "data", "library.json"), "utf8")) as Library;
      return sendJson(res, lib);
    }
    // 静态：产物是单个 index.html（vite-plugin-singlefile），一律回它
    const html = await readFile(path.join(DIST, "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

// 端口 0 = 系统自动分配空闲端口（b55：不固定默认端口）
server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const ms = (performance.now() - startedAt).toFixed(0);
  console.log(`slice-studio 已启动: http://127.0.0.1:${port}  (冷启动 ${ms}ms, 项目根 ${ROOT})`);
});
