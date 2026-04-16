"""FastAPI server for K8s Agentic Decision Pipeline."""
from __future__ import annotations

import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..core.decision_engine import DecisionEngine
from ..core.metric_observer import MetricObserver
from ..core.policy_engine import PolicyEngine
from ..models import (
    EvaluationRequest,
    EvaluationResponse,
    ExecutionRequest,
    ExecutionResponse,
    HealthStatus,
    MetricSnapshot,
)

logger = logging.getLogger(__name__)

# Global state
_app_state: Dict[str, Any] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    # Startup
    logger.info("Starting K8s Agentic Decision Pipeline API")

    # Load default policy
    policy_path = os.getenv("POLICY_PATH")
    policy_engine = PolicyEngine(policy_path=policy_path)

    _app_state["policy_engine"] = policy_engine
    _app_state["metric_observer"] = MetricObserver()
    _app_state["decision_engine"] = DecisionEngine(policy_engine.policy)

    yield

    # Shutdown
    logger.info("Shutting down K8s Agentic Decision Pipeline API")
    _app_state.clear()


def create_app() -> FastAPI:
    """Create and configure FastAPI application."""
    app = FastAPI(
        title="K8s Agentic Decision Pipeline",
        description="Production-ready K8s cost-aware recommendation engine",
        version="1.0.0",
        lifespan=lifespan,
    )

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", response_model=HealthStatus)
    async def health_check() -> HealthStatus:
        """Health check endpoint."""
        return HealthStatus(
            status="healthy",
            components={
                "policy_engine": "ok",
                "decision_engine": "ok",
                "metric_observer": "ok",
            },
        )

    @app.get("/")
    async def root() -> Dict[str, Any]:
        """Root endpoint with API info."""
        return {
            "name": "K8s Agentic Decision Pipeline",
            "version": "1.0.0",
            "endpoints": {
                "health": "/health",
                "evaluate": "/api/v1/evaluate",
                "execute": "/api/v1/execute",
                "metrics": "/api/v1/metrics/{namespace}/{deployment}",
            },
        }

    @app.post("/api/v1/evaluate", response_model=EvaluationResponse)
    async def evaluate_deployment(request: EvaluationRequest) -> EvaluationResponse:
        """Evaluate a deployment and generate recommendations.

        Args:
            request: Evaluation request with namespace, deployment, etc.

        Returns:
            EvaluationResponse with ranked recommendations
        """
        start_time = time.time()

        try:
            # Load custom policy if specified
            if request.policy_path:
                policy_engine = PolicyEngine(policy_path=request.policy_path)
                decision_engine = DecisionEngine(policy_engine.policy)
            else:
                policy_engine = _app_state.get("policy_engine")
                decision_engine = _app_state.get("decision_engine")

            # Get metrics
            if request.metric_snapshot:
                metrics = request.metric_snapshot
            else:
                observer = _app_state.get("metric_observer")
                if observer is None:
                    raise HTTPException(status_code=500, detail="Metric observer not initialized")
                metrics = observer.fetch_metrics(request.namespace, request.deployment)

            # Generate evaluation ID
            evaluation_id = f"eval_{uuid.uuid4().hex[:8]}"

            # Generate recommendations
            response = decision_engine.generate_recommendations(
                metrics=metrics,
                namespace=request.namespace,
                deployment=request.deployment,
                evaluation_id=evaluation_id,
            )

            # Set evaluation time
            evaluation_time_ms = int((time.time() - start_time) * 1000)
            response.metadata["evaluation_time_ms"] = evaluation_time_ms

            # Store for potential execution
            _app_state[f"eval_{evaluation_id}"] = response

            return response

        except Exception as e:
            logger.exception("Evaluation failed")
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/api/v1/metrics/{namespace}/{deployment}")
    async def get_metrics(
        namespace: str,
        deployment: str,
    ) -> MetricSnapshot:
        """Get current metrics for a deployment.

        Args:
            namespace: Kubernetes namespace
            deployment: Deployment name

        Returns:
            MetricSnapshot with current metrics
        """
        try:
            observer = _app_state.get("metric_observer")
            if observer is None:
                raise HTTPException(status_code=500, detail="Metric observer not initialized")

            metrics = observer.fetch_metrics(namespace, deployment)
            return metrics

        except Exception as e:
            logger.exception("Failed to fetch metrics")
            raise HTTPException(status_code=500, detail=str(e))

    @app.post("/api/v1/execute", response_model=ExecutionResponse)
    async def execute_recommendation(
        request: ExecutionRequest,
        background_tasks: BackgroundTasks,
    ) -> ExecutionResponse:
        """Execute a recommendation.

        Args:
            request: Execution request with evaluation_id and recommendation_id
            background_tasks: FastAPI background tasks

        Returns:
            ExecutionResponse with status
        """
        execution_id = f"exec_{uuid.uuid4().hex[:8]}"

        if not request.approved:
            return ExecutionResponse(
                execution_id=execution_id,
                evaluation_id=request.evaluation_id,
                recommendation_id=request.recommendation_id,
                status="rejected",
                message="Execution not approved",
            )

        # Get stored evaluation
        eval_key = f"eval_{request.evaluation_id}"
        if eval_key not in _app_state:
            raise HTTPException(
                status_code=404,
                detail=f"Evaluation {request.evaluation_id} not found",
            )

        evaluation = _app_state[eval_key]

        # Find the recommendation
        recommendation = None
        for rec in evaluation.recommendations:
            if rec.id == request.recommendation_id:
                recommendation = rec
                break

        if recommendation is None:
            raise HTTPException(
                status_code=404,
                detail=f"Recommendation {request.recommendation_id} not found",
            )

        if request.dry_run:
            return ExecutionResponse(
                execution_id=execution_id,
                evaluation_id=request.evaluation_id,
                recommendation_id=request.recommendation_id,
                status="pending",
                message=f"DRY RUN: Would execute: {recommendation.execution_plan.command}",
                output="Dry run mode - no changes made",
            )

        # Execute in background
        background_tasks.add_task(
            _execute_action,
            execution_id,
            evaluation.target.namespace,
            evaluation.target.deployment,
            recommendation,
        )

        return ExecutionResponse(
            execution_id=execution_id,
            evaluation_id=request.evaluation_id,
            recommendation_id=request.recommendation_id,
            status="executing",
            message=f"Executing {recommendation.action_type}...",
        )

    @app.get("/api/v1/evaluations/{evaluation_id}")
    async def get_evaluation(evaluation_id: str) -> EvaluationResponse:
        """Retrieve a stored evaluation.

        Args:
            evaluation_id: Evaluation ID

        Returns:
            EvaluationResponse
        """
        eval_key = f"eval_{evaluation_id}"
        if eval_key not in _app_state:
            raise HTTPException(
                status_code=404,
                detail=f"Evaluation {evaluation_id} not found",
            )

        return _app_state[eval_key]

    @app.get("/api/v1/policy")
    async def get_policy() -> Dict[str, Any]:
        """Get current policy configuration."""
        policy_engine = _app_state.get("policy_engine")
        if policy_engine is None:
            raise HTTPException(status_code=500, detail="Policy engine not initialized")

        return policy_engine.to_dict()

    @app.post("/api/v1/policy/reload")
    async def reload_policy() -> Dict[str, str]:
        """Reload policy from file."""
        policy_engine = _app_state.get("policy_engine")
        if policy_engine is None:
            raise HTTPException(status_code=500, detail="Policy engine not initialized")

        try:
            policy_engine.reload()
            # Update decision engine with new policy
            _app_state["decision_engine"] = DecisionEngine(policy_engine.policy)
            return {"status": "Policy reloaded successfully"}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    return app


async def _execute_action(
    execution_id: str,
    namespace: str,
    deployment: str,
    recommendation: Any,
) -> None:
    """Execute a recommendation action in the background.

    Args:
        execution_id: Unique execution ID
        namespace: Kubernetes namespace
        deployment: Deployment name
        recommendation: Recommendation to execute
    """
    import subprocess

    logger.info(f"Executing {execution_id}: {recommendation.action_type}")

    try:
        command = recommendation.execution_plan.command.format(
            namespace=namespace,
            deployment=deployment,
        )

        # Execute command
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=300,
        )

        if result.returncode == 0:
            logger.info(f"Execution {execution_id} completed successfully")
        else:
            logger.error(f"Execution {execution_id} failed: {result.stderr}")

    except Exception as e:
        logger.exception(f"Execution {execution_id} failed")


def run_server(host: str = "0.0.0.0", port: int = 8000) -> None:
    """Run the FastAPI server.

    Args:
        host: Host to bind to
        port: Port to bind to
    """
    import uvicorn

    app = create_app()
    uvicorn.run(app, host=host, port=port)
