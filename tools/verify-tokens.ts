// 令牌单源静态扫描（不需要起服务、不需要浏览器，毫秒级）
//
// 为什么必须单独扫：第 17 轮审查发现「令牌双轨」——tokens.css 定义了一套，
// app.css 里又散着一批同义的字面色值/字号，改令牌只改到一半的样式，肉眼还看不出来
// （两处恰好同值），一旦改令牌就变成「一半新一半旧」。运行期再发现成本太高，
// 所以在源码层面固化成门：app.css 里出现颜色/字号/字体/圆角字面量即失败。
//
// 白名单只认两件事：
//   ① 形状不是设计决策：border-radius: 50% / 0、宽度高度、gap 等几何量不限；
//   ② 脚本里画布取不到 CSS 变量时的兜底值，必须显式标 // token-fallback: --xxx 注释，
//      这样「重复了一份色值」在仓库里是可 grep 的，而不是隐形漂移。
//
// 运行：node tools/verify-tokens.ts

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const UI = path.join(import.meta.dirname, "..", "src", "ui");

let passed = 0;
let failed = 0;
function check(name: string, hits: string[]): void {
  if (hits.length === 0) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}：${hits.length} 处`);
    for (const h of hits) console.log(`        ${h}`);
  }
}

function lines(file: string): Array<{ n: number; text: string }> {
  return readFileSync(path.join(UI, file), "utf8")
    .split(/\r?\n/)
    .map((text, i) => ({ n: i + 1, text }));
}

function scan(file: string, re: RegExp, allow?: (text: string) => boolean): string[] {
  return lines(file)
    .filter((l) => re.test(l.text) && !(allow?.(l.text) ?? false))
    .map((l) => `${file}:${l.n}  ${l.text.trim()}`);
}

const app = "app.css";

console.log("[1] app.css 不得自带颜色字面量");
check(
  "无 #hex / rgb() / hsl() / oklch() 颜色",
  scan(app, /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/),
);
check(
  "无 CSS 命名色（red/white/black… 会绕过令牌）",
  scan(
    app,
    /:\s*(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal)\b/,
  ),
);

console.log("[2] app.css 的字号/字体/圆角必须走令牌");
check(
  "无 px 字号（应为 var(--fs*))",
  scan(app, /font-size:\s*(?!\s*var\()/),
);
check(
  "无字面字号关键字（small/large/1.2em…）",
  scan(app, /font-size:\s*(?:x?-?(?:small|large)|[0-9.]+(?:em|rem|%|pt))/),
);
check(
  "font-family 只能引用令牌",
  scan(app, /font-family:\s*(?!\s*var\()/),
);
check(
  "圆角只能是 px 令牌或 50%/0（圆是形状，不是设计决策）",
  scan(app, /border(?:-[a-z]+)*-radius:\s*(?!\s*var\()/, (t) => /:\s*(?:50%|0)\s*;/.test(t)),
);
check(
  "行高不写死像素（应为无单位倍数或令牌）",
  scan(app, /line-height:\s*[0-9.]+px/),
);

console.log("[3] tokens.css 是唯一色值出处，且暗色只定义一次");
const tokenLines = lines("tokens.css");
const darkBlocks = tokenLines.filter((l) => /\[data-theme="dark"\]/.test(l.text));
check(
  "暗色调色板只有一处（两处会各自漂移）",
  darkBlocks.length === 1 ? [] : [`tokens.css:${darkBlocks.map((d) => d.n).join(",")}`],
);
const mediaDark = scan("tokens.css", /prefers-color-scheme/);
check("没有 prefers-color-scheme 里再抄一份色值（配色只由 data-theme 决定）", mediaDark);

console.log("[4] index.html 首屏脚本先于样式（避免主题一闪）");
const html = readFileSync(path.join(UI, "index.html"), "utf8");
const scriptAt = html.indexOf("ss-theme");
const cssAt = html.search(/<link[^>]+stylesheet|@import/);
check(
  "主题解析脚本在样式表之前",
  scriptAt >= 0 && (cssAt < 0 || scriptAt < cssAt) ? [] : ["index.html: 主题脚本没抢在样式表之前"],
);

console.log("[5] 脚本里的兜底色值必须标注来源");
const tsFiles = readdirSync(UI).filter((f) => f.endsWith(".ts"));
const stray: string[] = [];
for (const f of tsFiles) {
  for (const l of lines(f)) {
    if (!/#[0-9a-fA-F]{6}\b|\brgba?\(/.test(l.text)) continue;
    if (l.text.includes("token-fallback")) continue;
    stray.push(`${f}:${l.n}  ${l.text.trim()}`);
  }
}
check("无未标注的硬编码色（画布兜底请加 // token-fallback: --x）", stray);

console.log("[6] 标记里不写行内样式（版面只由 app.css 决定）");
const inline = [...tsFiles, "index.html"].flatMap((f) =>
  lines(f)
    .filter((l) => /\bstyle="/.test(l.text))
    .map((l) => `${f}:${l.n}  ${l.text.trim()}`),
);
check("无 style=\"…\"（改成 class，动态尺寸才用 JS 属性）", inline);

console.log(`\n结果: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
