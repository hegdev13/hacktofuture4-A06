-- KubePulse: Supabase schema + RLS
-- Run this in Supabase SQL editor (or migration).

create extension if not exists "pgcrypto";

-- 1) users: managed by Supabase Auth (auth.users)

-- 2) endpoints
create table if not exists public.endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  ngrok_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists endpoints_user_id_idx on public.endpoints (user_id);
create index if not exists endpoints_created_at_idx on public.endpoints (created_at desc);

-- 3) metrics_snapshots
create table if not exists public.metrics_snapshots (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.endpoints (id) on delete cascade,
  pod_name text not null,
  namespace text not null default 'default',
  status text not null,
  cpu_usage numeric null,
  memory_usage numeric null,
  restart_count integer not null default 0,
  timestamp timestamptz not null default now()
);

create index if not exists metrics_snapshots_endpoint_ts_idx
  on public.metrics_snapshots (endpoint_id, timestamp desc);
create index if not exists metrics_snapshots_endpoint_pod_ts_idx
  on public.metrics_snapshots (endpoint_id, pod_name, timestamp desc);

-- 4) alerts
do $$
begin
  if not exists (select 1 from pg_type where typname = 'alert_severity') then
    create type public.alert_severity as enum ('low', 'medium', 'high');
  end if;
end$$;

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.endpoints (id) on delete cascade,
  message text not null,
  severity public.alert_severity not null default 'low',
  created_at timestamptz not null default now()
);

create index if not exists alerts_endpoint_created_at_idx
  on public.alerts (endpoint_id, created_at desc);

-- 5) healing_actions
create table if not exists public.healing_actions (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.endpoints (id) on delete cascade,
  action_taken text not null,
  status text not null check (status in ('success', 'failure')),
  timestamp timestamptz not null default now()
);

create index if not exists healing_actions_endpoint_ts_idx
  on public.healing_actions (endpoint_id, timestamp desc);

-- 6) normalized metrics series (Prometheus-like)
create table if not exists public.metrics_series (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.endpoints (id) on delete cascade,
  metric_name text not null,
  labels jsonb not null default '{}'::jsonb,
  value double precision not null,
  source text not null default 'scrape' check (source in ('scrape', 'push', 'derived')),
  timestamp timestamptz not null default now()
);

create index if not exists metrics_series_endpoint_metric_ts_idx
  on public.metrics_series (endpoint_id, metric_name, timestamp desc);
create index if not exists metrics_series_endpoint_ts_idx
  on public.metrics_series (endpoint_id, timestamp desc);
create index if not exists metrics_series_labels_gin_idx
  on public.metrics_series using gin (labels);

-- 7) pre-aggregated rollups for fast dashboards
create table if not exists public.metrics_rollups (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.endpoints (id) on delete cascade,
  bucket_start timestamptz not null,
  scope text not null check (scope in ('cluster', 'pod', 'namespace')),
  group_key text not null,
  avg_cpu double precision null,
  avg_memory double precision null,
  pod_running integer not null default 0,
  pod_failed integer not null default 0,
  pod_pending integer not null default 0,
  restart_rate double precision not null default 0,
  sample_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (endpoint_id, bucket_start, scope, group_key)
);

create index if not exists metrics_rollups_endpoint_bucket_idx
  on public.metrics_rollups (endpoint_id, bucket_start desc, scope);

-- 8) central logs table (Loki-like)
create table if not exists public.logs_entries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid null references public.endpoints (id) on delete set null,
  timestamp timestamptz not null default now(),
  labels jsonb not null default '{}'::jsonb,
  message text not null,
  source text not null default 'pod' check (source in ('pod', 'container', 'agent', 'system')),
  level text not null default 'info',
  correlation_id text null
);

create index if not exists logs_entries_endpoint_ts_idx
  on public.logs_entries (endpoint_id, timestamp desc);
