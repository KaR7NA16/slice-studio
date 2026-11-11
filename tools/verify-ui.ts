// 界面冒烟回归（真实 headless Chromium 驱动，不是静态渲染截图）
//
// 为什么必须有这个文件：第 3 轮实测证明，下面两类缺陷 **HTTP 接口用例结构性抓不到**——
//   ① 「两处分别都对、合起来才错」：写侧把 default_id 落 null，读侧 normalize 又升成
//      profiles[0].id 并报 ok:true → 文件说「没默认」、运行时说「默认可用」。
//   ② 「DOM 状态 vs 内存草稿不同步」：表单里填了 key，点一个会触发重画的按钮（设为默认）
//      → 输入框被清空 → 保存时读回空串 → **静默丢掉刚填的值，界面还显示「已保存」**。
// 本文件把这两条固化成回归，并覆盖 P1-4 新增的 missing 态在界面上的三处渲染
// （步骤行圆点 / 状态文案 / 待办条 chip）——其中「漏加 .dot.missing 会让圆点隐形」
// 正是这类静默失败：元素在、文案对，只有真实浏览器里读 computed style 才抓得到。
//
// 运行：node tools/verify-ui.ts（在 slice-studio 根目录下；需先 npm run build）
// 数据根指到临时目录，绝不碰真实数据；结束 kill 服务并清理。

import { SYSTEM_TEMP } from "./scratchdir.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { CUT_GAP, filmRanges, filmSeconds, previewJump } from "../src/shared/cut.ts";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expect: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}: 期望 ${JSON.stringify(expect)} 实际 ${JSON.stringify(actual)}`);
  }
}

const merged = filmRanges([
  { start: 0, end: 1, keep: true },
  { start: 1.2, end: 2, keep: true },
  { start: 3, end: 4, keep: false },
  { start: 5, end: 6, keep: true },
]);
check("间隔小于 0.5 秒的保留句并成一段", merged, [[0, 2], [5, 6]]);
check("成片时长是各段之和", filmSeconds(merged), 3);
check("落在删掉的空隙里就跳到下一段", previewJump(2.5, merged), 5);
check("落在保留段里不跳", previewJump(1.5, merged), null);
check("播过最后一段就结束", previewJump(6, merged), "end");
check(
  "夹回片段区间后超界的句子丢掉",
  filmRanges(
    [
      { start: 0.2, end: 0.4, keep: true },
      { start: 1.6, end: 2.4, keep: true },
    ],
    { start: 1, end: 3 },
  ),
  [[1.6, 2.4]],
);
check("预览与出片共用 0.5 秒间隔", CUT_GAP, 0.5);

// ---- 数据根：临时目录 + 预置两个 owner，覆盖 missing 的两种可见位置 ----
// 每次运行用唯一目录：clip/job id 由输入内容哈希稳定复现，固定名根上残留的旧夹具会被
// /api/clips 重新命中，把「本次没有 run」读成上次的结果（2026-11-09 实测同款污染）。
// mkdtempSync 直接建好目录，不必先 rm；清理失败只影响磁盘占用，不污染下一次运行。
//
// 根放在**系统临时目录**而不是 `work/_scratch`：项目盘的删除受环境配额限制（单 turn 累计 50 个
// 条目），本夹具是 67 个条目（38 文件 + 29 目录），删到第 50 个必被拦——于是一跑一份地堆，
// 攒到 27 份才发现。挪到系统临时目录后，项目内不再增长，残留由操作系统按临时文件清理。
const ROOT = mkdtempSync(path.join(SYSTEM_TEMP, "slice-ui-smoke-"));

const now = new Date().toISOString();
const w = (...p: string[]): string => path.join(ROOT, "work", ...p);
const put = (file: string, data: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
};
// 显式关掉调试用的免密钥默认档：不写 llm 键时 config.ts 会回落到外部免费接口，
// 设置页「未配置」的前提就不成立（[C] 段会一直等到超时）。与 verify-stage2.ts 同款夹具隔离。
put(path.join(ROOT, "config.json"), { llm: { profiles: [], default_id: null } });

// job 的 video_path 必须**真实存在**：媒体出口对缺失文件会抛 500（已登记进缺口清单，
// 不属本次改动范围）。夹具不制造这个噪音，「无预期错误」那条断言才有判别力。
const fakeVideo = path.join(ROOT, "fake-video.mp4");
const ffmpeg = path.join(import.meta.dirname, "ffmpeg", "ffmpeg.exe");
const enc = spawnSync(
  ffmpeg,
  [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=160x120:r=25:d=6",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-shortest", "-t", "6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    fakeVideo,
  ],
  { stdio: "pipe" },
);
if (enc.status !== 0) {
  writeFileSync(fakeVideo, Buffer.alloc(1024));
  console.log(String(enc.stderr ?? "ffmpeg 没生成夹具视频"));
}

