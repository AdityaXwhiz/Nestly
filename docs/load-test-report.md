# Nestly Load-Test & Invariant Verification Report (Step 13C)

> **Scope & Disclaimer:** Every metric below was measured locally on one developer machine using `grafana/k6` inside Docker against the containerized `nestly-load` Compose stack and an in-memory mock payment provider. These results verify correctness under concurrency and expose local container bottlenecks; they are **not** production capacity claims (BRD Section 6, HLD Section 2).

---

## 1. Environment, Versions & Hardware

- **Host Hardware:** Apple M4 (10 CPU cores, 16 GiB physical RAM)
- **Docker Desktop Allocation:** 10 CPUs, 8,319,504,384 bytes (~7.75 GiB RAM), Docker Engine `29.7.2`
- **Software Versions:**
  - Runtime: Node.js `v22.14.0`
  - Database: PostgreSQL `16.15` (`Debian 16.15-1.pgdg13+2`)
  - Load Generator: `grafana/k6:0.55.0` (`go1.23.3`, `linux/arm64`)
  - Infrastructure: Redis `7`, ElasticMQ `1.6.12`, MinIO (`pgsty/minio`), OpenSearch `2.18.0`, Nginx (`nginxinc/nginx-unprivileged:1.27.4-alpine`), Prometheus `v3.2.1`, Grafana OSS `11.5.2`

### Differences Between `docker-compose.loadtest.yml` (`nestly-load`) and `docker-compose.prod.yml` (`nestly-prod`)

