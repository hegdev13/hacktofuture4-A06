"""K8s Agentic Decision Pipeline - Production-ready cost-aware recommendation engine.

This package provides a comprehensive system for generating cost-aware recommendations
for Kubernetes scaling decisions, helping SREs balance performance and cost.

Example usage:
    from k8s_agentic_pipeline import PolicyEngine, DecisionEngine

    policy = PolicyEngine(policy_path="sre_policy.yaml").policy
    engine = DecisionEngine(policy)
    response = engine.generate_recommendations(metrics, namespace, deployment, eval_id)
"""

__version__ = "1.0.0"
__author__ = "SRE Team"

from .core.decision_engine import DecisionEngine
from .core.metric_observer import MetricObserver
from .core.policy_engine import PolicyEngine
from .models import (
    ActionType,
    CostAnalysis,
    EvaluationResponse,
    MetricSnapshot,
    Recommendation,
    SREPolicy,
    TrendDirection,
)

__all__ = [
    "DecisionEngine",
    "MetricObserver",
    "PolicyEngine",
    "ActionType",
    "CostAnalysis",
    "EvaluationResponse",
    "MetricSnapshot",
    "Recommendation",
    "SREPolicy",
    "TrendDirection",
]