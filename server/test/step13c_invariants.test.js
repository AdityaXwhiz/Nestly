import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PurgeQueueCommand } from '@aws-sdk/client-sqs';

process.env.NODE_ENV = 'test';

const { pool } = await import('../src/infrastructure/postgres.js');
const { sqsClient, QUEUE_DEFINITIONS } = await import('../src/infrastructure/sqs/client.js');
const { setupQueues } = await import('../src/infrastructure/sqs/setupQueues.js');
const { checkAllInvariants, verifyInvariantsWithPolling } = await import('../scripts/verifyInvariants.js');
const { assertLoadtestGuards } = await import('../scripts/seedLoadTest.js');
const { default: mockApp } = await import('../src/infrastructure/payment/mockProvider.js');

describe('Step 13C: Invariant Checker & Mock Provider Stats Suite', () => {
  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdProviderIds = [];
  const createdServiceIds = [];
  const createdOrderIds = [];
  let mockServer = null;
  let mockBaseUrl = '';

  async function resetDbToClean() {
    await pool.query('DELETE FROM outbox WHERE published_at IS NULL');
    await pool.query('DELETE FROM payment_transactions');
    await pool.query('DELETE FROM payments');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM saga_instances');
    await pool.query('DELETE FROM order_items');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM service_capacity');
  }

  before(async () => {
    await setupQueues();
    for (const def of Object.values(QUEUE_DEFINITIONS)) {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.dlqUrl })).catch(() => {});
    }
    await resetDbToClean();

    mockServer = mockApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => {
      if (mockServer.listening) return resolve();
      mockServer.once('listening', resolve);
    });
    const addr = mockServer.address();
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;
    await fetch(`${mockBaseUrl}/stats/reset`, { method: 'POST' });
  });

  after(async () => {
    await resetDbToClean();
    if (createdServiceIds.length > 0) {
      await pool.query('DELETE FROM services WHERE id = ANY($1::uuid[])', [createdServiceIds]).catch(() => {});
    }
    if (createdProviderIds.length > 0) {
      await pool.query('DELETE FROM providers WHERE id = ANY($1::uuid[])', [createdProviderIds]).catch(() => {});
    }
    if (createdPropertyIds.length > 0) {
      await pool.query('DELETE FROM properties WHERE id = ANY($1::uuid[])', [createdPropertyIds]).catch(() => {});
    }
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]).catch(() => {});
    }
    if (mockServer) {
      await new Promise((resolve) => mockServer.close(resolve));
    }
    await pool.end();
  });

  async function seedBasicEntities() {
    const hash = await bcrypt.hash('Password123!', 10);
    const uid = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}@example.test`;
    const u1 = (await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'CUSTOMER') RETURNING id`, [uid('cust'), hash])).rows[0].id;
    const u2 = (await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'HOST') RETURNING id`, [uid('host'), hash])).rows[0].id;
    const u3 = (await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'PROVIDER') RETURNING id`, [uid('prov'), hash])).rows[0].id;
    createdUserIds.push(u1, u2, u3);

    const propId = (
      await pool.query(
        `INSERT INTO properties (host_id, title, description, location, capacity, pricing_minor, currency, status)
         VALUES ($1, 'Inv Villa', 'Test', 'Goa', 4, 10000, 'INR', 'ACTIVE') RETURNING id`,
        [u2],
      )
    ).rows[0].id;
    createdPropertyIds.push(propId);

    const provId = (
      await pool.query(
        `INSERT INTO providers (user_id, business_name, bio)
         VALUES ($1, 'Inv Catering', 'Test') RETURNING id`,
        [u3],
      )
    ).rows[0].id;
    createdProviderIds.push(provId);

    const svcId = (
      await pool.query(
        `INSERT INTO services (provider_id, title, description, category, kind, capacity, price_minor, currency, status)
         VALUES ($1, 'Inv Cap Svc', 'Test', 'catering', 'capacity', 5, 2000, 'INR', 'ACTIVE') RETURNING id`,
        [provId],
      )
    ).rows[0].id;
    createdServiceIds.push(svcId);

    return { customerId: u1, propId, svcId };
  }

  it('mock-provider exposes /stats in test/loadtest mode and returns 404 in strict production mode', async () => {
    const res1 = await fetch(`${mockBaseUrl}/stats`);
    assert.equal(res1.status, 200);
    const data = await res1.json();
    assert.equal(data.chargesCount, 0);

    const prevEnv = process.env.NODE_ENV;
    const prevFlag = process.env.ENABLE_MOCK_STATS;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ENABLE_MOCK_STATS;
      const resProd = await fetch(`${mockBaseUrl}/stats`);
      assert.equal(resProd.status, 404);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevFlag !== undefined) process.env.ENABLE_MOCK_STATS = prevFlag;
    }
  });

  it('passes all 11 invariants on consistent data including confirmed order, capacity sum, and provider stats', async () => {
    await resetDbToClean();
    await fetch(`${mockBaseUrl}/stats/reset`, { method: 'POST' });
    const { customerId, propId, svcId } = await seedBasicEntities();

    // Send a charge through mock provider
    const chargeKey = `charge_inv_ok_${crypto.randomUUID()}`;
    const cRes = await fetch(`${mockBaseUrl}/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': chargeKey },
      body: JSON.stringify({ amount_minor: 14000, currency: 'INR', reference: 'ch_inv_ok' }),
    });
    assert.equal(cRes.status, 200);

    // Insert clean matching CONFIRMED order + 2 items + 2 CONFIRMED reservations + capacity + payment
    const orderId = (
      await pool.query(
        `INSERT INTO orders (user_id, status, total_amount_minor, currency, during, guest_count)
         VALUES ($1, 'CONFIRMED', 14000, 'INR', '[2027-06-01, 2027-06-02)', 2) RETURNING id`,
        [customerId],
      )
    ).rows[0].id;
    createdOrderIds.push(orderId);

    const oiProp = (
      await pool.query(
        `INSERT INTO order_items (order_id, resource_type, resource_id, quantity, unit_price_minor, currency, title, pricing_unit)
         VALUES ($1, 'PROPERTY', $2, 1, 10000, 'INR', 'Inv Villa', 'PER_DAY') RETURNING id`,
        [orderId, propId],
      )
    ).rows[0].id;

    const oiSvc = (
      await pool.query(
        `INSERT INTO order_items (order_id, resource_type, resource_id, quantity, unit_price_minor, currency, title, slot, pricing_unit)
         VALUES ($1, 'SERVICE', $2, 2, 2000, 'INR', 'Inv Cap Svc', '2027-06-01', 'PER_UNIT') RETURNING id`,
        [orderId, svcId],
      )
    ).rows[0].id;

    await pool.query(
      `INSERT INTO reservations (order_item_id, resource_type, resource_id, during, status, is_exclusive, quantity)
       VALUES ($1, 'PROPERTY', $2, '[2027-06-01, 2027-06-02)', 'CONFIRMED', true, 1)`,
      [oiProp, propId],
    );

    await pool.query(
      `INSERT INTO reservations (order_item_id, resource_type, resource_id, during, status, is_exclusive, quantity, slot)
       VALUES ($1, 'SERVICE', $2, '[2027-06-01, 2027-06-02)', 'CONFIRMED', false, 2, '2027-06-01')`,
      [oiSvc, svcId],
    );

    await pool.query(
      `INSERT INTO service_capacity (service_id, slot, capacity, reserved)
       VALUES ($1, '2027-06-01', 5, 2)`,
      [svcId],
    );

    await pool.query(
      `INSERT INTO payments (order_id, amount_minor, currency, status, provider_reference)
       VALUES ($1, 14000, 'INR', 'SUCCESS', 'ch_inv_ok')`,
      [orderId],
    );

    const report = await checkAllInvariants({
      mockStatsUrl: `${mockBaseUrl}/stats`,
      requireMockStats: true,
    });

    assert.equal(report.allPassed, true, JSON.stringify(report.results.filter((r) => !r.passed)));
    assert.equal(report.results.length, 11);
  });

  it('detects and reports failing rules accurately across structural and async invariants', async () => {
    await resetDbToClean();
    await fetch(`${mockBaseUrl}/stats/reset`, { method: 'POST' });
    const { customerId, propId, svcId } = await seedBasicEntities();

    // Order total deliberately disagrees with snapshot item sum (9999 vs 10000),
    // Confirmed order missing reservation & payment, payment amount differs from order total,
    // Failed order with SUCCESS payment, capacity out of sync, expired HELD reservation, unpublished outbox, stale saga.
    const badOrderId = (
      await pool.query(
        `INSERT INTO orders (user_id, status, total_amount_minor, currency, during, guest_count)
         VALUES ($1, 'CONFIRMED', 9999, 'INR', '[2027-07-01, 2027-07-02)', 2) RETURNING id`,
        [customerId],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO order_items (order_id, resource_type, resource_id, quantity, unit_price_minor, currency, title, pricing_unit)
       VALUES ($1, 'PROPERTY', $2, 1, 10000, 'INR', 'Inv Villa', 'PER_DAY')`,
      [badOrderId, propId],
    );

    const failedOrderId = (
      await pool.query(
        `INSERT INTO orders (user_id, status, total_amount_minor, currency, during, guest_count)
         VALUES ($1, 'FAILED', 10000, 'INR', '[2027-07-05, 2027-07-06)', 2) RETURNING id`,
        [customerId],
      )
    ).rows[0].id;
    const failedItemId = (
      await pool.query(
        `INSERT INTO order_items (order_id, resource_type, resource_id, quantity, unit_price_minor, currency, title, pricing_unit)
         VALUES ($1, 'PROPERTY', $2, 1, 10000, 'INR', 'Inv Villa', 'PER_DAY') RETURNING id`,
        [failedOrderId, propId],
      )
    ).rows[0].id;

    // Payment amount wrong + SUCCESS on FAILED order + provider_reference absent from mock stats
    await pool.query(
      `INSERT INTO payments (order_id, amount_minor, currency, status, provider_reference)
       VALUES ($1, 5000, 'INR', 'SUCCESS', 'ch_ghost')`,
      [failedOrderId],
    );

    // Expired HELD reservation still active
    await pool.query(
      `INSERT INTO reservations (order_item_id, resource_type, resource_id, during, status, hold_expires_at, is_exclusive, quantity)
       VALUES ($1, 'PROPERTY', $2, '[2027-07-05, 2027-07-06)', 'HELD', now() - interval '10 minutes', true, 1)`,
      [failedItemId, propId],
    );

    // service_capacity mismatch (reserved=3 but 0 active capacity reservations)
    await pool.query(
      `INSERT INTO service_capacity (service_id, slot, capacity, reserved)
       VALUES ($1, '2027-07-01', 5, 3)`,
      [svcId],
    );

    // Unpublished outbox row + stale non-terminal saga
    await pool.query(
      `INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'test.event', '{}'::jsonb)`,
      [badOrderId],
    );
    await pool.query(
      `INSERT INTO saga_instances (order_id, state, step, context, updated_at)
       VALUES ($1, 'HOLDING_SERVICES', 2, '{}'::jsonb, now() - interval '10 minutes')`,
      [badOrderId],
    );

    const report = await verifyInvariantsWithPolling({
      timeoutMs: 0,
      mockStatsUrl: `${mockBaseUrl}/stats`,
      requireMockStats: true,
    });

    assert.equal(report.allPassed, false);
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    assert.equal(byId.capacity_consistency.passed, false);
    assert.equal(byId.confirmed_order_integrity.passed, false);
    assert.equal(byId.order_total_matches_snapshots.passed, false);
    assert.equal(byId.payment_amount_matches_order.passed, false);
    assert.equal(byId.provider_charges_match_db.passed, false);
    assert.equal(byId.no_unrefunded_success_on_failed_order.passed, false);
    assert.equal(byId.no_expired_held_reservations.passed, false);
    assert.equal(byId.no_stale_non_terminal_sagas.passed, false);
    assert.equal(byId.outbox_all_published.passed, false);
  });

  it('seedLoadTest guards refuse execution unless LOADTEST_ENABLED=true and COMPOSE_PROJECT_NAME=nestly-load (Change #7)', () => {
    const prevEn = process.env.LOADTEST_ENABLED;
    const prevProj = process.env.COMPOSE_PROJECT_NAME;
    try {
      delete process.env.LOADTEST_ENABLED;
      process.env.COMPOSE_PROJECT_NAME = 'nestly-load';
      assert.throws(() => assertLoadtestGuards(), /LOADTEST_ENABLED/);

      process.env.LOADTEST_ENABLED = 'true';
      process.env.COMPOSE_PROJECT_NAME = 'nestly-prod';
      assert.throws(() => assertLoadtestGuards(), /nestly-load/);

      process.env.LOADTEST_ENABLED = 'true';
      process.env.COMPOSE_PROJECT_NAME = 'nestly-load';
      assert.doesNotThrow(() => assertLoadtestGuards());
    } finally {
      if (prevEn !== undefined) process.env.LOADTEST_ENABLED = prevEn;
      else delete process.env.LOADTEST_ENABLED;
      if (prevProj !== undefined) process.env.COMPOSE_PROJECT_NAME = prevProj;
      else delete process.env.COMPOSE_PROJECT_NAME;
    }
  });
});
