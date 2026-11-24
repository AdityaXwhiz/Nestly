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

Update `.env.prod` with generated values for `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` (production mode refuses to start with weak or default placeholders).

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
