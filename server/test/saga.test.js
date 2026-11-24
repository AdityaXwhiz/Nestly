import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/infrastructure/postgres.js');
const { redis } = await import('../src/infrastructure/redis.js');
const { usersRepository } = await import('../src/modules/users/repository.js');
const { propertiesRepository } = await import('../src/modules/properties/repository.js');
const { servicesRepository } = await import('../src/modules/services/repository.js');
const { providersRepository } = await import('../src/modules/providers/repository.js');
const { ordersRepository } = await import('../src/modules/orders/repository.js');
const { paymentsRepository } = await import('../src/modules/payments/repository.js');
const { sagaRepository } = await import('../src/modules/orders/sagaRepository.js');
const { sagaOrchestrator, setFailureHook, clearFailureHooks } = await import('../src/modules/orders/saga.js');
const { reservationsService } = await import('../src/modules/reservations/service.js');
const { paymentProvider } = await import('../src/infrastructure/payment/index.js');
const { FakePaymentProvider } = await import('../src/infrastructure/payment/fakeProvider.js');
const {
  publishOutbox,
  InMemoryPublisher,
  setPublisher,
  setOutboxFailureHook,
  clearOutboxFailureHook,
} = await import('../src/modules/outbox/publisher.js');
const { runSchedulerTick, ADVISORY_LOCK_OUTBOX } = await import('../src/workers/index.js');

