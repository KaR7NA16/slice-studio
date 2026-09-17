// 阶段 1 界面验证截图：用本机已有 Chromium 打开服务首页，截全页（判据：浏览器看到真实三态清单）
// 运行：node tools/screenshot.ts <服务地址> <输出png>
//
// Chromium 从哪来（X-2，2026-09-17 定）：三级解析，**不写死版本号**。
//   ① SLICE_CHROMIUM 环境变量（显式覆盖，最高优先）
//   ② 项目内 tools/chromium/chrome-headless-shell-win64/（若你日后把 shell 拷进来）
//   ③ %USERPROFILE%\AppData\Local\ms-playwright\chromium_headless_shell-*\（按前缀扫，不写死 -1234）
// 为什么不随包内置那 271MB：它是开发期核验工具，不进运行链路——六步流水线与服务启动都不需要它。
// 原实现把 os.homedir() + 版本号写死，playwright 一升级或换机器即失效（且会被反复误认成「C 盘残留」）。
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const url = process.argv[2] ?? "http://127.0.0.1:51987";
const out = process.argv[3] ?? path.join(os.tmpdir(), "slice-stage1.png");

const SHELL_REL = path.join("chrome-headless-shell-win64", "chrome-headless-shell.exe");

// ② 项目内自带
const bundled = path.join(import.meta.dirname, "chromium", SHELL_REL);

// ③ ms-playwright 兜底：目录名形如 chromium_headless_shell-1234，版本号会变，故按前缀扫
function findInPlaywright(): string | null {
  const base = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return null;
  }
  const dir = names.filter((n) => n.startsWith("chromium_headless_shell-")).sort().pop();
  return dir ? path.join(base, dir, SHELL_REL) : null;
}

const exe = [process.env.SLICE_CHROMIUM, bundled, findInPlaywright()]
  .filter((p): p is string => typeof p === "string" && p.length > 0)
  .find((p) => existsSync(p));

if (!exe) {
  console.error("找不到 Chromium headless shell，三种解法任选：");
  console.error("  1) 设环境变量 SLICE_CHROMIUM=<chrome-headless-shell.exe 的绝对路径>");
  console.error(`  2) 把 headless shell 放到 ${path.join(import.meta.dirname, "chromium")}\\`);
  console.error("  3) 用 playwright 装一份：npx playwright install chromium-headless-shell");
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: exe });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text());
  });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e)));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".topbar .title", { timeout: 5000 });
  // 展开素材库的 <details> 让截图包含真实条目
  await page.evaluate(() => {
    document.querySelectorAll("details.lib").forEach((d) => ((d as HTMLDetailsElement).open = true));
  });
  await page.screenshot({ path: out, fullPage: true });
  const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
  console.log("Chromium:", exe);
  console.log("截图:", out);
  console.log("页面文本(前400字):", text);
} finally {
  await browser.close();
}