create index if not exists logs_entries_labels_gin_idx
  on public.logs_entries using gin (labels);

-- 9) generic event timeline + lifecycle (AI + alerts + anomalies)
create table if not exists public.observability_events (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid null references public.endpoints (id) on delete set null,
  correlation_id text null,
  event_type text not null,
  related_resource text null,
  related_kind text null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title text not null,
  details jsonb not null default '{}'::jsonb,
  timestamp timestamptz not null default now()
);

create index if not exists observability_events_endpoint_ts_idx
  on public.observability_events (endpoint_id, timestamp desc);
create index if not exists observability_events_type_ts_idx
  on public.observability_events (event_type, timestamp desc);

create table if not exists public.issue_lifecycles (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid null references public.endpoints (id) on delete set null,
  issue_id text not null,
  title text not null,
  status text not null,
  detected_at timestamptz null,
  analysis_started_at timestamptz null,
  fix_applied_at timestamptz null,
  resolved_at timestamptz null,
  failed_at timestamptz null,
  updated_at timestamptz not null default now(),
  unique (endpoint_id, issue_id)
);

create index if not exists issue_lifecycles_endpoint_updated_idx
  on public.issue_lifecycles (endpoint_id, updated_at desc);

-- 10) alerting rules + state/history
create table if not exists public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid null references public.endpoints (id) on delete cascade,
  rule_key text not null,
  metric_name text not null,
  aggregation text not null default 'avg' check (aggregation in ('avg', 'sum', 'min', 'max', 'rate')),
  threshold double precision not null,
  duration_seconds integer not null default 300,
  severity public.alert_severity not null default 'medium',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (endpoint_id, rule_key)
);

create table if not exists public.alert_states (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.endpoints (id) on delete cascade,
  rule_key text not null,
  state text not null check (state in ('pending', 'firing', 'resolved')),
  state_since timestamptz not null default now(),
  last_value double precision null,
  updated_at timestamptz not null default now(),
  unique (endpoint_id, rule_key)
);

create table if not exists public.alert_state_history (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references public.endpoints (id) on delete cascade,
  rule_key text not null,
  state text not null check (state in ('pending', 'firing', 'resolved')),
  value double precision null,
  message text not null,
  timestamp timestamptz not null default now()
);

create index if not exists alert_state_history_endpoint_ts_idx
  on public.alert_state_history (endpoint_id, timestamp desc);

-- RLS
alter table public.endpoints enable row level security;
alter table public.metrics_snapshots enable row level security;
alter table public.alerts enable row level security;
alter table public.healing_actions enable row level security;
alter table public.metrics_series enable row level security;
alter table public.metrics_rollups enable row level security;
alter table public.logs_entries enable row level security;
alter table public.observability_events enable row level security;
alter table public.issue_lifecycles enable row level security;
alter table public.alert_rules enable row level security;
alter table public.alert_states enable row level security;
alter table public.alert_state_history enable row level security;

-- endpoints policies
drop policy if exists "endpoints_select_own" on public.endpoints;
create policy "endpoints_select_own"
  on public.endpoints for select
  using (user_id = auth.uid());

drop policy if exists "endpoints_insert_own" on public.endpoints;
create policy "endpoints_insert_own"
  on public.endpoints for insert
  with check (user_id = auth.uid());

drop policy if exists "endpoints_update_own" on public.endpoints;
create policy "endpoints_update_own"
  on public.endpoints for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "endpoints_delete_own" on public.endpoints;
create policy "endpoints_delete_own"
  on public.endpoints for delete
  using (user_id = auth.uid());

