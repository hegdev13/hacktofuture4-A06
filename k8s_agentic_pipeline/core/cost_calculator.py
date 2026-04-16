"""Cost Calculator with transparent reasoning for K8s scaling decisions."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from ..models import (
    ActionType,
    AvoidedCostBreakdown,
    CostAnalysis,
    CostReasoning,
    MetricSnapshot,
    SREPolicy,
    TrendDirection,
)

logger = logging.getLogger(__name__)


class CostCalculator:
    """Calculates costs with detailed reasoning for scaling decisions."""

    def __init__(self, policy: SREPolicy):
        """Initialize cost calculator with policy.

        Args:
            policy: SRE policy containing cost constraints and pricing
        """
        self.policy = policy
        self.pricing = policy.cloud_provider.pricing

    def calculate_horizontal_scaling_cost(
        self,
        current_replicas: int,
        target_replicas: int,
        cpu_request_millicores: float,
        memory_request_mb: float,
        duration_hours: float,
    ) -> CostAnalysis:
        """Calculate cost for horizontal pod scaling.

        Args:
            current_replicas: Current number of replicas
            target_replicas: Target number of replicas
            cpu_request_millicores: CPU request per pod in millicores
            memory_request_mb: Memory request per pod in MB
            duration_hours: Estimated duration of scaling action

        Returns:
            CostAnalysis with full reasoning
        """
        replicas_added = target_replicas - current_replicas
        if replicas_added <= 0:
            return CostAnalysis(
                hourly_increase=0.0,
                estimated_total_cost=0.0,
                monthly_if_sustained=0.0,
                avoided_cost=0.0,
                net_benefit=0.0,
                roi=0.0,
                duration_hours=duration_hours,
                reasoning=CostReasoning(
                    calculation_basis=["No replicas added"],
                    assumptions=["No scaling required"],
                    risk_factors=["N/A"],
                    avoided_cost_breakdown=AvoidedCostBreakdown(
                        downtime_risk=0.0,
                        downtime_cost_if_occurs=0.0,
                        expected_downtime_cost=0.0,
                        degradation_risk=0.0,
                        degradation_cost_if_occurs=0.0,
                        expected_degradation_cost=0.0,
                        total_avoided_cost=0.0,
                    ),
                ),
            )

        # Convert millicores to vCPUs and MB to GB
        vcpu_per_pod = cpu_request_millicores / 1000.0
        memory_gb_per_pod = memory_request_mb / 1024.0

        # Calculate hourly cost per pod
        cpu_cost_per_hour = vcpu_per_pod * self.pricing.vcpu_hourly
        memory_cost_per_hour = memory_gb_per_pod * self.pricing.memory_gb_hourly
        cost_per_pod_hour = cpu_cost_per_hour + memory_cost_per_hour

        # Total hourly cost increase
        hourly_increase = cost_per_pod_hour * replicas_added

        # Calculate total cost for duration
        estimated_total_cost = hourly_increase * duration_hours

        # Monthly cost if sustained
        monthly_if_sustained = hourly_increase * 24 * 30

        # Calculate avoided costs based on risk assessment
        avoided_cost_breakdown = self._calculate_avoided_costs(duration_hours)
        total_avoided_cost = avoided_cost_breakdown.total_avoided_cost

        # Net benefit and ROI
        net_benefit = total_avoided_cost - estimated_total_cost
        roi = (net_benefit / estimated_total_cost) if estimated_total_cost > 0 else float('inf')

        # Build reasoning
        calculation_basis = [
            f"Adding {replicas_added} pod(s)",
            f"Per pod: {vcpu_per_pod:.2f} vCPU (${cpu_cost_per_hour:.4f}/h) + "
            f"{memory_gb_per_pod:.2f}GB RAM (${memory_cost_per_hour:.4f}/h) = "
            f"${cost_per_pod_hour:.4f}/h",
            f"Total hourly increase: ${hourly_increase:.4f} ({replicas_added} × ${cost_per_pod_hour:.4f})",
            f"Duration: {duration_hours}h → Total cost: ${estimated_total_cost:.4f}",
        ]

        assumptions = [
            f"Duration estimate of {duration_hours}h based on trend analysis",
            "Pricing based on on-demand rates without reserved capacity discounts",
            "Network costs estimated at $0 for internal traffic",
        ]

        risk_factors = [
            f"Current resource pressure increases risk of service degradation",
            f"Expected degradation cost: ${avoided_cost_breakdown.expected_degradation_cost:.2f}",
            f"Expected downtime cost: ${avoided_cost_breakdown.expected_downtime_cost:.2f}",
        ]

        reasoning = CostReasoning(
            calculation_basis=calculation_basis,
            assumptions=assumptions,
            risk_factors=risk_factors,
            avoided_cost_breakdown=avoided_cost_breakdown,
        )

        return CostAnalysis(
            hourly_increase=hourly_increase,
            estimated_total_cost=estimated_total_cost,
            monthly_if_sustained=monthly_if_sustained,
            avoided_cost=total_avoided_cost,
            net_benefit=net_benefit,
            roi=roi,
            duration_hours=duration_hours,
            reasoning=reasoning,
        )

    def calculate_vertical_scaling_cost(
        self,
        current_cpu_limit: float,
        target_cpu_limit: float,
        current_memory_limit: float,
        target_memory_limit: float,
        current_replicas: int,
        duration_hours: float,
    ) -> CostAnalysis:
        """Calculate cost for vertical pod scaling.

        Args:
            current_cpu_limit: Current CPU limit in millicores
            target_cpu_limit: Target CPU limit in millicores
            current_memory_limit: Current memory limit in MB
            target_memory_limit: Target memory limit in MB
            current_replicas: Current number of replicas
            duration_hours: Estimated duration (typically permanent for vertical scaling)

        Returns:
            CostAnalysis with full reasoning
        """
        # Calculate resource increase
        cpu_increase_millicores = target_cpu_limit - current_cpu_limit
        memory_increase_mb = target_memory_limit - current_memory_limit

        if cpu_increase_millicores <= 0 and memory_increase_mb <= 0:
            return CostAnalysis(
                hourly_increase=0.0,
                estimated_total_cost=0.0,
                monthly_if_sustained=0.0,
                avoided_cost=0.0,
                net_benefit=0.0,
                roi=0.0,
                duration_hours=duration_hours,
                reasoning=CostReasoning(
                    calculation_basis=["No resource increase"],
                    assumptions=["No vertical scaling required"],
                    risk_factors=["N/A"],
                    avoided_cost_breakdown=AvoidedCostBreakdown(
                        downtime_risk=0.0,
                        downtime_cost_if_occurs=0.0,
                        expected_downtime_cost=0.0,
                        degradation_risk=0.0,
                        degradation_cost_if_occurs=0.0,
                        expected_degradation_cost=0.0,
                        total_avoided_cost=0.0,
                    ),
                ),
            )

        # Convert to vCPU and GB
        cpu_increase_vcpu = cpu_increase_millicores / 1000.0
        memory_increase_gb = memory_increase_mb / 1024.0

        # Calculate hourly cost increase per pod
        cpu_cost_increase = cpu_increase_vcpu * self.pricing.vcpu_hourly
        memory_cost_increase = memory_increase_gb * self.pricing.memory_gb_hourly
        hourly_increase_per_pod = cpu_cost_increase + memory_cost_increase

        # Total hourly increase across all replicas
        hourly_increase = hourly_increase_per_pod * current_replicas

        # Calculate costs
        estimated_total_cost = hourly_increase * duration_hours
        monthly_if_sustained = hourly_increase * 24 * 30

        # Calculate avoided costs
        avoided_cost_breakdown = self._calculate_avoided_costs(duration_hours)
        total_avoided_cost = avoided_cost_breakdown.total_avoided_cost

        net_benefit = total_avoided_cost - estimated_total_cost
        roi = (net_benefit / estimated_total_cost) if estimated_total_cost > 0 else float('inf')

        calculation_basis = [
            f"CPU increase: {cpu_increase_millicores}m → {cpu_increase_vcpu:.2f} vCPU "
            f"(${cpu_cost_increase:.4f}/h per pod)",
            f"Memory increase: {memory_increase_mb}MB → {memory_increase_gb:.2f}GB "
            f"(${memory_cost_increase:.4f}/h per pod)",
            f"Applied to {current_replicas} replica(s): ${hourly_increase:.4f}/h",
            f"Duration: {duration_hours}h → Total: ${estimated_total_cost:.4f}",
        ]

        assumptions = [
            "Vertical scaling typically permanent - using 168h (1 week) baseline",
            "All replicas receive same resource increase",
            "No additional node provisioning costs considered",
        ]

        risk_factors = [
            "Vertical scaling requires pod restart (brief downtime)",
            f"Expected degradation cost prevented: ${avoided_cost_breakdown.expected_degradation_cost:.2f}",
        ]

        reasoning = CostReasoning(
            calculation_basis=calculation_basis,
            assumptions=assumptions,
            risk_factors=risk_factors,
            avoided_cost_breakdown=avoided_cost_breakdown,
        )

        return CostAnalysis(
            hourly_increase=hourly_increase,
            estimated_total_cost=estimated_total_cost,
            monthly_if_sustained=monthly_if_sustained,
            avoided_cost=total_avoided_cost,
            net_benefit=net_benefit,
            roi=roi,
            duration_hours=duration_hours,
            reasoning=reasoning,
        )

    def calculate_no_action_cost(
        self,
        metrics: MetricSnapshot,
        duration_hours: float,
    ) -> CostAnalysis:
        """Calculate cost of taking no action.

        Args:
            metrics: Current metric snapshot
            duration_hours: Duration to project

        Returns:
            CostAnalysis showing risk exposure
        """
        # No immediate cost
        hourly_increase = 0.0
        estimated_total_cost = 0.0
        monthly_if_sustained = 0.0

        # Calculate expected costs from risk
        avoided_cost_breakdown = self._calculate_avoided_costs(duration_hours)

        # For no action, these become actual expected costs (not avoided)
        expected_costs = avoided_cost_breakdown

        # Net benefit is negative (we expect to lose this money)
        net_benefit = -expected_costs.total_avoided_cost
        roi = -1.0  # Negative ROI for no action when risks exist

        # Assess risk levels
        risk_factors = []
        if metrics.cpu_usage_percent > 80:
            risk_factors.append(
                f"CPU at {metrics.cpu_usage_percent:.1f}% - risk of request queuing"
            )
        if metrics.memory_usage_percent > 85:
            risk_factors.append(
                f"Memory at {metrics.memory_usage_percent:.1f}% - risk of OOM kills"
            )
        if metrics.error_rate_percent > 1:
            risk_factors.append(
                f"Error rate at {metrics.error_rate_percent:.2f}% - indicates service degradation"
            )

        calculation_basis = [
            "No immediate infrastructure cost",
            f"Expected degradation cost: ${expected_costs.expected_degradation_cost:.2f}",
            f"Expected downtime cost: ${expected_costs.expected_downtime_cost:.2f}",
        ]

        assumptions = [
            f"Risk window: {duration_hours}h based on metric trend",
            "Degradation risk calculated from current resource pressure",
            "Downtime risk based on historical patterns",
        ]

        if not risk_factors:
            risk_factors.append("System stable - low risk of issues")

        reasoning = CostReasoning(
            calculation_basis=calculation_basis,
            assumptions=assumptions,
            risk_factors=risk_factors,
            avoided_cost_breakdown=expected_costs,
        )

        return CostAnalysis(
            hourly_increase=hourly_increase,
            estimated_total_cost=estimated_total_cost,
            monthly_if_sustained=monthly_if_sustained,
            avoided_cost=0.0,  # No cost avoided with no action
            net_benefit=net_benefit,
            roi=roi,
            duration_hours=duration_hours,
            reasoning=reasoning,
        )

    def _calculate_avoided_costs(self, duration_hours: float) -> AvoidedCostBreakdown:
        """Calculate expected costs that would be avoided by taking action.

        Args:
            duration_hours: Duration to calculate for

        Returns:
            AvoidedCostBreakdown with all risk calculations
        """
        business_impact = self.policy.business_impact

        # Risk probabilities (these would ideally come from historical analysis)
        # Based on thresholds being exceeded
        downtime_risk = 0.05  # 5% chance of full downtime
        degradation_risk = 0.20  # 20% chance of service degradation

        # Calculate costs
        duration_minutes = duration_hours * 60

        downtime_cost_if_occurs = duration_minutes * business_impact.downtime_cost_per_minute
        expected_downtime_cost = downtime_risk * downtime_cost_if_occurs

        degradation_cost_if_occurs = duration_minutes * business_impact.degradation_cost_per_minute
        expected_degradation_cost = degradation_risk * degradation_cost_if_occurs

        total_avoided_cost = expected_downtime_cost + expected_degradation_cost

        return AvoidedCostBreakdown(
            downtime_risk=downtime_risk,
            downtime_cost_if_occurs=downtime_cost_if_occurs,
            expected_downtime_cost=expected_downtime_cost,
            degradation_risk=degradation_risk,
            degradation_cost_if_occurs=degradation_cost_if_occurs,
            expected_degradation_cost=expected_degradation_cost,
            total_avoided_cost=total_avoided_cost,
        )

    def determine_duration(self, trend: TrendDirection, action_type: ActionType) -> float:
        """Determine expected duration of scaling action.

        Args:
            trend: Metric trend direction
            action_type: Type of action being considered

        Returns:
            Expected duration in hours
        """
        # Default durations based on trend and action type
        durations = {
            (TrendDirection.SPIKE, ActionType.HORIZONTAL_SCALING): 2.0,
            (TrendDirection.SPIKE, ActionType.VERTICAL_SCALING): 4.0,
            (TrendDirection.GRADUAL_INCREASE, ActionType.HORIZONTAL_SCALING): 24.0,
            (TrendDirection.GRADUAL_INCREASE, ActionType.VERTICAL_SCALING): 168.0,  # Permanent
            (TrendDirection.STABLE, ActionType.HORIZONTAL_SCALING): 4.0,
            (TrendDirection.STABLE, ActionType.VERTICAL_SCALING): 168.0,
            (TrendDirection.DECREASING, ActionType.HORIZONTAL_SCALING): 1.0,
            (TrendDirection.DECREASING, ActionType.VERTICAL_SCALING): 1.0,
            (TrendDirection.UNKNOWN, ActionType.HORIZONTAL_SCALING): 2.0,
            (TrendDirection.UNKNOWN, ActionType.VERTICAL_SCALING): 168.0,
        }

        return durations.get((trend, action_type), 2.0)

    def get_pricing_summary(self) -> Dict[str, Any]:
        """Get a summary of current pricing configuration."""
        return {
            "provider": self.policy.cloud_provider.name,
            "region": self.policy.cloud_provider.region,
            "vcpu_hourly": self.pricing.vcpu_hourly,
            "memory_gb_hourly": self.pricing.memory_gb_hourly,
            "network_gb": self.pricing.network_gb,
            "example_costs": {
                "1_vcpu_2gb_pod_per_hour": self.pricing.vcpu_hourly + (2 * self.pricing.memory_gb_hourly),
                "1_vcpu_2gb_pod_per_month": (self.pricing.vcpu_hourly + (2 * self.pricing.memory_gb_hourly)) * 24 * 30,
            },
        }
