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
};

export function icon(name: keyof typeof PATHS, size = 13): string {
  const d = PATHS[name];
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
