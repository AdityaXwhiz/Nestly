# AGENTS.md: Nestly project rules

Nestly is a property + event-services marketplace (one order, one payment).
Source of truth: /docs/Nestly_BRD.pdf, /docs/Nestly_HLD.pdf, /docs/Nestly_LLD.pdf.
Read the relevant sections before working on any step.

## 1. Stack
1. JavaScript only (no TypeScript). Node.js + Express, ES modules.
2. PostgreSQL, Redis, Docker. React for the client (built last).
3. No Java/Spring.

## 2. Architecture (LLD sections 1-2)
1. Modular monolith. One Express app organized by domain modules.
2. Layering per module: routes -> controller -> validation -> service -> repository.
3. Controllers never touch the database or Redis.
4. Repositories contain parameterized SQL only, no business rules.
5. No module reads or writes another module's tables. Use service calls or outbox events.
6. Workers share the codebase but have their own entrypoint.

## 3. Free-only policy (hard rule)
1. Every tool, service, library and API must be free, with NO credit card and NO paid plan.
   Open-source or local-in-Docker is the default.
2. Allowed by default: PostgreSQL, Redis, ElasticMQ (SQS-compatible), MinIO (S3-compatible),
   Postgres full-text search (OpenSearch only locally in Docker, later), Prometheus + Grafana,
   k6, GitHub Actions free tier, Razorpay or Stripe TEST mode only.
3. Never introduce a paid or card-gated service (including real AWS resources) without
   stopping and asking me first. If proposing anything outside the allowed list, state:
   (a) what it is, (b) its free-tier limits, (c) whether a card is required,
   (d) a free local alternative. Then wait for my approval.
4. Real AWS is deferred until step 13. Until then, code against local equivalents using
   the real AWS SDKs and endpoint environment variables, so switching later is config only.
5. Never hardcode keys. Use .env (gitignored) and keep .env.example up to date.

## 4. Learning mode (I am learning while building)
For every step:
1. Before coding, explain in plain language WHAT we are building and WHY, linking it to
   the BRD/HLD/LLD section.
2. Show a short plan and wait for my approval before writing code.
3. Implement in small pieces, not one giant change.
4. After coding, give a "What you just learned" summary (3-5 bullets) and ONE exercise or
   question to check my understanding.
5. Never silently add features beyond the current step.
6. If I ask, explain code file by file.

## 5. Workflow
1. Work only on the step I give you.
2. After each step: run it, show me exactly how to verify it, and propose a git commit
   message. Do not commit for me.
3. If the docs are ambiguous, or an open decision (D-1 to D-5 in the BRD) blocks you,
   ask me. Do not guess.

## 6. Correctness and security
1. Money is stored as integer minor units.
2. Parameterized SQL only. Validate every mutation's input (zod), reject unknown fields.
3. Authorization is always enforced server-side. Ownership is checked in the service layer.
4. Never log secrets, tokens, passwords or card data. Never expose stack traces.
5. PostgreSQL is the only source of truth. Redis, search and queues are derived or
   coordination stores. Never trust the cache for booking decisions.
6. Every mutation that can be retried must be idempotent (see LLD section 7).

## 7. Build order (LLD section 16)
1. Repo, config, Docker
2. PostgreSQL schema + migrations
3. Auth + RBAC
4. Marketplace CRUD (properties, providers, services)
5. Availability + reservations
6. Redis cache, holds, locks
7. Orders + price snapshots
8. Payments + idempotency + webhooks
9. Saga + outbox
10. SQS-compatible workers + DLQ + schedulers
11. Media upload + search
12. React client
13. AWS deployment, observability, k6 load tests

Do not jump ahead of the step I specify.