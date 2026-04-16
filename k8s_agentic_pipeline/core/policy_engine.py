"""Policy Engine for loading and validating SRE policies."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional, Union

import yaml

from ..models import SREPolicy


class PolicyEngine:
    """Engine for loading and applying SRE policies."""

    DEFAULT_POLICY_PATHS = [
        "./sre_policy.yaml",
        "./config/sre_policy.yaml",
        "~/.config/k8s-agent/sre_policy.yaml",
        "/etc/k8s-agent/sre_policy.yaml",
    ]

    def __init__(self, policy: Optional[SREPolicy] = None, policy_path: Optional[str] = None):
        """Initialize the policy engine.

        Args:
            policy: Pre-loaded policy object
            policy_path: Path to policy YAML file
        """
        self._policy = policy
        self._policy_path = policy_path

        if policy is None:
            self._load_policy(policy_path)

    def _load_policy(self, policy_path: Optional[str] = None) -> None:
        """Load policy from file or use defaults.

        Args:
            policy_path: Specific path to policy file, or None to search defaults
        """
        if policy_path:
            paths = [policy_path]
        else:
            paths = self.DEFAULT_POLICY_PATHS

        for path in paths:
            expanded_path = os.path.expanduser(path)
            if os.path.isfile(expanded_path):
                try:
                    self._policy = self._load_from_file(expanded_path)
                    self._policy_path = expanded_path
                    return
                except Exception as e:
                    raise ValueError(f"Failed to load policy from {expanded_path}: {e}")

        # Use defaults if no file found
        self._policy = SREPolicy()
        self._policy_path = None

    def _load_from_file(self, path: str) -> SREPolicy:
        """Load policy from YAML file.

        Args:
            path: Path to YAML file

        Returns:
            SREPolicy instance
        """
        with open(path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)

        if not isinstance(data, dict):
            raise ValueError("Policy file must contain a YAML dictionary")

        return SREPolicy(**data)

    @property
    def policy(self) -> SREPolicy:
        """Get the current policy."""
        if self._policy is None:
            raise RuntimeError("Policy not loaded")
        return self._policy

    def reload(self) -> None:
        """Reload policy from file."""
        self._load_policy(self._policy_path)

    def validate_metrics_against_thresholds(
        self,
        cpu_percent: float,
        memory_percent: float,
        latency_ms: float,
        error_rate: float,
        availability: float,
    ) -> Dict[str, Any]:
        """Validate metrics against policy thresholds.

        Returns dict with violations and status.
        """
        thresholds = self.policy.performance_thresholds
        violations = []

        if cpu_percent > thresholds.cpu_percent_max:
            violations.append({
                "metric": "cpu_percent",
                "value": cpu_percent,
                "threshold": thresholds.cpu_percent_max,
                "severity": "high" if cpu_percent > 90 else "medium"
            })

        if memory_percent > thresholds.memory_percent_max:
            violations.append({
                "metric": "memory_percent",
                "value": memory_percent,
                "threshold": thresholds.memory_percent_max,
                "severity": "high" if memory_percent > 95 else "medium"
            })

        if latency_ms > thresholds.latency_p95_ms_max:
            violations.append({
                "metric": "latency_p95",
                "value": latency_ms,
                "threshold": thresholds.latency_p95_ms_max,
                "severity": "medium"
            })

        if error_rate > thresholds.error_rate_max:
            violations.append({
                "metric": "error_rate",
                "value": error_rate,
                "threshold": thresholds.error_rate_max,
                "severity": "high" if error_rate > 5 else "medium"
            })

        if availability < thresholds.availability_min:
            violations.append({
                "metric": "availability",
                "value": availability,
                "threshold": thresholds.availability_min,
                "severity": "critical"
            })

        return {
            "compliant": len(violations) == 0,
            "violations": violations,
            "violation_count": len(violations)
        }

    def check_cost_constraints(
        self,
        hourly_increase: float,
        monthly_impact: float,
    ) -> Dict[str, Any]:
        """Check if cost increase is within policy constraints.

        Returns dict with compliance status and details.
        """
        constraints = self.policy.cost_constraints
        violations = []

        within_hourly = hourly_increase <= constraints.max_hourly_cost_increase
        within_monthly = monthly_impact <= constraints.max_monthly_budget_impact

        if not within_hourly:
            violations.append({
                "constraint": "max_hourly_cost_increase",
                "value": hourly_increase,
                "limit": constraints.max_hourly_cost_increase
            })

        if not within_monthly:
            violations.append({
                "constraint": "max_monthly_budget_impact",
                "value": monthly_impact,
                "limit": constraints.max_monthly_budget_impact
            })

        return {
            "compliant": len(violations) == 0,
            "within_hourly": within_hourly,
            "within_monthly": within_monthly,
            "violations": violations
        }

    def get_duration_prediction(self, trend: str) -> float:
        """Predict duration of metric condition based on trend.

        Returns estimated duration in hours.
        """
        trend_durations = {
            "spike": 2.0,
            "gradual_increase": 24.0,
            "stable": 4.0,
            "decreasing": 1.0,
            "unknown": 2.0
        }
        return trend_durations.get(trend, 2.0)

    def to_dict(self) -> Dict[str, Any]:
        """Convert policy to dictionary."""
        return self.policy.dict()

    def save(self, path: str) -> None:
        """Save current policy to YAML file.

        Args:
            path: Path to save policy
        """
        data = self.to_dict()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)
