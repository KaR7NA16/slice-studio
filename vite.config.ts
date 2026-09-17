import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 前端构建链（b13：Vite + TS 无框架）；产物 = 单个 index.html（原话#1 的 grill B 方案）
export default defineConfig({
  root: "src/ui",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    assetsInlineLimit: 1024 * 1024,
  },
});
