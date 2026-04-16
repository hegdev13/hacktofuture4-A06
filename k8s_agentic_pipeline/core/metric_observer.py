"""Metric Observer for collecting Kubernetes and Prometheus metrics."""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import requests
from datetime import datetime, timedelta

from ..models import MetricSnapshot, TrendDirection

logger = logging.getLogger(__name__)


@dataclass
class TrendAnalysis:
    """Result of trend analysis."""
    direction: TrendDirection
    slope: float
    confidence: float


class MetricObserver:
    """Observes metrics from Prometheus and Kubernetes API."""

    def __init__(
        self,
        prometheus_url: Optional[str] = None,
        k8s_config_path: Optional[str] = None,
    ):
        """Initialize the metric observer.

        Args:
            prometheus_url: URL to Prometheus API (e.g., http://prometheus:9090)
            k8s_config_path: Path to Kubernetes config file
        """
        self.prometheus_url = prometheus_url or os.getenv(
            "PROMETHEUS_URL", "http://localhost:9090"
        )
        self.k8s_config_path = k8s_config_path or os.getenv(
            "KUBECONFIG", os.path.expanduser("~/.kube/config")
        )
        self._k8s_client = None

    def _get_k8s_client(self):
        """Lazy initialization of Kubernetes client."""
        if self._k8s_client is None:
            try:
                from kubernetes import client, config

                if os.path.exists(self.k8s_config_path):
                    config.load_kube_config(self.k8s_config_path)
                else:
                    config.load_incluster_config()
                self._k8s_client = client
            except ImportError:
                logger.warning("kubernetes client not installed, using mock mode")
                self._k8s_client = None
        return self._k8s_client

    def _query_prometheus(self, query: str) -> Optional[Dict[str, Any]]:
        """Query Prometheus API.

        Args:
            query: PromQL query string

        Returns:
            Query result or None if failed
        """
        try:
            url = f"{self.prometheus_url}/api/v1/query"
            response = requests.get(
                url, params={"query": query}, timeout=30
            )
            response.raise_for_status()
            data = response.json()
            return data.get("data", {}).get("result", [])
        except Exception as e:
            logger.error(f"Prometheus query failed: {e}")
            return None

    def _query_prometheus_range(
        self, query: str, start: datetime, end: datetime, step: str = "1m"
    ) -> Optional[List[Dict[str, Any]]]:
        """Query Prometheus for time series data.

        Args:
            query: PromQL query string
            start: Start time
            end: End time
            step: Query resolution step width

        Returns:
            Time series data or None if failed
        """
        try:
            url = f"{self.prometheus_url}/api/v1/query_range"
            params = {
                "query": query,
                "start": start.isoformat("T") + "Z",
                "end": end.isoformat("T") + "Z",
                "step": step,
            }
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()
            return data.get("data", {}).get("result", [])
        except Exception as e:
            logger.error(f"Prometheus range query failed: {e}")
            return None

    def _analyze_trend(
        self, values: List[Tuple[float, float]], threshold: float
    ) -> TrendAnalysis:
        """Analyze trend from time series values.

        Args:
            values: List of (timestamp, value) tuples
            threshold: Threshold value to compare against

        Returns:
            TrendAnalysis with direction, slope, and confidence
        """
        if len(values) < 3:
            return TrendAnalysis(TrendDirection.UNKNOWN, 0.0, 0.0)

        # Calculate simple linear regression
        n = len(values)
        sum_x = sum(i for i, _ in enumerate(values))
        sum_y = sum(v for _, v in values)
        sum_xy = sum(i * v for i, (_, v) in enumerate(values))
        sum_xx = sum(i * i for i, _ in enumerate(values))

        if n * sum_xx - sum_x * sum_x == 0:
            return TrendAnalysis(TrendDirection.STABLE, 0.0, 0.5)

        slope = (n * sum_xy - sum_x * sum_y) / (n * sum_xx - sum_x * sum_x)

        # Calculate R-squared for confidence
        mean_y = sum_y / n
        ss_tot = sum((v - mean_y) ** 2 for _, v in values)
        ss_res = sum(
            (v - (slope * i + (sum_y - slope * sum_x) / n)) ** 2
            for i, (_, v) in enumerate(values)
        )
        r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0

        # Determine trend direction
        recent_avg = sum(v for _, v in values[-5:]) / min(5, len(values[-5:]))
        old_avg = sum(v for _, v in values[:5]) / min(5, len(values[:5]))

        if recent_avg > threshold and slope > 0.1:
            direction = TrendDirection.SPIKE
        elif slope > 0.05:
            direction = TrendDirection.GRADUAL_INCREASE
        elif slope < -0.05:
            direction = TrendDirection.DECREASING
        elif abs(slope) <= 0.05:
            direction = TrendDirection.STABLE
        else:
            direction = TrendDirection.UNKNOWN

        return TrendAnalysis(direction, slope, r_squared)

    def _get_time_above_threshold(
        self, values: List[Tuple[float, float]], threshold: float
    ) -> float:
        """Calculate duration in minutes that value was above threshold.

        Args:
            values: List of (timestamp, value) tuples
            threshold: Threshold value

        Returns:
            Duration in minutes
        """
        if not values:
            return 0.0

        above_periods = []
        current_start = None

        for ts, val in values:
            if val > threshold:
                if current_start is None:
                    current_start = ts
            else:
                if current_start is not None:
                    above_periods.append((current_start, ts))
                    current_start = None

        if current_start is not None:
            above_periods.append((current_start, values[-1][0]))

        total_minutes = sum((end - start) / 60.0 for start, end in above_periods)
        return total_minutes

    def fetch_metrics(
        self,
        namespace: str,
        deployment: str,
        duration_minutes: int = 15,
    ) -> MetricSnapshot:
        """Fetch metrics for a deployment.

        Args:
            namespace: Kubernetes namespace
            deployment: Deployment name
            duration_minutes: Duration of historical data to analyze

        Returns:
            MetricSnapshot with current metrics and trends
        """
        end_time = datetime.utcnow()
        start_time = end_time - timedelta(minutes=duration_minutes)

        # Build PromQL queries
        labels = f'namespace="{namespace}",deployment="{deployment}"'

        # Get current metrics
        cpu_query = f"rate(container_cpu_usage_seconds_total{{{labels}}}[5m])"
        memory_query = f"container_memory_usage_bytes{{{labels}}}"
        replicas_query = f"kube_deployment_status_replicas{{{labels}}}"
        rps_query = f"sum(rate(http_requests_total{{{labels}}}[5m]))"
        latency_query = f'histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{{{labels}}}[5m])) * 1000'
        error_rate_query = f"sum(rate(http_requests_total{{{labels},status=~'5..'}}[5m])) / sum(rate(http_requests_total{{{labels}}}[5m])) * 100"
        availability_query = f"(1 - sum(rate(http_requests_total{{{labels},status=~'5..'}}[5m])) / sum(rate(http_requests_total{{{labels}}}[5m]))) * 100"

        # Resource specs from kube-state-metrics
        cpu_request_query = f"kube_deployment_spec_template_spec_containers_resource_requests{{{labels},resource='cpu'}}"
        cpu_limit_query = f"kube_deployment_spec_template_spec_containers_resource_limits{{{labels},resource='cpu'}}"
        mem_request_query = f"kube_deployment_spec_template_spec_containers_resource_requests{{{labels},resource='memory'}}"
        mem_limit_query = f"kube_deployment_spec_template_spec_containers_resource_limits{{{labels},resource='memory'}}"

        # Fetch current values
        cpu_result = self._query_prometheus(cpu_query)
        memory_result = self._query_prometheus(memory_query)
        replicas_result = self._query_prometheus(replicas_query)
        rps_result = self._query_prometheus(rps_query)
        latency_result = self._query_prometheus(latency_query)
        error_rate_result = self._query_prometheus(error_rate_query)
        availability_result = self._query_prometheus(availability_query)

        # Fetch resource specs
        cpu_request_result = self._query_prometheus(cpu_request_query)
        cpu_limit_result = self._query_prometheus(cpu_limit_query)
        mem_request_result = self._query_prometheus(mem_request_query)
        mem_limit_result = self._query_prometheus(mem_limit_query)

        # Extract values with defaults
        def extract_value(result: Optional[List], default: float = 0.0) -> float:
            if result and len(result) > 0:
                val = result[0].get("value", [None, default])[1]
                try:
                    return float(val)
                except (TypeError, ValueError):
                    return default
            return default

        cpu_percent = extract_value(cpu_result, 0.0) * 100
        memory_percent = extract_value(memory_result, 0.0)
        current_replicas = int(extract_value(replicas_result, 1.0))
        rps = extract_value(rps_result, 0.0)
        latency_ms = extract_value(latency_result, 0.0)
        error_rate = extract_value(error_rate_result, 0.0)
        availability = extract_value(availability_result, 100.0)

        # Convert resource specs (may be in different units)
        cpu_request = extract_value(cpu_request_result, 100.0)  # millicores
        cpu_limit = extract_value(cpu_limit_result, 1000.0)  # millicores
        mem_request = extract_value(mem_request_result, 256.0)  # MB
        mem_limit = extract_value(mem_limit_result, 512.0)  # MB

        # Convert memory from bytes to MB if needed
        if mem_request > 1024 * 1024:
            mem_request = mem_request / (1024 * 1024)
        if mem_limit > 1024 * 1024:
            mem_limit = mem_limit / (1024 * 1024)

        # Calculate memory percentage based on limit
        memory_usage_mb = memory_percent
        if memory_limit_result:
            memory_limit_bytes = extract_value(memory_limit_result, 512 * 1024 * 1024)
            memory_usage_bytes = extract_value(memory_result, 0)
            if memory_limit_bytes > 0:
                memory_percent = (memory_usage_bytes / memory_limit_bytes) * 100

        # Analyze trends
        cpu_trend_data = self._query_prometheus_range(cpu_query, start_time, end_time)
        memory_trend_data = self._query_prometheus_range(
            memory_query, start_time, end_time
        )

        cpu_trend = TrendDirection.UNKNOWN
        memory_trend = TrendDirection.UNKNOWN
        duration_above = 0.0

        if cpu_trend_data and len(cpu_trend_data) > 0:
            cpu_values = [
                (float(v[0]), float(v[1]) * 100)
                for v in cpu_trend_data[0].get("values", [])
            ]
            if cpu_values:
                analysis = self._analyze_trend(cpu_values, 80.0)
                cpu_trend = analysis.direction
                duration_above = self._get_time_above_threshold(cpu_values, 80.0)

        if memory_trend_data and len(memory_trend_data) > 0:
            memory_values = [
                (float(v[0]), float(v[1]))
                for v in memory_trend_data[0].get("values", [])
            ]
            if memory_values:
                analysis = self._analyze_trend(memory_values, 85.0)
                memory_trend = analysis.direction

        return MetricSnapshot(
            timestamp=datetime.utcnow(),
            cpu_usage_percent=cpu_percent,
            memory_usage_percent=memory_percent,
            current_replicas=current_replicas,
            requests_per_second=rps,
            latency_p95_ms=latency_ms,
            error_rate_percent=error_rate,
            availability_percent=availability,
            cpu_request_millicores=cpu_request,
            cpu_limit_millicores=cpu_limit,
            memory_request_mb=mem_request,
            memory_limit_mb=mem_limit,
            cpu_trend=cpu_trend,
            memory_trend=memory_trend,
            duration_above_threshold_minutes=duration_above,
        )

    def get_deployment_info(
        self, namespace: str, deployment: str
    ) -> Dict[str, Any]:
        """Get deployment information from Kubernetes API.

        Args:
            namespace: Kubernetes namespace
            deployment: Deployment name

        Returns:
            Deployment information dict
        """
        k8s = self._get_k8s_client()
        if k8s is None:
            logger.warning("Kubernetes client not available, returning mock data")
            return {
                "name": deployment,
                "namespace": namespace,
                "replicas": 3,
                "pod_names": [f"{deployment}-pod-{i}" for i in range(3)],
            }

        try:
            apps_v1 = k8s.AppsV1Api()
            dep = apps_v1.read_namespaced_deployment(deployment, namespace)

            return {
                "name": dep.metadata.name,
                "namespace": dep.metadata.namespace,
                "replicas": dep.spec.replicas or 0,
                "labels": dep.metadata.labels or {},
                "annotations": dep.metadata.annotations or {},
            }
        except Exception as e:
            logger.error(f"Failed to get deployment info: {e}")
            return {
                "name": deployment,
                "namespace": namespace,
                "replicas": 0,
                "error": str(e),
            }

    def get_pod_names(self, namespace: str, deployment: str) -> List[str]:
        """Get list of pod names for a deployment.

        Args:
            namespace: Kubernetes namespace
            deployment: Deployment name

        Returns:
            List of pod names
        """
        k8s = self._get_k8s_client()
        if k8s is None:
            logger.warning("Kubernetes client not available, returning mock pods")
            return [f"{deployment}-pod-{i}" for i in range(3)]

        try:
            core_v1 = k8s.CoreV1Api()
            selector = f"app={deployment}"
            pods = core_v1.list_namespaced_pod(
                namespace, label_selector=selector
            )
            return [pod.metadata.name for pod in pods.items]
        except Exception as e:
            logger.error(f"Failed to get pod names: {e}")
            return []
