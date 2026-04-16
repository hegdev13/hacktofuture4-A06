"""Pydantic models for K8s Agentic Decision Pipeline."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Union

from pydantic import BaseModel, Field, validator


class TrendDirection(str, Enum):
    """Metric trend directions."""
    SPIKE = "spike"
    GRADUAL_INCREASE = "gradual_increase"
    STABLE = "stable"
    DECREASING = "decreasing"
    UNKNOWN = "unknown"


class ActionType(str, Enum):
    """Types of actions."""
    NO_ACTION = "no_action"
    HORIZONTAL_SCALING = "horizontal_scaling"
    VERTICAL_SCALING = "vertical_scaling"
    HYBRID = "hybrid"
    ALTERNATIVE = "alternative"


class CloudProvider(str, Enum):
    """Supported cloud providers."""
    AWS = "aws"
    GCP = "gcp"
    AZURE = "azure"


class PolicyCompliance(str, Enum):
    """Policy compliance status."""
    COMPLIANT = "compliant"
    WARNING = "warning"
    VIOLATION = "violation"


class SREPolicy(BaseModel):
    """SRE Policy configuration model."""

    class CostConstraints(BaseModel):
        max_hourly_cost_increase: float = Field(default=10.0, ge=0)
        max_monthly_budget_impact: float = Field(default=500.0, ge=0)
        cost_vs_performance_weight: float = Field(default=0.7, ge=0, le=1.0)

    class PerformanceThresholds(BaseModel):
        cpu_percent_max: float = Field(default=80.0, ge=0, le=100)
        memory_percent_max: float = Field(default=85.0, ge=0, le=100)
        latency_p95_ms_max: float = Field(default=200.0, ge=0)
        availability_min: float = Field(default=99.9, ge=0, le=100)
        error_rate_max: float = Field(default=1.0, ge=0, le=100)

    class BusinessImpact(BaseModel):
        downtime_cost_per_minute: float = Field(default=1000.0, ge=0)
        degradation_cost_per_minute: float = Field(default=200.0, ge=0)

    class CloudProviderConfig(BaseModel):
        name: CloudProvider = CloudProvider.AWS
        region: str = "us-east-1"

        class Pricing(BaseModel):
            vcpu_hourly: float = Field(default=0.0416, ge=0)
            memory_gb_hourly: float = Field(default=0.0052, ge=0)
            network_gb: float = Field(default=0.09, ge=0)

        pricing: Pricing = Field(default_factory=Pricing)

    cost_constraints: CostConstraints = Field(default_factory=CostConstraints)
    performance_thresholds: PerformanceThresholds = Field(default_factory=PerformanceThresholds)
    business_impact: BusinessImpact = Field(default_factory=BusinessImpact)
    cloud_provider: CloudProviderConfig = Field(default_factory=CloudProviderConfig)


class MetricSnapshot(BaseModel):
    """Current metric snapshot for a deployment."""
    timestamp: datetime = Field(default_factory=datetime.utcnow)

    # Resource metrics
    cpu_usage_percent: float = Field(ge=0, le=100)
    memory_usage_percent: float = Field(ge=0, le=100)
    current_replicas: int = Field(ge=0)

    # Performance metrics
    requests_per_second: float = Field(ge=0)
    latency_p95_ms: float = Field(ge=0)
    error_rate_percent: float = Field(ge=0, le=100)
    availability_percent: float = Field(ge=0, le=100)

    # Resource specs
    cpu_request_millicores: float = Field(ge=0)
    cpu_limit_millicores: float = Field(ge=0)
    memory_request_mb: float = Field(ge=0)
    memory_limit_mb: float = Field(ge=0)

    # Trend analysis
    cpu_trend: TrendDirection = TrendDirection.UNKNOWN
    memory_trend: TrendDirection = TrendDirection.UNKNOWN
    duration_above_threshold_minutes: float = Field(default=0, ge=0)

    @validator('cpu_limit_millicores')
    def cpu_limit_gte_request(cls, v, values):
        if 'cpu_request_millicores' in values and v < values['cpu_request_millicores']:
            raise ValueError('cpu_limit must be >= cpu_request')
        return v

    @validator('memory_limit_mb')
    def memory_limit_gte_request(cls, v, values):
        if 'memory_request_mb' in values and v < values['memory_request_mb']:
            raise ValueError('memory_limit must be >= memory_request')
        return v


class AvoidedCostBreakdown(BaseModel):
    """Breakdown of avoided costs due to recommended action."""
    downtime_risk: float = Field(ge=0, le=1)
    downtime_cost_if_occurs: float = Field(ge=0)
    expected_downtime_cost: float = Field(ge=0)
    degradation_risk: float = Field(ge=0, le=1)
    degradation_cost_if_occurs: float = Field(ge=0)
    expected_degradation_cost: float = Field(ge=0)
    total_avoided_cost: float = Field(ge=0)


class CostReasoning(BaseModel):
    """Detailed cost calculation reasoning."""
    calculation_basis: List[str] = Field(default_factory=list)
    assumptions: List[str] = Field(default_factory=list)
    risk_factors: List[str] = Field(default_factory=list)
    avoided_cost_breakdown: AvoidedCostBreakdown


class CostAnalysis(BaseModel):
    """Cost analysis for a recommendation."""
    hourly_increase: float
    estimated_total_cost: float
    monthly_if_sustained: float
    avoided_cost: float
    net_benefit: float
    roi: float
    duration_hours: float = Field(default=2.0, ge=0)
    reasoning: CostReasoning


class PolicyComplianceStatus(BaseModel):
    """Policy compliance check results."""
    within_hourly_budget: bool
    within_monthly_budget: bool
    within_all_thresholds: bool
    compliance: PolicyCompliance
    justification: str
    violations: List[str] = Field(default_factory=list)


class ExecutionPlan(BaseModel):
    """Execution plan for applying a recommendation."""
    command: str
    rollback_command: str
    estimated_duration_seconds: int = Field(ge=0)
    impact: str  # e.g., "zero_downtime", "brief_interruption", "requires_restart"
    requires_approval: bool = True


class Recommendation(BaseModel):
    """Single recommendation option."""
    rank: int = Field(ge=1)
    id: str
    action_type: ActionType
    description: str
    confidence: float = Field(ge=0, le=1)
    recommendation_score: float = Field(ge=0, le=1)

    # Parameters for the action
    parameters: Dict[str, Any] = Field(default_factory=dict)

    # Analysis
    cost_analysis: CostAnalysis
    policy_compliance: PolicyComplianceStatus
    execution_plan: ExecutionPlan


class TargetInfo(BaseModel):
    """Target deployment information."""
    namespace: str
    deployment: str
    current_replicas: int
    pod_names: List[str] = Field(default_factory=list)


class TriggerInfo(BaseModel):
    """Information about what triggered the evaluation."""
    metric: str
    current_value: float
    threshold: float
    duration_above_threshold_minutes: float
    trend: TrendDirection


class EvaluationResponse(BaseModel):
    """Main API response for an evaluation."""
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    evaluation_id: str
    target: TargetInfo
    trigger: TriggerInfo
    policy_constraints: Dict[str, float]
    recommendations: List[Recommendation]
    metadata: Dict[str, Any] = Field(default_factory=dict)


class EvaluationRequest(BaseModel):
    """Request to evaluate a deployment."""
    namespace: str = "default"
    deployment: str
    policy_path: Optional[str] = None
    metric_snapshot: Optional[MetricSnapshot] = None


class ExecutionRequest(BaseModel):
    """Request to execute a recommendation."""
    evaluation_id: str
    recommendation_id: str
    approved: bool = False
    dry_run: bool = False
    executed_by: Optional[str] = None


class ExecutionResponse(BaseModel):
    """Response from executing a recommendation."""
    execution_id: str
    evaluation_id: str
    recommendation_id: str
    status: str  # "pending", "executing", "completed", "failed", "rejected"
    message: str
    output: Optional[str] = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class HealthStatus(BaseModel):
    """Health check response."""
    status: str = "healthy"
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    version: str = "1.0.0"
    components: Dict[str, str] = Field(default_factory=dict)
