# 切片助手 · slice-studio

中文口播视频的本地切片工具。一条素材进来，按句切开，删掉不要的，配字幕和 BGM，导出成片。
全程在本机跑，素材不上传。

六步流水线，每步的产物都是可读的 JSON 或媒体文件，可以只重跑其中一步：

| 步骤 | 单位 | 产出 |
|---|---|---|
| s00 字幕 | 任务 | `sentences.json` · `job.srt` |
| s01 选高光 | 任务 | `candidates.json` |
| s02 人声分离 | 片段 | `vocals.wav` · `no_vocals.wav` |
| s03 逐句删留 | 片段 | `sentences.json` |
| s04 配乐 | 片段 | `bgm.json` |
| s05 成片 | 片段 | `final.mp4` · `package.zip` |

有 SRT 就直接解析，没有才走本地 Paraformer 转写；人声分离用 demucs；成片用 ffmpeg 拼区间、烧字幕。
AI 只负责出初稿（选高光、删留、配乐 mood），改不改由你，不接 AI 也能跑完。

## 快速开始

需要 Windows 10/11 x64 与 Node ≥ 22.18（服务端直接跑 `.ts`，不编译）。

```bash
npm install
npm run build      # 服务端静态出口只回 dist/index.html，必须先构建
npm start          # 打印 http://127.0.0.1:<端口>
```

`npm start` 等于 `node src/server/main.ts [数据根]`，数据根缺省为项目目录。要分开：

```bash
node src/server/main.ts D:\slice-data
```

## 运行时按需自备

仓库里只有源码（约 1.2 MB）和依赖清单。运行时约 2.3 GB：第三方二进制、模型权重、
有版权的 BGM，都不适合进 git，所以不入库。缺哪一样，对应步骤就用不了：

| 缺什么 | 谁需要 | 怎么补 |
|---|---|---|
| `tools/ffmpeg/` | 几乎全部 | FFmpeg 9.0.1，把 `ffmpeg.exe`、`ffprobe.exe` 放进去 |
| `tools/python/` + `models/demucs/` | s02 | Python 3.13，`pip install -r tools/requirements.txt`（版本已锁），权重 `htdemucs` 80 MB |
| `models/asr/` | s00 无 SRT 时 | Paraformer ONNX int8 233 MB，FunASR 官方导出 |
| `assets/bgm/` + `data/library.json` | s04 | 自己的曲库。总览页「素材库」改指向，只登记不复制 |
| `config.json` | s01 / s03 / s04 的 AI 路径 | 复制 `config.example.json`，填 OpenAI 兼容的 `api_key` |

最短能出片的组合：一份 SRT + ffmpeg + s02 那套（成片依赖分离结果）+ 一个 LLM Key。
只想看界面：`npm start` 后建个任务，所有页面都能进，不跑步骤也行。

## 设计上的几条规矩

- **产物与契约分开**。`step.json.outputs` 记实际产出过什么，`artifacts[]` 记必须有什
  么。可选产物被删不算缺失，否则合法状态会被误报成 missing。
- **指纹驱动失效**。每步记输入的内容哈希（文件取 sha256，参数取值哈希），变了才标脏，
  逐层向下传播。换字幕源、改源视频都会直接把下游标脏。
- **读侧现算**。状态（empty / error / stale / missing / ready / suspect）不落盘，每次请求
  从文件和指纹算出来，不会出现「磁盘上是旧的、界面显示是新的」。
- **子进程隔离**。六步各自跑在独立子进程，一步崩了不带走服务；长任务有心跳与取消。

## 目录

```
src/
  shared/   步骤注册表（依赖关系的唯一真相源）与全部数据结构
  server/   node:http，零框架；路由 + 读模型 + 变体 + 媒体 Range 流
  steps/    六步执行体，各跑一个子进程；lib.ts 管指纹与产物
  ui/       Vite + TS，无框架，哈希路由；产物是单个 index.html
tools/      判据脚本、两个 Python worker、夹具、依赖清单
launcher/   绿色目录启动器（C#）：自愈 pyvenv.cfg、选数据根、拉起服务、开浏览器
docs/       规划、交接文档、缺口与问题清单
```

## 开发

```bash
npm run check     # tsc --noEmit
npm run verify    # 六组判据，十几分钟，会真跑 demucs 与 ffmpeg
```

判据是脚本化的验收：真起服务、真开 headless 浏览器、真跑 ffmpeg。共 591 条
（tokens 16 / stage1 29 / stage2 257 / ui 237 / e2e 27 / launch 25）。
`npm run verify:tokens`、`verify:stage1`、`verify:ui` 三组不需要 Python 侧，装 node 就能跑。

## 文档

- [`docs/项目规划.md`](docs/项目规划.md) — 链路表、数据契约、硬约束
- [`docs/交接文档.md`](docs/交接文档.md) — 当前状态、代码地图、坑位
- [`docs/缺口与问题清单.md`](docs/缺口与问题清单.md) — 逐轮审查记录与未闭合项

## 许可

本项目代码以 MIT 发布，见 [`LICENSE`](LICENSE)。依赖、模型权重与 BGM 素材不在 MIT 覆盖范围内：
Node MIT、Python PSF、PyTorch BSD-3、demucs MIT、onnxruntime MIT、FFmpeg 为 GPL 构建
（以独立进程调用，不与本项目代码链接）；Paraformer 与 htdemucs 权重归各自发布方，本项目不再分发。
