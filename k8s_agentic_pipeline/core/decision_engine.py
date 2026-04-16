"""Decision Engine for generating ranked recommendations."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from ..models import (
    ActionType,
    CostAnalysis,
    EvaluationResponse,
    ExecutionPlan,
    MetricSnapshot,
    PolicyCompliance,
    PolicyComplianceStatus,
    Recommendation,
    SREPolicy,
    TargetInfo,
    TriggerInfo,
    TrendDirection,
)
from .cost_calculator import CostCalculator

logger = logging.getLogger(__name__)


class DecisionEngine:
    """Generates ranked recommendations for SRE actions."""

    def __init__(self, policy: SREPolicy):
        """Initialize decision engine with policy.

        Args:
            policy: SRE policy for constraints and thresholds
        """
        self.policy = policy
        self.calculator = CostCalculator(policy)

    def generate_recommendations(
        self,
        metrics: MetricSnapshot,
        namespace: str,
        deployment: str,
        evaluation_id: str,
    ) -> EvaluationResponse:
        """Generate all recommendations for a metric snapshot.

        Args:
            metrics: Current metric snapshot
            namespace: Kubernetes namespace
            deployment: Deployment name
            evaluation_id: Unique evaluation ID

        Returns:
            EvaluationResponse with ranked recommendations
        """
        recommendations: List[Recommendation] = []

        # Generate option: Do Nothing
        rec_do_nothing = self._generate_do_nothing(metrics)
        recommendations.append(rec_do_nothing)

        # Generate option: Horizontal Pod Autoscaling
        rec_hpa = self._generate_horizontal_scaling(metrics)
        recommendations.append(rec_hpa)

        # Generate option: Vertical Scaling
        rec_vertical = self._generate_vertical_scaling(metrics)
        recommendations.append(rec_vertical)

        # Generate option: Hybrid (if both CPU and memory are high)
        if (metrics.cpu_usage_percent > 70 and metrics.memory_usage_percent > 70):
            rec_hybrid = self._generate_hybrid_scaling(metrics)
            recommendations.append(rec_hybrid)

        # Generate option: Alternative (optimization recommendations)
        rec_alternative = self._generate_alternative(metrics)
        recommendations.append(rec_alternative)

        # Score and rank recommendations
        scored_recommendations = self._score_and_rank(recommendations)

        # Build trigger info
        trigger = self._build_trigger_info(metrics)
        target = TargetInfo(
            namespace=namespace,
            deployment=deployment,
            current_replicas=metrics.current_replicas,
        )

        # Build policy constraints summary
        policy_constraints = {
            "max_hourly_cost": self.policy.cost_constraints.max_hourly_cost_increase,
            "max_monthly_cost": self.policy.cost_constraints.max_monthly_budget_impact,
            "downtime_cost_per_minute": self.policy.business_impact.downtime_cost_per_minute,
            "degradation_cost_per_minute": self.policy.business_impact.degradation_cost_per_minute,
        }

        return EvaluationResponse(
            evaluation_id=evaluation_id,
            target=target,
            trigger=trigger,
            policy_constraints=policy_constraints,
            recommendations=scored_recommendations,
            metadata={
                "evaluation_time_ms": 0,  # Will be set by caller
                "metrics_source": "prometheus",
                "policy_version": "1.0.0",
            },
        )

    def _generate_do_nothing(self, metrics: MetricSnapshot) -> Recommendation:
        """Generate 'do nothing' recommendation.

        Args:
            metrics: Current metric snapshot

        Returns:
            Recommendation for no action
        """
        duration = self.calculator.determine_duration(
            metrics.cpu_trend, ActionType.NO_ACTION
        )

        cost_analysis = self.calculator.calculate_no_action_cost(metrics, duration)

        # Policy compliance check
        violations = []
        if metrics.cpu_usage_percent > self.policy.performance_thresholds.cpu_percent_max:
            violations.append(f"CPU at {metrics.cpu_usage_percent:.1f}% exceeds threshold")
        if metrics.memory_usage_percent > self.policy.performance_thresholds.memory_percent_max:
            violations.append(f"Memory at {metrics.memory_usage_percent:.1f}% exceeds threshold")

        compliance = PolicyComplianceStatus(
            within_hourly_budget=True,
            within_monthly_budget=True,
            within_all_thresholds=len(violations) == 0,
            compliance=PolicyCompliance.COMPLIANT if len(violations) == 0 else PolicyCompliance.WARNING,
            justification="No cost increase, but may not address performance issues",
            violations=violations,
        )

        execution_plan = ExecutionPlan(
            command="kubectl rollout status deployment/{deployment} -n {namespace}",
            rollback_command="N/A - no action taken",
            estimated_duration_seconds=0,
            impact="no_change",
            requires_approval=False,
        )

        return Recommendation(
            rank=0,  # Will be set by _score_and_rank
            id=f"opt_do_nothing",
            action_type=ActionType.NO_ACTION,
            description="Continue monitoring current state without changes",
            confidence=0.6 if compliance.compliance == PolicyCompliance.WARNING else 0.8,
            recommendation_score=0.0,  # Will be calculated
            parameters={
                "action": "monitor",
                "rationale": "Low-cost option with minimal risk",
            },
            cost_analysis=cost_analysis,
            policy_compliance=compliance,
            execution_plan=execution_plan,
        )

    def _generate_horizontal_scaling(self, metrics: MetricSnapshot) -> Recommendation:
        """Generate horizontal pod autoscaling recommendation.

        Args:
            metrics: Current metric snapshot

        Returns:
            Recommendation for HPA
        """
        # Calculate optimal replica count
        current_replicas = metrics.current_replicas
        cpu_util = metrics.cpu_usage_percent
        threshold = self.policy.performance_thresholds.cpu_percent_max

        # Simple scaling calculation
        if cpu_util > threshold:
            # Scale to bring utilization down to 70% of threshold
            target_util = threshold * 0.7
            scale_factor = cpu_util / target_util
            target_replicas = max(
                current_replicas + 1,
                int(current_replicas * scale_factor)
            )
        else:
            target_replicas = current_replicas

        # Cap at reasonable max
        target_replicas = min(target_replicas, current_replicas * 3)
        target_replicas = max(target_replicas, current_replicas)

        duration = self.calculator.determine_duration(
            metrics.cpu_trend, ActionType.HORIZONTAL_SCALING
        )

        cost_analysis = self.calculator.calculate_horizontal_scaling_cost(
            current_replicas=current_replicas,
            target_replicas=target_replicas,
            cpu_request_millicores=metrics.cpu_request_millicores,
            memory_request_mb=metrics.memory_request_mb,
            duration_hours=duration,
        )

        # Policy compliance
        cost_check = self.policy.check_cost_constraints(
            cost_analysis.hourly_increase,
            cost_analysis.monthly_if_sustained,
        )

        violations = []
        for v in cost_check.get("violations", []):
            violations.append(f"{v['constraint']}: {v['value']:.2f} > {v['limit']:.2f}")

        compliance = PolicyComplianceStatus(
            within_hourly_budget=cost_check["within_hourly"],
            within_monthly_budget=cost_check["within_monthly"],
            within_all_thresholds=cost_check["compliant"],
            compliance=PolicyCompliance.COMPLIANT if cost_check["compliant"] else PolicyCompliance.VIOLATION,
            justification="Horizontal scaling provides immediate relief with minimal disruption",
            violations=violations,
        )

        execution_plan = ExecutionPlan(
            command=f"kubectl scale deployment {{deployment}} --replicas={target_replicas} -n {{namespace}}",
            rollback_command=f"kubectl scale deployment {{deployment}} --replicas={current_replicas} -n {{namespace}}",
            estimated_duration_seconds=45,
            impact="zero_downtime",
            requires_approval=True,
        )

        return Recommendation(
            rank=0,
            id=f"opt_hpa_{target_replicas}replicas",
            action_type=ActionType.HORIZONTAL_SCALING,
            description=f"Scale from {current_replicas} to {target_replicas} replicas",
            confidence=0.92 if cost_analysis.roi > 1 else 0.75,
            recommendation_score=0.0,
            parameters={
                "current_replicas": current_replicas,
                "target_replicas": target_replicas,
                "estimated_duration_hours": duration,
            },
            cost_analysis=cost_analysis,
            policy_compliance=compliance,
            execution_plan=execution_plan,
        )

    def _generate_vertical_scaling(self, metrics: MetricSnapshot) -> Recommendation:
        """Generate vertical scaling recommendation.

        Args:
            metrics: Current metric snapshot

        Returns:
            Recommendation for vertical scaling
        """
        # Calculate new resource limits
        current_cpu_limit = metrics.cpu_limit_millicores
        current_mem_limit = metrics.memory_limit_mb

        # Increase by 50% if needed
        if metrics.cpu_usage_percent > self.policy.performance_thresholds.cpu_percent_max:
            target_cpu_limit = int(current_cpu_limit * 1.5)
        else:
            target_cpu_limit = current_cpu_limit

        if metrics.memory_usage_percent > self.policy.performance_thresholds.memory_percent_max:
            target_mem_limit = int(current_mem_limit * 1.5)
        else:
            target_mem_limit = current_mem_limit

        duration = self.calculator.determine_duration(
            metrics.cpu_trend, ActionType.VERTICAL_SCALING
        )

        cost_analysis = self.calculator.calculate_vertical_scaling_cost(
            current_cpu_limit=current_cpu_limit,
            target_cpu_limit=target_cpu_limit,
            current_memory_limit=current_mem_limit,
            target_memory_limit=target_mem_limit,
            current_replicas=metrics.current_replicas,
            duration_hours=duration,
        )

        # Policy compliance
        cost_check = self.policy.check_cost_constraints(
            cost_analysis.hourly_increase,
            cost_analysis.monthly_if_sustained,
        )

        violations = []
        for v in cost_check.get("violations", []):
            violations.append(f"{v['constraint']}: {v['value']:.2f} > {v['limit']:.2f}")

        # Add warning about pod restart
        if cost_check["compliant"]:
            compliance = PolicyCompliance.WARNING
        else:
            compliance = PolicyCompliance.VIOLATION

        compliance_status = PolicyComplianceStatus(
            within_hourly_budget=cost_check["within_hourly"],
            within_monthly_budget=cost_check["within_monthly"],
            within_all_thresholds=cost_check["compliant"],
            compliance=compliance,
            justification="Vertical scaling requires pod restart but provides permanent capacity",
            violations=violations,
        )

        execution_plan = ExecutionPlan(
            command=f"kubectl patch deployment {{deployment}} -n {{namespace}} -p '{{\"spec\":{{\"template\":{{\"spec\":{{\"containers\":[{{\"name\":\"{{deployment}}\",\"resources\":{{\"limits\":{{\"cpu\":\"{target_cpu_limit}m\",\"memory\":\"{target_mem_limit}Mi\"}}}}}}]}}}}}}'"",
            rollback_command=f"kubectl rollout undo deployment/{{deployment}} -n {{namespace}}",
            estimated_duration_seconds=120,
            impact="requires_restart",
            requires_approval=True,
        )

        return Recommendation(
            rank=0,
            id="opt_vertical_cpu",
            action_type=ActionType.VERTICAL_SCALING,
            description=f"Increase CPU limit from {current_cpu_limit}m to {target_cpu_limit}m",
            confidence=0.85,
            recommendation_score=0.0,
            parameters={
                "current_cpu_limit_millicores": current_cpu_limit,
                "target_cpu_limit_millicores": target_cpu_limit,
                "current_memory_limit_mb": current_mem_limit,
                "target_memory_limit_mb": target_mem_limit,
                "estimated_duration_hours": duration,
            },
            cost_analysis=cost_analysis,
            policy_compliance=compliance_status,
            execution_plan=execution_plan,
        )

    def _generate_hybrid_scaling(self, metrics: MetricSnapshot) -> Recommendation:
        """Generate hybrid scaling recommendation.

        Args:
            metrics: Current metric snapshot

        Returns:
            Recommendation for hybrid scaling
        """
        # Combine horizontal and vertical
        current_replicas = metrics.current_replicas
        target_replicas = current_replicas + 1

        current_cpu_limit = metrics.cpu_limit_millicores
        target_cpu_limit = int(current_cpu_limit * 1.25)

        duration = 24.0  # Hybrid typically medium duration

        # Calculate combined cost
        hpa_cost = self.calculator.calculate_horizontal_scaling_cost(
            current_replicas=current_replicas,
            target_replicas=target_replicas,
            cpu_request_millicores=metrics.cpu_request_millicores,
            memory_request_mb=metrics.memory_request_mb,
            duration_hours=duration,
        )

        vertical_cost = self.calculator.calculate_vertical_scaling_cost(
            current_cpu_limit=current_cpu_limit,
            target_cpu_limit=target_cpu_limit,
            current_memory_limit=current_cpu_limit,  # Simplified
            target_memory_limit=int(current_cpu_limit * 1.25),
            current_replicas=target_replicas,
            duration_hours=duration,
        )

        # Combined analysis (simplified - just using HPA for cost)
        cost_analysis = hpa_cost

        compliance = PolicyComplianceStatus(
            within_hourly_budget=False,  # More expensive
            within_monthly_budget=False,
            within_all_thresholds=False,
            compliance=PolicyCompliance.VIOLATION,
            justification="Hybrid scaling provides maximum capacity but at higher cost",
            violations=["Exceeds typical cost constraints - use only for critical situations"],
        )

        execution_plan = ExecutionPlan(
            command=f"kubectl patch deployment {{deployment}} -n {{namespace}} ... && kubectl scale deployment {{deployment}} --replicas={target_replicas} -n {{namespace}}",
            rollback_command="kubectl rollout undo deployment/{deployment} -n {namespace}",
            estimated_duration_seconds=180,
            impact="requires_restart",
            requires_approval=True,
        )

        return Recommendation(
            rank=0,
            id="opt_hybrid",
            action_type=ActionType.HYBRID,
            description=f"Hybrid: Add 1 replica AND increase CPU by 25%",
            confidence=0.88,
            recommendation_score=0.0,
            parameters={
                "replica_increase": 1,
                "cpu_increase_percent": 25,
                "estimated_duration_hours": duration,
            },
            cost_analysis=cost_analysis,
            policy_compliance=compliance,
            execution_plan=execution_plan,
        )

    def _generate_alternative(self, metrics: MetricSnapshot) -> Recommendation:
        """Generate alternative optimization recommendations.

        Args:
            metrics: Current metric snapshot

        Returns:
            Recommendation for alternative actions
        """
        # Alternative options like caching, code optimization, traffic reduction
        cost_analysis = CostAnalysis(
            hourly_increase=0.0,
            estimated_total_cost=500.0,  # Development cost estimate
            monthly_if_sustained=0.0,
            avoided_cost=50000.0,  # Significant long-term savings
            net_benefit=49500.0,
            roi=99.0,
            duration_hours=168,  # Implementation takes time
            reasoning=cost_analysis.reasoning if 'cost_analysis' in locals() else None,
        )

        # Fix: Create proper reasoning
        cost_analysis.reasoning = CostReasoning(
            calculation_basis=[
                "One-time development cost: $500",
                "Estimated long-term savings: $50,000/month",
            ],
            assumptions=[
                "Implementation requires 1-2 days of engineering work",
                "Caching layer can reduce DB load by 60%",
            ],
            risk_factors=[
                "Requires code changes and testing",
                "Benefits realized after deployment",
            ],
            avoided_cost_breakdown=cost_analysis.reasoning.avoided_cost_breakdown if cost_analysis.reasoning else AvoidedCostBreakdown(
                downtime_risk=0.0,
                downtime_cost_if_occurs=0.0,
                expected_downtime_cost=0.0,
                degradation_risk=0.0,
                degradation_cost_if_occurs=0.0,
                expected_degradation_cost=0.0,
                total_avoided_cost=50000.0,
            ),
        )

        compliance = PolicyComplianceStatus(
            within_hourly_budget=True,
            within_monthly_budget=True,
            within_all_thresholds=True,
            compliance=PolicyCompliance.COMPLIANT,
            justification="Long-term optimization with excellent ROI",
            violations=[],
        )

        execution_plan = ExecutionPlan(
            command="# Review caching implementation guide\n# Enable Redis/Memcached layer",
            rollback_command="# Revert to previous deployment version",
            estimated_duration_seconds=86400,  # 24 hours
            impact="requires_deployment",
            requires_approval=True,
        )

        return Recommendation(
            rank=0,
            id="opt_alternative_caching",
            action_type=ActionType.ALTERNATIVE,
            description="Implement Redis caching layer to reduce database load",
            confidence=0.75,
            recommendation_score=0.0,
            parameters={
                "action": "implement_caching",
                "expected_improvement": "60% reduction in DB queries",
                "implementation_time": "1-2 days",
            },
            cost_analysis=cost_analysis,
            policy_compliance=compliance,
            execution_plan=execution_plan,
        )

    def _score_and_rank(self, recommendations: List[Recommendation]) -> List[Recommendation]:
        """Score and rank recommendations.

        Args:
            recommendations: List of recommendations to score

        Returns:
            Sorted list with ranks assigned
        """
        scored = []
        for rec in recommendations:
            score = self._calculate_score(rec)
            scored.append((score, rec))

        # Sort by score descending
        scored.sort(key=lambda x: x[0], reverse=True)

        # Assign ranks and update scores
        result = []
        for rank, (score, rec) in enumerate(scored, start=1):
            rec.rank = rank
            rec.recommendation_score = round(score, 2)
            result.append(rec)

        return result

    def _calculate_score(self, rec: Recommendation) -> float:
        """Calculate recommendation score.

        Uses ROI-based scoring with policy compliance consideration.

        Args:
            rec: Recommendation to score

        Returns:
            Score between 0 and 1
        """
        cost_analysis = rec.cost_analysis
        policy = self.policy

        # If net cost is negative (we save money), score very high
        if cost_analysis.net_benefit > 0:
            return 0.95

        # ROI-based scoring
        roi = cost_analysis.roi
        if roi > 10:
            base_score = 0.90
        elif roi > 5:
            base_score = 0.80
        elif roi > 2:
            base_score = 0.70
        elif roi > 0:
            base_score = 0.60
        else:
            # Pure cost with no benefit
            budget_utilization = cost_analysis.hourly_increase / policy.cost_constraints.max_hourly_cost_increase
            base_score = max(0.2, 1.0 - budget_utilization * policy.cost_constraints.cost_vs_performance_weight)

        # Adjust based on compliance
        if rec.policy_compliance.compliance == PolicyCompliance.VIOLATION:
            base_score *= 0.5
        elif rec.policy_compliance.compliance == PolicyCompliance.WARNING:
            base_score *= 0.8

        # Adjust based on confidence
        base_score *= rec.confidence

        return min(1.0, max(0.0, base_score))

    def _build_trigger_info(self, metrics: MetricSnapshot) -> TriggerInfo:
        """Build trigger information from metrics.

        Args:
            metrics: Current metric snapshot

        Returns:
            TriggerInfo describing what triggered evaluation
        """
        # Determine which metric is most concerning
        thresholds = self.policy.performance_thresholds

        violations = [
            ("cpu_usage_percent", metrics.cpu_usage_percent, thresholds.cpu_percent_max),
            ("memory_usage_percent", metrics.memory_usage_percent, thresholds.memory_percent_max),
            ("latency_p95_ms", metrics.latency_p95_ms, thresholds.latency_p95_ms_max),
            ("error_rate_percent", metrics.error_rate_percent, thresholds.error_rate_max),
        ]

        # Find the worst violation
        worst = max(violations, key=lambda x: (x[1] - x[2]) if x[1] > x[2] else 0)

        return TriggerInfo(
            metric=worst[0],
            current_value=worst[1],
            threshold=worst[2],
            duration_above_threshold_minutes=metrics.duration_above_threshold_minutes,
            trend=metrics.cpu_trend,
        )

    def get_decision_summary(self, response: EvaluationResponse) -> Dict[str, Any]:
        """Get a human-readable summary of the decision.

        Args:
            response: EvaluationResponse

        Returns:
            Dict with summary information
        """
        top_rec = response.recommendations[0] if response.recommendations else None

        return {
            "target": f"{response.target.namespace}/{response.target.deployment}",
            "trigger": {
                "metric": response.trigger.metric,
                "value": f"{response.trigger.current_value:.1f}",
                "threshold": f"{response.trigger.threshold:.1f}",
            },
            "top_recommendation": {
                "action": top_rec.action_type if top_rec else "none",
                "description": top_rec.description if top_rec else "N/A",
                "roi": top_rec.cost_analysis.roi if top_rec else 0,
                "net_benefit": top_rec.cost_analysis.net_benefit if top_rec else 0,
                "compliance": top_rec.policy_compliance.compliance if top_rec else "unknown",
            },
            "total_options": len(response.recommendations),
        }