describe('Saga Orchestrator, Recovery and Outbox Test Suite', () => {
  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdProviderIds = [];
  const createdServiceIds = [];
  const createdOrderIds = [];
  const createdPaymentIds = [];

  const fakeProvider = new FakePaymentProvider();
  const testPublisher = new InMemoryPublisher();

  beforeEach(async () => {
    fakeProvider.reset();
    testPublisher.reset();
    paymentProvider.setProvider(fakeProvider);
    setPublisher(testPublisher);
    clearFailureHooks();
    clearOutboxFailureHook();
    await pool.query('UPDATE outbox SET published_at = now() WHERE published_at IS NULL;');
  });

  const uniqueEmail = () => `saga_${crypto.randomUUID().slice(0, 8)}@example.com`;

  async function createAuthenticatedUser(role = 'CUSTOMER') {
    const email = uniqueEmail();
    const password = 'Password123!';
    let userId;

    if (role === 'ADMIN') {
      const passwordHash = await bcrypt.hash(password, 10);
      const admin = await usersRepository.createUser({
        email,
        role: 'ADMIN',
        passwordHash,
      });
      userId = admin.id;
    } else {
      const reg = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password, role });
      userId = reg.body.user.id;
    }
    createdUserIds.push(userId);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password });

    return {
      id: userId,
      userId,
      role,
      token: login.body.accessToken,
    };
  }

  let customerUser;
  let hostUser;
  let providerUser;

  let testProperty;
  let testService;
  let limitedService;

  before(async () => {
    customerUser = await createAuthenticatedUser('CUSTOMER');
    hostUser = await createAuthenticatedUser('HOST');
    providerUser = await createAuthenticatedUser('PROVIDER');

    // Create property: 500,000 minor INR per day
    const propRes = await request(app)
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${hostUser.token}`)
      .send({
        title: 'Saga Grand Estate',
        description: 'Luxury estate for composite event workflows',
        location: 'Goa',
        capacity: 50,
        pricing_minor: 500000,
        currency: 'INR',
      });
    testProperty = propRes.body.property;
    createdPropertyIds.push(testProperty.id);

    // Create provider profile
    const provRes = await request(app)
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        business_name: 'Saga Event Solutions',
        bio: 'Premier orchestration services',
      });
    createdProviderIds.push(provRes.body.id);

    // Create exclusive service
    const svcRes = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        name: 'Live Orchestra Band',
        description: 'Complete orchestral ensemble',
        category: 'music',
        price_minor: 200000,
        currency: 'INR',
        kind: 'exclusive',
      });
    testService = svcRes.body.service;
    createdServiceIds.push(testService.id);

    // Create capacity service with capacity 1
    const capRes = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        name: 'Private Bartender Master',
        description: 'Mixologist service',
        category: 'catering',
        price_minor: 100000,
        currency: 'INR',
        kind: 'capacity',
        capacity: 1,
      });
    limitedService = capRes.body.service;
    createdServiceIds.push(limitedService.id);
  });

  after(async () => {
    for (const id of createdPaymentIds) {
      await paymentsRepository.deleteById(id);
    }
    for (const id of createdOrderIds) {
      await ordersRepository.deleteById(id);
    }
    for (const id of createdServiceIds) {
      await servicesRepository.deleteById(id);
    }
    for (const id of createdProviderIds) {
      await providersRepository.deleteById(id);
    }
    for (const id of createdPropertyIds) {
      await propertiesRepository.deleteById(id);
    }
    for (const id of createdUserIds) {
      await usersRepository.deleteById(id);
    }
    await pool.end();
    redis.disconnect();
  });

  async function createOrderFixture(daysOffset = 10, includeLimited = false) {
    const start = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + (daysOffset + 2) * 24 * 60 * 60 * 1000).toISOString();

    const services = [{ service_id: testService.id, quantity: 1 }];
    if (includeLimited) {
      const slot = start.slice(0, 10);
      services.push({ service_id: limitedService.id, quantity: 1, slot });
    }

    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${customerUser.token}`)
      .send({
        property_id: testProperty.id,
        during: { start, end },
        guest_count: 15,
        services,
      });
    assert.equal(orderRes.status, 201);
    createdOrderIds.push(orderRes.body.id);
    return orderRes.body;
  }

  describe('Saga Orchestrator Execution & Compensation', () => {
    it('happy path: create, hold via saga, pay, webhook -> saga COMPLETED and order CONFIRMED', async () => {
      const order = await createOrderFixture(10);

      // 1. Hold order via Saga
      const holdRes = await request(app)
        .post(`/api/v1/orders/${order.id}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);
      assert.equal(holdRes.status, 200);

      let saga = await sagaRepository.findByOrderId(order.id);
      assert.ok(saga);
      assert.equal(saga.state, 'AWAITING_PAYMENT');
      assert.equal(saga.step, 2);

      // 2. Initiate payment -> saga transitions to PAYING
      const idempotencyKey = crypto.randomUUID();
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ order_id: order.id });
      assert.equal(payRes.status, 202);
      createdPaymentIds.push(payRes.body.id);

      saga = await sagaRepository.findByOrderId(order.id);
      assert.equal(saga.state, 'PAYING');
      assert.equal(saga.step, 3);

      // 3. Webhook delivery -> saga transitions to CONFIRMING then COMPLETED
      const webhookPayload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };
      const signed = fakeProvider.signWebhookPayload(webhookPayload);
      const whRes = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signed.signatureHeader)
        .set('Content-Type', 'application/json')
        .send(signed.rawBody);
      assert.equal(whRes.status, 200);

      // Verify terminal states
      saga = await sagaRepository.findByOrderId(order.id);
      assert.equal(saga.state, 'COMPLETED');
      assert.equal(saga.step, 4);

      const dbOrder = await ordersRepository.findById(order.id);
      assert.equal(dbOrder.status, 'CONFIRMED');

      const reservations = await reservationsService.getReservationsByOrderId(order.id);
      for (const r of reservations) {
        assert.equal(r.status, 'CONFIRMED');
      }
    });

    it('service hold fails: saga compensates, no active reservations remain, order stays PENDING, and customer can retry hold successfully', async () => {
      const daysOffset = 20;
      const slot = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      // Pre-fill capacity slot so limitedService hold fails
      await pool.query(
        `INSERT INTO service_capacity (service_id, slot, capacity, reserved)
         VALUES ($1, $2, 1, 1)
         ON CONFLICT (service_id, slot) DO UPDATE SET reserved = 1`,
        [limitedService.id, slot],
      );

      const order = await createOrderFixture(daysOffset, true);

      // Hold call: property succeeds, limitedService fails -> compensation triggers
      const holdRes = await request(app)
        .post(`/api/v1/orders/${order.id}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);
      assert.equal(holdRes.status, 409);
      assert.equal(holdRes.body.error.code, 'RESOURCE_CONFLICT');

      // Saga reached terminal FAILED
      const saga = await sagaRepository.findByOrderId(order.id);
      assert.equal(saga.state, 'FAILED');

      // Order remains PENDING
      const dbOrder = await ordersRepository.findById(order.id);
      assert.equal(dbOrder.status, 'PENDING');

      // No active reservations stay HELD
      const activeReservations = await pool.query(
        `SELECT r.* FROM reservations r
         JOIN order_items oi ON oi.id = r.order_item_id
         WHERE oi.order_id = $1 AND r.status = 'HELD'`,
        [order.id],
      );
      assert.equal(activeReservations.rows.length, 0);

      // Now free the slot and retry hold: customer can retry successfully!
      await pool.query(
        'UPDATE service_capacity SET reserved = 0 WHERE service_id = $1 AND slot = $2',
        [limitedService.id, slot],
      );

      const retryHoldRes = await request(app)
        .post(`/api/v1/orders/${order.id}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);
      assert.equal(retryHoldRes.status, 200);

      const retriedSaga = await sagaRepository.findByOrderId(order.id);
      assert.equal(retriedSaga.state, 'AWAITING_PAYMENT');
      const retriedOrder = await ordersRepository.findById(order.id);
      assert.equal(retriedOrder.status, 'HELD');
    });

    it('simulated crash after property hold before services: recoverSagas() leaves NO orphan HELD reservation and saga reaches terminal state', async () => {
      const order = await createOrderFixture(30);

      // Inject failure right after property hold
      setFailureHook('after_property_hold', () => {
        const err = new Error('Simulated process crash immediately after property hold');
        err.isSimulatedCrash = true;
        throw err;
      });

      // Attempt hold -> throws simulated crash
      await assert.rejects(
        () => sagaOrchestrator.executeHold(order.id, customerUser),
        /Simulated process crash/,
      );

      // Set updated_at to 2 minutes ago to simulate stale interrupted saga
      await pool.query(
        "UPDATE saga_instances SET updated_at = now() - INTERVAL '2 minutes' WHERE order_id = $1",
        [order.id],
      );

      // Run recovery
      const rec = await sagaOrchestrator.recoverSagas({ olderThanSeconds: 30 });
      assert.ok(rec.some((r) => r.action === 'holding_phase_compensated'));

      // Check saga state: FAILED
      const saga = await sagaRepository.findByOrderId(order.id);
      assert.equal(saga.state, 'FAILED');

      // Check reservations: NO orphan HELD reservations
      const orphanHolds = await pool.query(
        `SELECT r.* FROM reservations r
         JOIN order_items oi ON oi.id = r.order_item_id
         WHERE oi.order_id = $1 AND r.status = 'HELD'`,
        [order.id],
      );
      assert.equal(orphanHolds.rows.length, 0);

      // Order returned to PENDING
      const dbOrder = await ordersRepository.findById(order.id);
      assert.equal(dbOrder.status, 'PENDING');
    });

    it('simulated crash after payment success before confirm: webhook rolled back, recovery reconciles via provider and confirms', async () => {
      const order = await createOrderFixture(40);
      await sagaOrchestrator.executeHold(order.id, customerUser);

      const idempotencyKey = crypto.randomUUID();
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ order_id: order.id });
      createdPaymentIds.push(payRes.body.id);

      // Register the charge at provider as SUCCESS
      fakeProvider.chargesByRef.set(payRes.body.provider_reference, {
        reference: payRes.body.provider_reference,
        amount_minor: payRes.body.amount_minor,
        currency: payRes.body.currency,
        status: 'SUCCESS',
      });

      // Force crash inside the webhook transaction right during confirmation
      const origConfirm = reservationsService.confirmOrderReservations;
      reservationsService.confirmOrderReservations = async () => {
        throw new Error('Forced crash inside webhook confirmation transaction');
      };

      const webhookPayload = {
        event_id: `evt_crash_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };
      const signed = fakeProvider.signWebhookPayload(webhookPayload);

      try {
        const failedWh = await request(app)
          .post('/api/v1/payments/webhook')
          .set('X-Signature', signed.signatureHeader)
          .set('Content-Type', 'application/json')
          .send(signed.rawBody);
        assert.equal(failedWh.status, 500);
      } finally {
        reservationsService.confirmOrderReservations = origConfirm;
      }

      // Assert that webhook transaction completely rolled back:
      // payment_transactions has no record, saga still in PAYING (or unchanged)
      const txRows = await pool.query(
        'SELECT * FROM payment_transactions WHERE provider_event_id = $1',
        [webhookPayload.event_id],
      );
      assert.equal(txRows.rows.length, 0, 'Webhook transaction rolled back cleanly');

      // Set updated_at older than threshold
      await pool.query(
        "UPDATE saga_instances SET updated_at = now() - INTERVAL '2 minutes' WHERE order_id = $1",
        [order.id],
      );

      // Run recovery: recovery calls reconcilePayment() via provider and completes confirmation!
      const rec = await sagaOrchestrator.recoverSagas({ olderThanSeconds: 30 });
      assert.ok(rec.some((r) => r.action === 'paying_reconciled'));

      // Verified: saga COMPLETED, order CONFIRMED, payment SUCCESS
      const saga = await sagaRepository.findByOrderId(order.id);
      assert.equal(saga.state, 'COMPLETED');
      const dbOrder = await ordersRepository.findById(order.id);
      assert.equal(dbOrder.status, 'CONFIRMED');
      const dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'SUCCESS');
    });

    it('compensation run twice has the exact same result as once (idempotent)', async () => {
      const order = await createOrderFixture(50);
      await sagaOrchestrator.executeHold(order.id, customerUser);

      // Fetch reservations
      const reservations = await reservationsService.getReservationsByOrderId(order.id);
      assert.ok(reservations.length > 0);

      // Release once
      const rel1 = await reservationsService.releaseOrderReservations(order.id);
      assert.equal(rel1.length, reservations.length);

      // Release twice
      const rel2 = await reservationsService.releaseOrderReservations(order.id);
      // Double release is a safe no-op (no duplicate capacity restoration)
      assert.equal(rel2.length, 0);

      // All remain CANCELLED
      const after = await reservationsService.getReservationsByOrderId(order.id);
      for (const r of after) {
        assert.equal(r.status, 'CANCELLED');
      }
    });

    it('two parallel recoverSagas() calls process each saga once without conflict', async () => {
      // Create 2 stale holding sagas
      const order1 = await createOrderFixture(60);
      const order2 = await createOrderFixture(65);

      await sagaRepository.insertSaga({ orderId: order1.id, state: 'HOLDING_PROPERTY', step: 1 });
      await sagaRepository.insertSaga({ orderId: order2.id, state: 'HOLDING_PROPERTY', step: 1 });

      await pool.query(
        "UPDATE saga_instances SET updated_at = now() - INTERVAL '2 minutes' WHERE order_id IN ($1, $2)",
        [order1.id, order2.id],
      );

      // Run 2 parallel recovery passes (SKIP LOCKED avoids collision)
      const [r1, r2] = await Promise.all([
        sagaOrchestrator.recoverSagas({ olderThanSeconds: 30 }),
        sagaOrchestrator.recoverSagas({ olderThanSeconds: 30 }),
      ]);

      const targetOrders = new Set([order1.id, order2.id]);
      const actions1 = r1.filter(
        (r) => r.action === 'holding_phase_compensated' && targetOrders.has(r.orderId),
      );
      const actions2 = r2.filter(
        (r) => r.action === 'holding_phase_compensated' && targetOrders.has(r.orderId),
      );

      // The 2 sagas are partitioned and recovered exactly once overall
      assert.equal(actions1.length + actions2.length, 2);

      const s1 = await sagaRepository.findByOrderId(order1.id);
      const s2 = await sagaRepository.findByOrderId(order2.id);
      assert.equal(s1.state, 'FAILED');
      assert.equal(s2.state, 'FAILED');
    });

    it('an AWAITING_PAYMENT saga within its hold is NOT touched by recovery', async () => {
      const order = await createOrderFixture(70);
      await sagaOrchestrator.executeHold(order.id, customerUser);

      // Hold is valid for 10 minutes; set updated_at to 2 minutes ago
      await pool.query(
        "UPDATE saga_instances SET updated_at = now() - INTERVAL '2 minutes' WHERE order_id = $1",
        [order.id],
      );

      const rec = await sagaOrchestrator.recoverSagas({ olderThanSeconds: 30 });
      assert.ok(rec.some((r) => r.action === 'ignored_active_hold'));

      const saga = await sagaRepository.findByOrderId(order.id);
      assert.equal(saga.state, 'AWAITING_PAYMENT');
      const dbOrder = await ordersRepository.findById(order.id);
      assert.equal(dbOrder.status, 'HELD');
    });

    it('after hold expires, recovery fails the AWAITING_PAYMENT saga and returns order to PENDING', async () => {
      const order = await createOrderFixture(75);
      await sagaOrchestrator.executeHold(order.id, customerUser);

      // Expire hold
      await pool.query(
        "UPDATE orders SET hold_expires_at = now() - INTERVAL '10 seconds' WHERE id = $1",
        [order.id],
      );
      await pool.query(
        "UPDATE saga_instances SET updated_at = now() - INTERVAL '2 minutes' WHERE order_id = $1",
        [order.id],
      );

      const rec = await sagaOrchestrator.recoverSagas({ olderThanSeconds: 30 });
      assert.ok(rec.some((r) => r.action === 'expired_awaiting_payment_recovered'));

      const saga = await sagaRepository.findByOrderId(order.id);
      assert.equal(saga.state, 'FAILED');
      const dbOrder = await ordersRepository.findById(order.id);
      assert.equal(dbOrder.status, 'PENDING');
    });

    it('two parallel hold() calls for the same order item return the same reservation (idempotency)', async () => {
      const order = await createOrderFixture(80);
      const items = await ordersRepository.findItemsByOrderId(order.id);
      const propertyItem = items.find((i) => i.resource_type === 'PROPERTY');

      const payload = {
        order_item_id: propertyItem.id,
        resource_type: propertyItem.resource_type,
        resource_id: propertyItem.resource_id,
        quantity: propertyItem.quantity,
      };

      const [res1, res2] = await Promise.all([
        reservationsService.hold(payload, order.during),
        reservationsService.hold(payload, order.during),
      ]);

      assert.equal(res1.id, res2.id, 'Both parallel holds on same order item must return identical reservation');
    });

    it('a saga whose order FAILED is never reset', async () => {
      const order = await createOrderFixture(85);
      await sagaOrchestrator.executeHold(order.id, customerUser);

      // Force order to FAILED
      await ordersRepository.updateStatusGuarded(order.id, ['HELD'], 'FAILED');
      await sagaRepository.updateStateByOrderId(order.id, { state: 'FAILED', step: 0 });

      // Attempting to hold a FAILED order must reject with 409 and not reset saga
      await assert.rejects(
        () => sagaOrchestrator.executeHold(order.id, customerUser),
        (err) => {
          assert.equal(err.code, 'ORDER_NOT_HOLDABLE');
          return true;
        },
      );
    });
  });

  describe('Outbox Publisher & Single-Runner Scheduler Guard', () => {
    it('outbox: rows published in order and marked; simulated crash between publish and mark causes redelivery with same eventId', async () => {
      const aggregateId = crypto.randomUUID();

      // Insert 2 outbox events
      const evt1 = await pool.query(
        "INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'event.one', '{\"seq\":1}') RETURNING id",
        [aggregateId],
      );
      const evt2 = await pool.query(
        "INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'event.two', '{\"seq\":2}') RETURNING id",
        [aggregateId],
      );

      // Simulate crash right after publishing evt1 before marking published_at
      let crashedOnce = false;
      setOutboxFailureHook((envelope) => {
        if (!crashedOnce && envelope.eventId === evt1.rows[0].id) {
          crashedOnce = true;
          throw new Error('Simulated crash between outbox publish and DB mark');
        }
      });

      // First publish run crashes
      await assert.rejects(
        () => publishOutbox({ batchSize: 10 }),
        /Simulated crash between outbox publish and DB mark/,
      );

      // Reset failure hook
      clearOutboxFailureHook();

      // Second publish run
      const publishedEnvelopes = await publishOutbox({ batchSize: 10 });
      assert.ok(publishedEnvelopes.length >= 2);

      // Assert eventId is identical for the republished event
      const republished = publishedEnvelopes.find((e) => e.eventId === evt1.rows[0].id);
      assert.ok(republished, 'Event must be published with the same eventId (at-least-once)');
      assert.equal(republished.eventType, 'event.one');

      // Both events are now marked published_at
      const check = await pool.query(
        'SELECT * FROM outbox WHERE id IN ($1, $2)',
        [evt1.rows[0].id, evt2.rows[0].id],
      );
      for (const row of check.rows) {
        assert.ok(row.published_at);
      }
    });

    it('two parallel outbox publishers never publish the same row concurrently', async () => {
      const aggId = crypto.randomUUID();
      for (let i = 0; i < 5; i++) {
        await pool.query(
          "INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'event.parallel', jsonb_build_object('i', $2::int))",
          [aggId, i],
        );
      }

      const pub1 = new InMemoryPublisher();
      const pub2 = new InMemoryPublisher();

      // Run parallel publishers
      const [res1, res2] = await Promise.all([
        publishOutbox({ batchSize: 5, publisher: pub1 }),
        publishOutbox({ batchSize: 5, publisher: pub2 }),
      ]);

      const ids1 = new Set(res1.map((e) => e.eventId));
      const ids2 = new Set(res2.map((e) => e.eventId));

      // Intersection must be empty (FOR UPDATE SKIP LOCKED guarantees disjoint sets)
      for (const id of ids1) {
        assert.ok(!ids2.has(id), 'Parallel publishers must not process the same outbox row');
      }
    });

    it('single-runner guard: two concurrent scheduler ticks run exactly once', async () => {
      let executionCount = 0;

      const [tick1, tick2] = await Promise.all([
        runSchedulerTick(ADVISORY_LOCK_OUTBOX, 'test_task', async () => {
          executionCount++;
          await new Promise((r) => setTimeout(r, 100)); // hold lock briefly
          return 'done1';
        }),
        runSchedulerTick(ADVISORY_LOCK_OUTBOX, 'test_task', async () => {
          executionCount++;
          return 'done2';
        }),
      ]);

      const executions = [tick1, tick2].filter((t) => !t.skipped);
      const skipped = [tick1, tick2].filter((t) => t.skipped);

      assert.equal(executions.length, 1, 'Exactly one worker tick must acquire advisory lock');
      assert.equal(skipped.length, 1, 'Contending worker tick must be skipped');
      assert.equal(executionCount, 1);
    });
  });
});
