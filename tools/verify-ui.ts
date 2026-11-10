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

import { SCRATCH } from "./scratchdir.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const ROOT = mkdtempSync(path.join(SCRATCH, "slice-ui-smoke-"));

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
  await page.waitForSelector("#st-name");
  await page.fill("#st-name", "冒烟档");
  await page.fill("#st-url", "https://api.example.com/v1");
  await page.fill("#st-key", KEY);
  await page.fill("#st-model", "smoke-model");
  await page.click("#st-default"); // ← 触发重画：DEFECT #2 就是在这里把刚填的 key 丢掉的
  await page.waitForSelector("#st-key");
  check("点「设为默认」（重画）后 key 仍在输入框里", await page.inputValue("#st-key"), KEY);
  check("重画后其它字段也还在", await page.inputValue("#st-model"), "smoke-model");
  await page.click("#st-save");
  await page.waitForFunction(() => (document.getElementById("st-msg")?.textContent ?? "").startsWith("已保存"), null, { timeout: 8000 });

  const cfg = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
  check("config.json 落了 2 个档", cfg.llm.profiles.length, 2);
  check("填的 key 真的落盘（不是被静默丢成空串）", cfg.llm.profiles.some((p: { api_key: string }) => p.api_key === KEY), true);
  check("默认档指向刚设的那个", cfg.llm.profiles.find((p: { id: string }) => p.id === cfg.llm.default_id)?.model, "smoke-model");

  await page.goto(`${base}/#/settings`); // 重载：走一遍真实读取路径
  await page.waitForSelector("#st-pick");
  await page.selectOption("#st-pick", "1"); // 切到有 key 的那一档
  await page.waitForSelector("#st-key");
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
  // 已知噪音（不是缺陷，但要盯着）：clip 页无条件请求 s03 合并视图，片段没跑过 s03 就 404，
  // 前端已 catch 降级为「还没跑」。语义上「未跑」不该用 404 表达，属既有设计，已登记缺口清单。
  const KNOWN_NOISE = [/^404 .*\/api\/clips\/[^/]+\/s03$/];
  const unexpected = bad.filter((b) => !KNOWN_NOISE.some((re) => re.test(b)));
  console.log(`  （非 2xx 响应：${JSON.stringify(bad)}）`);
  check("无非预期错误响应（5xx / 未登记的 4xx）", unexpected, []);
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


  // ============ J. 视觉与可访问性（规划 v2.8 判据） ============
  console.log("[J] 密度 / 对比度 / 焦点 / 主题 / 断点 / 选择器 / 失败出口");
  await page.setViewportSize({ width: 1440, height: 900 });
  // 密度：总览页的任务卡才是 stepRow 的宿主（任务页把步骤收成了 chip 行）
  await page.goto(`${base}/#/`);
  await page.waitForSelector(".step");
  check("正文 13px", await page.evaluate(() => getComputedStyle(document.body).fontSize), "13px");
  check("步骤行 32px（b10 的 28–32）", await page.evaluate(() => getComputedStyle(document.querySelector(".step")!).height), "32px");
  check("步骤行状态字 12px", await page.evaluate(() => getComputedStyle(document.querySelector(".step .state")!).fontSize), "12px");

  await page.goto(`${base}/#/job/ui-j1`);
  await page.waitForSelector("#job-sents .sent");
  check("句流最小行高 32px", await page.evaluate(() => getComputedStyle(document.querySelector("#job-sents .sent")!).minHeight), "32px");
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

  check("全程没有出现原生 alert/confirm/prompt", nativeDialogs, 0);

  // ---- 截图：布局塌陷、圆点隐形这类问题只有看图才发现 ----
  await page.goto(`${base}/#/`);
  await page.waitForSelector(".step");
  const shot = path.join(process.env.TEMP ?? "/tmp", "slice-ui-smoke-shot.png");
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
    rmSync(ROOT, { recursive: true, force: true });
  } catch (e) {
    // 删除守卫（turn 级配额）拦下时不能抛：否则原始异常被吞、汇总行也打不出来。
    cleanupWarn += `夹具未清：${ROOT} —— ${(e as Error).message.split("\n")[0]}；`;
  }
}

if (cleanupWarn) console.log(`\n⚠️ 清理告警（不影响用例结论）：${cleanupWarn}`);
console.log(`\n结果: ${passed} passed / ${failed} failed${fatal ? "（另有验证中断）" : ""}`);
process.exit(failed === 0 && !fatal ? 0 : 1);
