"""CLI for K8s Agentic Decision Pipeline."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import click
import yaml
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree
from rich import box

from ..core.decision_engine import DecisionEngine
from ..core.metric_observer import MetricObserver
from ..core.policy_engine import PolicyEngine
from ..models import MetricSnapshot
from ..utils.id_generator import generate_evaluation_id

console = Console()


@click.group()
@click.version_option(version="1.0.0")
def cli():
    """K8s Agentic Decision Pipeline - SRE cost-aware recommendation engine."""
    pass


@cli.command()
@click.option("--namespace", "-n", default="default", help="Kubernetes namespace")
@click.option("--deployment", "-d", required=True, help="Deployment name")
@click.option("--policy", "-p", help="Path to SRE policy file")
@click.option("--interval", "-i", type=int, default=30, help="Watch interval in seconds")
@click.option("--output", "-o", type=click.Choice(["table", "json"]), default="table")
def watch(namespace: str, deployment: str, policy: Optional[str], interval: int, output: str):
    """Watch a deployment and get real-time recommendations."""
    console.print(Panel.fit(
        f"[bold blue]Watching {namespace}/{deployment}[/bold blue]",
        subtitle=f"Interval: {interval}s"
    ))

    # Load policy
    policy_engine = PolicyEngine(policy_path=policy)
    decision_engine = DecisionEngine(policy_engine.policy)
    observer = MetricObserver()

    try:
        while True:
            # Fetch metrics
            metrics = observer.fetch_metrics(namespace, deployment)
            evaluation_id = generate_evaluation_id()

            # Generate recommendations
            response = decision_engine.generate_recommendations(
                metrics=metrics,
                namespace=namespace,
                deployment=deployment,
                evaluation_id=evaluation_id,
            )

            # Display
            if output == "json":
                console.print(json.dumps(response.dict(), indent=2, default=str))
            else:
                _display_recommendations(response, metrics)

            # Wait for next iteration
            import time
            time.sleep(interval)

    except KeyboardInterrupt:
        console.print("\n[bold yellow]Watch stopped[/bold yellow]")


@cli.command()
@click.option("--namespace", "-n", default="default", help="Kubernetes namespace")
@click.option("--deployment", "-d", required=True, help="Deployment name")
@click.option("--metric-snapshot", "-m", help="Path to metric snapshot JSON file")
@click.option("--policy", "-p", help="Path to SRE policy file")
@click.option("--dry-run", is_flag=True, help="Show recommendations without executing")
@click.option("--show-all", is_flag=True, help="Show all recommendation options")
@click.option("--output", "-o", type=click.Choice(["table", "json"]), default="table")
def recommend(
    namespace: str,
    deployment: str,
    metric_snapshot: Optional[str],
    policy: Optional[str],
    dry_run: bool,
    show_all: bool,
    output: str,
):
    """Get recommendations for a specific deployment."""
    # Load policy
    policy_engine = PolicyEngine(policy_path=policy)

    # Load metrics
    if metric_snapshot:
        with open(metric_snapshot, "r") as f:
            data = json.load(f)
        metrics = MetricSnapshot(**data)
    else:
        observer = MetricObserver()
        with console.status("[bold green]Fetching metrics..."):
            metrics = observer.fetch_metrics(namespace, deployment)

    # Generate recommendations
    decision_engine = DecisionEngine(policy_engine.policy)
    evaluation_id = generate_evaluation_id()

    with console.status("[bold green]Generating recommendations..."):
        response = decision_engine.generate_recommendations(
            metrics=metrics,
            namespace=namespace,
            deployment=deployment,
            evaluation_id=evaluation_id,
        )

    # Filter if not showing all
    if not show_all:
        response.recommendations = [response.recommendations[0]]

    # Output
    if output == "json":
        console.print(json.dumps(response.dict(), indent=2, default=str))
    else:
        _display_recommendations(response, metrics)


@cli.command()
@click.option("--evaluation-id", "-e", required=True, help="Evaluation ID")
@click.option("--recommendation-id", "-r", required=True, help="Recommendation ID")
@click.option("--approve", is_flag=True, help="Approve and execute the recommendation")
@click.option("--dry-run", is_flag=True, help="Show what would be executed")
def execute(evaluation_id: str, recommendation_id: str, approve: bool, dry_run: bool):
    """Execute an approved recommendation."""
    # In a real implementation, this would call the API
    # For now, just show what would happen

    console.print(Panel.fit(
        f"[bold blue]Execution Plan[/bold blue]",
        subtitle=f"Eval: {evaluation_id}"
    ))

    console.print(f"[bold]Recommendation ID:[/bold] {recommendation_id}")
    console.print(f"[bold]Approved:[/bold] {approve}")
    console.print(f"[bold]Dry Run:[/bold] {dry_run}")

    if not approve:
        console.print("\n[bold yellow]Action not approved. Use --approve to execute.[/bold yellow]")
        return

    if dry_run:
        console.print("\n[bold green]DRY RUN - No changes made[/bold green]")
        console.print("Would execute: kubectl scale deployment ...")
    else:
        console.print("\n[bold green]Executing...[/bold green]")
        # Implementation would call K8s API here


@cli.command()
@click.option("--recommendation-id", "-r", required=True, help="Recommendation ID")
@click.option("--evaluation-file", "-f", help="Path to evaluation JSON file")
def explain(recommendation_id: str, evaluation_file: Optional[str]):
    """Show detailed cost breakdown for a recommendation."""
    # Load evaluation
    if evaluation_file:
        with open(evaluation_file, "r") as f:
            data = json.load(f)
        # Parse into model
        from ..models import EvaluationResponse
        response = EvaluationResponse(**data)
    else:
        console.print("[bold red]Error: Must provide --evaluation-file[/bold red]")
        return

    # Find recommendation
    recommendation = None
    for rec in response.recommendations:
        if rec.id == recommendation_id:
            recommendation = rec
            break

    if not recommendation:
        console.print(f"[bold red]Recommendation {recommendation_id} not found[/bold red]")
        return

    # Display detailed breakdown
    _display_cost_breakdown(recommendation)


@cli.command()
@click.option("--output", "-o", default="sre_policy.yaml", help="Output file path")
def init_policy(output: str):
    """Initialize a sample SRE policy file."""
    sample_policy = {
        "cost_constraints": {
            "max_hourly_cost_increase": 10.0,
            "max_monthly_budget_impact": 500.0,
            "cost_vs_performance_weight": 0.7,
        },
        "performance_thresholds": {
            "cpu_percent_max": 80.0,
            "memory_percent_max": 85.0,
            "latency_p95_ms_max": 200.0,
            "availability_min": 99.9,
            "error_rate_max": 1.0,
        },
        "business_impact": {
            "downtime_cost_per_minute": 1000.0,
            "degradation_cost_per_minute": 200.0,
        },
        "cloud_provider": {
            "name": "aws",
            "region": "us-east-1",
            "pricing": {
                "vcpu_hourly": 0.0416,
                "memory_gb_hourly": 0.0052,
                "network_gb": 0.09,
            },
        },
    }

    with open(output, "w") as f:
        yaml.dump(sample_policy, f, default_flow_style=False, sort_keys=False)

    console.print(f"[bold green]Created sample policy file: {output}[/bold green]")


@cli.command()
@click.option("--host", default="0.0.0.0", help="Host to bind to")
@click.option("--port", default=8000, help="Port to bind to")
@click.option("--reload", is_flag=True, help="Enable auto-reload")
def serve(host: str, port: int, reload: bool):
    """Start the API server."""
    import uvicorn
    from ..api.server import create_app

    console.print(Panel.fit(
        f"[bold green]Starting API Server[/bold green]",
        subtitle=f"http://{host}:{port}"
    ))

    uvicorn.run(
        "k8s_agentic_pipeline.api.server:create_app",
        host=host,
        port=port,
        reload=reload,
    )


def _display_recommendations(response, metrics: MetricSnapshot):
    """Display recommendations in a formatted table."""
    # Header
    console.print(f"\n[bold blue]Evaluation ID:[/bold blue] {response.evaluation_id}")
    console.print(f"[bold]Target:[/bold] {response.target.namespace}/{response.target.deployment}")
    console.print(f"[bold]Trigger:[/bold] {response.trigger.metric} = {response.trigger.current_value:.1f}")

    # Current metrics table
    metrics_table = Table(title="Current Metrics", box=box.ROUNDED)
    metrics_table.add_column("Metric", style="cyan")
    metrics_table.add_column("Value", justify="right")
    metrics_table.add_column("Threshold", justify="right")
    metrics_table.add_column("Status", justify="center")

    thresholds = response.policy_constraints
    metrics_data = [
        ("CPU %", metrics.cpu_usage_percent, thresholds.get("cpu_percent_max", 80)),
        ("Memory %", metrics.memory_usage_percent, thresholds.get("memory_percent_max", 85)),
        ("Replicas", metrics.current_replicas, "N/A"),
        ("Latency P95 (ms)", metrics.latency_p95_ms, thresholds.get("latency_p95_ms_max", 200)),
        ("Error Rate %", metrics.error_rate_percent, thresholds.get("error_rate_max", 1)),
    ]

    for name, value, threshold in metrics_data:
        if isinstance(threshold, (int, float)) and threshold != "N/A":
            status = "[red]ALERT[/red]" if value > threshold else "[green]OK[/green]"
        else:
            status = "[blue]INFO[/blue]"
        metrics_table.add_row(name, f"{value:.1f}", str(threshold), status)

    console.print(metrics_table)

    # Recommendations table
    rec_table = Table(title="\nRecommendations", box=box.ROUNDED)
    rec_table.add_column("Rank", justify="center", style="bold")
    rec_table.add_column("Action", style="cyan")
    rec_table.add_column("Description")
    rec_table.add_column("Cost/hr", justify="right")
    rec_table.add_column("Net Benefit", justify="right")
    rec_table.add_column("ROI", justify="right")
    rec_table.add_column("Compliance", justify="center")

    for rec in response.recommendations:
        compliance = rec.policy_compliance.compliance
        if compliance == "compliant":
            comp_str = "[green]✓[/green]"
        elif compliance == "warning":
            comp_str = "[yellow]![/yellow]"
        else:
            comp_str = "[red]✗[/red]"

        roi_str = f"{rec.cost_analysis.roi:.1f}x" if rec.cost_analysis.roi != float('inf') else "∞"

        rec_table.add_row(
            str(rec.rank),
            rec.action_type.value,
            rec.description,
            f"${rec.cost_analysis.hourly_increase:.3f}",
            f"${rec.cost_analysis.net_benefit:.2f}",
            roi_str,
            comp_str,
        )

    console.print(rec_table)

    # Top recommendation details
    if response.recommendations:
        top = response.recommendations[0]
        console.print(f"\n[bold cyan]Top Recommendation: {top.description}[/bold cyan]")
        console.print(f"[bold]Command:[/bold] {top.execution_plan.command}")
        console.print(f"[bold]Impact:[/bold] {top.execution_plan.impact}")
        console.print(f"[bold]Confidence:[/bold] {top.confidence:.0%}")


def _display_cost_breakdown(recommendation):
    """Display detailed cost breakdown."""
    analysis = recommendation.cost_analysis
    reasoning = analysis.reasoning

    console.print(Panel.fit(
        f"[bold blue]Cost Breakdown: {recommendation.description}[/bold blue]",
        subtitle=f"ID: {recommendation.id}"
    ))

    # Cost summary
    cost_tree = Tree("[bold]Cost Analysis[/bold]")
    cost_tree.add(f"[cyan]Hourly Increase:[/cyan] ${analysis.hourly_increase:.4f}")
    cost_tree.add(f"[cyan]Estimated Total:[/cyan] ${analysis.estimated_total_cost:.2f}")
    cost_tree.add(f"[cyan]Monthly (if sustained):[/cyan] ${analysis.monthly_if_sustained:.2f}")
    cost_tree.add(f"[cyan]Avoided Cost:[/cyan] ${analysis.avoided_cost:.2f}")
    cost_tree.add(f"[cyan]Net Benefit:[/cyan] ${analysis.net_benefit:.2f}")
    cost_tree.add(f"[cyan]ROI:[/cyan] {analysis.roi:.1f}x" if analysis.roi != float('inf') else "[cyan]ROI:[/cyan] ∞")

    console.print(cost_tree)

    # Calculation basis
    console.print("\n[bold]Calculation Basis:[/bold]")
    for item in reasoning.calculation_basis:
        console.print(f"  • {item}")

    # Assumptions
    console.print("\n[bold]Assumptions:[/bold]")
    for item in reasoning.assumptions:
        console.print(f"  • {item}")

    # Risk factors
    console.print("\n[bold]Risk Factors:[/bold]")
    for item in reasoning.risk_factors:
        console.print(f"  • {item}")

    # Avoided cost breakdown
    avoided = reasoning.avoided_cost_breakdown
    console.print("\n[bold]Avoided Cost Breakdown:[/bold]")
    console.print(f"  Downtime Risk: {avoided.downtime_risk:.0%} → ${avoided.expected_downtime_cost:.2f}")
    console.print(f"  Degradation Risk: {avoided.degradation_risk:.0%} → ${avoided.expected_degradation_cost:.2f}")
    console.print(f"  [bold]Total Avoided:[/bold] ${avoided.total_avoided_cost:.2f}")


def main():
    """Entry point for CLI."""
    cli()


if __name__ == "__main__":
    main()
