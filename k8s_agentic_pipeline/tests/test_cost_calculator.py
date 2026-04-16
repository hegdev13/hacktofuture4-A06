"""Tests for Cost Calculator."""
import pytest
from k8s_agentic_pipeline.core.cost_calculator import CostCalculator
from k8s_agentic_pipeline.models import (
    SREPolicy,
    MetricSnapshot,
    TrendDirection,
    ActionType,
)


@pytest.fixture
def default_policy():
    """Create a default SRE policy for testing."""
    return SREPolicy(
        cost_constraints=SREPolicy.CostConstraints(
            max_hourly_cost_increase=10.0,
            max_monthly_budget_impact=500.0,
            cost_vs_performance_weight=0.7,
        ),
        business_impact=SREPolicy.BusinessImpact(
            downtime_cost_per_minute=1000.0,
            degradation_cost_per_minute=200.0,
        ),
        cloud_provider=SREPolicy.CloudProviderConfig(
            name="aws",
            region="us-east-1",
            pricing=SREPolicy.CloudProviderConfig.Pricing(
                vcpu_hourly=0.0416,
                memory_gb_hourly=0.0052,
                network_gb=0.09,
            ),
        ),
    )


@pytest.fixture
def sample_metrics():
    """Create sample metrics for testing."""
    return MetricSnapshot(
        cpu_usage_percent=85.0,
        memory_usage_percent=70.0,
        current_replicas=3,
        requests_per_second=100.0,
        latency_p95_ms=150.0,
        error_rate_percent=0.5,
        availability_percent=99.95,
        cpu_request_millicores=500.0,
        cpu_limit_millicores=1000.0,
        memory_request_mb=512.0,
        memory_limit_mb=1024.0,
        cpu_trend=TrendDirection.GRADUAL_INCREASE,
        duration_above_threshold_minutes=12.0,
    )


class TestCostCalculator:
    """Test cases for CostCalculator."""

    def test_init(self, default_policy):
        """Test calculator initialization."""
        calc = CostCalculator(default_policy)
        assert calc.policy == default_policy
        assert calc.pricing.vcpu_hourly == 0.0416

    def test_horizontal_scaling_cost(self, default_policy, sample_metrics):
        """Test horizontal scaling cost calculation."""
        calc = CostCalculator(default_policy)

        result = calc.calculate_horizontal_scaling_cost(
            current_replicas=3,
            target_replicas=5,
            cpu_request_millicores=500,
            memory_request_mb=512,
            duration_hours=2.0,
        )

        # Verify structure
        assert result.hourly_increase > 0
        assert result.estimated_total_cost > 0
        assert result.monthly_if_sustained > 0
        assert result.avoided_cost > 0
        assert result.duration_hours == 2.0
        assert result.reasoning.calculation_basis
        assert result.reasoning.assumptions
        assert result.reasoning.risk_factors
        assert result.reasoning.avoided_cost_breakdown

        # Verify calculations
        # 2 pods × (0.5 vCPU × $0.0416 + 0.5GB × $0.0052)
        expected_hourly = 2 * (0.5 * 0.0416 + 0.5 * 0.0052)
        assert abs(result.hourly_increase - expected_hourly) < 0.001

    def test_horizontal_scaling_no_change(self, default_policy):
        """Test horizontal scaling with no replicas added."""
        calc = CostCalculator(default_policy)

        result = calc.calculate_horizontal_scaling_cost(
            current_replicas=3,
            target_replicas=3,
            cpu_request_millicores=500,
            memory_request_mb=512,
            duration_hours=2.0,
        )

        assert result.hourly_increase == 0.0
        assert result.estimated_total_cost == 0.0

    def test_vertical_scaling_cost(self, default_policy, sample_metrics):
        """Test vertical scaling cost calculation."""
        calc = CostCalculator(default_policy)

        result = calc.calculate_vertical_scaling_cost(
            current_cpu_limit=1000.0,
            target_cpu_limit=1500.0,
            current_memory_limit=1024.0,
            target_memory_limit=1536.0,
            current_replicas=3,
            duration_hours=168.0,
        )

        assert result.hourly_increase > 0
        assert result.estimated_total_cost > 0
        assert result.monthly_if_sustained > 0
        assert result.duration_hours == 168.0

    def test_no_action_cost(self, default_policy, sample_metrics):
        """Test no action cost calculation."""
        calc = CostCalculator(default_policy)

        result = calc.calculate_no_action_cost(sample_metrics, duration_hours=2.0)

        assert result.hourly_increase == 0.0
        assert result.estimated_total_cost == 0.0
        assert result.net_benefit < 0  # Negative net benefit
        assert result.roi == -1.0
        assert len(result.reasoning.risk_factors) > 0

    def test_determine_duration(self, default_policy):
        """Test duration determination."""
        calc = CostCalculator(default_policy)

        # Spike should be 2 hours
        assert calc.determine_duration(TrendDirection.SPIKE, ActionType.HORIZONTAL_SCALING) == 2.0

        # Gradual increase should be 24 hours for HPA
        assert calc.determine_duration(TrendDirection.GRADUAL_INCREASE, ActionType.HORIZONTAL_SCALING) == 24.0

        # Gradual increase should be 168 hours for vertical
        assert calc.determine_duration(TrendDirection.GRADUAL_INCREASE, ActionType.VERTICAL_SCALING) == 168.0

    def test_pricing_summary(self, default_policy):
        """Test pricing summary generation."""
        calc = CostCalculator(default_policy)

        summary = calc.get_pricing_summary()

        assert summary["provider"] == "aws"
        assert summary["region"] == "us-east-1"
        assert "vcpu_hourly" in summary
        assert "example_costs" in summary
        assert "1_vcpu_2gb_pod_per_hour" in summary["example_costs"]


class TestAvoidedCosts:
    """Test cases for avoided cost calculations."""

    def test_avoided_costs_calculation(self, default_policy):
        """Test that avoided costs are calculated correctly."""
        calc = CostCalculator(default_policy)

        avoided = calc._calculate_avoided_costs(duration_hours=2.0)

        assert avoided.downtime_risk == 0.05
        assert avoided.degradation_risk == 0.20

        # Calculate expected values
        duration_minutes = 2.0 * 60
        expected_downtime_if = duration_minutes * 1000.0
        expected_downtime = 0.05 * expected_downtime_if

        expected_degradation_if = duration_minutes * 200.0
        expected_degradation = 0.20 * expected_degradation_if

        assert avoided.downtime_cost_if_occurs == expected_downtime_if
        assert avoided.expected_downtime_cost == expected_downtime
        assert avoided.degradation_cost_if_occurs == expected_degradation_if
        assert avoided.expected_degradation_cost == expected_degradation
        assert avoided.total_avoided_cost == expected_downtime + expected_degradation
