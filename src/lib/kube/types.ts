export type PodMetric = {
  pod_name: string;
  namespace?: string;
  status: string;
  cpu_usage?: number | null;
  memory_usage?: number | null;
  restart_count?: number | null;
};

export type ClusterSnapshot = {
  pods: PodMetric[];
  fetched_at?: string;
};

