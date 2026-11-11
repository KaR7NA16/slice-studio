// 令牌单源静态扫描（不需要起服务、不需要浏览器，毫秒级）
//
// 为什么必须单独扫：第 17 轮审查发现「令牌双轨」——tokens.css 定义了一套，
// app.css 里又散着一批同义的字面色值/字号，改令牌只改到一半的样式，肉眼还看不出来
// （两处恰好同值），一旦改令牌就变成「一半新一半旧」。运行期再发现成本太高，
// 所以在源码层面固化成门：app.css 里出现颜色/字号/字体/圆角字面量即失败。
//
// 扫的面不止 CSS 文件：样式可以在**运行时**被拼出来（字符串里的色值、.style.xxx =、
// 模板里塞 CSS 声明），也可以靠一个**根本没有规则**的 class 名假装自己有样式。
// 这两类都改不动任何一行 app.css，却照样能决定界面长什么样，所以 [5][7][8][9] 一起管。
//
// 白名单只认三件事：
//   ① 形状不是设计决策：border-radius: 50% / 0、宽度高度、gap 等几何量不限；
//   ② 脚本里画布取不到 CSS 变量时的兜底值，必须显式标 // token-fallback: --xxx 注释，
//      这样「重复了一份色值」在仓库里是可 grep 的，而不是隐形漂移；
//   ③ 纯查询钩子 class（HOOK）：没有任何样式，只用于 querySelector。
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
// 正则要覆盖**拼进字符串**的颜色，而不只是 rgb()：
// 原先只认 6 位 hex，于是 `"#fff"` / `hsl(...)` 这类在模板里拼进去的色值完全逃过扫描——
// 而「运行时拼 DOM」正是最不容易被肉眼 review 到的那一类。
const colorLiteral = /["'`]\s*#[0-9a-fA-F]{3,8}\b|#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/;
const stray: string[] = [];
for (const f of tsFiles) {
  for (const l of lines(f)) {
    if (!colorLiteral.test(l.text)) continue;
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

// [7][8] 补的是同一个缺口：样式可以**绕过 CSS 文件**在运行时被拼出来，
// 静态扫描只盯 app.css 的话，这类写法改变不了任何一行 CSS，却照样能画出界面。
console.log("[7] 运行时不得用 .style.xxx = 直接写令牌维度");
// 只禁「令牌维度」的属性（颜色/字体/间距/阴影）；几何量（height/transform/left…）本来就得现算，
// 用白名单会把将来每一个合法的几何属性变成误报。
const TOKEN_DIM = new Set([
  "color", "background", "backgroundColor", "borderColor", "borderRadius",
  "font", "fontSize", "fontFamily", "fontWeight", "lineHeight", "letterSpacing",
  "boxShadow", "textShadow", "padding", "margin", "gap", "outline", "fill", "stroke",
]);
const styleAssign: string[] = [];
for (const f of tsFiles) {
  for (const l of lines(f)) {
    for (const g of l.text.matchAll(/\.style\.([a-zA-Z]+)\s*=/g)) {
      const prop = g[1]!;
      if (TOKEN_DIM.has(prop)) styleAssign.push(`${f}:${l.n}  .style.${prop}  ${l.text.trim()}`);
    }
  }
}
check("无 .style.xxx = 写颜色/字号/间距（几何量除外）", styleAssign);

console.log("[8] 脚本里不拼 CSS 声明");
// 只认带连字符的 CSS 属性名：`color:` 这种短名在 TS 里太容易出现（对象字段、日志文本），
// 查它会淹在误报里；而 `font-size:` / `background-color:` 出现在脚本里只可能是拼样式。
const CSS_DECL = /["'`][^"'`]*\b(?:font-size|background-color|border-radius|border-color|line-height|font-family|box-shadow|text-shadow)\s*:/;
const declHits: string[] = [];
for (const f of tsFiles) {
  for (const l of lines(f)) {
    if (/^\s*(\/\/|\*)/.test(l.text)) continue; // 注释里举例不算
    if (CSS_DECL.test(l.text)) declHits.push(`${f}:${l.n}  ${l.text.trim()}`);
  }
}
check("模板/字符串里不出现 CSS 声明（否则等于绕开 app.css 排版）", declHits);

// [9] 双向对账：标记里的类要有样式，样式里的类要有人用。
// 为什么值得单独扫：「标记里有这个 class、app.css 里一条规则都没有」时页面**不报错**——
// 元素在、文字在、判据全绿，只是排错了位置。片段页「成片预览」那行就是这么漂了两轮
// （开关和一大段片长说明粘在一行无名 div 里，既不像播放器控件也不像波形注解）。
// 反向的死规则同理：样式还在、标记早就不生成它了，留着会让下一个人当约束读。
console.log("[9] class 与样式双向对齐");
// 逐字符读 class="…"：要跳过 ${…}（里面有引号，正则的 [^"]* 会在那里提前断掉），
// 只收字面出现的类名。插值出来的类名（`dot ${st.status}`）静态拿不到，这里不管——
// 由反向检查兜住：CSS 里有的类名，总得在源码某个字面量里出现过。
function classesIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/class="/g)) {
    let k = m.index! + 7;
    let buf = "";
    while (k < src.length) {
      const ch = src[k]!;
      if (ch === '"') break;
      if (ch === "$" && src[k + 1] === "{") {
        out.push(...buf.split(/\s+/).filter(Boolean));
        buf = "";
        let depth = 1;
        k += 2;
        while (k < src.length && depth > 0) {
          const c = src[k]!;
          if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (c === '"' || c === "'" || c === "`") {
            k++;
            while (k < src.length && src[k] !== c) {
              if (src[k] === "\\") k++;
              k++;
            }
          }
          k++;
        }
        continue;
      }
      buf += ch;
      k++;
    }
    out.push(...buf.split(/\s+/).filter(Boolean));
  }
  return out;
}
const cssText = ["app.css", "tokens.css"].map((f) => readFileSync(path.join(UI, f), "utf8")).join("\n");
const cssCls = new Set([...cssText.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]!));
// 纯查询钩子：没有任何样式，靠 .minibtn 之类的外层类负责外观，只用于 querySelector。
const HOOK = new Set(["play", "pick", "toggle", "act"]);
const frontSrc = new Map(tsFiles.map((f) => [f, readFileSync(path.join(UI, f), "utf8")]));
frontSrc.set("index.html", html);
const strayCls: string[] = [];
for (const [f, t] of frontSrc) {
  const used = new Set(classesIn(t));
  for (const m of t.matchAll(/classList\.(?:add|toggle|remove)\("([^"]+)"\)/g)) used.add(m[1]!);
  for (const m of t.matchAll(/className\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1]!.split(/\s+/).filter(Boolean)) used.add(c);
  }
  for (const c of used) if (!cssCls.has(c) && !HOOK.has(c)) strayCls.push(`${f}  class="${c}"`);
}
check("标记里的 class 都有样式（纯钩子请加进 HOOK 白名单）", strayCls);

const allSrc = [...frontSrc.values()].join("\n");
const deadRules = [...cssCls]
  .filter((c) => !new RegExp(`\\b${c}\\b`).test(allSrc))
  .map((c) => `.${c}`);
check("app.css / tokens.css 里的类名都在前端源码里出现过（死规则）", deadRules);

console.log(`\n结果: ${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
