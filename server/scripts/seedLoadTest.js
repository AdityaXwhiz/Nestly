import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PurgeQueueCommand } from '@aws-sdk/client-sqs';
import { pool, withTx } from '../src/infrastructure/postgres.js';
import { redis } from '../src/infrastructure/redis.js';
import { sqsClient, QUEUE_DEFINITIONS } from '../src/infrastructure/sqs/client.js';
import { reindexProperties, reindexServices } from '../src/infrastructure/opensearch/reindex.js';
import { openSearchClient } from '../src/infrastructure/opensearch/client.js';
import { env } from '../src/config/env.js';

/**
 * Bulk Load-Test Catalog & User Pool Seeder (Step 13C)
 *
 * Refuses to run unless LOADTEST_ENABLED=true AND COMPOSE_PROJECT_NAME=nestly-load (Change #7).
 * Seeds ~5,000 ACTIVE properties and ~20,000 ACTIVE services (exclusive + capacity-based),
 * plus pre-hashed users and pre-signed JWTs (using env.JWT_ACCESS_SECRET) so k6 load tests
 * measure discovery/checkout/payment/workers without per-VU bcrypt login cost (Change #8).
 */

const CITIES = ['Goa', 'Mumbai', 'Jaipur', 'Bengaluru', 'Udaipur', 'Delhi', 'Pune', 'Kochi', 'Hyderabad', 'Chennai'];
const TITLE_THEMES = ['Villa', 'Retreat', 'Estate', 'Courtyard', 'Garden', 'Heritage', 'Coastal', 'Pavilion'];
const CATEGORIES = ['catering', 'decoration', 'cake', 'photography', 'music', 'other'];

export function assertLoadtestGuards() {
  if (process.env.LOADTEST_ENABLED !== 'true') {
    throw new Error('REFUSED: Set LOADTEST_ENABLED=true explicitly to run load-test seeding.');
  }
  const project = process.env.COMPOSE_PROJECT_NAME || '';
  if (project !== 'nestly-load') {
    throw new Error(`REFUSED: COMPOSE_PROJECT_NAME must be "nestly-load" (got "${project || 'unset'}").`);
  }
}