-- metrics_snapshots policies (visible only if endpoint belongs to user)
drop policy if exists "metrics_select_by_endpoint_owner" on public.metrics_snapshots;
create policy "metrics_select_by_endpoint_owner"
  on public.metrics_snapshots for select
  using (
    exists (
      select 1 from public.endpoints e
      where e.id = metrics_snapshots.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- NOTE: inserts are expected to be performed by backend using the service role key (bypasses RLS)

-- alerts policies
drop policy if exists "alerts_select_by_endpoint_owner" on public.alerts;
create policy "alerts_select_by_endpoint_owner"
  on public.alerts for select
  using (
    exists (
      select 1 from public.endpoints e
      where e.id = alerts.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- healing_actions policies
drop policy if exists "healing_select_by_endpoint_owner" on public.healing_actions;
create policy "healing_select_by_endpoint_owner"
  on public.healing_actions for select
  using (
    exists (
      select 1 from public.endpoints e
      where e.id = healing_actions.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- metrics_series policies
drop policy if exists "metrics_series_select_by_endpoint_owner" on public.metrics_series;
create policy "metrics_series_select_by_endpoint_owner"
  on public.metrics_series for select
  using (
    exists (
      select 1 from public.endpoints e
      where e.id = metrics_series.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- metrics_rollups policies
drop policy if exists "metrics_rollups_select_by_endpoint_owner" on public.metrics_rollups;
create policy "metrics_rollups_select_by_endpoint_owner"
  on public.metrics_rollups for select
  using (
    exists (
      select 1 from public.endpoints e
      where e.id = metrics_rollups.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- logs_entries policies
drop policy if exists "logs_entries_select_by_endpoint_owner" on public.logs_entries;
create policy "logs_entries_select_by_endpoint_owner"
  on public.logs_entries for select
  using (
    endpoint_id is null or exists (
      select 1 from public.endpoints e
      where e.id = logs_entries.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- observability_events policies
drop policy if exists "observability_events_select_by_endpoint_owner" on public.observability_events;
create policy "observability_events_select_by_endpoint_owner"
  on public.observability_events for select
  using (
    endpoint_id is null or exists (
      select 1 from public.endpoints e
      where e.id = observability_events.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- issue_lifecycles policies
drop policy if exists "issue_lifecycles_select_by_endpoint_owner" on public.issue_lifecycles;
create policy "issue_lifecycles_select_by_endpoint_owner"
  on public.issue_lifecycles for select
  using (
    endpoint_id is null or exists (
      select 1 from public.endpoints e
      where e.id = issue_lifecycles.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- alert_rules policies
drop policy if exists "alert_rules_select_by_endpoint_owner" on public.alert_rules;
create policy "alert_rules_select_by_endpoint_owner"
  on public.alert_rules for select
  using (
    endpoint_id is null or exists (
      select 1 from public.endpoints e
      where e.id = alert_rules.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- alert_states policies
drop policy if exists "alert_states_select_by_endpoint_owner" on public.alert_states;
create policy "alert_states_select_by_endpoint_owner"
  on public.alert_states for select
  using (
    exists (
      select 1 from public.endpoints e
      where e.id = alert_states.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- alert_state_history policies
drop policy if exists "alert_state_history_select_by_endpoint_owner" on public.alert_state_history;
create policy "alert_state_history_select_by_endpoint_owner"
  on public.alert_state_history for select
  using (
    exists (
      select 1 from public.endpoints e
      where e.id = alert_state_history.endpoint_id
        and e.user_id = auth.uid()
    )
  );

-- Seed default rules for existing endpoints
insert into public.alert_rules (endpoint_id, rule_key, metric_name, aggregation, threshold, duration_seconds, severity)
select e.id, 'high_cpu_cluster_5m', 'cpu_usage', 'avg', 0.85, 300, 'high'
from public.endpoints e
on conflict (endpoint_id, rule_key) do nothing;

insert into public.alert_rules (endpoint_id, rule_key, metric_name, aggregation, threshold, duration_seconds, severity)
select e.id, 'high_restart_rate_5m', 'restart_count', 'rate', 0.2, 300, 'medium'
from public.endpoints e
on conflict (endpoint_id, rule_key) do nothing;

