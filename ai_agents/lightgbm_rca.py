#!/usr/bin/env python3
"""LightGBM-based Root Cause Analysis (RCA) utility.

Modes:
- train: generate mock incident data, train a LightGBM model, save model + metadata.
- predict: load trained model and score current pod state to find dynamic root cause.

Usage examples:
  python3 ai_agents/lightgbm_rca.py --mode train --output-dir ai_agents/models --rows 12000
  cat payload.json | python3 ai_agents/lightgbm_rca.py --mode predict --model-dir ai_agents/models
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np

try:
    import lightgbm as lgb
except ImportError as exc:  # pragma: no cover - explicit runtime guidance
    raise SystemExit(
        "Missing dependency: lightgbm. Install it with: pip install lightgbm"
    ) from exc


FEATURE_NAMES = [
    "cpu",
    "memory",
    "restart_count",
    "status_failed",
    "status_pending",
    "status_running",
    "num_dependencies",
    "num_dependents",
    "failed_dependencies",
    "failed_dependents",
    "failed_ratio_dependencies",
    "failed_ratio_dependents",
    "is_database",
    "is_cache",
    "is_api",
    "is_worker",
    "is_frontend",
]


@dataclass
class PodState:
    name: str
    status: str
    cpu: float
    memory: float
    restart_count: int


def status_flags(status: str) -> Tuple[int, int, int]:
    s = (status or "").lower()
    failed = int(any(k in s for k in ["failed", "crash", "error", "oom", "backoff"]))
    pending = int("pending" in s or "init" in s)
    running = int(not failed and not pending)
    return failed, pending, running


def service_type_flags(name: str) -> Tuple[int, int, int, int, int]:
    n = name.lower()
    return (
        int(any(k in n for k in ["db", "database", "postgres", "mysql", "mongo"])),
        int(any(k in n for k in ["redis", "cache"])),
        int("api" in n or "backend" in n or "gateway" in n),
        int("worker" in n or "job" in n),
        int("frontend" in n or "web" in n or "ui" in n),
    )


def build_reverse_map(dependency_map: Dict[str, List[str]]) -> Dict[str, List[str]]:
    reverse = defaultdict(list)
    for svc, deps in dependency_map.items():
        for dep in deps:
            reverse[dep].append(svc)
    return dict(reverse)


def normalize_memory(value: float) -> float:
    # Keep features in comparable ranges; memory often comes in bytes.
    return max(0.0, min(1.0, value / (1024.0 * 1024.0 * 1024.0)))


def pod_feature_vector(
    pod: PodState,
    pods_by_name: Dict[str, PodState],
    dependency_map: Dict[str, List[str]],
    reverse_map: Dict[str, List[str]],
) -> List[float]:
    deps = dependency_map.get(pod.name, [])
    dependents = reverse_map.get(pod.name, [])

    dep_failed = sum(status_flags(pods_by_name.get(d, PodState(d, "Running", 0.1, 256e6, 0)).status)[0] for d in deps)
    depd_failed = sum(status_flags(pods_by_name.get(d, PodState(d, "Running", 0.1, 256e6, 0)).status)[0] for d in dependents)

    failed, pending, running = status_flags(pod.status)
    t_db, t_cache, t_api, t_worker, t_front = service_type_flags(pod.name)

    num_deps = len(deps)
    num_dependents = len(dependents)
    dep_ratio = dep_failed / max(1, num_deps)
    depd_ratio = depd_failed / max(1, num_dependents)

    return [
        float(max(0.0, min(2.0, pod.cpu))),
        float(normalize_memory(pod.memory)),
        float(max(0, pod.restart_count)),
        float(failed),
        float(pending),
        float(running),
        float(num_deps),
        float(num_dependents),
        float(dep_failed),
        float(depd_failed),
        float(dep_ratio),
        float(depd_ratio),
        float(t_db),
        float(t_cache),
        float(t_api),
        float(t_worker),
        float(t_front),
    ]


def random_service_graph(services: List[str], edge_prob: float = 0.22) -> Dict[str, List[str]]:
    # Directed acyclic-ish graph by only allowing dependencies from later to earlier index.
    deps: Dict[str, List[str]] = {s: [] for s in services}
    for i, svc in enumerate(services):
        for j in range(i):
            if random.random() < edge_prob:
                deps[svc].append(services[j])
    return deps


def cause_profile(root: str, cause_type: str) -> Tuple[float, float, int, str]:
    if cause_type == "cpu":
        return random.uniform(0.9, 1.5), random.uniform(400e6, 900e6), random.randint(0, 2), "CrashLoopBackOff"
    if cause_type == "memory":
        return random.uniform(0.5, 1.1), random.uniform(1.3e9, 2.8e9), random.randint(1, 5), "OOMKilled"
    if cause_type == "network":
        return random.uniform(0.2, 0.9), random.uniform(300e6, 900e6), random.randint(0, 2), "Error"
    # crash
    return random.uniform(0.3, 1.0), random.uniform(300e6, 1000e6), random.randint(3, 8), "CrashLoopBackOff"


def simulate_incident(services: List[str]) -> Tuple[List[PodState], Dict[str, List[str]], str]:
    dependency_map = random_service_graph(services)
    reverse_map = build_reverse_map(dependency_map)

    root = random.choice(services)
    cause_type = random.choice(["cpu", "memory", "network", "crash"])

    pods: Dict[str, PodState] = {}
    for s in services:
        pods[s] = PodState(
            name=s,
            status="Running",
            cpu=random.uniform(0.08, 0.55),
            memory=random.uniform(180e6, 900e6),
            restart_count=random.randint(0, 1),
        )

    rcpu, rmem, rrestart, rstatus = cause_profile(root, cause_type)
    pods[root] = PodState(root, rstatus, rcpu, rmem, rrestart)

    # Propagate cascading degradation to dependents.
    q: deque[str] = deque([root])
    visited = {root}
    while q:
        cur = q.popleft()
        for depd in reverse_map.get(cur, []):
            if depd in visited:
                continue
            visited.add(depd)
            if random.random() < 0.72:
                base = pods[depd]
                bad_status = random.choice(["Error", "Pending", "CrashLoopBackOff"])
                pods[depd] = PodState(
                    depd,
                    bad_status,
                    min(2.0, base.cpu + random.uniform(0.05, 0.45)),
                    min(3e9, base.memory + random.uniform(50e6, 600e6)),
                    base.restart_count + random.randint(0, 3),
                )
                q.append(depd)

    return list(pods.values()), dependency_map, root


def build_mock_training_data(rows: int = 10000) -> Tuple[np.ndarray, np.ndarray, List[Dict[str, Any]]]:
    services = [
        "database-primary",
        "cache-redis",
        "api-server",
        "worker-1",
        "worker-2",
        "web-frontend",
        "log-aggregator",
        "monitoring-agent",
    ]

    x_rows: List[List[float]] = []
    y_rows: List[int] = []
    samples: List[Dict[str, Any]] = []

    incidents = max(300, rows // len(services))
    for _ in range(incidents):
        pods, dep_map, root = simulate_incident(services)
        reverse_map = build_reverse_map(dep_map)
        by_name = {p.name: p for p in pods}

        for pod in pods:
            feat = pod_feature_vector(pod, by_name, dep_map, reverse_map)
            label = int(pod.name == root)
            x_rows.append(feat)
            y_rows.append(label)

            samples.append(
                {
                    "name": pod.name,
                    "status": pod.status,
                    "cpu": round(pod.cpu, 4),
                    "memory": round(pod.memory, 2),
                    "restart_count": pod.restart_count,
                    "label_root_cause": label,
                }
            )

    x = np.array(x_rows, dtype=np.float32)
    y = np.array(y_rows, dtype=np.int32)
    return x, y, samples


def split_indices(n: int, train_ratio: float = 0.8) -> Tuple[np.ndarray, np.ndarray]:
    idx = np.arange(n)
    np.random.shuffle(idx)
    cut = int(n * train_ratio)
    return idx[:cut], idx[cut:]


def train_lightgbm(x: np.ndarray, y: np.ndarray) -> Tuple[Any, Dict[str, float]]:
    train_idx, val_idx = split_indices(len(x), train_ratio=0.82)
    x_train, y_train = x[train_idx], y[train_idx]
    x_val, y_val = x[val_idx], y[val_idx]

    train_data = lgb.Dataset(x_train, label=y_train, feature_name=FEATURE_NAMES)
    val_data = lgb.Dataset(x_val, label=y_val, feature_name=FEATURE_NAMES, reference=train_data)

    params = {
        "objective": "binary",
        "metric": ["binary_logloss", "auc"],
        "learning_rate": 0.05,
        "num_leaves": 63,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.9,
        "bagging_freq": 3,
        "min_data_in_leaf": 35,
        "verbosity": -1,
        "seed": 42,
    }

    booster = lgb.train(
        params,
        train_data,
        num_boost_round=350,
        valid_sets=[val_data],
        callbacks=[lgb.early_stopping(30, verbose=False)],
    )

    preds = booster.predict(x_val, num_iteration=booster.best_iteration)
    y_hat = (preds >= 0.5).astype(np.int32)
    acc = float((y_hat == y_val).mean()) if len(y_val) else 0.0

    pos_idx = np.where(y_val == 1)[0]
    neg_idx = np.where(y_val == 0)[0]
    if len(pos_idx) and len(neg_idx):
        # Mann-Whitney U equivalent for AUC.
        order = np.argsort(preds)
        ranks = np.empty_like(order)
        ranks[order] = np.arange(len(preds)) + 1
        rank_sum_pos = ranks[pos_idx].sum()
        auc = float((rank_sum_pos - len(pos_idx) * (len(pos_idx) + 1) / 2) / (len(pos_idx) * len(neg_idx)))
    else:
        auc = 0.0

    return booster, {"val_accuracy": round(acc, 4), "val_auc": round(auc, 4)}


def find_affected(root: str, dependency_map: Dict[str, List[str]], failed_set: set[str]) -> List[str]:
    reverse = build_reverse_map(dependency_map)
    affected: List[str] = []
    q: deque[str] = deque([root])
    seen = {root}

    while q:
        cur = q.popleft()
        for depd in reverse.get(cur, []):
            if depd in seen:
                continue
            seen.add(depd)
            if depd in failed_set:
                affected.append(depd)
                q.append(depd)

    return affected


def dynamic_score(prob: float, pod: PodState, feat_map: Dict[str, float]) -> float:
    failed, pending, _ = status_flags(pod.status)
    status_term = 0.08 if failed else (0.03 if pending else -0.03)
    independence = 0.08 if feat_map["failed_dependencies"] == 0 and failed else 0.0
    cascade = 0.08 * feat_map["failed_ratio_dependents"]
    return float(max(0.0, min(1.0, 0.76 * prob + status_term + independence + cascade)))


def remediations_for_root(root: str, affected_count: int) -> List[Dict[str, str]]:
    low = root.lower()
    if "database" in low or "postgres" in low or "mysql" in low:
        return [
            {
                "priority": "critical",
                "action": f"Restart {root}",
                "reason": "Database root cause likely impacting dependent services",
                "command": f"kubectl rollout restart deployment/{root}",
                "impact": f"May recover {affected_count} cascading pod(s)",
            }
        ]
    if "cache" in low or "redis" in low:
        return [
            {
                "priority": "high",
                "action": f"Restart {root}",
                "reason": "Cache instability can propagate quickly",
                "command": f"kubectl rollout restart deployment/{root}",
                "impact": f"May recover {affected_count} cascading pod(s)",
            }
        ]
    return [
        {
            "priority": "high",
            "action": f"Investigate and restart {root}",
            "reason": "Highest dynamic root-cause score",
            "command": f"kubectl describe pod {root} && kubectl logs {root} --tail=100",
            "impact": f"Potentially recovers {affected_count} cascading pod(s)",
        }
    ]


def predict_root_cause(
    payload: Dict[str, Any],
    model_dir: Path,
) -> Dict[str, Any]:
    model_path = model_dir / "lightgbm_rca_model.txt"
    meta_path = model_dir / "lightgbm_rca_meta.json"
    if not model_path.exists() or not meta_path.exists():
        raise FileNotFoundError(
            "Model files missing. Train first with --mode train --output-dir ai_agents/models"
        )

    with meta_path.open("r", encoding="utf-8") as fh:
        metadata = json.load(fh)

    booster = lgb.Booster(model_file=str(model_path))

    pods_raw = payload.get("pods", [])
    dependency_map = payload.get("dependency_map") or {}

    pods: List[PodState] = []
    for p in pods_raw:
        pods.append(
            PodState(
                name=str(p.get("name", "unknown")),
                status=str(p.get("status", "Running")),
                cpu=float(p.get("cpu", 0.0) or 0.0),
                memory=float(p.get("memory", 0.0) or 0.0),
                restart_count=int(p.get("restart_count", 0) or 0),
            )
        )

    if not pods:
        return {
            "status": "healthy",
            "rootCauses": [],
            "affectedPods": [],
            "impactedCount": 0,
            "healthPercent": 100,
            "remediations": [],
            "summary": "No pods provided",
            "rankedRootCauses": [],
        }

    reverse = build_reverse_map(dependency_map)
    pods_by_name = {p.name: p for p in pods}

    x_rows: List[List[float]] = []
    feat_maps: Dict[str, Dict[str, float]] = {}
    for p in pods:
        vec = pod_feature_vector(p, pods_by_name, dependency_map, reverse)
        x_rows.append(vec)
        feat_maps[p.name] = {FEATURE_NAMES[i]: vec[i] for i in range(len(FEATURE_NAMES))}

    x = np.array(x_rows, dtype=np.float32)
    probs = booster.predict(x)

    ranked: List[Dict[str, Any]] = []
    failed_set = set()
    for i, pod in enumerate(pods):
        failed, pending, running = status_flags(pod.status)
        if failed or pending:
            failed_set.add(pod.name)

        score = dynamic_score(float(probs[i]), pod, feat_maps[pod.name])
        ranked.append(
            {
                "name": pod.name,
                "status": pod.status,
                "cpu": pod.cpu,
                "memory": pod.memory,
                "probability": round(float(probs[i]), 6),
                "dynamicScore": round(score, 6),
                "failedDependencies": int(feat_maps[pod.name]["failed_dependencies"]),
                "failedDependents": int(feat_maps[pod.name]["failed_dependents"]),
                "restartCount": pod.restart_count,
                "isCandidate": bool(failed or pending),
            }
        )

    candidate_ranked = [r for r in ranked if r["isCandidate"]]
    if not candidate_ranked:
        candidate_ranked = ranked

    candidate_ranked.sort(key=lambda r: r["dynamicScore"], reverse=True)
    top = candidate_ranked[0]
    root = top["name"]

    affected = find_affected(root, dependency_map, failed_set)
    impacted_count = len(set(affected + [root]))
    total = max(1, len(pods))
    health_percent = int(round((1.0 - (impacted_count / total)) * 100.0))

    status = "healthy"
    if impacted_count > 0:
        status = "critical" if impacted_count >= max(3, math.ceil(total * 0.3)) else "degraded"

    return {
        "status": status,
        "rootCauses": [
            {
                "name": root,
                "status": top["status"],
                "cpu": top["cpu"],
                "memory": top["memory"],
                "score": top["dynamicScore"],
                "modelProbability": top["probability"],
            }
        ],
        "affectedPods": affected,
        "impactedCount": impacted_count,
        "healthPercent": max(0, min(100, health_percent)),
        "remediations": remediations_for_root(root, len(affected)),
        "summary": f"LightGBM selected {root} as the most likely dynamic root cause with score {top['dynamicScore']:.3f}.",
        "rankedRootCauses": candidate_ranked[:8],
        "modelInfo": {
            "featureNames": metadata.get("featureNames", FEATURE_NAMES),
            "metrics": metadata.get("metrics", {}),
            "trainedAt": metadata.get("trainedAt"),
        },
    }


def train_mode(output_dir: Path, rows: int) -> Dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)

    x, y, samples = build_mock_training_data(rows=rows)
    booster, metrics = train_lightgbm(x, y)

    model_path = output_dir / "lightgbm_rca_model.txt"
    meta_path = output_dir / "lightgbm_rca_meta.json"
    sample_path = output_dir / "mock_rca_samples.json"

    booster.save_model(str(model_path))

    metadata = {
        "featureNames": FEATURE_NAMES,
        "rows": int(len(x)),
        "positiveRate": round(float(y.mean()), 6),
        "metrics": metrics,
        "trainedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }

    with meta_path.open("w", encoding="utf-8") as fh:
        json.dump(metadata, fh, indent=2)

    with sample_path.open("w", encoding="utf-8") as fh:
        json.dump(samples[: min(1200, len(samples))], fh, indent=2)

    return {
        "ok": True,
        "modelPath": str(model_path),
        "metaPath": str(meta_path),
        "mockSamplesPath": str(sample_path),
        "metrics": metrics,
        "rows": int(len(x)),
        "positiveRate": round(float(y.mean()), 6),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LightGBM RCA trainer/predictor")
    parser.add_argument("--mode", choices=["train", "predict"], required=True)
    parser.add_argument("--output-dir", default="ai_agents/models")
    parser.add_argument("--model-dir", default="ai_agents/models")
    parser.add_argument("--rows", type=int, default=12000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.mode == "train":
        result = train_mode(Path(args.output_dir), rows=max(2000, int(args.rows)))
        print(json.dumps(result))
        return

    payload = json.load(__import__("sys").stdin)
    result = predict_root_cause(payload=payload, model_dir=Path(args.model_dir))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
