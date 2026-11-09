// 内联 SVG 图标（原话#1：emoji 全换 SVG；SF Symbols 风——细 stroke、圆角端点）
// 用法：icon("check") 返回 svg 字符串，颜色跟随 currentColor。

const PATHS: Record<string, string> = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  warn: "M12 4.5L2.5 20h19L12 4.5zM12 10v4.5M12 17.2v.3",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2",
  refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
  film: "M4 5h16v14H4zM4 9h16M4 15h16M8 5v14M16 5v14",
  music: "M9 18.5V6l11-2v12.5M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  cut: "M7 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM7 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8.8 7.8L20 19M8.8 16.2L20 5",
  doc: "M6 3h8l5 5v13H6zM14 3v5h5",
  play: "M8 5.5v13l10-6.5z",
  font: "M5 19L12 5l7 14M7.5 14h9",
  plus: "M12 5v14M5 12h14",
  back: "M15 5l-7 7 7 7",
  spark: "M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z",
  sliders: "M6 4v6M6 14v6M3.5 12h5M12 4v2M12 10v10M9.5 8h5M18 4v10M18 18v2M15.5 16h5",
  down: "M12 4.5v13M6.5 12l5.5 5.5 5.5-5.5",
  // 分叉树（b7）：一个主干节点分出一条侧枝
  branch: "M7 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7 6v12M7 12h6a4 4 0 0 0 4-4V8M17 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  // 自动档（b3/b4）
  bolt: "M13 3L5 14h6l-1 7 8-11h-6l1-7z",
  // 波形（s03 气口）
  wave: "M3 12h1.5l2-6 2 13 2-16 2 19 2-13 2 6 1.5-3H21",
  save: "M12 4v10M7 9.5l5 5 5-5M5 20h14",
  x: "M6 6l12 12M18 6L6 18",
};

export function icon(name: keyof typeof PATHS, size = 13): string {
  const d = PATHS[name];
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
