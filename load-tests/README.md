# Load Tests (`load-tests/`)

Implemented in **Step 13C** using pinned open-source `grafana/k6:0.55.0` against an isolated `nestly-load` Docker Compose stack ([docker-compose.loadtest.yml](file:///Users/adityasingh/Desktop/Nestly/docker-compose.loadtest.yml)).

## Quick Reference

- `load-tests/k6/00-smoke.js` — 10s CI error-rate-only smoke test
- `load-tests/k6/01-search-normal.js` — Normal skewed search & browse (`ramping-arrival-rate`)
- `load-tests/k6/02-search-burst.js` — Search spike & recovery (`ramping-arrival-rate`, `abortOnFail` on errors)
- `load-tests/k6/03-contention.js` — 20 rounds × 50 contenders on shared `(property_id, dates)`
- `load-tests/k6/04-duplicate-payment.js` — Parallel same-key & different-key `POST /payments` concurrency + `/stats` parity
- `load-tests/k6/05-queue-stress.js` — High-rate confirmed orders measuring outbox/SQS drain and DLQ=0
- `load-tests/k6/06-mixed-journey.js` — Full search -> detail -> availability -> order -> hold -> pay -> poll mix

All raw JSON summaries and generated fixtures live under `load-tests/results/` (gitignored). Full measured results, threshold reasoning, bottleneck analysis, and limitations are documented in [load-test-report.md](file:///Users/adityasingh/Desktop/Nestly/docs/load-test-report.md).
