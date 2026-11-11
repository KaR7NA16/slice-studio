"""s00 的 ASR 兜底执行体（b2/b14/b41/b42：SRT 优先、ASR 兜底；引擎 Paraformer）。

与 demucs_worker 同源的三条硬约束（docs/项目规划.md §6）：
- ① 一律 `python.exe -m asr_worker`，**禁止**调 venv 的 `.exe` launcher（内嵌绝对路径，换机器即坏）；
- ② 真 fd 1 **独占**给 JSON：onnxruntime/kaldi 会往 fd 1 打日志，不 dup 的话
     下游解析到的是「日志里混着 JSON」，症状是随机的解析失败；
- ③ 权重默认从**本地目录**加载（`--model-dir`），零网络。
     `--allow-download` 只在首次准备权重时用，并把落点打出来，便于随后预置进数据根。

为什么是「onnxruntime 直调」而不是 `pip install funasr-onnx`（2026-09-18 实测，硬事实）：
- `funasr-onnx` 硬 pin `numpy<=1.26.4`；本 venv 是 numpy 2.5.3（torch 2.14 / demucs 4.1 要求）。
  numpy 1.26 在 Python 3.13 上**没有 wheel**，pip 会退化成源码构建并失败 → 该包在本环境**装不上**。
  降级 numpy 又会打断 demucs（s02 直接不可用），所以不能为了 ASR 换掉 numpy。
- 权重本身仍是 **FunASR 官方导出**：模型卡写明来自
  `damo/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-onnx`（ModelScope）。
  本环境 ModelScope 与 HF-LFS 全部不可达，只有 GitHub release 可下，
  故取 k2-fsa/sherpa-onnx 发布的同一份 FunASR ONNX 导出。
- 解码逻辑照抄权重包内 FunASR 官方参考脚本 `test-paraformer-onnx.py`
  （fbank 80 维 → LFR 7/6 → CMVN → logits/token_num/us_cif_peak），未自创特征或后处理口径。

用法：
  python.exe -m asr_worker --audio <16k mono wav> [--model-dir <dir>] [--allow-download]
                           [--device cpu] [--gap 0.5] [--max-sentence 20]

输出（stdout，一行 JSON）：
  {"ok": true, "sentences": [{"start": <秒>, "end": <秒>, "text": "..."}], "model": "<描述>"}
  {"ok": false, "error": "..."}
"""

import argparse
import json
import os
import sys
import tarfile
import tempfile
import traceback
import urllib.request

# ② 真 fd 1 独占给 JSON lines：先复制一份原 stdout 作协议通道，再把 fd 1 改道 stderr。
#    顺序很重要——必须在 import onnxruntime **之前**做，否则库在 import 期就打脏了 fd 1。
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)

# 权重来源（唯一可达的公开地址；见文件头「为什么」）。整包 234MB。
WEIGHT_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2"
)
WEIGHT_TARBALL = "sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2"

SAMPLE_RATE = 16000
LFR_M = 7
LFR_N = 6
LFR_FRAME_S = 0.01 * LFR_N  # LFR 后每帧 60ms

# ⚠️ CIF peak 的下标**不是** LFR 帧号，而是**编码器输出帧号**（本模型实测 255 = 85×3，
#    即编码器把 LFR 再降采样 3 倍 → 每帧 20ms）。第一版按 60ms 算，5.16s 的音频报出 13.68s，
#    且末句结束时间被 `min(end, audio_len)` 夹住 → 表现为「所有 end 都等于音频长度」。
#    所以帧长在运行时**按实际 shape 推**（LFR 帧数 / alphas 长度），不写死倍数：
#    换权重时倍数会变，写死就会静默算错时间轴，而字幕错位是「看起来能跑」的那类缺陷。


def emit(obj: dict) -> None:
    _proto.write(json.dumps(obj, ensure_ascii=False) + "\n")


def find_onnx(model_dir: str) -> str | None:
    for name in ("model.int8.onnx", "model_quant.onnx", "model.onnx"):
        p = os.path.join(model_dir, name)
        if os.path.isfile(p):
            return p
    return None


