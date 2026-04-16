#!/usr/bin/env python3
"""Deterministic SRE decision engine for Kubernetes incidents.

Priority order:
1) Rulebook checks
2) Regex/log pattern analysis
3) Simulated ML-style classification
4) Fallback reasoning
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class Decision:
    root_cause: str
    action: str
    confidence: float
    impact: float
    cost: float
    score: float
    reasoning: str


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_percent(value: Any) -> float:
    v = to_float(value)
    if v > 1.0:
        v = v / 100.0
    return clamp01(v)


def has_any_pattern(text: str, patterns: List[str]) -> bool:
    return any(re.search(p, text, flags=re.IGNORECASE) for p in patterns)


def collect_text_fields(data: Dict[str, Any]) -> str:
    logs = data.get("logs", [])
    traces = data.get("traces", [])
    dependencies = data.get("dependency_graph", {})

    chunks: List[str] = []
    if isinstance(logs, list):
        chunks.extend(str(x) for x in logs)
    elif logs:
        chunks.append(str(logs))

    if isinstance(traces, list):
        chunks.extend(str(x) for x in traces)
    elif traces:
        chunks.append(str(traces))

    chunks.append(str(dependencies))
    return "\n".join(chunks)


def build_decision(
    root_cause: str,
    action: str,
    confidence: float,
    impact: float,
    cost: float,
    reasoning: str,
) -> Decision:
    c = clamp01(confidence)
    i = clamp01(impact)
    k = clamp01(cost)
    s = clamp01((i * c) - k)
    return Decision(root_cause=root_cause, action=action, confidence=c, impact=i, cost=k, score=s, reasoning=reasoning)


def step1_rulebook(data: Dict[str, Any]) -> Optional[Decision]:
    text = collect_text_fields(data)
    metrics = data.get("metrics", {}) or {}
    deployment = data.get("deployment", {}) or {}

    cpu = normalize_percent(metrics.get("cpu", metrics.get("cpu_utilization", 0.0)))

    if has_any_pattern(text, [r"CrashLoopBackOff"]):
        return build_decision(
            root_cause="Pod crash loop detected (CrashLoopBackOff).",
            action="restart",
            confidence=0.98,
            impact=0.75,
            cost=0.20,
            reasoning="Rulebook match: CrashLoopBackOff maps directly to pod restart.",
        )

    if has_any_pattern(text, [r"OOMKilled"]):
        return build_decision(
            root_cause="Container memory exhaustion (OOMKilled).",
            action="scale",
            confidence=0.97,
            impact=0.85,
            cost=0.45,
            reasoning="Rulebook match: OOMKilled requires memory increase or scaling.",
        )

    if cpu > 0.85:
        return build_decision(
            root_cause="Sustained high CPU utilization above 85%.",
            action="scale",
            confidence=0.92,
            impact=0.80,
            cost=0.45,
            reasoning="Rulebook match: high CPU indicates a scaling action.",
        )

    if has_any_pattern(text, [r"ImagePullBackOff"]):
        return build_decision(
            root_cause="Container image retrieval failure (ImagePullBackOff).",
            action="restart",
            confidence=0.95,
            impact=0.60,
            cost=0.20,
            reasoning="Rulebook match: fix image/config then restart pod deployment.",
        )

    recent_deploy = bool(deployment.get("recent", False))
    error_rate = normalize_percent(metrics.get("error_rate", metrics.get("errors", 0.0)))
    has_errors = error_rate > 0.05 or has_any_pattern(text, [r"error", r"exception", r"failed"])
    if recent_deploy and has_errors:
        return build_decision(
            root_cause="Recent deployment correlates with elevated errors.",
            action="rollback",
            confidence=0.93,
            impact=0.88,
            cost=0.35,
            reasoning="Rulebook match: deployment-induced regression should be rolled back.",
        )

    return None


def step2_regex_patterns(data: Dict[str, Any]) -> Optional[Decision]:
    text = collect_text_fields(data)

    checks: List[Tuple[List[str], str, str, float, float, float, str]] = [
        (
            [r"timeout", r"connection refused"],
            "Database/network connectivity instability.",
            "restart",
            0.82,
            0.62,
            0.20,
            "Strong log pattern for timeout/connection refusal indicates dependency reachability failure.",
        ),
        (
            [r"OOMKilled"],
            "Memory pressure causing process termination.",
            "scale",
            0.90,
            0.84,
            0.45,
            "Strong OOM pattern indicates memory remediation via scaling.",
        ),
        (
            [r"segmentation fault", r"panic"],
            "Application runtime crash.",
            "restart",
            0.80,
            0.66,
            0.20,
            "Crash signatures detected in logs suggest app failure.",
        ),
        (
            [r"rate limit", r"throttling"],
            "Throughput saturation or quota throttling.",
            "scale",
            0.84,
            0.78,
            0.45,
            "Rate limiting patterns generally improve with horizontal scaling.",
        ),
    ]

    for patterns, root_cause, action, confidence, impact, cost, reasoning in checks:
        if has_any_pattern(text, patterns):
            decision = build_decision(root_cause, action, confidence, impact, cost, reasoning)
            if decision.confidence > 0.70:
                return decision

    return None


def classify_category(data: Dict[str, Any]) -> Tuple[str, float, str]:
    metrics = data.get("metrics", {}) or {}
    deployment = data.get("deployment", {}) or {}
    text = collect_text_fields(data)

    cpu = normalize_percent(metrics.get("cpu", metrics.get("cpu_utilization", 0.0)))
    memory = normalize_percent(metrics.get("memory", metrics.get("memory_utilization", 0.0)))
    latency = normalize_percent(metrics.get("latency", metrics.get("latency_p95", 0.0)))
    error_rate = normalize_percent(metrics.get("error_rate", metrics.get("errors", 0.0)))

    slow_db_signal = 1.0 if has_any_pattern(text, [r"db", r"database", r"query slow", r"lock wait", r"timeout"]) else 0.0
    network_signal = 1.0 if has_any_pattern(text, [r"connection refused", r"unreachable", r"dns", r"timeout"]) else 0.0
    oom_signal = 1.0 if has_any_pattern(text, [r"OOMKilled", r"out of memory"]) else 0.0
    recent_deploy_signal = 1.0 if bool(deployment.get("recent", False)) else 0.0

    category_scores: Dict[str, float] = {
        "CPU bottleneck": clamp01((0.75 * cpu) + (0.25 * error_rate)),
        "Memory issue": clamp01((0.70 * memory) + (0.30 * oom_signal)),
        "Database latency": clamp01((0.65 * latency) + (0.35 * slow_db_signal)),
        "Network issue": clamp01((0.60 * network_signal) + (0.40 * latency)),
        "Deployment issue": clamp01((0.60 * recent_deploy_signal) + (0.40 * error_rate)),
    }

    category = max(category_scores, key=category_scores.get)
    category_confidence = category_scores[category]

    action_by_category = {
        "CPU bottleneck": "scale",
        "Memory issue": "scale",
        "Database latency": "restart",
        "Network issue": "restart",
        "Deployment issue": "rollback",
    }

    return category, category_confidence, action_by_category[category]


def action_cost(action: str) -> float:
    return {
        "restart": 0.20,
        "scale": 0.45,
        "rollback": 0.35,
    }.get(action, 0.40)


def action_impact_for_category(category: str) -> float:
    return {
        "CPU bottleneck": 0.82,
        "Memory issue": 0.84,
        "Database latency": 0.68,
        "Network issue": 0.64,
        "Deployment issue": 0.90,
    }.get(category, 0.60)


def step3_ml_style(data: Dict[str, Any]) -> Optional[Decision]:
    category, confidence, action = classify_category(data)
    impact = action_impact_for_category(category)
    cost = action_cost(action)

    decision = build_decision(
        root_cause=category,
        action=action,
        confidence=confidence,
        impact=impact,
        cost=cost,
        reasoning=(
            "ML-style classification from metrics/traces/dependency signals selected "
            f"'{category}' with action '{action}'."
        ),
    )

    if decision.confidence >= 0.70:
        return decision

    return None


def step4_fallback(data: Dict[str, Any]) -> Decision:
    metrics = data.get("metrics", {}) or {}
    cpu = normalize_percent(metrics.get("cpu", metrics.get("cpu_utilization", 0.0)))
    memory = normalize_percent(metrics.get("memory", metrics.get("memory_utilization", 0.0)))
    latency = normalize_percent(metrics.get("latency", metrics.get("latency_p95", 0.0)))
    error_rate = normalize_percent(metrics.get("error_rate", metrics.get("errors", 0.0)))

    # Conservative fallback to minimize risk under uncertainty.
    weighted_pressure = (0.30 * cpu) + (0.25 * memory) + (0.25 * latency) + (0.20 * error_rate)
    if weighted_pressure > 0.75:
        action = "scale"
        root = "Mixed saturation signals with high overall pressure."
        impact = 0.70
        cost = 0.45
    elif error_rate > 0.35:
        action = "rollback"
        root = "Conflicting telemetry but elevated error profile after change window."
        impact = 0.78
        cost = 0.35
    else:
        action = "restart"
        root = "Ambiguous signals; low-cost service recovery attempt preferred."
        impact = 0.55
        cost = 0.20

    return build_decision(
        root_cause=root,
        action=action,
        confidence=0.58,
        impact=impact,
        cost=cost,
        reasoning="Fallback reasoning used because earlier steps had low confidence or conflicting signals.",
    )


def decide(data: Dict[str, Any]) -> Decision:
    decision = step1_rulebook(data)
    if decision is not None:
        return decision

    decision = step2_regex_patterns(data)
    if decision is not None:
        return decision

    decision = step3_ml_style(data)
    if decision is not None:
        return decision

    return step4_fallback(data)


def format_decision(decision: Decision) -> str:
    return (
        f"Root Cause: {decision.root_cause}\n"
        f"Action: {decision.action}\n"
        f"Confidence: {decision.confidence:.2f}\n"
        f"Impact: {decision.impact:.2f}\n"
        f"Cost: {decision.cost:.2f}\n"
        f"Score: {decision.score:.2f}\n"
        f"Reasoning: {decision.reasoning}"
    )


def read_input(path: Optional[str]) -> Dict[str, Any]:
    if path:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    raw = sys.stdin.read().strip()
    if not raw:
        raise ValueError("No input provided. Pass a JSON file path or pipe JSON through stdin.")
    return json.loads(raw)


def main() -> int:
    input_path = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        payload = read_input(input_path)
        decision = decide(payload)
        print(format_decision(decision))
        return 0
    except Exception as exc:  # pragma: no cover - CLI safety path
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