export async function resetTransactionalState({ mockStatsUrl = `${env.PAYMENT_PROVIDER_URL.replace(/\/+$/, '')}/stats/reset` } = {}) {
  await withTx(async (tx) => {
    await tx.query('DELETE FROM outbox');
    await tx.query('DELETE FROM processed_events');
    await tx.query('DELETE FROM payment_transactions');
    await tx.query('DELETE FROM payments');
    await tx.query('DELETE FROM idempotency_keys');
    await tx.query('DELETE FROM reservations');
    await tx.query('DELETE FROM saga_instances');
    await tx.query('DELETE FROM order_items');
    await tx.query('DELETE FROM orders');
    await tx.query('DELETE FROM service_capacity');
  });

  // Reset Redis rate-limit/cache keys cleanly before scenario runs
  await redis.flushdb().catch(() => {});

  // Purge queues and DLQs cleanly
  for (const def of Object.values(QUEUE_DEFINITIONS)) {
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.url })).catch(() => {});
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.dlqUrl })).catch(() => {});
  }

  // Reset mock provider charge/refund counters if reachable
  await fetch(mockStatsUrl, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

export async function seedLoadTestData({
  customerCount = 150,
  hostCount = 20,
  providerCount = 20,
  propertyCount = 5000,
  serviceCount = 20000,
  cleanTx = true,
  skipReindex = false,
} = {}) {
  assertLoadtestGuards();

  if (cleanTx) {
    await resetTransactionalState();
  }

  // Single bcrypt hash reused for all seeded pool accounts (no per-user bcrypt overhead)
  const passwordHash = await bcrypt.hash('LoadTestPass123!', 10);

  const existingPropRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM properties WHERE title LIKE 'Load Property %'`);
  const existingSvcRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM services WHERE title LIKE 'Load Service %'`);
  const alreadySeeded =
    existingPropRes.rows[0].cnt >= propertyCount && existingSvcRes.rows[0].cnt >= serviceCount;

  if (!alreadySeeded) {
    console.error(`[seedLoadTest] Seeding users, ${propertyCount} properties, and ${serviceCount} services in batched SQL...`);

    await withTx(async (tx) => {
      // Clear any partial previous loadtest catalog cleanly
      await tx.query(`DELETE FROM properties WHERE title LIKE 'Load Property %'`);
      await tx.query(`DELETE FROM users WHERE email LIKE 'lt-%@loadtest.local'`);

      // 1. Insert Customer, Host, Provider user pools
      await tx.query(
        `
          INSERT INTO users (email, password_hash, role, created_at)
          SELECT
            'lt-cust-' || lpad(i::text, 4, '0') || '@loadtest.local',
            $1,
            'CUSTOMER',
            now() + (i || ' milliseconds')::interval
          FROM generate_series(1, $2) AS s(i)
          ON CONFLICT (email) DO NOTHING;
        `,
        [passwordHash, customerCount],
      );

      await tx.query(
        `
          INSERT INTO users (email, password_hash, role, created_at)
          SELECT
            'lt-host-' || lpad(i::text, 3, '0') || '@loadtest.local',
            $1,
            'HOST',
            now() + (i || ' milliseconds')::interval
          FROM generate_series(1, $2) AS s(i)
          ON CONFLICT (email) DO NOTHING;
        `,
        [passwordHash, hostCount],
      );

      await tx.query(
        `
          INSERT INTO users (email, password_hash, role, created_at)
          SELECT
            'lt-prov-' || lpad(i::text, 3, '0') || '@loadtest.local',
            $1,
            'PROVIDER',
            now() + (i || ' milliseconds')::interval
          FROM generate_series(1, $2) AS s(i)
          ON CONFLICT (email) DO NOTHING;
        `,
        [passwordHash, providerCount],
      );

      // 2. Provider profiles
      await tx.query(
        `
          INSERT INTO providers (user_id, business_name, bio, status, created_at)
          SELECT
            u.id,
            'Load Provider ' || row_number() OVER (ORDER BY u.email),
            'Synthetic provider for Step 13C load testing',
            'ACTIVE',
            u.created_at
          FROM users u
          WHERE u.email LIKE 'lt-prov-%@loadtest.local'
          ON CONFLICT (user_id) DO NOTHING;
        `,
      );

      // 3. 5,000 ACTIVE properties distributed across hosts with monotonic timestamps
      await tx.query(
        `
          WITH hosts AS (
            SELECT id, row_number() OVER (ORDER BY email) AS idx
            FROM users
            WHERE email LIKE 'lt-host-%@loadtest.local'
          ),
          cities AS (
            SELECT $3::text[] AS arr
          ),
          themes AS (
            SELECT $4::text[] AS arr
          )
          INSERT INTO properties (host_id, title, description, location, capacity, pricing_minor, currency, status, created_at, updated_at)
          SELECT
            (SELECT id FROM hosts WHERE idx = ((i - 1) % $2) + 1),
            'Load Property ' || lpad(i::text, 5, '0') || ' ' || (SELECT arr[((i - 1) % array_length(arr, 1)) + 1] FROM themes),
            'Spacious event venue #' || i || ' with landscaped lawns and indoor hall',
            (SELECT arr[((i - 1) % array_length(arr, 1)) + 1] FROM cities),
            2 + (i % 18),
            100000 + ((i % 25) * 50000),
            'INR',
            'ACTIVE',
            timestamp '2026-01-01 00:00:00+00' + (i || ' milliseconds')::interval,
            timestamp '2026-01-01 00:00:00+00' + (i || ' milliseconds')::interval
          FROM generate_series(1, $1) AS s(i);
        `,
        [propertyCount, hostCount, CITIES, TITLE_THEMES],
      );

      // Add amenities on the first 500 properties for realistic detail payloads
      await tx.query(
        `
          INSERT INTO amenities (property_id, name)
          SELECT p.id, a.name
          FROM (
            SELECT id FROM properties WHERE title LIKE 'Load Property %' ORDER BY created_at ASC LIMIT 500
          ) p
          CROSS JOIN (VALUES ('WiFi'), ('Parking'), ('Lawn'), ('Power Backup')) AS a(name);
        `,
      );

      // 4. 20,000 ACTIVE services (60% exclusive, 40% capacity-based) with monotonic timestamps
      await tx.query(
        `
          WITH provs AS (
            SELECT id, row_number() OVER (ORDER BY created_at ASC) AS idx
            FROM providers
            WHERE business_name LIKE 'Load Provider %'
          ),
          cats AS (
            SELECT $3::text[] AS arr
          )
          INSERT INTO services (provider_id, title, description, category, kind, price_minor, currency, duration_minutes, capacity, status, created_at, updated_at)
          SELECT
            (SELECT id FROM provs WHERE idx = ((i - 1) % $2) + 1),
            'Load Service ' || lpad(i::text, 5, '0') || CASE WHEN (i % 5) < 3 THEN ' Exclusive' ELSE ' Capacity' END,
            'Synthetic event service #' || i || ' for load verification',
            (SELECT arr[((i - 1) % array_length(arr, 1)) + 1] FROM cats),
            CASE WHEN (i % 5) < 3 THEN 'exclusive' ELSE 'capacity' END,
            25000 + ((i % 20) * 10000),
            'INR',
            120,
            CASE WHEN (i % 5) < 3 THEN NULL ELSE 5 + (i % 46) END,
            'ACTIVE',
            timestamp '2026-01-01 00:00:00+00' + (i || ' milliseconds')::interval,
            timestamp '2026-01-01 00:00:00+00' + (i || ' milliseconds')::interval
          FROM generate_series(1, $1) AS s(i);
        `,
        [serviceCount, providerCount, CATEGORIES],
      );
    });

    if (!skipReindex) {
      console.error('[seedLoadTest] Reindexing properties and services to OpenSearch...');
      await reindexProperties({ batchSize: 500 });
      await reindexServices({ batchSize: 500 });
    }
  } else {
    console.error(`[seedLoadTest] Catalog already present (${existingPropRes.rows[0].cnt} properties, ${existingSvcRes.rows[0].cnt} services); reusing catalog.`);
    if (!skipReindex) {
      // Ensure OpenSearch aliases exist and have full catalog count
      const propIndexRes = await openSearchClient.count({ index: `${env.OPENSEARCH_INDEX_PREFIX}_properties` }).catch(() => null);
      const svcIndexRes = await openSearchClient.count({ index: `${env.OPENSEARCH_INDEX_PREFIX}_services` }).catch(() => null);
      if (!propIndexRes || propIndexRes.body.count < propertyCount) {
        await reindexProperties({ batchSize: 500 });
      }
      if (!svcIndexRes || svcIndexRes.body.count < serviceCount) {
        await reindexServices({ batchSize: 500 });
      }
    }
  }

  // Mint pre-signed JWTs for customer pool using env.JWT_ACCESS_SECRET & env.JWT_TTL (Change #8)
  const custRows = (
    await pool.query(
      `SELECT id, email, role FROM users WHERE email LIKE 'lt-cust-%@loadtest.local' ORDER BY email ASC LIMIT $1`,
      [customerCount],
    )
  ).rows;

  const customers = custRows.map((u) => ({
    id: u.id,
    email: u.email,
    token: jwt.sign({ sub: u.id, role: u.role }, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: env.JWT_TTL,
      audience: env.JWT_AUDIENCE,
    }),
  }));

  // Partition properties deterministically into hot browse, cold browse, contention, duplicate-payment, and general booking pools
  const propRows = (
    await pool.query(
      `SELECT id, title, location, pricing_minor, capacity
       FROM properties
       WHERE title LIKE 'Load Property %' AND status = 'ACTIVE'
       ORDER BY created_at ASC`,
    )
  ).rows;

  const hotProperties = propRows.slice(0, 100).map((p) => p.id);
  const contentionProperties = propRows.slice(100, 130).map((p) => p.id);
  const duplicatePaymentProperties = propRows.slice(130, 160).map((p) => p.id);
  const bookingProperties = propRows.slice(160, 2160).map((p) => p.id);
  const coldProperties = propRows.slice(2160, 5000).map((p) => p.id);

  const exclSvcs = (
    await pool.query(
      `SELECT id FROM services WHERE title LIKE 'Load Service %' AND kind = 'exclusive' AND status = 'ACTIVE' ORDER BY created_at ASC LIMIT 500`,
    )
  ).rows.map((r) => r.id);

  const capSvcs = (
    await pool.query(
      `SELECT id, capacity FROM services WHERE title LIKE 'Load Service %' AND kind = 'capacity' AND status = 'ACTIVE' ORDER BY created_at ASC LIMIT 500`,
    )
  ).rows;

  return {
    generatedAt: new Date().toISOString(),
    jwtTtl: env.JWT_TTL,
    catalogCounts: {
      properties: propRows.length,
      services: existingSvcRes.rows[0].cnt >= serviceCount ? existingSvcRes.rows[0].cnt : serviceCount,
    },
    customers,
    hotProperties,
    coldProperties,
    contentionProperties,
    duplicatePaymentProperties,
    bookingProperties,
    exclusiveServices: exclSvcs,
    capacityServices: capSvcs,
    searchTerms: {
      hotQueries: [
        { q: 'Villa', location: 'goa' },
        { q: 'Retreat', location: 'mumbai' },
        { q: 'Estate', location: 'jaipur' },
        { q: 'Courtyard', location: 'bengaluru' },
        { q: 'Garden', location: 'udaipur' },
      ],
      coldQueries: [
        { q: 'Heritage', location: 'delhi' },
        { q: 'Coastal', location: 'kochi' },
        { q: 'Pavilion', location: 'hyderabad' },
        { q: 'Villa', location: 'pune' },
        { q: 'Estate', location: 'chennai' },
      ],
      categories: CATEGORIES,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cleanTx = !process.argv.includes('--no-clean-tx');
  const skipReindex = process.argv.includes('--skip-reindex');
  const outIdx = process.argv.indexOf('--out');
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : null;

  seedLoadTestData({ cleanTx, skipReindex })
    .then(async (fixtures) => {
      const json = JSON.stringify(fixtures);
      if (outPath) {
        fs.writeFileSync(outPath, json, 'utf8');
        console.error(`[seedLoadTest] Wrote fixture pool (${fixtures.customers.length} users, ${fixtures.catalogCounts.properties} properties) to ${outPath}`);
      } else {
        process.stdout.write(json);
      }
      await pool.end().catch(() => {});
      redis.disconnect();
      await openSearchClient.close().catch(() => {});
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[seedLoadTest] FAILED: ${err.message}`);
      await pool.end().catch(() => {});
      redis.disconnect();
      await openSearchClient.close().catch(() => {});
      process.exit(1);
    });
}
