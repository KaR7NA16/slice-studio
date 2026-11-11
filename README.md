# slice-studio · 切片助手

本地自托管的 AI 切片编辑器：把一段中文口播视频按句子切开、删掉不要的、配上字幕和 BGM，导出成片。
六步流水线，每一步的产物都是可读的文件，可以查、可以改、可以只重跑某一步。**不上传云端**。

> **状态**：开发中。链路在真实素材上跑通（含 ASR 兜底、人声分离、字幕烧录），
> 判据 **591** 条（6 个脚本）当天全绿。**打包分发尚未排期**——克隆下来只有源码，
> 运行时需要自备，见下文。

---

## 它做什么

前两步以「任务」为单位（一条源视频），后四步以「片段」为单位（从任务里切出的一条）。

| 步 | 名称 | 级别 | 必需产物 | 说明 |
|---|---|---|---|---|
| s00 | 字幕 | 任务 | `sentences.json`、`job.srt` | 有 SRT 就解析，**绝不触发转写**；没有才 ffmpeg 抽 16k 单声道走 Paraformer |
| s01 | 选高光 | 任务 | `candidates.json`（+ `ai.json`） | LLM 抽卡 / 人工改；越界、倒置、过短、过长、空标题一律剔除并计数 |
| s02 | 人声分离 | 片段 | `vocals.wav`、`no_vocals.wav` | demucs 常驻 worker，权重只加载一次 |
| s03 | 逐句删留 | 片段 | `sentences.json`（+ `ai.json`） | 句流 + 波形 + 播放器三者联动；AI 出初稿后可逐句改 |
| s04 | 配乐 | 片段 | `bgm.json` | mood 从曲库现算；规则优先、LLM 兜底；越界报错不回退 |
| s05 | 成片 | 片段 | `final.mp4`、`package.zip` | 保留句区间合并 → `filter_complex` 拼接 → 字幕烧录 |

设计上的两条硬规矩：

- **产物 vs 契约分开**。`step.json.outputs` 是「实际产出过什么」的并集，`artifacts[]` 是「必须有什
  么」。可选产物（如 s03 的 `ai.json`）被删不算缺失，否则会把合法状态误报成 missing。
- **指纹驱动失效**。每步记输入的内容哈希（文件取 sha256，参数取值哈希），输入变了才标脏，逐层向下传播。

## 它不做什么

- **不上传**：素材、模型、中间产物全在本机。
- **不自带素材**：`assets/bgm/` 那 97 首 mp3 版权不在本项目，仓库里没有。
- **不分发**：绿色目录启动器（`launcher/Launcher.cs`）代码在，打包与分发已从当前范围撤下。
- **不接云端 ASR**：ASR 走本地 ONNX 模型。LLM 走 OpenAI 兼容接口，Key 自己填。

---

## 快速开始

**前置**：Windows 10/11 x64；Node ≥ 22.18（要能直跑 `.ts`，本项目不编译服务端）。

```bash
npm install
npm run build        # 必须先构建：服务端静态出口只回 dist/index.html
npm start            # 打印 http://127.0.0.1:<端口>（端口 0 = 系统分配，不固定）
```

`npm start` = `node src/server/main.ts [数据根]`，数据根缺省为当前目录。
想把数据和代码分开放：`node src/server/main.ts D:\slice-data`。

### 克隆下来跑不起来，这是设计

仓库只放源码（1.3 MB），运行时合计约 2.3 GB 全部在 `.gitignore` 里——它们要么是第三方构建物，
要么有各自的许可，要么几百 MB 不适合进 git。缺哪样，对应步骤就不可用：

