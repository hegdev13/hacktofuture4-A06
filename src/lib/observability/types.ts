export type MetricLabels = Record<string, string>;

export type NormalizedMetricPoint = {
  endpoint_id: string;
  metric_name: string;
  labels: MetricLabels;
  value: number;
  timestamp: string;
  source: "scrape" | "push" | "derived";
};

export type LogSource = "pod" | "container" | "agent" | "system";

export type LogEntryInput = {
  endpoint_id?: string | null;
  timestamp?: string;
  labels: MetricLabels;
  message: string;
  source?: LogSource;
  level?: string;
  correlation_id?: string;
};

export type QueryRange = {
  from?: string;
  to?: string;
};

export type TimelineEventType =
  | "metric_anomaly"
  | "alert"
  | "ai_detection"
  | "ai_action"
  | "resolution"
  | "log"
  | "system";

export type ObservabilityEventInput = {
  endpoint_id?: string | null;
  correlation_id?: string;
  event_type: TimelineEventType;
  related_resource?: string;
  related_kind?: string;
  severity?: "info" | "warning" | "critical";
  title: string;
  details?: Record<string, unknown>;
  timestamp?: string;
};

export type PromLikeQuery = {
  query: string;
  groupBy?: string;
  from?: string;
  to?: string;
  namespace?: string;
  pod?: string;
  node?: string;
  stepSeconds?: number;
  limit?: number;
};

export type PromLikePoint = {
  timestamp: string;
  value: number;
};

export type PromLikeSeries = {
  metric_name: string;
  labels: MetricLabels;
  points: PromLikePoint[];
};

export type PromLikeQueryResult = {
  expression: string;
  metric_name: string;
  function?: "raw" | "sum" | "avg" | "min" | "max" | "rate";
  groupBy?: string;
  range: { from: string; to: string };
  series: PromLikeSeries[];
};
