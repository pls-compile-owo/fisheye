#!/usr/bin/env python3
"""语义切分 CLI（fisheye 语义模块参考实现）

契约（fisheye 通过子进程调用，stdout 输出 JSON）：
  python cli.py <input.json> [--n-bkps N] [--model NAME]

  input.json: [{"t": 12.3, "text": "台词..."}, ...]
  stdout: {
    "segments":    [{"t": 123.4, "confidence": 0.82, "signals": ["embedding", "change"]}],
    "suggestions": [{"t": 123.4, "reason": "...", "confidence": 0.82,
                     "source": "semantic", "kind": "structural"}]
  }

原理：台词逐行做 embedding → 相邻窗口质心的余弦距离度量语义漂移 → ruptures 变点检测
找话题切换点。零 token、纯 CPU。

依赖：pip install -r semantic/requirements.txt
（fastembed 首次运行会自动下载模型，中文默认 BAAI/bge-small-zh-v1.5，约 100MB。）
"""
import argparse
import json
import sys


def emit(obj):
    """把结果写到 stdout（fisheye 用 fd 重定向捕获）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def empty():
    emit({"segments": [], "suggestions": []})


def main():
    ap = argparse.ArgumentParser(description="fisheye semantic segmenter (reference implementation)")
    ap.add_argument("input", help="台词 JSON 文件（[{t, text}]）")
    ap.add_argument("--n-bkps", type=int, default=5, help="期望的最多切换点数")
    ap.add_argument("--model", default=None, help="fastembed 模型名（默认 BAAI/bge-small-zh-v1.5）")
    ap.add_argument("--min-lines", type=int, default=8, help="少于这么多行不做切分")
    args = ap.parse_args()

    # 输入解析失败不报错：返回空结果，fisheye 会当作"无切换点"降级
    try:
        with open(args.input, encoding="utf-8") as f:
            lines = json.load(f)
    except Exception:
        empty()
        return 0

    lines = [l for l in lines if isinstance(l, dict) and str(l.get("text", "")).strip()]
    if len(lines) < args.min_lines:
        empty()
        return 0

    try:
        import numpy as np
        from fastembed import TextEmbedding
        import ruptures as rpt
    except ImportError as e:
        # 依赖缺失：返回带 error 的空结构（fisheye 侧解析失败会降级）
        emit({"segments": [], "suggestions": [], "error": f"missing deps: {e}"})
        return 0

    texts = [str(l["text"]).strip() for l in lines]
    times = [float(l.get("t") or 0) for l in lines]

    try:
        model = TextEmbedding(model_name=args.model or "BAAI/bge-small-zh-v1.5")
        vectors = np.array([list(v) for v in model.embed(texts)], dtype=np.float64)
    except Exception as e:
        emit({"segments": [], "suggestions": [], "error": f"embedding failed: {e}"})
        return 0

    if vectors.shape[0] < args.min_lines:
        empty()
        return 0

    # 变点检测：线性核 KCPD（比 PELT 更稳，适合 embedding 序列）
    n_bkps = max(1, min(args.n_bkps, max(1, len(texts) // 10)))
    try:
        algo = rpt.KernelCPD(kernel="linear", min_size=2).fit(vectors)
        bkps = algo.predict(n_bkps=n_bkps)
    except Exception as e:
        emit({"segments": [], "suggestions": [], "error": f"change-point failed: {e}"})
        return 0

    segments = []
    suggestions = []
    for b in bkps[:-1]:  # ruptures 最后一个元素是序列长度
        idx = min(b, len(times) - 1)
        if idx <= 0:
            continue
        left = vectors[max(0, idx - 5):idx].mean(axis=0)
        right = vectors[idx:min(len(vectors), idx + 5)].mean(axis=0)
        denom = (np.linalg.norm(left) * np.linalg.norm(right)) + 1e-9
        cos = float(np.dot(left, right) / denom)
        conf = round(max(0.0, min(1.0, 1.0 - cos)), 3)
        t = times[idx]
        segments.append({"t": t, "confidence": conf, "signals": ["embedding", "change"]})
        suggestions.append({
            "t": t,
            "reason": f"话题切换（embedding 变点，置信度 {conf}）",
            "confidence": conf,
            "source": "semantic",
            "kind": "structural",
        })

    emit({"segments": segments, "suggestions": suggestions})
    return 0


if __name__ == "__main__":
    sys.exit(main())