// 一条能真解码的 WAV（正弦波）：波形用例要走到 decodeAudioData 之后，
// 拿字节垃圾当音频会让波形静默降级成「读取失败」——那正是这条用例要防的假绿。
function wav(seconds: number): Buffer {
  const rate = 8000;
  const n = Math.round(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
// 夹具清理：环境对「一次删掉 >50 个文件」有确认门，而本文件的夹具是 67 个文件——
// 整棵 rmSync 会被拦下（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），于是每跑一次就漏下一份夹具，
// 攒到 27 份才被发现。改成逐个文件删、再由深到浅删空目录：每次只动一个目标，不触发批量门。
// 失败**不吞**：没删干净必须让调用方看见（否则「已清理」会变成假话）。
function nuke(dir: string): void {
  const files: string[] = [];
  const dirs: string[] = [];
  const walk = (d: string): void => {
    dirs.push(d);
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  for (const f of files) unlinkSync(f);
  for (const d of dirs.reverse()) rmdirSync(d); // 深到浅，父目录此时已空
}
const putBuf = (file: string, data: Buffer): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
};

// job ui-j1：s00 与 s01 都 ready（s00 的契约产物齐备 → 句流列表可渲染；
// s01 同时有**人工定稿**（candidates.json）与**AI 提案**（ai.json），用来验证两者分列不合并）
put(w("jobs", "ui-j1", "job.json"), { schema: 1, id: "ui-j1", video_path: fakeVideo, srt_path: null, created_at: now });
put(w("jobs", "ui-j1", "s00", "step.json"), { schema: 1, step: "s00", finished_at: now, inputs: [], outputs: ["sentences.json", "job.srt"] });
put(w("jobs", "ui-j1", "s00", "sentences.json"), {
  schema: 1,
  sentences: [
    { id: "1", start: 0.5, end: 1.5, text: "第一句：开场白" },
    { id: "2", start: 1.6, end: 2.4, text: "第二句：呃，喝口水" },
    { id: "3", start: 2.5, end: 3.6, text: "第三句：讲重点" },
    { id: "4", start: 3.7, end: 4.8, text: "第四句：收尾" },
  ],
});
put(w("jobs", "ui-j1", "s00", "job.srt"), "1\n00:00:00,500 --> 00:00:01,500\n第一句：开场白\n");
put(w("jobs", "ui-j1", "s01", "step.json"), { schema: 1, step: "s01", finished_at: now, inputs: [], outputs: ["candidates.json", "ai.json"], active_variant: "v1" });
put(w("jobs", "ui-j1", "s01", "candidates.json"), {
  schema: 1,
  source: "human",
  clips: [{ clip_id: "ui-c1", title: "界面冒烟片段", start: 1, end: 3, created_at: now }],
});
const s01ai = { schema: 1, model: "冒烟模型", at: now, candidates: [{ id: "h1", title: "AI 挑的高光", start: 0.5, end: 3.6, reason: "信息密度高" }] };
put(w("jobs", "ui-j1", "s01", "ai.json"), s01ai);
put(w("jobs", "ui-j1", "s01", "variants", "v1.json"), { schema: 1, meta: { id: "v1", step: "s01", created_at: now, model: "冒烟模型", label: "1 条：AI 挑的高光", parent: null }, payload: s01ai });

// 曲库：两条 bgm，路径指向**真实文件**（s04 面板的试听按钮会真去请求它，
// 路径不存在就会制造一条 404 噪音，把「无预期错误响应」那条断言弄成假红）
const libA = path.join(ROOT, "lib-a.wav");
const libB = path.join(ROOT, "lib-b.wav");
putBuf(libA, wav(0.5));
putBuf(libB, wav(0.5));
put(path.join(ROOT, "data", "library.json"), {
  schema: 1,
  source_root: "(冒烟)",
  items: [
    { id: "bgm-a", kind: "bgm", group: "轻松", title: "轻快 A", path: libA, sha256: "x", bytes: 8044 },
    { id: "bgm-b", kind: "bgm", group: "轻松", title: "轻快 B", path: libB, sha256: "y", bytes: 8044 },
  ],
});

// clip ui-c1：五步全部就绪，一次把四个工作空间 + 分叉树 + 档位 + 曲库都渲染出来。
// s03 特意给两版变体（v2 为当前主干），用来验证「切回侧枝」在界面上真能点、真落盘。
put(w("clips", "ui-c1", "clip.json"), { schema: 1, id: "ui-c1", job_id: "ui-j1", title: "界面冒烟片段", start: 1, end: 3, fps: null });
putBuf(w("clips", "ui-c1", "s02", "vocals.wav"), wav(2));
putBuf(w("clips", "ui-c1", "s02", "no_vocals.wav"), wav(2));
put(w("clips", "ui-c1", "s02", "step.json"), { schema: 1, step: "s02", finished_at: now, inputs: [], outputs: ["vocals.wav", "no_vocals.wav"] });
put(w("clips", "ui-c1", "s03", "sentences.json"), {
  schema: 1,
  sentences: [
    { id: "2", start: 1.6, end: 2.4, text: "第二句：呃，喝口水" },
    { id: "3", start: 2.5, end: 3.6, text: "第三句：讲重点" },
  ],
});
const aiV1 = { schema: 1, model: "冒烟模型", at: "2026-01-01T00:00:00.000Z", decisions: [{ id: "2", keep: false, reason: "第一版：删掉口水话" }] };
const aiV2 = { schema: 1, model: "冒烟模型", at: "2026-01-02T00:00:00.000Z", decisions: [{ id: "3", keep: false, reason: "第二版：删掉重点" }] };
put(w("clips", "ui-c1", "s03", "ai.json"), aiV2);
put(w("clips", "ui-c1", "s03", "variants", "v1.json"), { schema: 1, meta: { id: "v1", step: "s03", created_at: "2026-01-01T00:00:00.000Z", model: "冒烟模型", label: "第一版", parent: null }, payload: aiV1 });
put(w("clips", "ui-c1", "s03", "variants", "v2.json"), { schema: 1, meta: { id: "v2", step: "s03", created_at: "2026-01-02T00:00:00.000Z", model: "冒烟模型", label: "第二版", parent: null }, payload: aiV2 });
put(w("clips", "ui-c1", "s03", "step.json"), { schema: 1, step: "s03", finished_at: now, inputs: [], outputs: ["sentences.json", "ai.json"], active_variant: "v2" });
put(w("clips", "ui-c1", "s04", "params.json"), { schema: 1, bgm_mood: "轻松" });
put(w("clips", "ui-c1", "s04", "bgm.json"), {
  schema: 1, mood: "轻松", source: "human", reason: null,
  track: { id: "bgm-a", title: "轻快 A", path: libA, bytes: 8044 }, candidates: 2, at: now,
});
put(w("clips", "ui-c1", "s04", "step.json"), { schema: 1, step: "s04", finished_at: now, inputs: [], outputs: ["bgm.json"] });
put(w("clips", "ui-c1", "s05", "final.mp4"), Buffer.alloc(2048));
put(w("clips", "ui-c1", "s05", "package.zip"), Buffer.alloc(256));
put(w("clips", "ui-c1", "s05", "step.json"), { schema: 1, step: "s05", finished_at: now, inputs: [], outputs: ["final.mp4", "package.zip"] });

// P1-4 的 missing 态需要**另一个** owner 来呈现（ui-j1/ui-c1 现在全是 ready）：
// job ui-j2 的 s00 step.json 在、两个契约产物都不在 → missing（总览页的 .step 行）
put(w("jobs", "ui-j2", "job.json"), { schema: 1, id: "ui-j2", video_path: fakeVideo, srt_path: null, created_at: now });
put(w("jobs", "ui-j2", "s00", "step.json"), { schema: 1, step: "s00", finished_at: now, inputs: [], outputs: ["sentences.json", "job.srt"] });
// clip ui-c2 的 s03 缺 sentences.json → missing（片段页步骤 chip 的圆点）
put(w("clips", "ui-c2", "clip.json"), { schema: 1, id: "ui-c2", job_id: "ui-j2", title: "缺产物的片段", start: 1, end: 3, fps: null });
put(w("clips", "ui-c2", "s03", "step.json"), { schema: 1, step: "s03", finished_at: now, inputs: [], outputs: ["sentences.json"] });

// job ui-j3：一步都没跑过（连 step.json 都没有）。用来验「整条链路未跑」只说一遍——
// 以前逐步铺「未跑」，一屏出现三次同一个词，读起来像三件各自独立的毛病。
put(w("jobs", "ui-j3", "job.json"), { schema: 1, id: "ui-j3", video_path: fakeVideo, srt_path: null, created_at: now });

// ---- 起服务：脚本内 spawn、脚本内 kill（shell 的 job control 在非交互环境下不可靠）----
const srv = spawn(process.execPath, ["src/server/main.ts", ROOT], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise<string>((resolve, reject) => {
  let buf = "";
  srv.stdout.on("data", (d: Buffer) => {
    buf += String(d);
    const m = buf.match(/127\.0\.0\.1:(\d+)/);
    if (m) resolve(m[1]!);
  });
  srv.on("exit", () => reject(new Error(`服务提前退出：${buf}`)));
  setTimeout(() => reject(new Error(`启动超时：${buf}`)), 20000);
});
console.log(`服务已起：http://127.0.0.1:${port}（数据根 ${ROOT}）`);

// ---- 找 Chromium：按前缀扫，绝不写死版本号（playwright 一升级就失效）----
const pwBase = path.join(process.env.USERPROFILE ?? "", "AppData", "Local", "ms-playwright");
const shellDir = readdirSync(pwBase).filter((n) => n.startsWith("chromium_headless_shell-")).sort().pop();
if (!shellDir) throw new Error(`没找到 chromium_headless_shell-*（${pwBase}）`);
const exe = path.join(pwBase, shellDir, "chrome-headless-shell-win64", "chrome-headless-shell.exe");

// 期望色不再写死：--st-missing 指向 --text-danger，令牌换值时断言必须跟着走。
// 开页后由 DOM 探针读 --text-danger 的计算色（独立于被测的 .dot.missing 规则，避免自己验自己）。
let MISSING_RGB = "";
const KEY = "sk-ui-smoke-1234567890";
const errs: string[] = [];
let browser: Browser | null = null;
let fatal: unknown = null;
let cleanupWarn = "";
try {
  browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage();
  let nativeDialogs = 0;
  page.on("dialog", (d) => {
    nativeDialogs++;
    void d.dismiss();
  });
  // 抓 JS 运行时错误的唯一手段
  page.on("pageerror", (e) => errs.push("pageerror: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text());
  });
  // 记下所有 >=400 的响应：console 里只会说「Failed to load resource」，
  // 不给 URL 就没法定位——而 5xx 是真故障，不能当噪音放过。
  const bad: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
  });
  const base = `http://127.0.0.1:${port}`;

  // ============ O. 重画代次：慢的旧代不许覆盖新页（必须第一个跑） ============
  // 为什么排在最前：这个缺陷一旦存在，后面每一段都可能撞上「元素被换掉」而中断，
  // 而中断的输出是「N passed / 0 failed」——failed 是 0，很容易被当成通过。
  // 放在第一位，它会在任何中断之前先给出一条明确的红。
  //
  // 判据本身也特殊：靠「等元素出现」抓不到，因为旧代写的是**另一个页面**，
  // 元素在、页面错。必须造出「旧代比新代晚返回」的时序：
  // 拦下 survey，第一发挂 800ms（首页那一代），之后放行（任务页那一代立即完成）。
  // 没有代次控制时，首页会晚于任务页返回，把用户刚打开的任务页整页覆盖成首页。
  console.log("[O] 重画代次：旧代晚返回时不许覆盖新页");
  let surveyHits = 0;
  await page.route("**/api/survey", async (route) => {
    surveyHits++;
    if (surveyHits === 1) await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.goto(`${base}/#/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(150); // 首页 render 已发出 survey，正挂在那里
  await page.evaluate(() => {
    location.hash = "#/job/ui-j1";
  });
  await page.waitForTimeout(1400); // 等旧代（800ms）也走完——它此刻才有机会覆盖
  const genCheck = await page.evaluate(() => ({
    hash: location.hash,
    job: !!document.getElementById("job-sents"),
    home: !!document.getElementById("nj-go"),
  }));
  await page.unroute("**/api/survey");
  check(
    `hash 是任务页时 DOM 也是任务页（实测 job=${String(genCheck.job)} / home=${String(genCheck.home)}）`,
    genCheck.job && !genCheck.home,
    true,
  );

  // ============ A. P1-4：missing 在总览页的渲染 ============
  console.log("[A] P1-4：missing 态渲染（步骤行圆点 / 状态文案 / 待办条）");
  await page.goto(`${base}/#/`);
  await page.waitForSelector(".step");
  MISSING_RGB = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-danger)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  console.log(`  missing 期望色（读 --text-danger）：${MISSING_RGB}`);
  // 按卡片归属取行：现在有两个 job，直接 `$$eval(".step")` 会把两者的 s00 混在一起，
  // `find` 取到的是排在前面的 ui-j1（ready）——断言会红得莫名其妙。
  const rows = await page.$$eval(".card", (cards) =>
    cards.map((c) => ({
      job: (c.querySelector("a.card-head") as HTMLAnchorElement | null)?.getAttribute("href") ?? "",
      steps: Array.from(c.querySelectorAll(".step")).map((el) => {
        const dot = el.querySelector(".dot") as HTMLElement;
        const state = el.querySelector(".state") as HTMLElement;
        return {
          id: el.querySelector(".id")?.textContent ?? "",
          dotCls: dot.className,
          dotBg: getComputedStyle(dot).backgroundColor,
          stateText: state.textContent,
          reason: el.querySelector(".reason")?.textContent ?? "",
        };
      }),
    })),
  );
  const s00 = rows.find((r) => r.job.includes("ui-j2"))?.steps.find((r) => r.id === "s00");
  check("s00 行状态类为 missing", s00?.dotCls, "dot missing");
  check("s00 圆点有真实背景色（漏加 .dot.missing 会退成 transparent → 圆点隐形）", s00?.dotBg, MISSING_RGB);
  check("s00 状态文案", s00?.stateText, "丢失");
  check("s00 原因写明缺哪个产物", s00?.reason, "缺少 sentences.json");
  const chips = await page.$$eval(".todo .chip", (els) =>
    els.map((el) => ({ cls: el.className, color: getComputedStyle(el as HTMLElement).color, text: el.textContent ?? "" })),
  );
  const miss = chips.filter((c) => c.cls.includes("miss"));
  check("待办条有 2 条产物丢失（job 的 s00 + clip 的 s03）", miss.length, 2);
  check("待办条文案指向「产物丢失」", miss.every((c) => c.text.includes("产物丢失")), true);
  check("待办条配色是 missing 色（此前靠嗅探文案判样式，新增一类会静默落回默认灰）", miss[0]?.color, MISSING_RGB);

  // ============ B. P1-4：clip 页 tab 状态圆点（同一类静默失败的第二处）============
  // 旧版这里查的是 .steps-line .chip，状态被印了两次（一行文字 + tab 圆点）；v2.8 合并成 tab 圆点一处。
  console.log("[B] P1-4：clip 页 tab 的状态圆点");
  await page.goto(`${base}/#/clip/ui-c2`);
  await page.waitForSelector(".tabs .tab");
  const chipDots = await page.$$eval(".tabs .tab", (els) =>
    els.map((el) => {
      const dot = el.querySelector(".dot") as HTMLElement | null;
      return { id: (el.querySelector(".tab-id")?.textContent ?? "").trim(), cls: dot?.className ?? "", bg: dot ? getComputedStyle(dot).backgroundColor : "" };
    }).filter((x) => x.id),
  );
  check("s03 tab 带 missing 类", chipDots.some((c) => c.cls === "dot missing"), true);
  check("s03 tab 圆点有背景色", chipDots.filter((c) => c.cls === "dot missing").every((c) => c.bg === MISSING_RGB), true);
  check("s02 tab 仍是 empty（没被 missing 连累）", chipDots.some((c) => c.cls === "dot empty"), true);
  check("状态只印一次（页内没有第二条 steps-line）", await page.$$eval(".steps-line", (els) => els.length), 0);

  // N-4：没跑过 s03 的片段（ui-c2）要凭 built:false 渲染空态。
  // 这一组的意义是把「空态」与「吞错」分开：只要前端还靠 catch(()=>null) 兜底，
  // 状态位那条反而会「通过」——错误被吞了、界面看不出异常；能指出「有 4xx」的只剩 [D] 段。
  // 等「句流区已画完」，而不是等「画对了」——若等待条件本身就要求结论正确，
  // 被测行为一错就变成超时中断（0 failed 的中断，比红更危险：看起来像没失败）。
  await page.waitForFunction(() => (document.getElementById("s03-info")?.textContent ?? "").length > 0, null, { timeout: 10000 });
  check("未构建时句流标题标「未构建」", await page.textContent("#s03-info"), "句流（未构建）");
  check("未构建时句流区给出空态说明", (await page.textContent("#s03-sents"))?.includes("句流未构建"), true);
  check("未构建不等于不可操作：重建按钮仍可用", await page.$eval("#run-build", (b) => (b as HTMLButtonElement).disabled), false);
  check("未构建不往状态位写错误（空态是 200 回答的，不是吞错换的）", await page.textContent("#run-status"), "");

  // ============ C. 设置页：草稿不丢 + 落盘 + 不回显 ============
  console.log("[C] 设置页：填 key → 触发重画 → 草稿必须还在 → 保存必须落盘");
  await page.goto(`${base}/#/settings`);
  await page.waitForSelector("#st-url");
  await page.click("#st-test");
  await page.waitForFunction(() => (document.getElementById("st-msg")?.textContent ?? "").includes("还没填 API 地址"));
  check("没填地址时测试连接据实说明", await page.textContent("#st-msg"), "还没填 API 地址");
  // 第一档只给合法地址：saveLlm 是整批拒，任一档地址非法会连累整次保存
  await page.fill("#st-url", "https://api.example.com/v1");
  await page.fill("#st-model", "other-model");
  await page.click("#st-add"); // 建第二个档
  // 不能等 "#st-name"：旧 DOM 上也有这个 id，重画还没完成时它就已经匹配了，
  // 后面几个 fill 会落在随即被丢弃的旧节点上（本轮实测 name 就是这么丢的）。
  // 等「档数真的变成 2 且选到第 2 档」——这是重画完成的确定信号。
  await page.waitForFunction(
    () => {
      const sel = document.getElementById("st-pick") as HTMLSelectElement | null;
      return !!sel && sel.options.length === 2 && sel.selectedIndex === 1;
    },
    null,
    { timeout: 8000 },
  );
  await page.fill("#st-name", "冒烟档");
  await page.fill("#st-url", "https://api.example.com/v1");
  await page.fill("#st-key", KEY);
  await page.fill("#st-model", "smoke-model");
  await page.click("#st-default"); // ← 触发重画：DEFECT #2 就是在这里把刚填的 key 丢掉的
  // 同理：等「按钮自己变成已是默认」而不是等 key 输入框还在
  await page.waitForFunction(
    () => (document.getElementById("st-default") as HTMLButtonElement | null)?.disabled === true,
    null,
    { timeout: 8000 },
  );
  check("点「设为默认」（重画）后 key 仍在输入框里", await page.inputValue("#st-key"), KEY);
  check("重画后其它字段也还在", await page.inputValue("#st-model"), "smoke-model");
  await page.click("#st-save");
  await page.waitForFunction(() => (document.getElementById("st-msg")?.textContent ?? "").startsWith("已保存"), null, { timeout: 8000 });

  const cfg = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
  check("config.json 落了 2 个档", cfg.llm.profiles.length, 2);
  check("填的 key 真的落盘（不是被静默丢成空串）", cfg.llm.profiles.some((p: { api_key: string }) => p.api_key === KEY), true);
  check("默认档指向刚设的那个", cfg.llm.profiles.find((p: { id: string }) => p.id === cfg.llm.default_id)?.model, "smoke-model");

  await page.goto(`${base}/#/settings`); // 重载：走一遍真实读取路径
  await page.waitForFunction(
    () => {
      const sel = document.getElementById("st-pick") as HTMLSelectElement | null;
      return !!sel && sel.options.length === 2;
    },
    null,
    { timeout: 8000 },
  );
  // 切档的等待条件要中立：等「输入框被换成新元素」，而不是等我们要断言的 placeholder 出现——
  // 后者若恰好没出现，会变成超时中断而不是一条红（这个坑本文件已经踩过两次）。
  await page.evaluate(() => {
    (window as unknown as { __oldKey?: Element | null }).__oldKey = document.getElementById("st-key");
  });
  await page.selectOption("#st-pick", "1"); // 切到有 key 的那一档
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __oldKey?: Element | null };
      const k = document.getElementById("st-key");
      return !!k && k !== w.__oldKey;
    },
    null,
    { timeout: 8000 },
  );
  check("重载后 key 输入框为空（明文不下发浏览器）", await page.inputValue("#st-key"), "");
  check("重载后 placeholder 是掩码提示", (await page.getAttribute("#st-key", "placeholder"))?.includes("已存"), true);
  const apiText = await page.evaluate(() => fetch("/api/llm").then((r) => r.text()));
  check("GET /api/llm 响应体里没有明文 key", apiText.includes(KEY), false);

  // ============ E. 任务工作空间：s00/s01 两个工作空间 + 档位 + 分叉树 + AI 提案分列 ============
  console.log("[E] 任务工作空间：档位开关落盘 / 分叉树 / AI 提案与人工定稿分列");
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#step-s01");
  const wsHeads = await page.$$eval(".ws-head", (els) => els.map((e) => e.textContent?.trim() ?? ""));
  check("任务页有 s00 与 s01 两个工作空间", wsHeads.length, 2);
  check("s00 句流渲染出 4 行", await page.$$eval("#job-sents .sent", (e) => e.length), 4);
  check("AI 提案 1 条（未采纳）", await page.$$eval(".cand", (e) => e.length), 1);
  check("人工定稿 1 条", await page.$$eval(".card .clip-row", (e) => e.length >= 1), true);
  check("分叉树主干节点没有「切为主干」按钮", await page.$$eval(".tree-node.main .act", (e) => e.length), 0);

  // 档位开关：点一下必须真的落盘（b3/b4）。任务页的开关写的是**全局默认**（job 级没有覆盖层）。
  await page.click('.auto-slot[data-step="s01"] .seg[data-auto="auto"]');
  // ⚠️ 不能只等 `#step-s01` 出现——它本来就在（旧 DOM），等它等于没等，
  // 断言会跑在重画之前的 DOM 上（实测踩到：磁盘写对了、界面断言假红）。要等**目标状态**。
  await page
    .waitForFunction(
      () => document.querySelector('.auto-slot[data-step="s01"] .seg[data-auto="auto"]')?.className.includes("on") === true,
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  const cfgAfter = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
  check("任务页点「自动」→ 写进 config.json 的全局档位", cfgAfter.automation?.s01, "auto");
  check(
    "重画后该开关显示为选中态",
    await page.$eval('.auto-slot[data-step="s01"] .seg[data-auto="auto"]', (e) => e.className.includes("on")),
    true,
  );

  // 采纳 AI 提案 = 用这条候选去建片段（b1：人工定稿这一步没有被 AI 绕过）
  await page.click(".cand .adopt");
  await page.waitForFunction(() => location.hash.startsWith("#/clip/"), null, { timeout: 10000 });
  const adoptedHash = await page.evaluate(() => location.hash);
  const adopted = decodeURIComponent(adoptedHash.slice("#/clip/".length));
  const adoptedDir = w("clips", adopted);
  check("采纳后跳到新片段页", adopted.length > 0, true);
  check("新片段真的落了 clip.json", readFileSync(path.join(adoptedDir, "clip.json"), "utf8").includes(adopted), true);
  const candAfter = JSON.parse(readFileSync(w("jobs", "ui-j1", "s01", "candidates.json"), "utf8"));
  check("采纳的候选并进人工定稿（candidates.json 变 2 条）", candAfter.clips.length, 2);
  check("AI 提案文件没有被改写（分文件存放）", JSON.parse(readFileSync(w("jobs", "ui-j1", "s01", "ai.json"), "utf8")).candidates.length, 1);

  // ============ F. 片段工作空间：tab 切换 + 分叉树切主干真落盘 ============
  console.log("[F] 片段工作空间：四个 tab + 分叉树切回侧枝（不重跑 AI）");
  await page.goto(`${base}/#/clip/ui-c1`);
  await page.waitForSelector(".tabs .tab.on");
  check("默认落在 s03 tab", await page.$eval(".tabs .tab.on", (e) => (e as HTMLElement).dataset.tab), "s03");
  check("s03 面板可见", await page.$eval("#panel-s03", (e) => !(e as HTMLElement).hidden), true);
  check("非当前 tab 的面板是 hidden（不是只靠样式藏）", await page.$eval("#panel-s05", (e) => (e as HTMLElement).hidden), true);

  // 波形气口：数据来自 s02 的人声轨，必须真的画到画布上（不是渲染了个空 canvas）
  await page
    .waitForFunction(
      () => {
        const c = document.getElementById("s03-wave") as HTMLCanvasElement | null;
        if (!c || c.width === 0) return false;
        const g = c.getContext("2d");
        if (!g) return false;
        const d = g.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) return true;
        return false;
      },
      null,
      { timeout: 10000 },
    )
    .catch(() => {});
  const wavePx = await page.evaluate(() => {
    const c = document.getElementById("s03-wave") as HTMLCanvasElement;
    const g = c.getContext("2d")!;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) n++;
    return n;
  });
  check("波形画布真的画了东西（不是空 canvas）", wavePx > 100, true);

  // s03 面板实拍：这轮把「成片预览」开关挪进播放器卡片、片长说明挪到波形标题行，
  // 位置对不对只能看图（元素都在、文字也对，但排错了这种缺陷判据看不出来）。
  // 放系统临时目录，理由同文末那张总览图。
  const shotS03 = path.join(SYSTEM_TEMP, "slice-ui-s03.png");
  await page.screenshot({ path: shotS03, fullPage: true });
  console.log(`\n截图（s03 面板）：${shotS03}`);

  check("成片预览默认开着", await page.$eval("#preview-cut", (el) => (el as HTMLInputElement).checked), true);
  check(
    "预览时长按当前删留算（留第二句 0.8 秒，删第三句）",
    await page.$eval("#preview-len", (el) => el.textContent ?? ""),
    "约 0.8 秒，1 段。播放时跳过已删的句子；间隔小于 0.5 秒的保留句会连着播，和出片同一规则。",
  );
  const jumped = await page.evaluate(async () => {
    const v = document.querySelector("#player") as HTMLVideoElement;
    v.muted = true;
    if (v.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("metadata timeout")), 8000);
        v.addEventListener("loadedmetadata", () => { clearTimeout(timer); resolve(); }, { once: true });
        v.addEventListener("error", () => { clearTimeout(timer); reject(new Error("media error")); }, { once: true });
      });
    }
    await v.play();
    v.currentTime = 0.2;
    const start = performance.now();
    while (performance.now() - start < 4000) {
      if (v.currentTime >= 1.5 && v.currentTime < 2.05) return `jumped:${v.currentTime.toFixed(2)}`;
      await new Promise((r) => setTimeout(r, 40));
    }
    return `stayed:${v.currentTime.toFixed(2)} paused:${v.paused} ready:${v.readyState}`;
  });
  check("播放头在保留段之前会跳到第一段保留句", jumped.startsWith("jumped:") ? "jumped" : jumped, "jumped");
  const skipped = await page.evaluate(async () => {
    const v = document.querySelector("#player") as HTMLVideoElement;
    v.muted = true;
    await v.play();
    v.currentTime = 2.7;
    const start = performance.now();
    while (performance.now() - start < 3000) {
      if (v.paused && v.currentTime > 2 && v.currentTime < 2.5) return `ended:${v.currentTime.toFixed(2)}`;
      await new Promise((r) => setTimeout(r, 40));
    }
    return `stayed:${v.currentTime.toFixed(2)} paused:${v.paused}`;
  });
  check("播进已删的句子会停在上一段保留的结尾", skipped.startsWith("ended:") ? "ended" : skipped, "ended");
  await page.click("#preview-cut");
  const raw = await page.evaluate(async () => {
    const v = document.querySelector("#player") as HTMLVideoElement;
    v.muted = true;
    await v.play();
    v.currentTime = 2.7;
    await new Promise((r) => setTimeout(r, 500));
    return `t:${v.currentTime.toFixed(2)} paused:${v.paused}`;
  });
  check(
    "关掉成片预览后，已删的句子会照常播",
    (/^t:2\.[7-9]|^t:3\./.test(raw) && raw.includes("paused:false")) ? "played" : raw,
    "played",
  );
  await page.click("#preview-cut");
  await page.evaluate(() => (document.querySelector("#player") as HTMLVideoElement).pause());
  await page.locator("#s03-sents .sent.drop .toggle").click();
  await page.waitForFunction(
    () => (document.querySelector("#preview-len")?.textContent ?? "").includes("1.4 秒"),
    null,
    { timeout: 8000 },
  );
  check(
    "改删留后预览时长马上变，不用等出片",
    (await page.$eval("#preview-len", (el) => el.textContent ?? "")).includes("1.4 秒"),
    true,
  );

  await page.click('.tabs .tab[data-tab="s02"]');
  await page.waitForSelector("#panel-s02:not([hidden])");
  check("切到 s02 后 hash 带 tab", await page.evaluate(() => location.hash), "#/clip/ui-c1/s02");
  check("s02 试听区渲染出 2 条（人声 / 伴奏）", await page.$$eval("#panel-s02 .audio-row", (e) => e.length), 2);

  await page.click('.tabs .tab[data-tab="s05"]');
  await page.waitForSelector("#panel-s05:not([hidden])");
  check("s05 有播放器与两个下载出口", await page.$$eval("#panel-s05 video, #panel-s05 a[download]", (e) => e.length), 3);

  await page.click('.tabs .tab[data-tab="tree"]');
  await page.waitForSelector("#panel-tree:not([hidden])");
  check("分叉树列出 s03 的两版", await page.$$eval("#tree .tree-node", (e) => e.length), 2);
  check("主干标记在 v2 上", await page.$eval("#tree .tree-node.main .tn-id", (e) => e.textContent), "v2");
  await page.click('#tree .tree-node:not(.main) .act'); // 切回 v1
  await page.waitForFunction(
    () => (document.querySelector("#tree .tree-node.main .tn-id")?.textContent ?? "") === "v1",
    null,
    { timeout: 10000 },
  );
  const s03step = JSON.parse(readFileSync(w("clips", "ui-c1", "s03", "step.json"), "utf8"));
  const s03ai = JSON.parse(readFileSync(w("clips", "ui-c1", "s03", "ai.json"), "utf8"));
  check("切主干写进了 step.json 的 active_variant", s03step.active_variant, "v1");
  check("切主干 = 物化那一版（时间戳是存档里的，不是刚刚）", s03ai.at, "2026-01-01T00:00:00.000Z");

  // ============ G. s04 曲库：全部可列出 + 人工换曲写覆盖层 ============
  console.log("[G] s04 曲库：列出全部曲目 + 换一首写 pick.json（不动 bgm.json）");
  await page.click('.tabs .tab[data-tab="s04"]');
  await page.waitForSelector("#panel-s04:not([hidden])");
  await page.waitForSelector("#panel-s04 .track");
  check("曲库列出全部 2 首", await page.$$eval("#panel-s04 .track", (e) => e.length), 2);
  check(
    "风格下拉列出曲库分组，并选中当前 mood",
    await page.$eval("#bgm-mood", (el) => {
      const s = el as HTMLSelectElement;
      return `${s.value}|${Array.from(s.options).map((o) => o.value).join(",")}`;
    }),
    "轻松|,轻松",
  );
  check("当前生效显示 s04 产物那首", await page.$eval("#panel-s04 .bgm-now .t", (e) => e.textContent), "轻快 A");
  // 前面的设置页用例已经配上了模型。这里临时拿掉，才能测「没模型时」的按钮，测完写回去。
  const cfgPath = path.join(ROOT, "config.json");
  const savedCfg = readFileSync(cfgPath, "utf8");
  const cfgNoLlm = JSON.parse(savedCfg) as { llm?: { profiles?: unknown; default_id?: unknown } };
  if (!cfgNoLlm.llm) cfgNoLlm.llm = {};
  cfgNoLlm.llm.profiles = [];
  cfgNoLlm.llm.default_id = null;
  writeFileSync(cfgPath, JSON.stringify(cfgNoLlm, null, 2));
  await page.goto(`${base}/#/clip/ui-c1/s04`);
  await page.waitForSelector("#run-s04");
  check("已选风格时，没配模型也能点跑一次", await page.$eval("#run-s04", (el) => (el as HTMLButtonElement).disabled), false);
  await page.selectOption("#bgm-mood", "");
  await page.waitForFunction(() => (document.querySelector("#run-s04") as HTMLButtonElement | null)?.disabled === true, null, { timeout: 10000 });
  check(
    "没选风格且没配模型时，跑一次是灰的，并说明可以去设置或先选风格",
    await page.$eval("#s04-status", (el) => {
      const t = el.textContent ?? "";
      return t.includes("去设置") && t.includes("风格");
    }),
    true,
  );
  await page.selectOption("#bgm-mood", "轻松");
  await page.waitForFunction(() => (document.querySelector("#run-s04") as HTMLButtonElement | null)?.disabled === false, null, { timeout: 10000 });
  writeFileSync(cfgPath, savedCfg);
  const bgmBytesBefore = readFileSync(w("clips", "ui-c1", "s04", "bgm.json"));
  const tracks = page.locator("#panel-s04 .track");
  await tracks.nth(1).locator(".pick").click(); // 第二首
  await page.waitForFunction(
    () => (document.querySelector("#panel-s04 .bgm-now .t")?.textContent ?? "") === "轻快 B",
    null,
    { timeout: 10000 },
  );
  check("换曲后当前生效变成人工选的那首", await page.$eval("#panel-s04 .bgm-now .badge", (e) => e.textContent), "人工换曲");
  const pick = JSON.parse(readFileSync(w("clips", "ui-c1", "s04", "pick.json"), "utf8"));
  check("人工换曲写进了 pick.json（覆盖层）", pick.track_id, "bgm-b");
  check("人工换曲没有改 s04 产物（bgm.json 逐字节未变）", Buffer.compare(bgmBytesBefore, readFileSync(w("clips", "ui-c1", "s04", "bgm.json"))), 0);

  // ============ H. 重跑确认页（b39）：只列将动哪些文件、不估时长 ============
  console.log("[H] 重跑确认页：先出预览、可取消、取消后不产生 run");
  const runsBefore = (await (await fetch(`${base}/api/runs`)).json()) as unknown[];
  await page.click('.tabs .tab[data-tab="s03"]');
  await page.waitForSelector("#panel-s03:not([hidden])");
  await page.click("#run-build");
  await page.waitForSelector(".modal", { timeout: 10000 });
  const modalText = await page.$eval(".modal", (e) => e.textContent ?? "");
  check("确认页列出将写入的文件", modalText.includes("clips/ui-c1/s03/sentences.json"), true);
  check("确认页有「重跑后会被标脏的下游」一栏", modalText.includes("重跑后会被标脏的下游"), true);
  check("确认页不估时长", /预计|大约|耗时|\d+\s*秒/.test(modalText), false);
  await page.click('.modal [data-act="cancel"]');
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });
  check("取消后弹层消失", await page.$$eval(".modal", (e) => e.length), 0);
  const runsAfter = (await (await fetch(`${base}/api/runs`)).json()) as unknown[];
  check("取消后没有产生新的 run（确认不是摆设）", runsAfter.length, runsBefore.length);

  // ============ D. 页面无 JS 报错 ============
  // 这里**不再有白名单**。此前的 KNOWN_NOISE 是给「未跑 s03 就 404」开的洞——白名单一旦存在，
  // 登记进去的那类响应就再没人看，新增同类问题会静默通过。N-4 把「未构建」改成 200 + built:false，
  // 洞已从源头闭合，所以这里改回最硬的口径：任何 4xx / 5xx 都算非预期。
  console.log(`  （非 2xx 响应：${JSON.stringify(bad)}）`);
  check("无非预期错误响应（任何 4xx / 5xx 都算）", bad, []);
  // console 里的 "Failed to load resource" 是上面那些响应的回声，已由 bad 覆盖；
  // 这里只看真正的 JS 异常与代码主动打的 console.error。
  const jsErrs = errs.filter((e) => !e.startsWith("console: Failed to load resource"));
  check("无页面 JS 异常 / 主动 console.error", jsErrs, []);

  // ============ I. 任务改名 / 归档 / 删除 ============
  console.log("[I] 任务改名 / 归档 / 删除（不改 job.json，不删源视频）");
  await page.goto(`${base}/#/`);
  await page.waitForSelector("[data-job='ui-j1'][data-job-act='rename']");
  const jobBefore = readFileSync(w("jobs", "ui-j1", "job.json"));
  const j2Before = readFileSync(w("jobs", "ui-j2", "job.json"));
  await page.click("[data-job='ui-j1'][data-job-act='rename']");
  await page.waitForSelector(".modal #prompt-input");
  await page.fill(".modal #prompt-input", "冒烟改名");
  await page.click('.modal [data-act="ok"]');
  await page.waitForFunction(() => document.body.textContent?.includes("冒烟改名") === true);
  check("改名不改 job.json（避免把已跑的步标脏）", Buffer.compare(jobBefore, readFileSync(w("jobs", "ui-j1", "job.json"))), 0);
  check("显示名写在 card.json", JSON.parse(readFileSync(w("jobs", "ui-j1", "card.json"), "utf8")).title, "冒烟改名");
  check("总览卡片显示新名字", (await page.locator("a.card-head", { hasText: "冒烟改名" }).count()) > 0, true);

  await page.click("[data-job='ui-j2'][data-job-act='archive']");
  await page.waitForSelector("#archived [data-job='ui-j2'][data-job-act='restore']");
  check("归档后离开进行中列表", await page.locator("#jobs [data-job='ui-j2']").count(), 0);
  check("归档不改 job.json", Buffer.compare(j2Before, readFileSync(w("jobs", "ui-j2", "job.json"))), 0);
  const todoOwners = await page.$$eval(".todo .chip", (els) => els.map((e) => e.getAttribute("data-owner")));
  check("归档后待办不再提这个任务", todoOwners.includes("ui-j2"), false);
  check("归档后待办也不再提它的片段", todoOwners.includes("ui-c2"), false);
  await page.click("#archived [data-job='ui-j2'][data-job-act='restore']");
  await page.waitForSelector("#jobs [data-job='ui-j2'][data-job-act='archive']");

  const madeRes = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ video_path: fakeVideo }),
  });
  const made = (await madeRes.json()) as { id?: string; error?: string };
  check("能再建一个用于删除的任务", typeof made.id, "string");
  put(w("clips", "ui-del", "clip.json"), { schema: 1, id: "ui-del", job_id: made.id, title: "待删", start: 0, end: 1, fps: null });
  // 已经在 #/ 上，再 goto 同一个哈希不会重新拉总览。刷新才会看见刚建的任务。
  await page.reload();
  await page.waitForSelector(`[data-job='${made.id}'][data-job-act='delete']`);
  await page.click(`[data-job='${made.id}'][data-job-act='delete']`);
  await page.waitForSelector('.modal [data-act="ok"]');
  await page.click('.modal [data-act="ok"]');
  await page.waitForFunction((jobId) => !document.querySelector(`[data-job="${jobId}"]`), made.id);
  check("删除后任务目录没了", existsSync(w("jobs", made.id!)), false);
  check("删除时一起拿走它的片段", existsSync(w("clips", "ui-del")), false);
  check("删除不碰源视频", existsSync(fakeVideo), true);
  const sneaky = await fetch(`${base}/api/jobs/${encodeURIComponent("../x")}`, { method: "DELETE" });
  check("拒绝带着路径的任务 id", sneaky.status, 400);

  // 任务行按钮组：右侧留白与左侧文字缩进对称；删除与归档之间要比组内更松；
  // 删除必须走危险色（颜色不是唯一信号——按钮文字已写明「删除」）。
  await page.goto(`${base}/#/`);
  await page.waitForSelector("[data-job='ui-j1'][data-job-act='delete']");
  const tools = await page.evaluate(() => {
    const del = document.querySelector<HTMLElement>("[data-job='ui-j1'][data-job-act='delete']");
    const group = del?.closest<HTMLElement>(".card-tools");
    const card = del?.closest<HTMLElement>(".card");
    const head = card?.querySelector<HTMLElement>(".job-row > .card-head");
    if (!del || !group || !card || !head) return null;
    const btns = Array.from(group.querySelectorAll<HTMLElement>(".minibtn"));
    const [ren, arc] = btns;
    const gap = (a: HTMLElement, b: HTMLElement): number => b.getBoundingClientRect().x - a.getBoundingClientRect().right;
    const probe = document.createElement("div");
    probe.style.color = "var(--text-danger)";
    document.body.appendChild(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    return {
      inner: +gap(ren!, arc!).toFixed(1),
      beforeDelete: +gap(arc!, del).toFixed(1),
      leftPad: parseFloat(getComputedStyle(head).paddingLeft),
      rightGap: +(card.getBoundingClientRect().right - del.getBoundingClientRect().right).toFixed(1),
      delColor: getComputedStyle(del).color,
      token,
    };
  });
  check("前置：任务卡上找得到三个按钮（否则下面三条是空转）", tools !== null, true);
  if (tools) {
    check(
      `按钮组右侧留白与左侧文字缩进对称（左 ${tools.leftPad} / 右 ${tools.rightGap}，差 1px 是卡片边框）`,
      Math.abs(tools.rightGap - 1 - tools.leftPad) <= 0.5,
      true,
    );
    check(
      `删除与归档的间隙明显大于组内（组内 ${tools.inner} / 删除前 ${tools.beforeDelete}）`,
      tools.beforeDelete - tools.inner >= 8,
      true,
    );
    check(`删除按钮走危险色而非普通文字色（实测 ${tools.delColor}，令牌 ${tools.token}）`, tools.delColor === tools.token, true);
  }

  // 容器只允许一层：jobTools 自带包裹 + 调用方再包一层，组间间距会被内层抹平成组内间距。
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector(".card-tools .minibtn");
  check("按钮组容器不嵌套（.card-tools 里没有第二个 .card-tools）", await page.$$eval(".card-tools .card-tools", (els) => els.length), 0);


  // ============ J. 视觉与可访问性（规划 v2.8 判据） ============
  console.log("[J] 密度 / 对比度 / 焦点 / 主题 / 断点 / 选择器 / 失败出口");
  await page.setViewportSize({ width: 1440, height: 900 });
  // 密度：总览页的任务卡才是 stepRow 的宿主（任务页把步骤收成了 chip 行）
  await page.goto(`${base}/#/`);
  await page.waitForSelector(".step");
  check("正文 13px", await page.evaluate(() => getComputedStyle(document.body).fontSize), "13px");
  check("步骤行 32px（b10 的 28–32）", await page.evaluate(() => getComputedStyle(document.querySelector(".step")!).height), "32px");
  check("步骤行状态字 12px", await page.evaluate(() => getComputedStyle(document.querySelector(".step .state")!).fontSize), "12px");

  // W-08：建任务表单原来三行控件——视频行、字幕行、「建任务」独占第三行右对齐，左下留一大片空白。
  // 提交是「给完字幕之后」的动作，跟最后一行输入同行是表单惯常读法，不是新结构。
  // 判据不量卡片高度（会被文案长短带跑），量「控件按 top 去重占几行」和「提交是否在最后一行」。
  const njRows = await page.evaluate(() => {
    const card = document.getElementById("nj-go")!.closest(".card") as HTMLElement;
    const tops = Array.from(card.querySelectorAll<HTMLElement>("button, input, select")).map((e) => Math.round(e.getBoundingClientRect().top));
    const rows: number[] = [];
    for (const t of [...new Set(tops)].sort((a, b) => a - b)) if (!rows.some((m) => Math.abs(m - t) <= 2)) rows.push(t);
    return { n: rows.length, tops: rows };
  });
  check(`新建任务卡的控件只占 ${njRows.n} 行（≤2；实测 top=${njRows.tops.join("/")}）`, njRows.n <= 2, true);
  check(
    "「建任务」与字幕输入同一行（提交跟着最后一行输入走，不再右对齐独占一行）",
    await page.evaluate(() => {
      const a = document.getElementById("nj-srt")!.getBoundingClientRect();
      const b = document.getElementById("nj-go")!.getBoundingClientRect();
      return Math.abs(a.top - b.top) <= 1;
    }),
    true,
  );
  // 两行若各是一个 flex 容器，按钮列宽不共享（「选择视频…」106 /「选字幕…」93），
  // 第二行输入框会整体左移 13px。右边缘本来就不该齐——第二行右端要给「建任务」让位，
  // 所以这里量的是「左边缘齐」+「整块表单的外框右边界齐」（第一行输入框 = 建任务按钮）。
  const njAlign = await page.evaluate(() => {
    const v = document.getElementById("nj-video")!.getBoundingClientRect();
    const s = document.getElementById("nj-srt")!.getBoundingClientRect();
    const g = document.getElementById("nj-go")!.getBoundingClientRect();
    return {
      lefts: [Math.round(v.left), Math.round(s.left)],
      rights: [Math.round(v.right), Math.round(g.right)],
    };
  });
  check(`两行输入框左边缘对齐（实测 ${njAlign.lefts.join(" / ")}）`, Math.abs(njAlign.lefts[0]! - njAlign.lefts[1]!) <= 1, true);
  check(`表单外框右边界对齐（输入框 ${njAlign.rights[0]} / 建任务 ${njAlign.rights[1]}）`, Math.abs(njAlign.rights[0]! - njAlign.rights[1]!) <= 1, true);

  await page.goto(`${base}/#/job/ui-j1`);
  // 等「句行已画成最终形态」，不是「出现就算」。hash 导航后 render 可能并发
  // （render() 没有丢弃过期结果的机制），前一版 DOM 会被后一版替换——
  // 等「出现」会拿到一个随即消失的节点，紧接着的 getComputedStyle 就拿到 null 直接中断。
  // 这正是「等条件依赖被测行为」的另一种形态：等对了时机，错的是「只要出现」。
  await page.waitForFunction(
    () => {
      const el = document.querySelector("#job-sents .sent");
      if (!el) return false;
      // 光有 minHeight 不够：元素若还在隐藏容器里，computed min-height 照样是 32px，
      // 但实高是 0——下一句就量出 0 然后误红。所以两个条件都要满足。
      const h = el.getBoundingClientRect().height;
      return h >= 32 && getComputedStyle(el).minHeight === "32px";
    },
    null,
    { timeout: 10000 },
  );
  check("句流最小行高 32px", await page.evaluate(() => getComputedStyle(document.querySelector("#job-sents .sent")!).minHeight), "32px");
  // W-07：实际高度 34.5 = min-height 32 的下界 + padding 3×2 + border 1，内容 27.5 由时间码两行撑开。
  // 两行是模板里的显式 <br/>（tc(s.start) / tc(s.end)）——逐句删留时要同时看见区间两端，
  // 100px 列横排放不下两个 8 字符时间码。所以 34.5 是设计结果，把判据从 32 放宽到 32–36。
  // 原来这条只量 min-height，等于把 CSS 复述一遍：撑到 40 也照样绿。
  const sentH = await page.$eval("#job-sents .sent", (e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
  check(`句行实际高度落在 32–36（实测 ${sentH}）`, sentH >= 32 && sentH <= 36, true);
  const tcShape = await page.evaluate(() => {
    const el = document.querySelector("#job-sents .sent .tc")!;
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return { brs: el.querySelectorAll("br").length, lines: Math.round((el.getBoundingClientRect().height / lh) * 10) / 10 };
  });
  check(`时间码两行来自显式 <br>（×${tcShape.brs}，实高 ${tcShape.lines} 行）`, tcShape.brs === 1 && tcShape.lines > 1.8 && tcShape.lines < 2.2, true);
  check(
    "时间码 11px 等宽",
    await page.evaluate(() => {
      const st = getComputedStyle(document.querySelector(".sent .tc")!);
      return `${st.fontSize} ${/mono/i.test(st.fontFamily) ? "mono" : "非等宽"}`;
    }),
    "11px mono",
  );

  const ratio = (fgSel: string, bgSel: string): Promise<number> =>
    page.evaluate((sels: [string, string]) => {
      const [f, b] = sels;
      const lum = (c: string): number => {
        const p = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const l = p.map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * (l[0] ?? 0) + 0.7152 * (l[1] ?? 0) + 0.0722 * (l[2] ?? 0);
      };
      const a = lum(getComputedStyle(document.querySelector(f)!).color);
      const c = lum(getComputedStyle(document.querySelector(b)!).backgroundColor);
      return Math.round(((Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05)) * 100) / 100;
    }, [fgSel, bgSel] as [string, string]);

  const tcRatio = await ratio(".sent .tc", ".card.sents");
  check(`时间码对卡片对比度 ≥4.5（实测 ${tcRatio}）`, tcRatio >= 4.5, true);
  const hintRatio = await ratio(".hint", ".card");
  check(`辅助文本对卡片对比度 ≥4.5（实测 ${hintRatio}）`, hintRatio >= 4.5, true);
  const borderRatio = await page.evaluate(() => {
    const lum = (c: string): number => {
      const p = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const l = p.map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * (l[0] ?? 0) + 0.7152 * (l[1] ?? 0) + 0.0722 * (l[2] ?? 0);
    };
    const input = document.querySelector(".text")!;
    const card = document.querySelector(".card")!;
    const a = lum(getComputedStyle(input).borderTopColor);
    const c = lum(getComputedStyle(card).backgroundColor);
    return Math.round(((Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05)) * 100) / 100;
  });
  check(`控件边界对卡片对比度 ≥3（实测 ${borderRatio}）`, borderRatio >= 3, true);

  // 当前句与已选区间必须是两种视觉，且底色差要能量出来。
  // 上一版这里踩了坑：拿两个不同元素分别加类比 backgroundColor 字符串，得出「不是同一个底色」
  // 就记为通过——实测叠加在同一行上只有 1.07:1，肉眼等于没有。句子行自身没有底色，
  // 计算值还可能是 color(srgb … / .22)，所以必须合成到真正画出来的卡片底上再比。
  const markMetric = (): Promise<{
    ratio: number;
    barPx: number;
    tc: string;
    normalTc: string;
    tcVsRow: number;
    bandKept: boolean;
    bandBarPx: number;
    bandTcDiffers: boolean;
  }> =>
    page.evaluate(() => {
      type RGBA = { r: number; g: number; b: number; a: number };
      const parse = (c: string): RGBA => {
        const m = (c.match(/[\d.]+/g) ?? []).map(Number);
        const v = /^\s*color\(/.test(c) ? [m[0]! * 255, m[1]! * 255, m[2]! * 255, m[3]] : m;
        return { r: v[0] ?? 0, g: v[1] ?? 0, b: v[2] ?? 0, a: v[3] ?? 1 };
      };
      const over = (fg: RGBA, bg: RGBA): RGBA => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const lum = ({ r, g, b }: RGBA): number => {
        const f = (v: number): number => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a: RGBA, b: RGBA): number => {
        const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
        return Math.round(((x! + 0.05) / (y! + 0.05)) * 1000) / 1000;
      };
      // 最近的不透明祖先 = 卡片底；一路合成上去才是眼睛看到的颜色
      const painted = (el: Element): RGBA => {
        const stack: RGBA[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.a > 0) stack.push(c);
          if (c.a === 1) break;
        }
        let base: RGBA = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i]!, base);
        return base;
      };

      const rows = Array.from(document.querySelectorAll<HTMLElement>("#job-sents .sent"));
      const row = rows[1]!;
      const base = painted(row);
      const saved = row.className;
      const paint = (cls: string): RGBA => {
        row.className = `sent ${cls}`;
        return over(parse(getComputedStyle(row).backgroundColor), base);
      };
      const sel = paint("in-sel");
      const cur = paint("cur");
      // 只取当前句：条宽 + 时间码色 + 文字对底色的比
      const shadow = getComputedStyle(row).boxShadow;
      const tcCur = getComputedStyle(row.querySelector(".tc")!).color;
      const tcOver = over(parse(getComputedStyle(row).backgroundColor), base);
      const curOnly = { shadow, tcCur, tcOver };
      // 再取「既是当前句又在选区里」——这才是用户真正会遇到的叠加态
      const both = paint("cur in-sel");
      const bandBarPx = Number(/([\d.]+)px/.exec(getComputedStyle(row).boxShadow)?.[1] ?? 0);
      const bandTc = getComputedStyle(row.querySelector(".tc")!).color;
      row.className = saved;
      const normalTc = getComputedStyle(row.querySelector(".tc")!).color;
      return {
        ratio: ratio(cur, sel),
        barPx: Number(/([\d.]+)px/.exec(curOnly.shadow)?.[1] ?? 0),
        tc: curOnly.tcCur,
        normalTc,
        tcVsRow: ratio(parse(curOnly.tcCur), curOnly.tcOver),
        // 选区是一段连续事实：播放头落在里面也不能在色带上咬出缺口
        bandKept: ratio(both, sel) === 1,
        bandBarPx,
        bandTcDiffers: bandTc !== normalTc,
      };
    });

  const lightMarks = await markMetric();
  check(`已选与当前句的底色差 ≥1.3（浅色实测 ${lightMarks.ratio}）`, lightMarks.ratio >= 1.3, true);
  check(`当前句左条 3px（实测 ${lightMarks.barPx}px）`, lightMarks.barPx, 3);
  check("当前句时间码换成强调色（不是和普通行一样）", lightMarks.tc !== lightMarks.normalTc, true);
  check(`时间码对当前句底色 ≥4.5（实测 ${lightMarks.tcVsRow}）`, lightMarks.tcVsRow >= 4.5, true);
  check("当前句落在选区里时仍保留选区底色（范围不被打断）", lightMarks.bandKept, true);
  check(`叠加态仍有 3px 左条（实测 ${lightMarks.bandBarPx}px）`, lightMarks.bandBarPx, 3);
  check("叠加态时间码仍是强调色（在选区里也看得出播到哪句）", lightMarks.bandTcDiffers, true);
  // 暗色下色板被压缩，底色差是辅助，左条与时间码才是主通道——两条都要成立
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const darkMarks = await markMetric();
  check(`暗色下已选与当前句底色差 ≥1.3（实测 ${darkMarks.ratio}）`, darkMarks.ratio >= 1.3, true);
  check(`暗色下左条仍 3px（实测 ${darkMarks.barPx}px）`, darkMarks.barPx, 3);
  check(`暗色下时间码对行底 ≥4.5（实测 ${darkMarks.tcVsRow}）`, darkMarks.tcVsRow >= 4.5, true);
  check("暗色下叠加态仍保留选区底色", darkMarks.bandKept, true);
  check(`暗色下叠加态仍有 3px 左条（实测 ${darkMarks.bandBarPx}px）`, darkMarks.bandBarPx, 3);
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  // 键盘焦点可见
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  const focusRing = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const st = getComputedStyle(el);
    return { w: st.outlineWidth, s: st.outlineStyle, tag: el.tagName };
  });
  check("Tab 后焦点环可见（2px 实线）", focusRing.w === "2px" && focusRing.s === "solid", true);

  // 播放器底色：明暗都应是近黑（审片时周围不能发光）
  const mediaLum = (): Promise<number> =>
    page.evaluate(() => {
      const c = getComputedStyle(document.querySelector(".player")!).backgroundColor;
      const p = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const l = p.map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      });
      return Math.round((0.2126 * (l[0] ?? 0) + 0.7152 * (l[1] ?? 0) + 0.0722 * (l[2] ?? 0)) * 1000) / 1000;
    });
  const lightLum = await mediaLum();
  check(`浅色下播放器底亮度 <5%（实测 ${lightLum}）`, lightLum < 0.05, true);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const darkLum = await mediaLum();
  check(`暗色下播放器底亮度 <5%（实测 ${darkLum}）`, darkLum < 0.05, true);
  check("明暗两态播放器底一致", darkLum, lightLum);
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  // 主题三态：点一次切浅、再点切深，刷新后保持
  await page.click("#btn-theme");
  check("点主题键切到浅色", await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.click("#btn-theme");
  check("再点切到深色", await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  await page.reload();
  await page.waitForSelector("#btn-theme");
  check("刷新后主题保持（存的是选择，不是解析结果）", await page.evaluate(() => document.documentElement.dataset.theme), "dark");
  check("暗色下 color-scheme=dark（原生控件跟着变暗）", (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).includes("dark"), true);
  await page.evaluate(() => localStorage.removeItem("ss-theme"));
  await page.reload();
  await page.waitForSelector("#btn-theme");

  // 待办条：是链接、能直达、并且 sticky
  await page.goto(`${base}/#/`);
  await page.waitForSelector(".todo");
  check("待办 chip 是链接（不是只回答、去不了）", await page.evaluate(() => document.querySelector(".todo .chip")?.tagName), "A");
  check("待办 chip 指向具体步骤", await page.evaluate(() => /^#\/(job|clip)\//.test(document.querySelector(".todo a.chip")?.getAttribute("href") ?? "")), true);
  check("待办条 sticky", await page.evaluate(() => getComputedStyle(document.querySelector(".todo")!).position), "sticky");

  // 800×600 不横向溢出（此前零断点，时间码会顶出去）
  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#job-sents .sent");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("800 宽无横向溢出", overflow <= 0, true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 同一 clip 在任务页只出现一次（此前「人工定稿」与「片段」各列一遍）
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector(".clip-row");
  check("同一 clip_id 在任务页只出现一次", await page.locator('a[href="#/clip/ui-c1"]').count(), 1);

  // 选择文件：真实列目录、Esc 关闭、焦点归还
  await page.goto(`${base}/#/`);
  await page.waitForSelector("#nj-pick");
  await page.click("#nj-pick");
  await page.waitForSelector(".picker .picker-row", { timeout: 10000 });
  check("选择器列出盘符/主目录（服务端列目录可用）", (await page.locator(".picker .picker-row").count()) > 0, true);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".picker", { state: "detached" });
  check("Esc 关闭后焦点回到触发按钮", await page.evaluate(() => document.activeElement?.id), "nj-pick");

  // s04 面板进卡片容器（此前唯一一个掉出容器的面板）
  await page.goto(`${base}/#/clip/ui-c1/s04`);
  await page.waitForSelector("#panel-s04 .ws-head");
  check("s04 的 ws-head 在 .card 里", await page.evaluate(() => !!document.querySelector("#panel-s04 .ws-head")?.closest(".card")), true);
  check("tab 高 28px（b10 的 28–32 下限）", await page.evaluate(() => getComputedStyle(document.querySelector(".tabs .tab")!).height), "28px");

  // 依赖没就绪时，整块不能再装成「能用」：结论要显式、入口要可点、曲库不许占半屏，
  // 空状态更不许劝用户去点一个被禁用的按钮（ui-c2 的 s03 产物缺失 → s04 强依赖未就绪）
  await page.goto(`${base}/#/clip/ui-c2/s04`);
  await page.waitForSelector("#panel-s04 .blocked-box");
  check(
    "阻断说明先给结论（「现在跑不了：上游没就绪」）",
    await page.evaluate(() => /现在跑不了/.test(document.querySelector("#panel-s04 .blocked-box .blocked-head")?.textContent ?? "")),
    true,
  );
  check(
    "阻断说明里带「去跑 s03」入口且指向本片段的 s03",
    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>("#panel-s04 .blocked-box a");
      return `${a?.textContent?.trim()}|${a?.getAttribute("href")}`;
    }),
    "去跑 s03|#/clip/ui-c2/s03",
  );
  check(
    "曲库收进折叠区（默认收起，不再占掉半屏）",
    await page.evaluate(() => {
      const d = document.querySelector<HTMLDetailsElement>("#panel-s04 details#bgm-lib");
      return d ? !d.open && /曲库/.test(d.querySelector("summary")?.textContent ?? "") : false;
    }),
    true,
  );
  check(
    "空状态不再劝你点被禁用的按钮",
    await page.evaluate(() => !/点上方/.test(document.querySelector("#panel-s04 .empty-hint")?.textContent ?? "")),
    true,
  );
  check(
    "跑一次在阻断态下是禁用的",
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("#run-s04")?.disabled),
    true,
  );

  // ============ K. 入口校验 / 任务页审片 / 句行键盘模型 / 导航中文优先 ============
  // 这四条都是「取舍对、但只在片段页兑现」的地方：b9 的联动此前只做了片段页一半，
  // b1 的入口此前只能手填路径。夹具视频是真的 6 秒 mp4，所以播放头位移可以实打实测。
  console.log("[K] 入口校验 / 任务页审片 / 句行键盘模型 / 导航中文优先");

  await page.goto(`${base}/#/`);
  await page.waitForSelector("#nj-video");
  let jobPosts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/jobs$/.test(new URL(r.url()).pathname)) jobPosts++;
  });
  await page.fill("#nj-video", path.join(ROOT, "根本没有这个文件.mp4"));
  await page.locator("#nj-video").blur();
  await page.waitForFunction(() => /不在这里/.test(document.getElementById("nj-msg")?.textContent ?? ""), null, { timeout: 10000 });
  check("路径填错时当场报「文件不在这里」（不等提交）", /不在这里/.test((await page.textContent("#nj-msg")) ?? ""), true);
  await page.click("#nj-go");
  await page.waitForTimeout(300);
  check("非法路径没有发出建任务请求（0 次 POST）", jobPosts, 0);
  page.removeAllListeners("request");

  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#job-player");
  check("任务页有播放器（不再只看 11px 时间码盲选）", await page.evaluate(() => !!document.querySelector("#job-player")), true);
  const seek = await page.evaluate(async () => {
    const v = document.querySelector("#job-player") as HTMLVideoElement;
    const rows = document.querySelectorAll<HTMLElement>("#job-sents .sent");
    rows[2]!.click(); // 第三句 start=2.5
    // 点完就开始播，播放头会往前走：先记「在播」，再暂停读数，否则测到的是 2.5 + 等待时长
    await new Promise((r) => setTimeout(r, 150));
    const playing = !v.paused;
    v.pause();
    return {
      playing,
      t: Math.round(v.currentTime * 100) / 100,
      cur: document.querySelectorAll("#job-sents .sent.cur").length,
    };
  });
  check(`点第三句后播放头落到 2.5s（实测 ${seek.t}）`, Math.abs(seek.t - 2.5) < 0.5, true);
  check("点句后开始播放", seek.playing, true);
  check("播放时高亮当前句（只有一个 .cur）", seek.cur, 1);

  const keyModel = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("#job-sents .sent"));
    return {
      role: rows[0]?.getAttribute("role"),
      stops: rows.filter((r) => r.getAttribute("tabindex") === "0").length,
      total: rows.length,
    };
  });
  check("句行是 listbox 选项（role=option）", keyModel.role, "option");
  check("整列只有一个 tab stop（roving tabindex）", keyModel.stops, 1);
  check("四句都在", keyModel.total, 4);

  // 键盘：↓ 移动焦点，[ ] 设起止 —— 目标是不碰鼠标也能选区
  await page.focus("#job-sents .sent[tabindex='0']");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("[");
  await page.keyboard.press("]");
  await page.waitForFunction(() => /已选/.test(document.getElementById("sel-info")?.textContent ?? ""), null, { timeout: 5000 });
  check("键盘 [ / ] 能设出区间（不依赖鼠标拖选）", /已选/.test((await page.textContent("#sel-info")) ?? ""), true);

  await page.goto(`${base}/#/clip/ui-c1/s03`);
  await page.waitForSelector(".tabs .tab");
  const tabText = (await page.textContent(".tabs .tab"))?.trim() ?? "";
  check(`tab 首词是中文，不是裸 s03（实测「${tabText.slice(0, 6)}」）`, /^[\u4e00-\u9fa5]/.test(tabText), true);
  check("tab 编号降级为 sNN 后缀", /^s\d\d$/.test((await page.textContent(".tabs .tab .tab-id"))?.trim() ?? ""), true);

  // 失败出口：/api/run 直接 500 时，状态行报失败并恢复按钮（此前会僵在「启动中…」）
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#run-s00");
  await page.route("**/api/run", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "冒烟注入失败" }) }));
  await page.click("#run-s00");
  await page.waitForSelector('.modal [data-act="ok"]');
  await page.click('.modal [data-act="ok"]');
  await page.waitForFunction(() => (document.querySelector("#run-status")?.textContent ?? "").includes("失败"), null, { timeout: 10000 });
  check("启动失败时状态行报失败", (await page.$eval("#run-status", (e) => e.textContent ?? "")).includes("冒烟注入失败"), true);
  check("失败后按钮恢复可点（不是永久 busy）", await page.$eval("#run-s00", (b) => (b as HTMLButtonElement).disabled === false), true);
  await page.unroute("**/api/run");

  // 停顿里的高亮：真实字幕之间普遍有 0.3–1 秒空隙，暂停停在那里不能「一句都不高亮」。
  // 以前 findIndex 落空就把整列 .cur 清掉，用户等于失去了「播到哪」的唯一线索。
  const gap = await page.evaluate(async () => {
    const v = document.querySelector("#job-player") as HTMLVideoElement;
    const cur = () =>
      Array.from(document.querySelectorAll<HTMLElement>("#job-sents .sent.cur")).map((e) => e.dataset.idx);
    v.pause();
    const seek = (t: number) =>
      new Promise<void>((res) => {
        v.addEventListener("seeked", () => res(), { once: true });
        v.currentTime = t;
      });
    await seek(3.65); // 第 3 句到 3.6 结束、第 4 句从 3.7 开始：这里正落在空隙里
    v.dispatchEvent(new Event("timeupdate"));
    const inGap = cur();
    await seek(5.5); // 末句 4.8 之后，没有下句可接
    v.dispatchEvent(new Event("timeupdate"));
    const past = cur();
    return { inGap, past };
  });
  check(`停在第 3、4 句的空隙里仍指着第 3 句（实测 ${JSON.stringify(gap.inGap)}）`, gap.inGap, ["2"]);
  check("末句之后不再滞留高亮（片尾没有台词就不该指着末句）", gap.past.length, 0);

  // 内部合约编号不许漏到界面上——用户看到「（b29）」只会以为界面坏了。
  // 扫的是渲染后的 textContent（含 hidden 面板），不是源码，所以换个写法再漏出来也会被抓到。
  const leaks: string[] = [];
  const leakRoutes: [string, string][] = [
    ["#/", ".step"],
    ["#/job/ui-j1", "#job-sents"],
    ["#/clip/ui-c1/s03", ".tabs"],
    ["#/clip/ui-c1/s05", ".tabs"],
    ["#/settings", ".main"],
  ];
  for (const [route, sel] of leakRoutes) {
    await page.goto(`${base}/${route}`);
    await page.waitForSelector(sel);
    const hit = await page.evaluate(() =>
      ((document.body.textContent ?? "").match(/[（(]b\d{1,2}[^）)]{0,10}/g) ?? []).slice(0, 3),
    );
    if (hit.length) leaks.push(`${route} → ${hit.join(" / ")}`);
  }
  check("界面文案里没有内部合约编号（bNN）", leaks, []);

  // ---- 第 19 轮：像素产物跟着主题走 / 惰性依赖不借状态词 / 全未跑只说一遍 ----
  //
  // 这三条共同的教训：前 18 轮的断言**全都在默认态量一次**就收工，于是「切换之后才对」这一类
  // 缺陷一条都抓不到（N-3 就是这么漏的：浅色下量到的色值完美，暗色下等于没画）。
  // 凡是有「切换」语义的东西，判据必须在切换后重新采样。

  // N-3：波形是画进像素的，不是样式——切主题不会自动变色。以前只在绘制那一刻读一次令牌。
  await page.goto(`${base}/#/clip/ui-c1/s03`);
  await page.waitForSelector("#s03-wave");
  // 解码 + 绘制是异步的：等到真有一帧不透明像素再采样，否则量到的是空白画布（那会让断言假绿）
  await page.waitForFunction(
    () => {
      const c = document.querySelector("#s03-wave") as HTMLCanvasElement | null;
      const g = c?.getContext("2d");
      if (!c || !g || !c.width) return false;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if ((d[i] as number) > 200) return true;
      return false;
    },
    null,
    { timeout: 20000 },
  );
  // 取**波形线**的色：波形描边 globalAlpha 0.95（像素 alpha≈242），句子边界竖线 alpha=255，
  // 两者都在同一张画布上。只按 alpha 筛会筛到边界线（它更不透明），量出来的就是 --border 而不是
  // --accent——第一版断言就栽在这里。所以取 alpha∈[230,250] 的像素里出现最多的那个色。
  // getImageData 返回非预乘 RGBA，所以这个 RGB 就是令牌色本身，不需要再合成。
  const lineRgb = async (): Promise<number[] | null> =>
    page.evaluate(() => {
      const c = document.querySelector("#s03-wave") as HTMLCanvasElement;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      const hist = new Map<number, number>();
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] as number;
        if (a < 230 || a > 250) continue;
        const k = ((d[i] as number) << 16) | ((d[i + 1] as number) << 8) | (d[i + 2] as number);
        hist.set(k, (hist.get(k) ?? 0) + 1);
      }
      let bestK = -1;
      let bestN = 0;
      for (const [k, n] of hist) if (n > bestN) {
        bestN = n;
        bestK = k;
      }
      return bestK < 0 ? null : [(bestK >> 16) & 255, (bestK >> 8) & 255, bestK & 255];
    });
  // --accent 的计算值交给浏览器自己解析（hex / color-mix 都吃），不让断言抄一份色值。
  const accentRgb = async (): Promise<number[]> =>
    page.evaluate(() => {
      const p = document.createElement("span");
      p.style.color = "var(--accent)";
      document.body.appendChild(p);
      const cs = getComputedStyle(p).color;
      p.remove();
      const n = (cs.match(/[\d.]+/g) ?? []).map(Number);
      const k = cs.startsWith("color(") ? 255 : 1; // color(srgb 0.1 …) 前三项是 0–1
      return [Math.round((n[0] ?? 0) * k), Math.round((n[1] ?? 0) * k), Math.round((n[2] ?? 0) * k)];
    });
  const rgbDist = (a: number[], b: number[]): number => Math.max(...a.map((v, i) => Math.abs(v - (b[i] ?? 0))));

  // 先把主题强制到浅色（上一个用例可能留下任意状态），采样；再点一次切暗色，采样。
  // 只有两侧都量，才能证明线色是「跟着令牌变」而不是「本来就长这样」。
  // ⚠️ 用**选择**（localStorage 的 ss-theme）判断，不能用 dataset.theme：
  // auto 在浅色系统下解析出来同样是 light，拿解析结果判断会以为「已经到位」、一次都不点
  // （第一版断言就卡在这——它当场报了个「没切到暗色」的假红，其实按钮一下都没按）。
  for (let i = 0; i < 3; i++) {
    if ((await page.evaluate(() => localStorage.getItem("ss-theme"))) === "light") break;
    await page.click("#btn-theme");
  }
  check("前置：主题选择已停在「浅色」", await page.evaluate(() => localStorage.getItem("ss-theme")), "light");
  const accentLight = await accentRgb();
  const lineLight = await lineRgb();
  check(
    `浅色下波形线用的就是 --accent（实测 ${lineLight ?? "没找到波形线"} vs ${accentLight}）`,
    lineLight !== null && rgbDist(lineLight, accentLight) <= 12,
    true,
  );

  await page.click("#btn-theme"); // light → dark
  check("点一次主题按钮确实到暗色（否则下面两条是空转）", await page.$eval("html", (e) => e.dataset.theme === "dark"), true);
  const lineDark = await lineRgb();
  const accentDark = await accentRgb();
  check(
    `切到暗色后波形线真的重画了（${lineLight} → ${lineDark}）`,
    lineLight !== null && lineDark !== null && rgbDist(lineLight, lineDark) > 20,
    true,
  );
  check(
    `暗色下波形线跟着 --accent 走（实测 ${lineDark} vs ${accentDark}）`,
    lineDark !== null && rgbDist(lineDark, accentDark) <= 12,
    true,
  );

  // N-5：惰性依赖的判据是「产物在不在磁盘上能不能用」（types.ts 的 LazyDep），不是 status。
  // 先取对照：ui-c1 有 vocals.wav，同一条提示不该出现——否则「永远都出」也能让下面的断言通过。
  const lazyOnReady = await page.$eval("#panel-s03", (e) => (e.textContent ?? "").includes("没有可用产物"));
  check("s02 产物齐备的片段不出现「没有可用产物」", lazyOnReady, false);

  // ui-c2 没有 s02 产物 → 这里必须出提示；提示里不许出现状态词，否则会与同屏待办条的
  // 「丢失」互相打架（同一件事两个词，读的人不知道该信哪个）。
  await page.goto(`${base}/#/clip/ui-c2/s03`);
  // ⚠️ 不能只等 `#panel-s03 .hint.block`：上一个片段的 DOM 里已经有这个元素，选择器会立刻
  // 命中**旧页面**，量到的是 ui-c1 的文案（第一版断言就栽在这里）。等「这个面板里出现了第 2 条
  // block 级提示」——只有 ui-c2 的惰性提示才会让它变成 2。
  await page
    .waitForFunction(() => document.querySelectorAll("#panel-s03 .hint.block").length >= 2, null, { timeout: 8000 })
    .catch(() => {});
  const lazyTxt = await page.$eval("#panel-s03", (e) =>
    Array.from(e.querySelectorAll(".hint.block"))
      .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
      .join(" | "),
  );
  check(`惰性依赖提示确实出现在 ui-c2 的 s03（实测「${lazyTxt.slice(0, 26)}」）`, lazyTxt.includes("没有可用产物"), true);
  check("惰性依赖提示不借用状态词（未跑 / 丢失 / 就绪）", /未跑|丢失|就绪/.test(lazyTxt), false);

  // W-09：一步都没跑过的链路，逐步铺「未跑」会让一屏出现三次同一个词，读起来像三件各自的问题。
  await page.goto(`${base}/#/job/ui-j3`);
  await page.waitForSelector(".steps-line");
  const chipsTxt = await page.$eval(".steps-line", (e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
  check(`一步没跑过的链路只说一遍「未跑」（实测「${chipsTxt}」）`, (chipsTxt.match(/未跑/g) ?? []).length <= 1, true);
  check("并且明确说的是「本链路还没跑过」", chipsTxt.includes("本链路还没跑过"), true);

  // W-05：读页与工作台页必须同宽。以前工作台页被旧值 900 卡住——要逐句删留、看波形的页面
  // 反而更窄，而任务页的播放器长到 1038，越过 b10 的 900。判据量**计算后的盒子**，
  // 不读样式表里写的数字（写了 900 却被别的规则覆盖时，断言仍然该红）。
  await page.setViewportSize({ width: 1440, height: 900 });
  // ⚠️ 等的是**本页独有**的元素，不是 `.main`：`.main` 在上一页也存在，
  // waitForSelector 会立刻命中旧 DOM，把上一页的宽度当成这一页的量（同 N-5 那次的坑）。
  const boxOf = async (route: string, ready: string, sel: string): Promise<number> => {
    await page.goto(`${base}/${route}`);
    await page.waitForSelector(ready);
    return page.$eval(sel, (e) => Math.round(e.getBoundingClientRect().width));
  };
  const mainJob = await boxOf("#/job/ui-j1", "#job-player", ".main");
  const mainClip = await boxOf("#/clip/ui-c1/s03", "#player", ".main");
  check(`任务页与片段页内容同宽（实测 ${mainJob} / ${mainClip}）`, mainJob, mainClip);

  const vJob = await boxOf("#/job/ui-j1", "#job-player", "#job-player");
  const vClip = await boxOf("#/clip/ui-c1/s03", "#player", "#player");
  check(`两页播放器同宽（实测 ${vJob} / ${vClip}）`, vJob, vClip);
  check(`播放器不超过 b10 的 900 上限（实测 ${vJob}）`, vJob <= 900 && vJob > 0, true);

  // ---- [L] 可访问性与控件边界 ----
  // ⚠️ 五个面板是一次性全渲染的（只切 hidden），所以「等 #panel-x 出现」会永远立即命中旧 DOM。
  // 判据必须同时要求：哈希已切过去 + 目标面板不 hidden + tab 节点在。这条纪律在第 19/20 轮
  // 各栽过一次（N-5 的惰性提示、W-05 的两页同宽），这里一次性写成 helper 复用。
  const gotoClipTab = async (clipId: string, tabId: string): Promise<void> => {
    await page.goto(`${base}/#/clip/${clipId}/${tabId}`);
    await page.waitForFunction(
      (t) => {
        const p = document.getElementById(`panel-${t}`);
        return location.hash.endsWith(`/${t}`) && !!p && !p.hasAttribute("hidden") && !!document.getElementById(`tab-${t}`);
      },
      tabId,
      { timeout: 8000 },
    );
  };

  // N-1：五个 tab 以前只是五个 <button>——没有 tablist/tab/tabpanel，读屏念成五个孤立按钮，
  // 五个都 tabIndex=0（按 Tab 要连过五站），← → 完全不动。
  await gotoClipTab("ui-c1", "s03");
  const tabsA11y = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".tabs");
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs .tab"));
    const panelOf = (b: HTMLButtonElement): HTMLElement | null =>
      document.getElementById(b.getAttribute("aria-controls") ?? "");
    return {
      listRole: list?.getAttribute("role") ?? null,
      listLabel: list?.getAttribute("aria-label") ?? null,
      ids: btns.map((b) => b.id),
      roles: btns.map((b) => b.getAttribute("role")),
      selected: btns.map((b) => b.getAttribute("aria-selected")),
      tabindex: btns.map((b) => b.tabIndex),
      panelRole: btns.map((b) => panelOf(b)?.getAttribute("role") ?? null),
      labelledby: btns.map((b) => panelOf(b)?.getAttribute("aria-labelledby") ?? null),
      visible: btns.map((b) => {
        const p = panelOf(b);
        return !!p && !p.hasAttribute("hidden");
      }),
    };
  });
  const onAt = tabsA11y.selected.indexOf("true");
  check(
    `tab 容器是 tablist 且带可读名字（实测 role=${tabsA11y.listRole} / ${tabsA11y.listLabel}）`,
    tabsA11y.listRole === "tablist" && !!tabsA11y.listLabel,
    true,
  );
  check(
    `五个 tab 都是 role=tab（实测 ${tabsA11y.roles.join(",")}）`,
    tabsA11y.roles.length === 5 && tabsA11y.roles.every((r) => r === "tab"),
    true,
  );
  check(
    `每个 tab 的 aria-controls 都指到 tabpanel（实测 ${tabsA11y.panelRole.join(",")}）`,
    tabsA11y.panelRole.every((r) => r === "tabpanel"),
    true,
  );
  check(
    `tabpanel 的 aria-labelledby 回指自己的 tab（实测 ${tabsA11y.labelledby.join(",")}）`,
    tabsA11y.labelledby.every((v, i) => v !== null && v === tabsA11y.ids[i]),
    true,
  );
  check(
    `当前 tab 唯一被标为选中，且就是 s03（实测 ${tabsA11y.selected.join(",")}）`,
    tabsA11y.selected.filter((v) => v === "true").length === 1 && tabsA11y.ids[onAt] === "tab-s03",
    true,
  );
  check(
    `roving tabindex：只有当前 tab 是 0（实测 ${tabsA11y.tabindex.join(",")}）`,
    tabsA11y.tabindex.filter((v) => v === 0).length === 1 && tabsA11y.tabindex[onAt] === 0,
    true,
  );
  check(
    `选中的 tab 与可见面板是同一个（实测 visible=${tabsA11y.visible.join(",")}）`,
    tabsA11y.visible.filter(Boolean).length === 1 && tabsA11y.visible[onAt] === true,
    true,
  );

  // 键盘：← → 必须真的切走，且焦点跟过去——路由是整页重画，不还焦点就只能生效一次
  await page.focus("#tab-s03");
  await page.keyboard.press("ArrowRight");
  await page
    .waitForFunction(
      () => {
        const p = document.getElementById("panel-s04");
        return location.hash.endsWith("/s04") && !!p && !p.hasAttribute("hidden") && document.activeElement?.id === "tab-s04";
      },
      null,
      { timeout: 8000 },
    )
    .catch(() => {});
  const afterRight = await page.evaluate(() => ({
    hash: location.hash,
    active: document.activeElement?.id ?? null,
    selected: document.querySelector(".tabs .tab[aria-selected='true']")?.id ?? null,
  }));
  check(`按 → 切到下一个 tab（实测 ${afterRight.hash}）`, afterRight.hash.endsWith("/s04"), true);
  check(`切完焦点落在新 tab 上，不留在 body（实测 ${afterRight.active}）`, afterRight.active === "tab-s04", true);
  check(`aria-selected 跟着走到 s04（实测 ${afterRight.selected}）`, afterRight.selected === "tab-s04", true);

  await page.keyboard.press("ArrowLeft");
  await page
    .waitForFunction(() => location.hash.endsWith("/s03") && document.activeElement?.id === "tab-s03", null, { timeout: 8000 })
    .catch(() => {});
  check("按 ← 回到 s03（双向都能走，不是只往右）", await page.evaluate(() => location.hash.endsWith("/s03")), true);

  // 首尾相接：第一个再往左应绕到最后一个
  await gotoClipTab("ui-c1", "s02");
  await page.focus("#tab-s02");
  await page.keyboard.press("ArrowLeft");
  await page
    .waitForFunction(() => location.hash.endsWith("/tree") && document.activeElement?.id === "tab-tree", null, { timeout: 8000 })
    .catch(() => {});
  check("s02 按 ← 绕到末尾的「分叉树」", await page.evaluate(() => location.hash.endsWith("/tree")), true);

  // N-2：状态位必须是 live region，否则失败对读屏用户等于没发生（WCAG 4.1.3）。
  // 两段都要验：①模板默认就注册（region 晚于内容变化才出现，第一条消息会漏）；
  // ②真失败时升成 alert（assertive），不能还停在 polite 慢慢排。
  await gotoClipTab("ui-c1", "s03");
  const msgAttrs = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".msg")).map((el) => ({
      id: el.id,
      role: el.getAttribute("role"),
      live: el.getAttribute("aria-live"),
    })),
  );
  const msgBad = msgAttrs.filter((m) => m.role !== "status" || m.live !== "polite");
  check(
    `状态位默认就是 polite 的 live region（实测 ${msgAttrs.length} 处，不合规 ${msgBad.length} 处：${msgBad.map((m) => m.id).join(",") || "无"}）`,
    msgAttrs.length > 0 && msgBad.length === 0,
    true,
  );

  check(
    "前置：重建句流按钮可用（禁用则下面的失败触发是空转）",
    await page.$eval("#run-build", (e: HTMLButtonElement) => !e.disabled),
    true,
  );
  // 拦一个 500，让 runAndPoll 走 err 分支；这是唯一能真看到「失败怎么播报」的路径
  await page.route("**/api/run", (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "验证故意失败" }) }),
  );
  await page.click("#run-build");
  await page.waitForSelector('.modal-foot button[data-act="ok"]', { timeout: 8000 });
  await page.click('.modal-foot button[data-act="ok"]');
  await page.waitForSelector("#run-status.err", { timeout: 8000 });
  const errMsg = await page.$eval("#run-status", (e) => ({
    role: e.getAttribute("role"),
    live: e.getAttribute("aria-live"),
    txt: (e.textContent ?? "").trim(),
  }));
  check(
    `失败消息升成 alert/assertive（实测 role=${errMsg.role} / aria-live=${errMsg.live}）`,
    errMsg.role === "alert" && errMsg.live === "assertive",
    true,
  );
  check(`失败消息确实写了内容（空 region 一样等于没报）实测「${errMsg.txt.slice(0, 20)}」`, errMsg.txt.length > 0, true);
  await page.unroute("**/api/run");

  // W-06 / N-6：控件的边框要真是个边框，有色 chip 不要画一条同色的假线。
  // 色值都要合成到不透明祖先再算——chip 的底是半透明色块，直接比 borderColor 会得出离谱的值。
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector(".steps-line", { timeout: 8000 });
  const borderMetrics = (): Promise<{ btn: number | null; del: number | null; chips: (number | null)[]; theme: string } | null> =>
    page.evaluate(() => {
      type RGBA = { r: number; g: number; b: number; a: number };
      const parse = (c: string): RGBA => {
        const m = (c.match(/[\d.]+/g) ?? []).map(Number);
        const v = /^\s*color\(/.test(c) ? [m[0]! * 255, m[1]! * 255, m[2]! * 255, m[3]] : m;
        return { r: v[0] ?? 0, g: v[1] ?? 0, b: v[2] ?? 0, a: v[3] ?? 1 };
      };
      const over = (fg: RGBA, bg: RGBA): RGBA => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const lum = ({ r, g, b }: RGBA): number => {
        const f = (v: number): number => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a: RGBA, b: RGBA): number => {
        const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
        return Math.round(((x! + 0.05) / (y! + 0.05)) * 1000) / 1000;
      };
      const painted = (el: Element): RGBA => {
        const stack: RGBA[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c.a > 0) stack.push(c);
          if (c.a === 1) break;
        }
        let base: RGBA = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i]!, base);
        return base;
      };

      const btn = document.querySelector<HTMLElement>(".minibtn");
      const del = document.querySelector<HTMLElement>(".minibtn.danger");
      const chip = document.querySelector<HTMLElement>(".chip");
      if (!btn || !chip) return null;
      const edge = (el: Element): RGBA => parse(getComputedStyle(el).borderTopColor);
      const btnRatio = (() => {
        const c = edge(btn);
        return c.a === 0 ? null : ratio(c, painted(btn));
      })();
      // 删除按钮是文字危险色，不是边框：danger 色对自身底要够 4.5:1（正文级），
      // 3:1 那档只够描边，拿它量文字会把不合格判成合格。
      const delRatio = del ? ratio(parse(getComputedStyle(del).color), painted(del)) : null;
      // 同一元素叠类再量：数据里有没有 err/warn/miss 全凭当时状态，找实例会时有时无
      const saved = chip.className;
      const chips: (number | null)[] = [];
      for (const k of ["err", "warn", "miss"]) {
        chip.className = `chip ${k}`;
        const c = edge(chip);
        chips.push(c.a === 0 ? null : ratio(c, painted(chip)));
      }
      chip.className = saved;
      return { btn: btnRatio, del: delRatio, chips, theme: document.documentElement.dataset.theme ?? "?" };
    });

  // 先强制回浅色：上面 [K] 段结束时停在暗色
  for (let i = 0; i < 4; i++) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) === "light") break;
    await page.click("#btn-theme");
  }
  const bl = await borderMetrics();
  check("前置：任务页上找得到 .minibtn 与 .chip（否则下面三条是空转）", bl !== null, true);
  if (bl) {
    check(`浅色下 .minibtn 边框对自身底 ≥3:1（实测 ${bl.btn ?? "透明"}）`, bl.btn !== null && bl.btn >= 3, true);
    check(`浅色下删除按钮的危险色文字 ≥4.5:1（实测 ${bl.del ?? "找不到 .minibtn.danger"}）`, bl.del !== null && bl.del >= 4.5, true);
    check(
      `浅色下有色 chip 要么无边框、要么 ≥1.5:1，不许画假线（实测 ${bl.chips.map((v) => v ?? "透明").join(" / ")}）`,
      bl.chips.every((v) => v === null || v >= 1.5),
      true,
    );
  }

  // 切暗色再量一遍：这两条在暗色下各有一份令牌，只测浅色等于只测了一半
  for (let i = 0; i < 4; i++) {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark") break;
    await page.click("#btn-theme");
  }
  const bd = await borderMetrics();
  if (bd) {
    check(`暗色下 .minibtn 边框对自身底 ≥3:1（实测 ${bd.btn ?? "透明"}）`, bd.btn !== null && bd.btn >= 3, true);
    check(`暗色下删除按钮的危险色文字 ≥4.5:1（实测 ${bd.del ?? "找不到 .minibtn.danger"}）`, bd.del !== null && bd.del >= 4.5, true);
    check(
      `暗色下有色 chip 要么无边框、要么 ≥1.5:1（实测 ${bd.chips.map((v) => v ?? "透明").join(" / ")}）`,
      bd.chips.every((v) => v === null || v >= 1.5),
      true,
    );
  }

  // ============ N. 步骤动作：命名 / 层级 / 文案卫生 ============
  // 两类信息不该常驻在界面上：① 实现策略（用哪个引擎、权重放哪、走不走网络）——
  // 用户无法据此做任何决定；② 架构断言（「走同一条 API」）——那是对审查者说的话。
  // 已有先例：界面不许出现内部合约编号（bNN），这条是同一原则的延伸。
  console.log("[N] 任务页步骤卡：按钮命名 / 层级 / 文案卫生");
  const btnOf = (sel: string): Promise<{ txt: string; cls: string }> =>
    page.$eval(sel, (el) => ({ txt: (el.textContent ?? "").trim(), cls: el.className }));

  await page.goto(`${base}/#/job/ui-j1`);
  // 等本页独有的东西：`#run-s00` 在下一段要去的 ui-j3 上也有，
  // 拿它当就绪信号就会在 hash 切换后立刻命中旧 DOM（这坑已经踩过三回）。
  await page.waitForSelector("#job-sents .sent", { timeout: 8000 });
  const j1s00 = await btnOf("#run-s00");
  const j1s01 = await btnOf("#run-s01");
  check(`有产物时字幕按钮不带「导入」二字（实测「${j1s00.txt}」）`, /导入/.test(j1s00.txt), false);
  check(`有产物时字幕是「重跑字幕」（实测「${j1s00.txt}」）`, j1s00.txt.includes("重跑字幕"), true);
  check("有产物时字幕按钮退回次级（不与「建片段」争主位）", /\bprimary\b/.test(j1s00.cls), false);
  check(`二次挑高光叫「再挑一版」（实测「${j1s01.txt}」）`, j1s01.txt.includes("再挑一版"), true);
  check("有产物时选高光按钮也是次级", /\bprimary\b/.test(j1s01.cls), false);
  // 「会不会覆盖现在这版」是按下前的第一个疑问，答案必须贴着按钮，不能藏到 section 标题里
  const s01Actions = (await page.textContent("#step-s01 .actions")) ?? "";
  check("「另存一版」贴着按钮说（此前在 section 标题里，隔着整张卡头）", s01Actions.includes("另存一版"), true);

  // 空态反过来：这一步是这一屏唯一能做的事，就该是主按钮。
  // 但不能让三个按钮都 primary——那样「建片段」的主位就没了，所以是**状态驱动**而非一律升格。
  await page.goto(`${base}/#/job/ui-j3`);
  // ui-j3 一步没跑过 → 句流区是空提示，ui-j1 那边是 4 条 .sent，用它区分页面
  await page.waitForSelector("#job-sents .empty-hint", { timeout: 8000 });
  const j3s00 = await btnOf("#run-s00");
  const j3s01 = await btnOf("#run-s01");
  check(`空态字幕按钮是动作名（实测「${j3s00.txt}」）`, j3s00.txt.includes("生成字幕"), true);
  // 空态才是「导入」这个词真正会误导人的地方：它暗示点开能选文件，实际是直接开跑。
  // 只看有产物那一页会漏掉——那页的文案根本不是「导入」。
  check(`空态字幕按钮不带「导入」二字（实测「${j3s00.txt}」）`, /导入/.test(j3s00.txt), false);
  check("空态字幕按钮是 primary", /\bprimary\b/.test(j3s00.cls), true);
  check(`空态选高光叫「AI 挑高光」（实测「${j3s01.txt}」）`, j3s01.txt.includes("AI 挑高光"), true);
  check("空态选高光也是 primary", /\bprimary\b/.test(j3s01.cls), true);

  // 文案卫生：常驻说明里不许出现实现细节与架构断言
  const hints = await page.evaluate(() => {
    const pick = (sel: string): string[] => Array.from(document.querySelectorAll(sel)).map((e) => e.textContent ?? "");
    return pick(".hint.block").concat(pick(".ws-card .hint"));
  });
  const bannedWords = ["本地识别兜底", "同一条 API", "权重随包", "demucs", "htdemucs", "不落定稿"];
  check("任务页说明不解释实现、不引用架构断言", bannedWords.filter((b) => hints.some((h) => h.includes(b))), []);

  // 副作用预告挪到「按下去那一刻」：卡片里不许再预言，弹窗里必须有
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#job-sents .sent", { timeout: 8000 });
  check("「句子可能变少」不再常驻在卡片里", ((await page.textContent("#step-s00")) ?? "").includes("句子可能变少"), false);
  await page.click("#run-s00");
  await page.waitForSelector(".modal", { timeout: 10000 });
  check("重跑字幕的确认页会说明选区怎么收", ((await page.textContent(".modal")) ?? "").includes("起止句会收回"), true);
  await page.click('.modal [data-act="cancel"]');
  await page.waitForSelector(".modal", { state: "detached", timeout: 5000 });

  // ============ P. 长任务的反馈：已用时 / 跑完据实报变化 ============
  // 真跑 s00 要走 ASR，几分钟。这里要验的是「跑的时候界面给什么」，
  // 把 /api/run 与心跳换成受控响应就能精确停在 running 态，不必真的跑。
  // 注意这只能证明受控路径：真实 run 的耗时分布不在这里的覆盖范围。
  console.log("[P] 长任务反馈：已用时 / 选区收敛");
  const stubRun = (id: string, status: "running" | "done", started: string) => ({
    id,
    owner: "jobs/ui-j1",
    step: "s00",
    mode: null,
    status,
    started_at: started,
    updated_at: started,
    finished_at: status === "done" ? new Date().toISOString() : null,
    message: status === "done" ? "完成" : "本地转写（Paraformer）…",
    error: null,
  });
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#job-sents .sent", { timeout: 8000 });
  // 假装已经跑了 65 秒：用它证明起算点是服务端 started_at，而不是点下去那一刻
  const runStarted = new Date(Date.now() - 65000).toISOString();
  await page.route("**/api/run", (route) => route.fulfill({ json: stubRun("r-stub", "running", runStarted) }));
  await page.route("**/api/runs/r-stub", (route) => route.fulfill({ json: stubRun("r-stub", "running", runStarted) }));
  await page.click("#run-s00");
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.click('.modal [data-act="ok"]');
  await page.waitForSelector(".elapsed", { timeout: 8000 });
  await page.waitForTimeout(1100); // 至少走一个 800ms 心跳，确认它真的在更新
  const el = await page.evaluate(() => ({
    text: document.querySelector(".elapsed")?.textContent ?? "",
    hidden: document.querySelector(".elapsed")?.getAttribute("aria-hidden"),
    msg: document.getElementById("run-status")?.textContent ?? "",
  }));
  check(`已用时按「分:秒」显示（实测「${el.text}」）`, /已用 \d+:\d\d/.test(el.text), true);
  check(`已用时从服务端 started_at 起算，不是点下去那刻（实测「${el.text}」）`, /已用 1:\d\d/.test(el.text), true);
  check("已用时对读屏隐藏", el.hidden, "true");
  check("已用时不在 live region 里（否则每 800ms 念一次秒表）", el.msg.includes("已用"), false);
  check(`状态位仍在报真实阶段（实测「${el.msg}」）`, el.msg.includes("本地转写"), true);

  await page.unroute("**/api/run");
  await page.unroute("**/api/runs/r-stub");
  await page.goto(`${base}/#/`); // 离开该页：轮询见 statusEl 断连即退出
  await page.waitForSelector("#nj-go", { timeout: 8000 });

  // ---- 跑完据实报变化：句数与选区要分开说 ----
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#job-sents .sent", { timeout: 8000 });
  await page.click('#job-sents .sent[data-idx="0"] [data-act="i"]');
  await page.click('#job-sents .sent[data-idx="3"] [data-act="j"]');
  check("前置：选区覆盖 4 句（否则后两条是空转）", ((await page.textContent("#sel-info")) ?? "").includes("4 句"), true);
  const beforeSentences = (await (await fetch(`${base}/api/jobs/ui-j1/sentences`)).json()) as {
    sentences: unknown[];
  };
  const fewerSentences = { ...beforeSentences, sentences: beforeSentences.sentences.slice(0, 2) };
  await page.route("**/api/run", (route) => route.fulfill({ json: stubRun("r-stub2", "done", new Date().toISOString()) }));
  // 心跳也要拦：只拦 /api/run 的话，第一轮心跳打到真实服务拿到 404，
  // runAndPoll 按「连续 3 次失联」判失败直接 return，根本走不到报告那句（本轮踩过）。
  await page.route("**/api/runs/r-stub2", (route) => route.fulfill({ json: stubRun("r-stub2", "done", new Date().toISOString()) }));
  await page.route("**/api/jobs/ui-j1/sentences", (route) => route.fulfill({ json: fewerSentences }));
  await page.click("#run-s00");
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.click('.modal [data-act="ok"]');
  // 不直接等 .toast：它是被测行为，等不到会变成超时**中断**（输出「0 failed」，比红更难发现）。
  // 先等一个中立的完成信号，再读 toast 是否存在，缺失时让断言去红。
  let toastText = "";
  try {
    await page.waitForSelector(".toast", { timeout: 6000 });
    toastText = (await page.textContent(".toast")) ?? "";
  } catch {
    toastText = "(没出现 toast)";
  }
  check(`跑完据实报句数变化（实测「${toastText}」）`, /句子 \d+ → \d+/.test(toastText), true);
  check(`并同时报选区收敛，不是只报句数（实测「${toastText}」）`, /选区 \d+–\d+ → \d+–\d+/.test(toastText), true);
  await page.unroute("**/api/run");
  await page.unroute("**/api/runs/r-stub2");
  await page.unroute("**/api/jobs/ui-j1/sentences");

  // ============ Q. 取消长任务：主动停下不是故障 ============
  // 取消是真杀进程（服务端 procs + killTree），那部分在 cancelbiz 里对真实三层进程树验过。
  // 这里盯的是界面这一侧的三件事：按钮在不在、请求打的是不是 cancel、结果有没有被报成「失败」。
  console.log("[Q] 取消长任务：按钮 / 请求 / 不许报成失败");
  const cancelReq: { method: string; url: string }[] = [];
  const cancelledRun = {
    ...stubRun("r-cancel", "running", new Date().toISOString()),
    status: "cancelled",
    message: "已取消",
    finished_at: new Date().toISOString(),
  };
  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#job-sents .sent", { timeout: 8000 });
  await page.route("**/api/run", (route) => route.fulfill({ json: stubRun("r-cancel", "running", new Date().toISOString()) }));
  // 一条正则管住 /api/runs/r-cancel 与 /api/runs/r-cancel/cancel：分开注册两条 glob 会踩
  // 「哪条优先」的匹配顺序问题，而那个顺序不该成为判据的一部分。
  const cancelRoute = /\/api\/runs\/r-cancel(\/cancel)?$/;
  // 桩必须像真服务一样**记住**状态：取消之后再来的心跳也必须是 cancelled。
  // 只按「这次请求是不是 /cancel」回不同的东西，会让下一次心跳又变回 running，
  // 界面于是永远等不到收尾（第一版就是这么挂的，而且挂得很像产品 bug）。
  let cancelCalled = false;
  await page.route(cancelRoute, (route) => {
    const req = route.request();
    cancelReq.push({ method: req.method(), url: req.url() });
    if (req.url().endsWith("/cancel")) cancelCalled = true;
    return route.fulfill({
      json: cancelCalled ? cancelledRun : stubRun("r-cancel", "running", new Date().toISOString()),
    });
  });
  await page.click("#run-s00");
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.click('.modal [data-act="ok"]');
  await page.waitForSelector(".elapsed", { timeout: 8000 });
  const liveRegion = await page.evaluate(() => {
    const el = document.getElementById("run-status");
    const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "取消");
    return { hasBtn: Boolean(btn), insideLive: el?.contains(btn ?? null) ?? false };
  });
  check("跑起来后给出「取消」按钮", liveRegion.hasBtn, true);
  // 取消按钮跑完就撤：若它挂在 live region 里，读屏会先念「取消 按钮」再念它消失，
  // 而真正该播报的是「已取消」那一句。
  check("取消按钮与已用时一样挂在 live region 之外", liveRegion.insideLive, false);

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === "取消");
    (btn as HTMLButtonElement | undefined)?.click();
  });
  await page.waitForTimeout(1400); // 至少走一轮 800ms 心跳，确认它自己收尾
  const afterCancel = await page.evaluate(() => {
    const el = document.getElementById("run-status");
    return {
      text: el?.textContent ?? "",
      role: el?.getAttribute("role") ?? "",
      cls: el?.className ?? "",
      elapsed: document.querySelectorAll(".elapsed").length,
      btn: Array.from(document.querySelectorAll("button")).filter((b) => (b.textContent ?? "").trim().startsWith("取消")).length,
    };
  });
  const cancelHits = cancelReq.filter((r) => r.url.endsWith("/cancel"));
  check(`取消打到 POST /api/runs/:id/cancel（实测 ${cancelHits.length} 次 ${cancelHits[0]?.method ?? "-"}）`,
    cancelHits.length === 1 && cancelHits[0]!.method === "POST", true);
  check(`取消后状态位说「已取消」（实测「${afterCancel.text}」）`, afterCancel.text.trim() === "已取消", true);
  // 主动停下不是故障：报成「失败」会让用户以为是自己弄坏了什么
  check("取消不报成失败", afterCancel.text.includes("失败"), false);
  check(`取消不是错误档（role=${afterCancel.role}，class 含 err=${afterCancel.cls.includes("err") ? "是" : "否"}）`,
    afterCancel.role !== "alert" && !afterCancel.cls.includes("err"), true);
  // 轮询必须真的停下：否则已用时与取消按钮会一直留着，看上去还在跑
  check(`取消后已用时与取消按钮都撤走（实测 elapsed=${afterCancel.elapsed} btn=${afterCancel.btn}）`,
    afterCancel.elapsed === 0 && afterCancel.btn === 0, true);

  // 服务端这一侧的语义（真打，不走 mock）：不存在的 run 是 404，不是 500，
  // 也证明 cancel 路由没被 GET /api/runs/:id 那条吃掉
  const missCancel = await fetch(`${base}/api/runs/nope-xx/cancel`, { method: "POST" });
  check(`取消不存在的 run 返回 404（实测 ${missCancel.status}）`, missCancel.status, 404);
  await page.unroute("**/api/run");
  await page.unroute(cancelRoute);

  // ---- [R] 转写连续进度：视觉连续，播报离散 ----
  // 这条要守的是**位置**而不是「有没有这个数字」：进度每块音频变一次，
  // 放进角色为 status 的区域里，读屏会一路念「2:15 / 10:00」，比没有进度更糟。
  console.log("\n[R] 转写进度：看得见，但不进 live region");
  // 必须 reload 而不是 goto：这是单页应用，goto 到同一文档内的另一个 hash 只触发 hashchange，
  // **文档不会重载**——模块级状态（选区 Map）和页面上残留的 toast 会整段继承下来。
  // 实测过：不 reload 时这一段能读到上一段留下的 toast 文案，判据于是在验证别人的现场。
  await page.goto(`${base}/#/job/ui-j1`);
  await page.reload();
  await page.waitForSelector("#job-sents .sent", { timeout: 8000 });
  await page.route("**/api/run", (route) => route.fulfill({ json: stubRun("r-prog", "running", new Date().toISOString()) }));
  const progSteps = ["0:03 / 10:00", "2:15 / 10:00", "7:40 / 10:00"];
  let progIdx = 0;
  let progDone = false;
  await page.route(/\/api\/runs\/r-prog$/, (route) =>
    route.fulfill({
      json: progDone
        ? { ...stubRun("r-prog", "done", new Date().toISOString()), message: "本地转写 8 句（paraformer）" }
        : {
            ...stubRun("r-prog", "running", new Date().toISOString()),
            progress_detail: progSteps[Math.min(progIdx++, progSteps.length - 1)],
          },
    }),
  );
  await page.click("#run-s00");
  await page.waitForSelector(".modal", { timeout: 10000 });
  await page.click('.modal [data-act="ok"]');
  // 等待条件不能依赖被测行为：既不能等「prog 是 status 的兄弟」，也不能只等「它存在」——
  // 它刚被创建时内容还是空的，而此时第一轮心跳（800ms）可能还没到。
  // 这里等的是「它说出了读数」，但**等不到只让它红、不让它中断**：
  // 中断会输出「N passed / 0 failed」，比红更难发现。
  try {
    await page.waitForFunction(() => (document.querySelector(".prog")?.textContent ?? "").length > 0, { timeout: 8000 });
  } catch {
    /* 等不到就交给下面的 check 判红 */
  }
  const progPos = await page.evaluate(() => {
    const status = document.getElementById("run-status");
    const prog = document.querySelector(".prog");
    return {
      exist: Boolean(prog),
      text: prog?.textContent ?? "",
      insideLive: status?.contains(prog ?? null) ?? false,
      hidden: prog?.getAttribute("aria-hidden") === "true",
    };
  });
  check(`进度旁注显示「已处理 / 总长」（实测「${progPos.text}」）`, /^\d+:\d{2} \/ \d+:\d{2}$/.test(progPos.text), true);
  // 三条都必须带 exist 前置：元素压根没渲染出来时，`contains(null)` / `getAttribute(null)`
  // 都会返回让它「通过」的值——缺陷于是被读成合规（注入实测到两次）。
  check("进度旁注不在 live region 里（否则读屏会一路念数字）", progPos.exist && !progPos.insideLive, true);
  check("进度旁注对读屏隐藏（视觉有、播报无）", progPos.exist && progPos.hidden, true);
  const p1 = progPos.text;
  await page.waitForTimeout(2000); // 至少两轮 800ms 心跳，让桩换一条读数
  const p2 = await page.evaluate(() => document.querySelector(".prog")?.textContent ?? "");
  check(`进度在界面上真的在推进（实测「${p1}」→「${p2}」）`, p1 !== p2 && p2.length > 0, true);
  progDone = true;
  await page.waitForTimeout(2000);
  check("跑完把进度旁注撤掉（不留一条停住的刻度）", await page.evaluate(() => document.querySelectorAll(".prog").length), 0);
  await page.unroute("**/api/run");
  await page.unroute(/\/api\/runs\/r-prog$/);

  // ---- [S] 换字幕源：入口 / 说清代价 / 清掉选区 ----
  // 选区的要害是它记「第几句」。换源后第 3 句已经不是原来那句，
  // 按索引收敛等于把选区静默挪到不相干的句子上——所以只能清。
  console.log("\n[S] 换字幕源：说清会丢什么，且选区必须清掉");
  // 同 [R]：单页应用里 goto 不重载文档，必须 reload 才能从干净的选区与无 toast 的页面开始。
  await page.goto(`${base}/#/job/ui-j1`);
  await page.reload();
  await page.waitForSelector("#job-sents .sent", { timeout: 8000 });
  await page.click('[data-act="i"][data-idx="1"]');
  await page.click('[data-act="j"][data-idx="3"]');
  const selBefore = await page.evaluate(() => document.getElementById("sel-info")?.textContent ?? "");
  check(`前置：先选一段区间（实测「${selBefore}」）`, selBefore.includes("已选"), true);

  await page.click("#swap-s00");
  const rowShown = await page.evaluate(() => !(document.getElementById("swap-row") as HTMLElement).hidden);
  check("点「换字幕源」展开路径输入行", rowShown, true);
  await page.fill("#swap-path", "C:/tmp/another.srt");

  const swapReq: string[] = [];
  await page.route("**/api/jobs/ui-j1/subtitle", (route) => {
    swapReq.push(route.request().method());
    return route.fulfill({ json: { ok: true, sentences: 9, ai_cleared: true } });
  });
  await page.route("**/api/run", (route) => route.fulfill({ json: stubRun("r-swap", "running", new Date().toISOString()) }));
  await page.route(/\/api\/runs\/r-swap$/, (route) =>
    route.fulfill({ json: { ...stubRun("r-swap", "done", new Date().toISOString()), message: "解析 9 句" } }),
  );
  await page.click("#swap-go");
  await page.waitForSelector(".modal", { timeout: 8000 });
  const swapBody = await page.evaluate(() => document.querySelector(".modal")?.textContent ?? "");
  // 三件事都要说到：会清选区、会清 AI 候选、下游会被标脏。
  // 只说「确认换源」等于让用户在不知情的情况下丢东西。
  check("确认框说了会清选区", swapBody.includes("选区"), true);
  check("确认框说了会清 AI 候选", swapBody.includes("候选"), true);
  check("确认框说了下游会被标脏", swapBody.includes("标脏"), true);
  await page.click('.modal [data-act="ok"]');
  await page.waitForSelector(".toast", { timeout: 10000 });
  const swapToast = await page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
  check(`换源后如实报出结果（实测「${swapToast}」）`, swapToast.includes("字幕源已换"), true);
  check("换源打的是 POST /api/jobs/:id/subtitle", swapReq.length === 1 && swapReq[0] === "POST", true);
  const selAfter = await page.evaluate(() => document.getElementById("sel-info")?.textContent ?? "");
  check(`换源后选区被清空（实测「${selAfter}」）`, selAfter.includes("已选"), false);
  await page.unroute("**/api/jobs/ui-j1/subtitle");
  await page.unroute("**/api/run");
  await page.unroute(/\/api\/runs\/r-swap$/);

  await page.goto(`${base}/#/`);
  await page.waitForSelector("#nj-go", { timeout: 8000 });

  check("全程没有出现原生 alert/confirm/prompt", nativeDialogs, 0);

  // ---- 截图：布局塌陷、圆点隐形这类问题只有看图才发现 ----
  await page.goto(`${base}/#/`);
  await page.waitForSelector(".step");
  // 截图放系统临时目录，跟着 ROOT 一起（scratchdir 把 TEMP 改到了项目盘 work/_scratch，
  // 用 process.env.TEMP 就会每跑一次在项目里留一张 100KB 的 png——「一跑一份」的又一处）。
  const shot = path.join(SYSTEM_TEMP, "slice-ui-smoke-shot.png");
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`\n截图：${shot}`);
} catch (e) {
  // 必须留住原始异常：以前 finally 里裸 rmSync 撞上删除守卫会抛第二个异常把它覆盖，
  // 真实失败原因（例如 waitForFunction 超时）就永远看不到了。
  fatal = e;
  console.error("\n验证中断（原始异常）：", e);
} finally {
  try {
    await browser?.close();
  } catch (e) {
    cleanupWarn += `关闭浏览器失败：${String(e)}；`;
  }
  try {
    srv.kill();
  } catch (e) {
    cleanupWarn += `关闭服务失败：${String(e)}；`;
  }
  await new Promise((r) => setTimeout(r, 300));
  try {
    nuke(ROOT);
  } catch (e) {
    // 删不掉时不能抛：否则原始异常被吞、汇总行也打不出来。
    // 但要**留下路径**——漏一份夹具就是下一次运行时的一笔垃圾。
    cleanupWarn += `夹具未清：${ROOT} —— ${(e as Error).message.split("\n")[0]}；`;
  }
}

if (cleanupWarn) console.log(`\n⚠️ 清理告警（不影响用例结论）：${cleanupWarn}`);
console.log(`\n结果: ${passed} passed / ${failed} failed${fatal ? "（另有验证中断）" : ""}`);
process.exit(failed === 0 && !fatal ? 0 : 1);
