"""Tests for Policy Engine."""
import os
import tempfile

import pytest
import yaml

from k8s_agentic_pipeline.core.policy_engine import PolicyEngine
from k8s_agentic_pipeline.models import SREPolicy


class TestPolicyEngine:
    """Test cases for PolicyEngine."""

    def test_init_with_defaults(self):
        """Test initialization with default policy."""
        engine = PolicyEngine()

        assert engine.policy is not None
        assert engine.policy.cost_constraints.max_hourly_cost_increase == 10.0
        assert engine.policy.performance_thresholds.cpu_percent_max == 80.0

    def test_init_with_custom_policy(self):
        """Test initialization with custom policy."""
        policy = SREPolicy(
            cost_constraints=SREPolicy.CostConstraints(
                max_hourly_cost_increase=5.0,
            )
        )
        engine = PolicyEngine(policy=policy)

        assert engine.policy.cost_constraints.max_hourly_cost_increase == 5.0

    def test_load_from_file(self):
        """Test loading policy from YAML file."""
        policy_data = {
            "cost_constraints": {
                "max_hourly_cost_increase": 15.0,
                "max_monthly_budget_impact": 1000.0,
            },
            "performance_thresholds": {
                "cpu_percent_max": 75.0,
            },
        }

        with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml', delete=False) as f:
            yaml.dump(policy_data, f)
            temp_path = f.name

        try:
            engine = PolicyEngine(policy_path=temp_path)
            assert engine.policy.cost_constraints.max_hourly_cost_increase == 15.0
            assert engine.policy.performance_thresholds.cpu_percent_max == 75.0
        finally:
            os.unlink(temp_path)

    def test_validate_metrics_against_thresholds(self):
        """Test metric validation."""
        engine = PolicyEngine()

        # All within thresholds
        result = engine.validate_metrics_against_thresholds(
            cpu_percent=70.0,
            memory_percent=80.0,
            latency_ms=150.0,
            error_rate=0.5,
            availability=99.95,
        )

        assert result["compliant"] is True
        assert result["violation_count"] == 0

        # CPU violation
        result = engine.validate_metrics_against_thresholds(
            cpu_percent=85.0,
            memory_percent=80.0,
            latency_ms=150.0,
            error_rate=0.5,
            availability=99.95,
        )

        assert result["compliant"] is False
        assert result["violation_count"] == 1
        assert result["violations"][0]["metric"] == "cpu_percent"

    def test_check_cost_constraints(self):
        """Test cost constraint checking."""
        engine = PolicyEngine()

        # Within constraints
        result = engine.check_cost_constraints(
            hourly_increase=5.0,
            monthly_impact=200.0,
        )

        assert result["compliant"] is True
        assert result["within_hourly"] is True
        assert result["within_monthly"] is True

        # Exceeds hourly
        result = engine.check_cost_constraints(
            hourly_increase=15.0,
            monthly_impact=200.0,
        )

        assert result["compliant"] is False
        assert result["within_hourly"] is False

    def test_get_duration_prediction(self):
        """Test duration prediction based on trend."""
        engine = PolicyEngine()

        assert engine.get_duration_prediction("spike") == 2.0
        assert engine.get_duration_prediction("gradual_increase") == 24.0
        assert engine.get_duration_prediction("stable") == 4.0
        assert engine.get_duration_prediction("decreasing") == 1.0
        assert engine.get_duration_prediction("unknown") == 2.0

    def test_save_and_reload(self):
        """Test saving and reloading policy."""
        policy = SREPolicy(
            cost_constraints=SREPolicy.CostConstraints(
                max_hourly_cost_increase=25.0,
            )
        )
        engine = PolicyEngine(policy=policy)

        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "test_policy.yaml")
            engine.save(path)

            # Reload
            engine2 = PolicyEngine(policy_path=path)
            assert engine2.policy.cost_constraints.max_hourly_cost_increase == 25.0