def download_weights(model_dir: str) -> None:
    """首次准备权重。下载后**平铺**到 model_dir（只留推理需要的四个文件）。"""
    os.makedirs(model_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        tar = os.path.join(td, WEIGHT_TARBALL)
        emit({"ok": True, "progress": f"下载权重 {WEIGHT_URL}"})
        urllib.request.urlretrieve(WEIGHT_URL, tar)  # noqa: S310
        with tarfile.open(tar, "r:bz2") as tf:
            tf.extractall(td, filter="data")  # noqa: S202
        src = None
        for entry in os.listdir(td):
            cand = os.path.join(td, entry)
            if os.path.isdir(cand) and find_onnx(cand):
                src = cand
                break
        if src is None:
            raise RuntimeError("权重包里找不到 onnx 模型")
        for name in ("model.int8.onnx", "model.onnx", "tokens.txt", "am.mvn", "config.yaml"):
            s = os.path.join(src, name)
            if os.path.isfile(s):
                dst = os.path.join(model_dir, name)
                with open(s, "rb") as fi, open(dst, "wb") as fo:
                    while True:
                        buf = fi.read(1 << 20)
                        if not buf:
                            break
                        fo.write(buf)
    emit({"ok": True, "progress": f"权重已落位：{model_dir}"})


def load_cmvn(model_dir: str):
    import numpy as np  # noqa: PLC0415

    neg_mean = None
    inv_std = None
    with open(os.path.join(model_dir, "am.mvn"), encoding="utf-8") as f:
        for line in f:
            if not line.startswith("<LearnRateCoef>"):
                continue
            t = list(map(float, line.split()[3:-1]))
            if neg_mean is None:
                neg_mean = np.array(t, dtype=np.float32)
            else:
                inv_std = np.array(t, dtype=np.float32)
    if neg_mean is None or inv_std is None:
        raise RuntimeError("am.mvn 解析失败")
    return neg_mean, inv_std


def load_tokens(model_dir: str) -> dict:
    ans = {}
    with open(os.path.join(model_dir, "tokens.txt"), encoding="utf-8") as f:
        for i, line in enumerate(f):
            ans[i] = line.strip().split()[0]
    return ans


def compute_feat(samples, neg_mean, inv_std):
    """官方参考脚本的 compute_feat：kaldi fbank(80) → LFR(7/6) → CMVN。"""
    import kaldi_native_fbank as knf  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    opts = knf.FbankOptions()
    opts.frame_opts.dither = 0
    opts.frame_opts.snip_edges = False
    opts.frame_opts.samp_freq = SAMPLE_RATE
    opts.mel_opts.num_bins = 80

    online_fbank = knf.OnlineFbank(opts)
    online_fbank.accept_waveform(SAMPLE_RATE, (samples * 32768).tolist())
    online_fbank.input_finished()

    n = online_fbank.num_frames_ready
    if n < LFR_M:
        return None
    features = np.stack([online_fbank.get_frame(i) for i in range(n)])

    # LFR：把相邻 7 帧拼成 560 维，步长 6 帧
    T = (features.shape[0] - LFR_M) // LFR_N + 1
    features = np.lib.stride_tricks.as_strided(
        features,
        shape=(T, features.shape[1] * LFR_M),
        strides=((LFR_N * features.shape[1]) * 4, 4),
    )
    features = (features + neg_mean) * inv_std
    return np.ascontiguousarray(features, dtype=np.float32)


def decode_chunk(sess, samples, neg_mean, inv_std, tokens, input_name, len_name, out_names):
    """跑一段音频，返回 [(秒, 字)] —— 时间来自 CIF peak 下标 × 运行时推出的编码器帧长。"""
    import numpy as np  # noqa: PLC0415

    feats = compute_feat(samples, neg_mean, inv_std)
    if feats is None:
        return []
    feats = np.expand_dims(feats, axis=0)
    lengths = np.array([feats.shape[1]], dtype=np.int32)
    outputs = sess.run(out_names, input_feed={input_name: feats, len_name: lengths})

    logits, token_num, alphas, cif_peak = outputs[0], outputs[1], outputs[2], outputs[3]
    y = logits[0].argmax(axis=-1)[: int(token_num[0])]
    peaks = [i for i, v in enumerate(cif_peak[0]) if v > (1 - 1e-4)]

    # 编码器帧长 = LFR 帧长 × (LFR 帧数 / 编码器帧数)。本模型 = 0.06 × 85/255 = 0.02s。
    n_enc = alphas.shape[1]
    shift = LFR_FRAME_S * feats.shape[1] / n_enc if n_enc else LFR_FRAME_S

    out = []
    for k, tok in enumerate(y):
        tid = int(tok)
        if tid in (0, 2):  # <blank> / </s>
            continue
        t = peaks[k] * shift if k < len(peaks) else None
        out.append((t, tokens.get(tid, "")))
    return out


def split_sentences(pairs, audio_len, gap_s, max_sentence, tail_s):
    """按停顿切句：相邻字间隔 > gap_s 或单句超过 max_sentence 就断。
    没有标点模型（本包只含 ASR AM，不含 punc），所以用停顿而不是标点切——
    这是与剪映真实场景的**已知偏离**，已记入 docs/缺口与问题清单.md。
    """
    groups = []
    cur = []
    for t, ch in pairs:
        if t is None or not ch:
            continue
        if cur:
            prev_t = cur[-1][0]
            if t - prev_t > gap_s or (t - cur[0][0]) > max_sentence:
                groups.append(cur)
                cur = []
        cur.append((t, ch))
    if cur:
        groups.append(cur)

    ans = []
    for idx, seg in enumerate(groups):
        text = "".join(c for _, c in seg)
        if not text.strip():
            continue
        start = seg[0][0]
        # 结束时间 = 末字起点 + tail（一个字约 0.2~0.4s），但不超过下一句起点与音频末尾。
        end = seg[-1][0] + tail_s
        if idx + 1 < len(groups):
            end = min(end, groups[idx + 1][0][0])
        if audio_len > 0:
            end = min(end, audio_len)
        # 兜底：end 不得早于 start（宁可短也不出倒置区间，倒置区间会让 s05 的 concat 直接失败）
        end = max(end, start + tail_s * 0.2)
        ans.append({"start": round(start, 3), "end": round(end, 3), "text": text})
    return ans


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--allow-download", action="store_true")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--gap", type=float, default=0.5)
    ap.add_argument("--max-sentence", type=float, default=20.0)
    ap.add_argument("--tail", type=float, default=0.3, help="末字到句尾的补偿秒数")
    ap.add_argument("--threads", type=int, default=0)
    # 切块秒数。默认 30，不要因为「进度更细」就调小：实测 10s 音频切到 3s 一块后，
    # 同段音频的识别结果从「各组比率按样本量做的加权平均」退化成
    # 「组比比按按本量做的恰真平倦」——上下文被切碎，Paraformer 的准确率直接掉。
    # 调小只用于验证（确认「进度在动」需要至少两块），不是产品参数。
    ap.add_argument("--chunk-sec", type=float, default=30.0)
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        emit({"ok": False, "error": f"音频不存在：{args.audio}"})
        return 2

    model_dir = args.model_dir
    if not model_dir:
        emit({"ok": False, "error": "没有本地权重：请用 --model-dir 指定（数据根 models/asr）"})
        return 5
    if not os.path.isdir(model_dir):
        if not args.allow_download:
            emit({"ok": False, "error": f"本地权重目录不存在：{model_dir}"})
            return 4
        os.makedirs(model_dir, exist_ok=True)

    onnx_path = find_onnx(model_dir)
    if onnx_path is None:
        if not args.allow_download:
            emit({
                "ok": False,
                "error": f"权重目录里没有 onnx 模型：{model_dir}（首次准备请加 --allow-download）",
            })
            return 4
        try:
            download_weights(model_dir)
        except Exception as e:  # noqa: BLE001
            emit({"ok": False, "error": f"权重下载失败（{type(e).__name__}: {e}）"})
            return 4
        onnx_path = find_onnx(model_dir)
        if onnx_path is None:
            emit({"ok": False, "error": f"下载后仍找不到 onnx 模型：{model_dir}"})
            return 4

    try:
        import numpy as np  # noqa: PLC0415
        import onnxruntime  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        emit({
            "ok": False,
            "error": f"ASR 依赖缺失（{type(e).__name__}: {e}）——需要 onnxruntime/numpy/soundfile/kaldi_native_fbank",
        })
        return 3

    try:
        samples, sr = sf.read(args.audio, dtype="float32", always_2d=True)
        samples = samples.mean(axis=1)
        if int(sr) != SAMPLE_RATE:
            emit({
                "ok": False,
                "error": f"音频采样率是 {sr}，要 {SAMPLE_RATE}。重采样交给 ffmpeg，不在 Python 里做。",
            })
            return 6
        samples = np.ascontiguousarray(samples, dtype=np.float32)
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"读音频失败（{type(e).__name__}: {e}）"})
        return 6

    audio_len = len(samples) / SAMPLE_RATE
    if audio_len <= 0.05:
        emit({"ok": False, "error": "音频过短或为空"})
        return 6

    try:
        neg_mean, inv_std = load_cmvn(model_dir)
        tokens = load_tokens(model_dir)
        so = onnxruntime.SessionOptions()
        so.log_severity_level = 3
        if args.threads > 0:
            so.intra_op_num_threads = args.threads
        sess = onnxruntime.InferenceSession(onnx_path, so, providers=["CPUExecutionProvider"])
        input_name = sess.get_inputs()[0].name
        len_name = sess.get_inputs()[1].name
        out_names = [o.name for o in sess.get_outputs()]
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "error": f"加载模型失败（{type(e).__name__}: {e}）\n{traceback.format_exc()[-600:]}"})
        return 7

    # 长音频切块：Paraformer 单次推理对长音频显存/内存与时延都不友好。
    # 切点选在**能量最低处**（而不是硬切整秒），避免把字切成两半。
    chunks = []
    win = max(1.0, args.chunk_sec)
    if audio_len <= win:
        chunks = [(0, len(samples))]
    else:
        pos = 0
        while pos < len(samples):
            end = min(pos + int(win * SAMPLE_RATE), len(samples))
            if end < len(samples):
                lo = end - int(1.0 * SAMPLE_RATE)
                seg = samples[max(lo, pos):end]
                if len(seg) > 0:
                    hop = max(1, int(0.01 * SAMPLE_RATE))
                    rms = np.sqrt(np.convolve(seg.astype(np.float64) ** 2, np.ones(hop) / hop, mode="same"))
                    end = max(lo, pos) + int(np.argmin(rms))
            chunks.append((pos, end))
            pos = end

    pairs = []
    total_sec = audio_len
    for start_i, end_i in chunks:
        if end_i - start_i < int(0.1 * SAMPLE_RATE):
            continue
        offset = start_i / SAMPLE_RATE
        got = decode_chunk(sess, samples[start_i:end_i], neg_mean, inv_std, tokens, input_name, len_name, out_names)
        for t, ch in got:
            pairs.append((None if t is None else t + offset, ch))
        # 进度报的是**真实音频位置**（这块结束处的采样点），不是按块数估的百分比——
        # 块长不等（切点在能量最低处），按块数算出来的百分比会跳。
        emit({"done_sec": round(end_i / SAMPLE_RATE, 1), "total_sec": round(total_sec, 1)})

    if not pairs:
        emit({"ok": False, "error": "转写结果里没有可用文本（音频可能是静音或纯噪声）"})
        return 8

    sents = split_sentences(pairs, audio_len, args.gap, args.max_sentence, args.tail)
    if not sents:
        emit({"ok": False, "error": "转写结果里没有可用文本"})
        return 8

    emit({
        "ok": True,
        "sentences": sents,
        "model": f"paraformer-zh(onnx) {os.path.basename(onnx_path)}",
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