1. **Isolated project name (`name: nestly-load`)**: Separate volumes, network, and containers so load tests never touch `nestly-prod` or dev databases.
2. **Raised auth rate limit (`RATE_LIMIT_AUTH_MAX=10000` / `60s`) & longer `JWT_TTL=2h`**: Prevents a single `k6` container IP from hitting IP rate limits and keeps pre-signed pool JWTs valid across multi-run campaigns. **Note:** Because customer JWTs are pre-signed by [seedLoadTest.js](file:///Users/adityasingh/Desktop/Nestly/server/scripts/seedLoadTest.js) using `JWT_ACCESS_SECRET`, **per-request `bcrypt` login CPU cost is excluded** from all API throughput numbers.
3. **Explicit CPU & memory limits** (all non-k6 services bounded inside Docker):
   - `postgres`: `1.0` CPU, `512 MiB` RAM (`max_connections=100`)
   - `api`: `0.5` CPU, `256 MiB` RAM per replica (`DB_POOL_MAX=10`, `API_REPLICAS=1` or `2`, zero `container_name`)
   - `client` (Nginx): `1.0` CPU (`0.5` during early queue-stress baseline), `128 MiB` RAM, `API_UPSTREAM_RESOLVER=127.0.0.11`
   - `worker-scheduler` / `worker-consumer` / `redis` / `mock-provider`: `0.5` CPU, `256 MiB` RAM each
   - `k6` container: `--cpus=2.0`
4. **Mock provider stats (`ENABLE_MOCK_STATS=true`)**: Enables `GET /stats` and `POST /stats/reset` on `mock-provider` (returns `404` in `docker-compose.prod.yml`), with webhooks routed via `http://client:8080/api/v1/payments/webhook`.
5. **Multi-replica Prometheus scrape (`prometheus.loadtest.yml`)**: `5s` scrape interval and `dns_sd_configs` resolving `api:9100` across scaled API replicas.

---

## 2. Seeded Catalog & Scenario Definitions

### Seeded HLD Catalog ([seedLoadTest.js](file:///Users/adityasingh/Desktop/Nestly/server/scripts/seedLoadTest.js))
- **150 Customers** (pre-signed JWT pool), **20 Hosts**, **20 Providers**
- **5,000 ACTIVE properties** and **20,000 ACTIVE services** (~60% exclusive, ~40% capacity-based), indexed into OpenSearch aliases (`nestly_properties`, `nestly_services`).
- Search scenarios use a **skewed 75% hot / 25% long-tail** query & property mix to exercise Redis cache hits realistically.

### Scenarios & Chosen Thresholds (HLD Section 2 / LLD Section 14)

| Scenario | Executor | Workload Shape | Thresholds & Reasoning |
|---|---|---|---|
| `01-search-normal` | `ramping-arrival-rate` | 6 -> 12 (100x HLD burst) -> 25 -> 12 RPS (50s, `maxVUs=100`) | `<1%` fail (`abortOnFail`), search `P95<250ms` / `P99<500ms`, detail `P95<150ms`, `dropped_iterations<20`. Verifies cached read budget at 1-2x HLD burst. |
| `02-search-burst` | `ramping-arrival-rate` | 12 -> 140 -> 220 -> 12 RPS spike/recovery (60s, `maxVUs=250`) | `<2%` fail (`abortOnFail` after `5s`), search `P95<600ms` / `P99<1200ms`. Tests spike handling and cache protection without coordinated omission. |
| `03-contention` | `per-vu-iterations` (20 staggered rounds) | 20 rounds x 50 simultaneous VUs hitting distinct `(property_id, dates)`; winner pays | `hold_winners==20`, `confirmed_winners==20`, `server_5xx_rate==0` (`abortOnFail`), `unexpected_hold_status_rate==0`, hold `P95<1500ms` / `P99<3000ms`. |
| `04-duplicate-payment` | `per-vu-iterations` + `http.batch(10)` | 10 rounds same `Idempotency-Key` batch + 10 rounds distinct-key batch on held orders | `dup_paid_orders_confirmed==20`, `mock_charge_parity_ok>=1` (delta charges == 20), `server_5xx_rate==0` (`abortOnFail`). |
| `05-queue-stress` | `shared-iterations` | 12 VUs create 90 disjoint property+capacity bookings (~540 outbox rows fan-out) | `<2%` fail (`abortOnFail`), `server_5xx_rate==0`, `queue_bookings_confirmed>=90`, plus post-run outbox/SQS drain & `DLQ==0`. |
| `06-mixed-journey` | `ramping-vus` | ~82% search/detail/availability + ~18% full checkout (`create -> hold -> pay -> poll`); up to 50 VUs (`60s`) | `<5%` HTTP fail & `<2%` 5xx (`abortOnFail` after `8s`), search `P95<600ms`, hold `P95<1200ms`. Probes first compute/DB saturation point. |

---

## 3. Measured Results (Warm-Up + 3 Measured Runs, Median `[Min..Max]`)

> Every passing scenario passed **both** k6 thresholds and all **11 database/mock-provider/SQS invariant checks** (`verify:invariants`) on every measured run.

### Client-Side (`k6`) vs. Server-Side (`Prometheus`) Performance

| Scenario | Pass | Client RPS | Server RPS | Client P50 / P95 / P99 (ms) | Server P50 / P95 / P99 (ms) | Err / Drop | Cache Hit |
|---|---|---|---|---|---|---|---|
| `01-search-normal` | PASS | `15.65` `[15.65..15.65]` | `13.95` `[13.85..14.15]` | `3.34` / `11.83` / `22.11` | `2.67` / `8.54` / `22.76` | `0` / `0` | `83.0%` |
| `02-search-burst` | PASS | `108.64` `[108.64..108.66]` | `94.75` `[93.45..101.98]` | `1.43` / `6.38` / `50.54` | `2.53` / `4.81` / `6.68` | `0` / `0` | `90.0%` |
| `03-contention` | PASS | `35.81` `[5.07..35.86]` | `30.40` `[4.89..32.00]` | `134.61` / `469.40` / `686.74` | `24.80` / `395.75` / `717.71` | `0` / `0` | `n/a` |
| `04-dup-payment` | PASS | `71.33` `[70.43..72.69]` | `4.67` `[3.40..5.05]` | `7.52` / `19.52` / `88.11` | `3.95` / `16.86` / `53.25` | `0` / `0` | `n/a` |
| `05-queue` *(before tune)* | **FAIL** | `219.34` `[212.34..244.26]` | `2.37` `[0.68..6.35]` | `7.70` / `94.47` / `177.88` | `4.95` / `47.13` / `87.56` | `0` / `0` | `n/a` |
| `05-queue` *(after tune)* | PASS | `166.81` `[143.39..197.17]` | `0` `[0..265.81]`\* | `13.97` / `172.56` / `198.43` | `7.55` / `96.74` / `216.25` | `0` / `0` | `n/a` |
| `06-mixed` (`1` API rep) | PASS | `368.71` `[354.61..397.01]` | `372.58` `[357.03..412.66]` | `26.83` / `179.85` / `454.34` | `3.22` / `73.96` / `145.35` | `0` / `0` | `89.2%` |
| `06-mixed` (`2` API reps) | PASS | `658.66` `[628.94..659.82]` | `689.17` `[679.92..689.19]` | `5.32` / `90.92` / `201.11` | `2.96` / `21.89` / `88.11` | `0` / `0` | `91.0%` |

*\*Note on short bursts (`04`, `05`): Because `04-dup-payment` completes in ~4s and `05-queue-stress` completes 90 bookings in ~2.1s—shorter than Prometheus's `5s` scrape tick—some runs fall between two scrapes (`increase()` returns 0 on runs 1-2 of `05-queue (after)`, while run 3 recorded `265.81 RPS`). Use client-side k6 RPS for sub-5s bursts and Prometheus for steady/sustained scenarios (`01`, `02`, `03`, `06`).*

### Resources, Async Queues & Container Telemetry (Median `[Min..Max]`)

| Scenario | DB Pool Total / Wait | Outbox Peak / SQS Peak / DLQ | Drain Time (ms) | Consumer (msg/s) | API Peak CPU (%) | Postgres Peak CPU (%) | k6 Peak CPU (%) |
|---|---|---|---|---|---|---|---|
| `01-search-normal` | `7` / `0` | `0` / `0` / `0` | `988` | `0` | `17.91` `[17.43..18.98]` | `3.74` `[2.96..4.23]` | `4.67` `[3.27..5.72]` |
| `02-search-burst` | `9` / `0` | `0` / `0` / `0` | `977` | `0` | `32.24` `[31.29..34.50]` | `4.57` `[3.78..4.74]` | `16.44` `[16.17..18.14]` |
| `03-contention` | `17` / `0` `[0..26]` | `8` / `0` / `0` | `3,715` | `1.85` | `35.20` `[30.09..35.41]` | `15.71` `[15.15..18.91]` | `10.03` `[4.00..23.95]` |
| `04-dup-payment` | `13` / `0` | `60` / `0` / `0` | `32,652` | `3.00` | `17.95` `[17.52..23.79]` | `7.23` `[6.37..11.05]` | `2.44` `[2.27..3.43]` |
| `05-queue` *(before)* | `16` / `0` | `530` / `0` / `0` | `76,451` *(380 left!)* | `2.50` | `0.54` `[0.38..1.59]` | `0.22` `[0.02..0.92]` | `-` *(2s run)* |
| `05-queue` *(after)* | `24` / `0` | `366` / `32` / `0` | `3,051` `[2405..3253]` | `45.10` `[23.55..62.55]` | `9.72` `[0.30..40.65]` | `8.57` `[7.49..32.70]` | `7.99` |
| `06-mixed` (`1` rep) | `27` / `0` | `524` / `16` / `0` | `2,413` `[478..7758]` | `118.61` | `52.00` `[51.65..52.53]` | `38.96` `[38.75..39.46]` | `22.66` `[18.86..29.64]` |
| `06-mixed` (`2` reps) | `39` / `0` | `5,068` / `137` / `0` | `30,547` | `124.21` | `api-1: 51.88`, `api-2: 51.23` | `65.83` `[60.32..75.50]` | `29.26` `[25.84..72.03]` |

Contention & Correctness highlights observed in k6 outputs + `verify:invariants`:
- **`03-contention`**: Across all 3 runs (`20 rounds x 50 contenders`), **20/20 rounds produced 1 winner (`hold_winners=20`, `hold_conflicts=980`, `confirmed_winners=20`, `0` 5xx)**. Total `order_items == order.total_amount_minor` and `mock chargesCount == 20`.
- **`04-duplicate-payment`**: Across 20 held orders (10 concurrent same-key batches of 10 + 10 concurrent different-key batches of 10 = 200 concurrent payment HTTP calls), **`dup_paid_orders_confirmed=20`**, `0` 5xx, and `mock-provider` `/stats` recorded **delta `chargesCount = 20`** (`1` charge per paid order).

---

## 4. Bottleneck Analysis, Tuning & Stateless Scaling

### Bottleneck #1 (Discovered & Fixed): Outbox Publisher Rate Cap
- **What happened:** On the initial `05-queue-stress` run, 90 bookings produced ~540 outbox events in 2 seconds while `worker-scheduler` CPU remained idle (`<10%`) and ElasticMQ queue depth stayed `0`. Yet after 75s of waiting (`30s` drain wait + `45s` invariant polling), **`380` outbox rows remained unpublished**, failing `outbox_all_published`. On the un-tuned baseline of `06-mixed-journey` (`1,218` bookings), **`7,018` rows** backed up.
- **Root cause:** In [workers/index.js](file:///Users/adityasingh/Desktop/Nestly/server/src/workers/index.js), `runOutboxTick()` published a single batch of `10` rows every `5000 ms`—hard-capping async fan-out at **2.0 rows/sec** regardless of spare worker/DB headroom.
- **Fix applied:** Added `OUTBOX_BATCH_SIZE` (default `100`) and `OUTBOX_POLL_INTERVAL_MS` (default `1000`) to [env.js](file:///Users/adityasingh/Desktop/Nestly/server/src/config/env.js), and updated `runOutboxTick()` to drain up to `10` consecutive full batches per tick (bounded by `4s`).
- **Before vs. After (`05-queue-stress`):**
  - Consumer throughput: **`2.50 msg/s`** -> **`45.10 msg/s`** (`18x` increase; peaked at **`118.61`–`124.21 msg/s`** under sustained `06-mixed-journey` load)
  - Queue/outbox drain time: **`>76,451 ms` (FAIL)** -> **`3,051 ms` (PASS, `0` unpublished, `0` DLQ)**

### Bottleneck #2 (Compute Limit) & Stretch Result: Scaling API from 1 to 2 Replicas
- **Observation (`06-mixed-journey`, 1 API replica):** `api-1` (capped at `0.50` CPU) saturated completely (`avg 47.57%`, `peak 52.00%` of host CPU quota), while `postgres-1` (`1.0` CPU) used only `27.03%` avg (`38.96%` peak) with `0` waiting DB pool connections. Notice `clientP95` (`179.85 ms`) diverged sharply from `serverP95` (`73.96 ms`) due to HTTP socket queuing in front of the CPU-throttled Node process.
- **Change (`API_REPLICAS=2`):** Configured dynamic Nginx DNS upstream resolution (`API_UPSTREAM_RESOLVER=127.0.0.11`, `valid=5s`) in [nginx.conf](file:///Users/adityasingh/Desktop/Nestly/client/nginx.conf) & [docker-entrypoint.sh](file:///Users/adityasingh/Desktop/Nestly/client/docker-entrypoint.sh) and scaled `api` to `2` replicas (`0.5` CPU each) with Prometheus `dns_sd_configs`.
- **Measured Before (`1` API replica) vs. After (`2` API replicas):**
  - Throughput (`clientRps` median): **`368.71 RPS`** -> **`658.66 RPS`** (**+78.6%**)
  - Confirmed bookings in 60s run: **`1,112`** -> **`1,804`** (**+62.2%**, ~30.1 bookings/sec vs. HLD's 1.2/s 100x burst target)
  - Latency (`clientP95` / `clientP99` median): **`179.85 ms` / `454.34 ms`** -> **`90.92 ms` / `201.11 ms`** (**~50%–56% reduction**)
  - CPU balance: `api-1` `avg 42.46%` + `api-2` `avg 41.86%` (even ~50/50 distribution behind Nginx), while `postgres-1` climbed from `38.96%` to `65.83%` peak (`39` total connections of `100` max, `0` waiting) — confirming Postgres + Nginx proxy CPU (`101%` peak on `client-1`) become the next tier to scale beyond ~660–690 RPS.

---

## 5. Exact Commands & Limitations

```bash
# 1. Start isolated load-test stack (requires generated .env.loadtest)
docker compose --env-file .env.loadtest -p nestly-load -f docker-compose.prod.yml -f docker-compose.loadtest.yml up --build -d --wait

# 2. Run a single scenario (warm-up + 3 measured runs + automatic verify:invariants)
LOADTEST_ENABLED=true ENV_FILE=.env.loadtest npm run loadtest:run -- 01-search-normal
LOADTEST_ENABLED=true ENV_FILE=.env.loadtest npm run loadtest:run -- 03-contention --no-seed

# 3. Optional 2-replica scaling test
API_REPLICAS=2 docker compose --env-file .env.loadtest -p nestly-load -f docker-compose.prod.yml -f docker-compose.loadtest.yml up -d --wait
API_REPLICAS=2 LOADTEST_ENABLED=true ENV_FILE=.env.loadtest npm run loadtest:run -- 06-mixed-journey --no-seed --tag 2rep

# 4. Run invariants standalone against nestly-load
docker compose --env-file .env.loadtest -p nestly-load -f docker-compose.prod.yml -f docker-compose.loadtest.yml exec -T worker-scheduler node scripts/verifyInvariants.js --require-mock-stats

# 5. Tear down isolated volumes/network
docker compose --env-file .env.loadtest -p nestly-load -f docker-compose.prod.yml -f docker-compose.loadtest.yml down -v
```

### Explicit Limitations
1. **Single-machine contention:** `k6` (`--cpus=2.0`), Nginx, Express API, PostgreSQL, Redis, ElasticMQ, OpenSearch, Prometheus, and Grafana all share one Apple M4 host. Network loopback latency (`<1 ms`) hides WAN/NAT/TLS overhead and multi-AZ RTTs.
2. **Pre-signed JWT pool:** Login endpoints (`POST /auth/login`) using `bcrypt` were intentionally bypassed via pre-signed JWTs (`JWT_TTL=2h`) so tests isolate discovery, booking contention, payment idempotency, and async worker bottlenecks. Real login spikes must keep `bcrypt` CPU isolated or horizontally scaled behind rate limits.
3. **Mock payment provider:** `mock-provider` responds in ~1–5 ms in memory and dispatches local webhooks in `50 ms`; real card gateways exhibit `200–1500+ ms` P95 latency and occasional HTTP timeouts, increasing concurrent hold/payment in-flight duration.
