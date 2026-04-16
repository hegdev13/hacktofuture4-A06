# Codeclan

## KubePulse (Supabase-powered Kubernetes monitoring dashboard)

Production-grade, realtime observability UI for a Kubernetes cluster exposed via an **ngrok URL**.  
Frontend + API are Next.js, backend services are Supabase (**Auth + Postgres + Realtime**).

### Features

- **Supabase Auth**: signup/login/logout + protected `/dashboard` routes
- **Endpoints**: save multiple ngrok URLs per user (RLS protected)
- **Metrics**: realtime dashboards powered by `metrics_snapshots` + Supabase Realtime
- **Logs viewer**: fetch pod logs via backend bridge (`/api/logs`)
- **Alerts**: stored + streamed via Realtime, toast notifications in UI
- **Self-healing**: external agent can POST healing actions to `/api/healing-actions`
- **Security**: ngrok URL validation + basic API rate limiting + secret-protected poll/heal APIs

---

## Setup

### 1) Create Supabase project + run SQL

In Supabase SQL Editor, run:

- `supabase/sql/001_init.sql`

This creates:

- `endpoints`
- `metrics_snapshots`
- `alerts`
- `healing_actions`

with **Row-Level Security** (users can only see their own endpoints + related rows).

### 2) Configure env

Create `.env.local` (copy from `.env.example`) and fill:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server only)
- `METRICS_POLL_SECRET` (protects poll/heal ingestion routes)

### 3) Install + run

From `d:\\h24App\\h24app`:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Optional: Tokentap for LLM cost-per-call tracking

This repo now supports running Gemini calls through a local tokentap proxy.

1. Install Python deps:

```bash
pip install -r requirements.txt
```

1. Start tokentap in terminal 1:

```bash
npm run tokentap:start
```

1. Start app through tokentap base URL in terminal 2:

```bash
npm run dev:tokentap
```

Per-call LLM cost (`cost_usd`) continues to be logged in `logs/llm-agent-logs.jsonl`, and requests can be inspected in tokentap's live dashboard.

---

## Upstream ngrok API (what KubePulse expects)

KubePulse will try these paths on your ngrok base URL until one matches:

- `/kubepulse/metrics`
- `/api/kubepulse/metrics`
- `/api/metrics`
- `/metrics`
- `/kube/metrics`
- `/api/kube/metrics`

Expected JSON shape:

```json
{
  "pods": [
    {
      "pod_name": "frontend-6c4b...",
      "namespace": "default",
      "status": "Running",
      "cpu_usage": 0.12,
      "memory_usage": 73400320,
      "restart_count": 0
    }
  ],
  "fetched_at": "2026-04-10T12:00:00Z"
}
```

For logs, KubePulse calls (with query params `pod` + `namespace`):

- `/kubepulse/logs`
- `/api/kubepulse/logs`
- `/api/logs`
- `/logs`
- `/kube/logs`
- `/api/kube/logs`

Return text/plain or JSON.

---

## Trigger polling (ingest metrics → Supabase)

KubePulse includes a secure polling endpoint that writes into Supabase using the **service role** key:

```bash
curl -X POST "http://localhost:3000/api/poll" ^
  -H "content-type: application/json" ^
  -H "x-kubepulse-secret: YOUR_SECRET" ^
  -d "{\"endpoint_id\":\"YOUR_ENDPOINT_UUID\"}"
```

- Omit `endpoint_id` to poll all endpoints.
- For true “always-on polling”, run this curl in a loop or schedule it (Task Scheduler / cron), every 5–10 seconds.

---

## External self-healing agent integration

Your healing agent can write actions into Supabase by calling:

```bash
curl -X POST "http://localhost:3000/api/healing-actions" ^
  -H "content-type: application/json" ^
  -H "x-kubepulse-secret: YOUR_SECRET" ^
  -d "{\"endpoint_id\":\"YOUR_ENDPOINT_UUID\",\"action_taken\":\"Restarted cartservice pod\",\"status\":\"success\"}"
```

These events show up in `/dashboard/alerts` in real time.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
