// 阶段 1 界面验证截图：用本机已有 Chromium 打开服务首页，截全页（判据：浏览器看到真实三态清单）
// 运行：node tools/screenshot.ts <服务地址> <输出png>
import { chromium } from "playwright-core";
import path from "node:path";
import os from "node:os";

const url = process.argv[2] ?? "http://127.0.0.1:51987";
const out = process.argv[3] ?? path.join(os.tmpdir(), "slice-stage1.png");

const exe = path.join(
  os.homedir(),
  "AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe",
);

const browser = await chromium.launch({ executablePath: exe });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".topbar .title", { timeout: 5000 });
  // 展开素材库的 <details> 让截图包含真实条目
  await page.evaluate(() => {
    document.querySelectorAll("details.lib").forEach((d) => ((d as HTMLDetailsElement).open = true));
  });
  await page.screenshot({ path: out, fullPage: true });
  const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
  console.log("截图:", out);
  console.log("页面文本(前400字):", text);
} finally {
  await browser.close();
}
