#!/usr/bin/env python
"""demucs 常驻分离 worker —— s02 的外部件。

形态约束（docs/项目规划.md §6，都是硬约束）：
- ② 调用形态一律 `python.exe -m demucs_worker`，禁止调 venv 的 `.exe` launcher
  （launcher 二进制内嵌绝对路径，换机器即坏或静默走错解释器）。
- ⑥ 权重走数据根 `models/demucs`，零网络。**`repo` 必须是 `pathlib.Path`**：
  传 `str` 会在 `pretrained.py:89` 抛 `AttributeError: 'str' object has no attribute 'is_dir'`
  （2026-09-18 首次实测就撞到；规划原文只写了路径、没写类型）。

常驻的意义（2026-09-18 实测，2 秒音频 / CPU）：
    import torch 2.09s ｜ Separator 加载权重 0.51s ｜ 首次分离 4.34s ｜ 复用分离 2.64s
  大头是**进程固定开销**（解释器 ~1.4s + import torch 2.09s），不是权重（0.51s）。
  所以本 worker 加载一次模型后**循环接任务**。数据根上的 broker 把多条片段喂进同一个 stdin，
  权重只加载一次（b44/b45）。

协议（stdin / stdout 各一行 JSON，UTF-8）：
    入：{"id": "<任务 id>", "audio": "<wav 绝对路径>", "out_dir": "<输出目录绝对路径>"}
    出：{"type": "ready", "samplerate": 44100, "sources": ["drums", ...]}
        {"type": "progress", "id": ..., "state": ..., "segment_offset": ..., "audio_length": ...}
        {"type": "done", "id": ..., "vocals": "<路径>", "no_vocals": "<路径>", "seconds": 1.23}
        {"type": "error", "id": ... | null, "message": "..."}
  调用方按行读 stdout 直到收到 done / error；id 原样回传，便于多任务并发时归位。
"""

import json
import os
import sys
from pathlib import Path

# demucs / torch 会往 fd 1 打进度条与日志，会污染 JSON lines 协议。
# 把真正的 fd 1 独占给协议，之后所有 print 与 C 层 stdout 全部改道 stderr。
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)


def emit(**obj):
    _proto.write(json.dumps(obj, ensure_ascii=False) + "\n")


def main() -> int:
    argv = sys.argv[1:]
    if "--repo" not in argv:
        emit(type="error", id=None, message="缺少 --repo 参数（应指向数据根的 models/demucs）")
        return 2
    repo = Path(argv[argv.index("--repo") + 1])  # ← 必须 Path，不能 str

    from demucs.api import Separator
    from demucs.audio import save_audio

    # 当前任务 id：callback 在构造时绑定一次，任务 id 逐任务变化，用可变容器传递
    current = {"id": None}

    def on_progress(info):
        emit(
            type="progress",
            id=current["id"],
            state=info.get("state"),
            segment_offset=info.get("segment_offset"),
            audio_length=info.get("audio_length"),
        )

    sep = Separator(model="htdemucs", repo=repo, callback=on_progress, callback_arg={})
    emit(type="ready", samplerate=sep.samplerate, sources=list(sep.model.sources))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            task = json.loads(line)
        except json.JSONDecodeError as err:
            emit(type="error", id=None, message=f"任务不是合法 JSON：{err}")
            continue

        tid = task.get("id")
        current["id"] = tid
        try:
            out_dir = Path(task["out_dir"])
            out_dir.mkdir(parents=True, exist_ok=True)
            _, stems = sep.separate_audio_file(Path(task["audio"]))

            # API 只给 4 轨（drums/bass/other/vocals），**不直接给 no_vocals**。
            # 伴奏 = 除 vocals 外各轨之和，与 demucs CLI 的 --two-stems=vocals 同口径。
            vocals = stems["vocals"]
            no_vocals = sum(t for name, t in stems.items() if name != "vocals")

            v_path = out_dir / "vocals.wav"
            n_path = out_dir / "no_vocals.wav"
            save_audio(vocals, v_path, sep.samplerate)
            save_audio(no_vocals, n_path, sep.samplerate)

            emit(
                type="done",
                id=tid,
                vocals=str(v_path),
                no_vocals=str(n_path),
                seconds=round(vocals.shape[1] / sep.samplerate, 2),
            )
        except Exception as err:  # 单任务失败不拖垮 worker：报错后继续接下一个
            emit(type="error", id=tid, message=f"{type(err).__name__}: {err}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
