# Nestly

Property and event-services marketplace ("one order, one payment").

*(Full documentation will be added in Step 14.)*

---

## DEPLOY

Run the complete production-like local stack (Postgres, Redis, ElasticMQ, MinIO, OpenSearch, one-off `migrate` and `init` jobs, Express API, split scheduler/consumer workers, mock payment provider, and unprivileged Nginx client) on a single origin at **`http://localhost:8080`**.

### 1. Generate Environment Secrets

Copy `.env.example` to `.env.prod` (gitignored) and generate strong random secrets:

```bash
cp .env.example .env.prod
# Generate 256-bit random secrets (run twice for JWT_ACCESS_SECRET and PAYMENT_WEBHOOK_SECRET)
openssl rand -hex 32
```

Update `.env.prod` with generated values for `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `GF_SECURITY_ADMIN_PASSWORD` (production mode refuses to start with weak or default placeholders).

> **Note:** If you currently have the development Compose stack running (`docker compose up`), stop it first (`docker compose down`) so ports `8080` and `9000` are available. MinIO port `9000` is published in the local prod stack because browsers perform presigned PUT image uploads and public image reads directly against `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`) and `MEDIA_PUBLIC_BASE_URL` instead of sending file bytes through the API.

### 2. Start the Stack (One Command)

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up --build -d
```

Open **`http://localhost:8080`** once containers are healthy (`docker compose -f docker-compose.prod.yml ps`).

### 3. Run the End-to-End Smoke Test

The smoke test registers fresh host, provider, and customer users through the API, creates a property and service, creates an order, places a hold, pays with an `Idempotency-Key`, and polls until `CONFIRMED`:

```bash
npm run smoke
```

*(Override target URL with `SMOKE_BASE_URL=http://localhost:8080 npm run smoke`.)*

### 4. Seed Demo Data (Local Use Only)

To explore the UI in the local prod-like stack with pre-populated accounts (`customer@example.test`, `host@example.test`, `provider@example.test`, password `DemoPass123!`), run the idempotent demo seeder explicitly with `NODE_ENV=development`:

> **Warning: Local use only.** Never run `seed:demo` in a real production environment (the script explicitly refuses to run when `NODE_ENV=production`).

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm -e NODE_ENV=development api npm run seed:demo
```

### 5. Stop the Stack

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml down
```

---

## Observability, Dashboards & Chaos Verification (Step 13B)

Metrics (`/metrics`) are served on dedicated internal ports (`API_METRICS_PORT=9100`, `WORKER_METRICS_PORT=9101`) that are never published to the host; Nginx also returns `404` on `/metrics`. Prometheus and Grafana OSS run inside Compose bound to `127.0.0.1` only:

- **Prometheus**: `http://127.0.0.1:9090` (7-day local retention)
- **Grafana**: `http://127.0.0.1:3001` (sign-up & anonymous access disabled; sign in with `GF_SECURITY_ADMIN_USER` / `GF_SECURITY_ADMIN_PASSWORD`)

In development mode (`docker-compose.yml`), start Prometheus + Grafana alongside infra using:

```bash
docker compose --profile observability up -d
```

Every HTTP request accepts sanitized `X-Request-Id` (`[A-Za-z0-9._-]{8,64}`) or generates one, propagating `reqId` across outbox rows, SQS envelopes/attributes, worker consumers, and JSON logs; payment webhooks and consumer jobs also log `origin_request_id` from the checkout payment request.

### Chaos Verification (`npm run chaos:check`)

Start the prod stack with the chaos rules overlay (`docker-compose.chaos.yml` shortens `for:` durations for fast automated verification), then run `chaos:check`:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml -f docker-compose.chaos.yml up --build -d --wait
CHAOS_ENABLED=true npm run chaos:check
```

`chaos:check` refuses to run unless `CHAOS_ENABLED=true` and the Compose project is `nestly-prod`, injects 4 faults sequentially while sending traffic, asserts alerts fire and recover, and always restores stopped containers/queues in `finally` blocks.

### Alert Runbooks

| Alert | `for:` | Likely Cause | First Action |
|---|---|---|---|
| `ElevatedHttp5xxRate` | `2m` | Unhandled exceptions or upstream `mock-provider` outage (`503`) | Filter `api` logs by `statusCode>=500` and inspect failing `reqId` / `origin_request_id`; check dependency health dashboard. |
| `HighHttpP95Latency` | `3m` | Slow Postgres queries, high concurrency, or event loop blocking | Inspect `01-api` dashboard event-loop lag & `db_pool_connections`; run `EXPLAIN` on slow endpoints. |
| `DbPoolWaitingClients` | `2m` | `pg` connection pool saturated by slow queries or held transactions | Check active/long transactions in Postgres (`pg_stat_activity`), review `DB_POOL_MAX`, or terminate runaway queries. |
| `SqsDlqNotEmpty` | `1m` | Poison payloads or repeated downstream failure moved messages to DLQ | Inspect with `npm --prefix server run dlq:inspect`, diagnose root cause via logged `reqId`, then redrive (`dlq:redrive`) or purge. |
| `OutboxUnpublishedLagHigh` | `2m` | `worker-scheduler` publisher stalled or ElasticMQ unreachable | Verify `worker-scheduler` health and `nestly_dependency_up{dependency="elasticmq"}`; inspect outbox table backlog. |
| `HighWorkerMessageAge` | `2m` | `worker-consumer` falling behind queue intake | Check `worker-consumer` logs, CPU/event-loop lag, and SQS queue depth; scale consumer workers if backlog grows. |
| `PaymentsStuckProcessing` | `5m` | Payment webhook missed or delayed past reconciliation window | Check `mock-provider` reachability and `worker-scheduler` `payment_reconciler` logs using `origin_request_id`. |
| `SagasStaleNonTerminal` | `5m` | Multi-step reservation saga crashed mid-flight | Inspect `worker-scheduler` `saga_recovery` tick logs and `saga_instances` state for impacted orders. |
| `RedisDependencyDown` | `1m` | Redis container down or network failure | Restart `redis` service; verify API stays live in degraded Postgres fallback mode and cache/lock recovery resumes. |
| `SearchDependencyDown` | `2m` | OpenSearch container down or cluster unhealthy | Check `opensearch` container memory/logs; catalog searches automatically degrade to PostgreSQL until recovered. |
| `CoreDependencyDown` | `1m` | Postgres, ElasticMQ, or MinIO unreachable by collector probe | Inspect failing container health (`docker compose ps`) and restore connectivity immediately. |
| `TargetDown` | `1m` | API, scheduler, or consumer metrics target unreachable | Inspect container state and exit logs (`docker compose logs <service>`); verify graceful shutdown/restart health. |

---

## Load Tests & Invariant Verification (Step 13C)

Load tests run in an isolated `nestly-load` Compose project (`docker-compose.loadtest.yml`) via pinned `grafana/k6:0.55.0`, followed automatically by database and SQS invariant verification (`npm run verify:invariants`). See [docs/load-test-report.md](file:///Users/adityasingh/Desktop/Nestly/docs/load-test-report.md) and [load-tests/README.md](file:///Users/adityasingh/Desktop/Nestly/load-tests/README.md).