| 缺什么 | 谁需要它 | 怎么补 |
|---|---|---|
| `tools/ffmpeg/` | 几乎全部（抽音轨、抽帧、烧录） | FFmpeg 9.0.1，`ffmpeg.exe` + `ffprobe.exe` 放进去 |
| `tools/python/` + `models/demucs/` | s02 人声分离 | Python 3.13 + torch(cpu) 2.14 + [demucs](https://github.com/facebookresearch/demucs) 4.1.0；权重 `htdemucs`（80 MB） |
| `models/asr/` | s00 在**没有 SRT** 时的转写兜底 | Paraformer ONNX int8（233 MB），FunASR 官方导出 |
| `assets/bgm/` + `data/library.json` | s04 配乐 | 自己的曲库；总览页「素材库」输入框或 `POST /api/library/ingest` 改指向，只登记不复制 |
| `config.json` | s01 / s03 / s04 的 AI 路径（人工路径不需要） | 复制 `config.example.json` 填 `api_key` |

**最短可用路径**：有 SRT + 装好 ffmpeg + 装好 s02 那套（s05 对 s02 是强依赖，成片必须有分离结果），
再配一个 LLM Key，就能从字幕走到成片。只想看界面和数据流：`npm start` 后去总览页建任务即可，
不跑任何步骤也能看全部页面。

---

## 目录结构

```
src/
  shared/    前后端共享：步骤注册表（步骤依赖的唯一真相源）、全部数据结构
  server/    node:http 零框架；路由 + 读模型（empty/stale/missing 现算不落盘）+ 变体 + 媒体 Range 流
  steps/     六步执行体，每个跑在独立子进程里；lib.ts 管指纹、产物、step.json
  ui/        Vite + TS，无框架，哈希路由（#/job/<id>、#/clip/<id>）；产物是单个 index.html
tools/
  verify-*.ts  判据脚本（见下）
  asr_worker.py / demucs_worker.py   Python 侧的两个 worker
  fixtures/    判据夹具（10 秒带人声小片，99 KB）
  node/ ffmpeg/ python/   内置运行时（不入库）
launcher/    绿色目录启动器（C#，只做四件事：自愈 pyvenv.cfg、选数据根、拉起服务、开浏览器）
docs/        项目规划 / 交接文档 / 缺口与问题清单（决策记录，写得很啰嗦但都是实测结论）
```

---

## 判据

不是「跑起来没报错」，是脚本化的验收：真实起服务、真实开 headless 浏览器、真实跑 demucs 和 ffmpeg。
每条都有名字，失败会打印实测值而不是只说「断言失败」。

```bash
npm run check          # tsc --noEmit
npm run verify         # 六组全跑（约 10 分钟）
```

| 脚本 | 条数 | 覆盖 |
|---|---|---|
| `verify-tokens.ts` | 16 | 设计令牌单源；色值/字号不许写死；class 与 CSS 双向对账 |
| `verify-stage1.ts` | 29 | 读模型：empty / stale / missing / suspect 六态 |
| `verify-stage2.ts` | 257 | 写路径全 HTTP 驱动：建任务→六步→换源→并发写→demucs 自愈 |
| `verify-ui.ts` | 237 | 界面：真实点击、区块顺序、键盘可达、live region 文案 |
| `verify-e2e.ts` | 27 | 端到端：一条素材从头走到成片 |
| `verify-launch.ts` | 25 | 启动器：数据根选择、pyvenv.cfg 自愈、进程树收尾 |

> 上表是 2026-11-11 的实跑记录。条数会随功能增长，以脚本自身输出为准。

## 依赖与许可

| 组件 | 版本 | 形态 | 许可 |
|---|---|---|---|
| Node.js | 22.22.2（需 ≥ 22.18） | 外部运行时，不入库 | MIT |
| FFmpeg / ffprobe | 9.0.1 essentials（gyan.dev） | 外部二进制，不入库 | **GPL** 构建，以独立进程调用，不与本项目代码链接 |
| Python | 3.13.14 | 外部运行时，不入库 | PSF |
| PyTorch | 2.14.0+cpu | 不入库 | BSD-3-Clause |
| demucs | 4.1.0 | 不入库 | MIT |
| onnxruntime | 1.30.0 | 不入库 | MIT |
| Paraformer 权重 | int8 ONNX | 不入库 | 归 FunASR / 模型卡发布方，本项目不再分发 |
| htdemucs 权重 | `955717e8` | 不入库 | 随 demucs 发布 |
| BGM 素材 | 97 首 mp3 | **不在仓库内** | 版权不归本项目 |
| Vite / TypeScript / Playwright Core | 7.3.6 / 5.9.3 / 1.63.0 | devDependencies | MIT / Apache-2.0 / Apache-2.0 |

本仓库自身的代码以 **MIT** 发布（见 `LICENSE`）。**依赖、模型权重、素材不在 MIT 覆盖范围内**，
各自遵循上表的许可；分发本项目的构建产物时请自行核对 FFmpeg 的 GPL 构建义务。

## 文档

- [`docs/项目规划.md`](docs/项目规划.md) — 链路表、数据契约、§6 全部硬约束（为什么这么写）
- [`docs/交接文档.md`](docs/交接文档.md) — 当前状态、代码地图、坑位清单
- [`docs/缺口与问题清单.md`](docs/缺口与问题清单.md) — 逐轮审查记录，含未闭合项与实测证据
