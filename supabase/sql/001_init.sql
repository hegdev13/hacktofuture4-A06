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

-- RLS
alter table public.endpoints enable row level security;
alter table public.metrics_snapshots enable row level security;
alter table public.alerts enable row level security;
alter table public.healing_actions enable row level security;

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

