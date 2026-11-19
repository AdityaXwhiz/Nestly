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
const { paymentsService } = await import('../src/modules/payments/service.js');
const { reservationsService } = await import('../src/modules/reservations/service.js');
const { paymentProvider } = await import('../src/infrastructure/payment/index.js');
const { FakePaymentProvider } = await import('../src/infrastructure/payment/fakeProvider.js');
const { env } = await import('../src/config/env.js');

describe('Payments, Idempotency and Webhooks Test Suite', () => {
  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdProviderIds = [];
  const createdServiceIds = [];
  const createdOrderIds = [];
  const createdPaymentIds = [];

  const fakeProvider = new FakePaymentProvider();

  beforeEach(() => {
    fakeProvider.reset();
    paymentProvider.setProvider(fakeProvider);
  });

  const uniqueEmail = () => `pay_${crypto.randomUUID().slice(0, 8)}@example.com`;

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
      userId,
      token: login.body.accessToken,
    };
  }

  let customerUser;
  let otherCustomerUser;
  let hostUser;
  let providerUser;
  let adminUser;

  let testProperty;
  let testService;

  before(async () => {
    customerUser = await createAuthenticatedUser('CUSTOMER');
    otherCustomerUser = await createAuthenticatedUser('CUSTOMER');
    hostUser = await createAuthenticatedUser('HOST');
    providerUser = await createAuthenticatedUser('PROVIDER');
    adminUser = await createAuthenticatedUser('ADMIN');

    // Create property: 500,000 minor INR per day
    const propRes = await request(app)
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${hostUser.token}`)
      .send({
        title: 'Seaside Villa',
        description: 'Luxury beachfront villa for private gatherings',
        location: 'Goa',
        capacity: 40,
        pricing_minor: 500000,
        currency: 'INR',
      });
    testProperty = propRes.body.property;
    createdPropertyIds.push(testProperty.id);

    // Create provider profile & service: 150,000 minor INR
    const provRes = await request(app)
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        business_name: 'Coastal Sounds and Lights',
        bio: 'Professional event production',
      });
    createdProviderIds.push(provRes.body.id);

    const svcRes = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        name: 'Acoustic Sound Stage',
        description: 'Complete audio equipment set with technician',
        category: 'music',
        price_minor: 150000,
        currency: 'INR',
        kind: 'exclusive',
      });
    testService = svcRes.body.service;
    createdServiceIds.push(testService.id);
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

  /**
   * Helper to create and hold an order for testing payments.
   */
  async function createHeldOrder(user = customerUser, daysOffset = 30) {
    const start = new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + (daysOffset + 2) * 24 * 60 * 60 * 1000).toISOString();

    const orderRes = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        property_id: testProperty.id,
        during: { start, end },
        guest_count: 20,
        services: [{ service_id: testService.id, quantity: 1 }],
      });
    assert.equal(orderRes.status, 201);
    const orderId = orderRes.body.id;
    createdOrderIds.push(orderId);

    const holdRes = await request(app)
      .post(`/api/v1/orders/${orderId}/hold`)
      .set('Authorization', `Bearer ${user.token}`);
    assert.equal(holdRes.status, 200);

    return { orderId, totalAmountMinor: orderRes.body.total_amount_minor };
  }

  describe('Payment Creation & Idempotency (LLD Section 7)', () => {
    it('creates a payment; replaying same key and same body returns 200 with stored payment and only 1 charge is created', async () => {
      const { orderId } = await createHeldOrder(customerUser, 10);
      const idempotencyKey = crypto.randomUUID();

      // First call -> 202 Accepted
      const res1 = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ order_id: orderId });

      assert.equal(res1.status, 202);
      assert.ok(res1.body.id);
      assert.equal(res1.body.order_id, orderId);
      assert.equal(res1.body.status, 'PROCESSING');
      createdPaymentIds.push(res1.body.id);

      assert.equal(fakeProvider.charges.size, 1);

      // Replay identical request -> 200 OK with cached payment record
      const res2 = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ order_id: orderId });

      assert.equal(res2.status, 200);
      assert.equal(res2.body.id, res1.body.id);
      assert.equal(res2.body.status, 'PROCESSING');

      // Crucial: no second charge in provider
      assert.equal(fakeProvider.charges.size, 1);
    });

    it('rejects same idempotency key with different body with 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const { orderId: order1 } = await createHeldOrder(customerUser, 15);
      const { orderId: order2 } = await createHeldOrder(customerUser, 20);
      const idempotencyKey = crypto.randomUUID();

      const res1 = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ order_id: order1 });
      assert.equal(res1.status, 202);
      createdPaymentIds.push(res1.body.id);

      // Same key, different body
      const res2 = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ order_id: order2 });

      assert.equal(res2.status, 422);
      assert.equal(res2.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    });

    it('10 parallel requests with the same key: exactly one payment and one provider charge created', async () => {
      const { orderId } = await createHeldOrder(customerUser, 25);
      const idempotencyKey = crypto.randomUUID();

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          request(app)
            .post('/api/v1/payments')
            .set('Authorization', `Bearer ${customerUser.token}`)
            .set('Idempotency-Key', idempotencyKey)
            .send({ order_id: orderId }),
        ),
      );

      const responses = results.map((r) => r.value);
      const acceptedOrOk = responses.filter((r) => r && (r.status === 202 || r.status === 200));
      const inProgress = responses.filter((r) => r && r.status === 409);

      // All calls resolve cleanly either with 200/202 or 409 REQUEST_IN_PROGRESS
      assert.ok(acceptedOrOk.length >= 1);
      assert.equal(acceptedOrOk.length + inProgress.length, 10);

      // Verify DB: exactly 1 payment record for this order
      const dbPayments = await paymentsRepository.findByOrderId(orderId);
      assert.equal(dbPayments.length, 1);
      createdPaymentIds.push(dbPayments[0].id);

      // Verify provider: exactly 1 charge created
      assert.equal(fakeProvider.charges.size, 1);
    });

    it('rejects a second payment on the same order with different idempotency key (partial unique index)', async () => {
      const { orderId } = await createHeldOrder(customerUser, 30);

      const key1 = crypto.randomUUID();
      const res1 = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', key1)
        .send({ order_id: orderId });
      assert.equal(res1.status, 202);
      createdPaymentIds.push(res1.body.id);

      const key2 = crypto.randomUUID();
      const res2 = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', key2)
        .send({ order_id: orderId });

      assert.equal(res2.status, 409);
      assert.equal(res2.body.error.code, 'ACTIVE_PAYMENT_EXISTS');
    });

    it('validates edge cases: missing header 400, non-HELD 409, expired hold 410, other customer 403', async () => {
      const { orderId } = await createHeldOrder(customerUser, 35);

      // 1. Missing Idempotency-Key header -> 400
      const resMissing = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({ order_id: orderId });
      assert.equal(resMissing.status, 400);

      // 2. Someone else's order -> 403
      const resOther = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${otherCustomerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      assert.equal(resOther.status, 403);

      // 3. Non-HELD order (create fresh PENDING order without hold) -> 409
      const pendingRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during: {
            start: '2027-08-01T10:00:00.000Z',
            end: '2027-08-03T10:00:00.000Z',
          },
          guest_count: 10,
        });
      createdOrderIds.push(pendingRes.body.id);

      const resNotHeld = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: pendingRes.body.id });
      assert.equal(resNotHeld.status, 409);
      assert.equal(resNotHeld.body.error.code, 'ORDER_NOT_HOLDABLE');

      // 4. Expired hold -> 410
      await pool.query(
        "UPDATE orders SET hold_expires_at = now() - INTERVAL '10 seconds' WHERE id = $1",
        [orderId],
      );
      const resExpired = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      assert.equal(resExpired.status, 410);
      assert.equal(resExpired.body.error.code, 'HOLD_EXPIRED');
    });

    it('rejects payment creation if hold has less than 60 seconds left', async () => {
      const { orderId } = await createHeldOrder(customerUser, 40);

      // Set hold_expires_at to 40 seconds in the future
      await pool.query(
        "UPDATE orders SET hold_expires_at = now() + INTERVAL '40 seconds' WHERE id = $1",
        [orderId],
      );

      const res = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });

      assert.equal(res.status, 410);
      assert.equal(res.body.error.code, 'HOLD_EXPIRING_SOON');
    });
  });

  describe('Webhook Ingestion & Transactional Side Effects', () => {
    it('rejects webhook with bad signature with 401 INVALID_SIGNATURE', async () => {
      const { orderId } = await createHeldOrder(customerUser, 45);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      const payload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Timestamp', String(Math.floor(Date.now() / 1000)))
        .set('X-Signature', 'bad_signature_hex')
        .send(payload);

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_SIGNATURE');

      // Payment remains PROCESSING
      const dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'PROCESSING');
    });

    it('rejects webhook with stale timestamp (> 5 minutes old)', async () => {
      const { orderId } = await createHeldOrder(customerUser, 50);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      const payload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };

      // Timestamp from 10 minutes ago
      const staleTimestamp = Math.floor(Date.now() / 1000) - 600;
      const { signatureHeader, rawBody } = fakeProvider.signWebhookPayload(payload, {
        timestamp: staleTimestamp,
      });

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'STALE_TIMESTAMP');
    });

    it('ignores webhook with amount or currency mismatch and logs warning', async () => {
      const { orderId } = await createHeldOrder(customerUser, 55);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      const payload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: 99999999, // Mismatched amount
          currency: 'INR',
        },
      };

      const { signatureHeader, rawBody } = fakeProvider.signWebhookPayload(payload);

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ignored');
      assert.equal(res.body.reason, 'AMOUNT_OR_CURRENCY_MISMATCH');

      // Payment remains in PROCESSING
      const dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'PROCESSING');
    });

    it('webhook SUCCESS: transitions payment to SUCCESS, confirms reservations, sets order to CONFIRMED', async () => {
      const { orderId } = await createHeldOrder(customerUser, 60);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      const payload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };

      const { signatureHeader, rawBody } = fakeProvider.signWebhookPayload(payload);

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      assert.equal(res.status, 200);

      // Verify payment SUCCESS
      const dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'SUCCESS');

      // Verify order CONFIRMED
      const dbOrder = await ordersRepository.findById(orderId);
      assert.equal(dbOrder.status, 'CONFIRMED');

      // Verify all reservations CONFIRMED
      const reservations = await reservationsService.getReservationsByOrderId(orderId);
      assert.ok(reservations.length > 0);
      for (const r of reservations) {
        assert.equal(r.status, 'CONFIRMED');
      }

      // Verify outbox rows written
      const outboxRows = await pool.query(
        "SELECT * FROM outbox WHERE event_type IN ('payment.succeeded', 'order.confirmed')",
      );
      assert.ok(outboxRows.rows.length >= 2);
    });

    it('webhook event delivered twice: exactly one transition and confirmation; returns 200 both times', async () => {
      const { orderId } = await createHeldOrder(customerUser, 65);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      const eventId = `evt_${crypto.randomUUID()}`;
      const payload = {
        event_id: eventId,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };

      const { signatureHeader, rawBody } = fakeProvider.signWebhookPayload(payload);

      // First delivery -> 200
      const res1 = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);
      assert.equal(res1.status, 200);

      // Second delivery (same event_id) -> 200 duplicate handled
      const res2 = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);
      assert.equal(res2.status, 200);

      // Transaction log has exactly 1 entry for this event
      const txRows = await pool.query(
        'SELECT * FROM payment_transactions WHERE provider_event_id = $1',
        [eventId],
      );
      assert.equal(txRows.rows.length, 1);
    });

    it('webhook FAILED: transitions payment to FAILED, releases reservations, sets order to FAILED', async () => {
      const { orderId } = await createHeldOrder(customerUser, 70);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      const payload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.failed',
        data: {
          reference: payRes.body.provider_reference,
          status: 'FAILED',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };

      const { signatureHeader, rawBody } = fakeProvider.signWebhookPayload(payload);

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);
      assert.equal(res.status, 200);

      const dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'FAILED');

      const dbOrder = await ordersRepository.findById(orderId);
      assert.equal(dbOrder.status, 'FAILED');

      const reservations = await reservationsService.getReservationsByOrderId(orderId);
      for (const r of reservations) {
        assert.equal(r.status, 'CANCELLED');
      }
    });

    it('a late FAILED event after SUCCESS is ignored (guarded transition)', async () => {
      const { orderId } = await createHeldOrder(customerUser, 75);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      // 1. Success event arrives
      const successPayload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };
      const sigSuccess = fakeProvider.signWebhookPayload(successPayload);
      await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', sigSuccess.signatureHeader)
        .set('Content-Type', 'application/json')
        .send(sigSuccess.rawBody);

      let dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'SUCCESS');

      // 2. Late fail event arrives for same payment
      const failPayload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.failed',
        data: {
          reference: payRes.body.provider_reference,
          status: 'FAILED',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };
      const sigFail = fakeProvider.signWebhookPayload(failPayload);
      const resFail = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', sigFail.signatureHeader)
        .set('Content-Type', 'application/json')
        .send(sigFail.rawBody);
      assert.equal(resFail.status, 200);

      // Status remains SUCCESS (guarded update ignored)
      dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'SUCCESS');
    });

    it('atomic rollback on unexpected exception inside webhook: nothing recorded and redelivery succeeds', async () => {
      const { orderId } = await createHeldOrder(customerUser, 80);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      const eventId = `evt_rollback_${crypto.randomUUID()}`;
      const payload = {
        event_id: eventId,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };

      const { signatureHeader, rawBody } = fakeProvider.signWebhookPayload(payload);

      // Force an unexpected DB error on reservations confirm during the first attempt
      const origConfirm = reservationsService.confirmOrderReservations;
      reservationsService.confirmOrderReservations = async () => {
        throw new Error('Forced transient database failure in test');
      };

      try {
        const failedAttempt = await request(app)
          .post('/api/v1/payments/webhook')
          .set('X-Signature', signatureHeader)
          .set('Content-Type', 'application/json')
          .send(rawBody);
        assert.equal(failedAttempt.status, 500);

        // Transaction rolled back: payment_transactions MUST NOT contain eventId
        const txCheck = await pool.query(
          'SELECT * FROM payment_transactions WHERE provider_event_id = $1',
          [eventId],
        );
        assert.equal(txCheck.rows.length, 0);

        // Payment remains PROCESSING
        const dbPayment = await paymentsRepository.findById(payRes.body.id);
        assert.equal(dbPayment.status, 'PROCESSING');
      } finally {
        reservationsService.confirmOrderReservations = origConfirm;
      }

      // Redelivery succeeds now that error is cleared
      const successAttempt = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);
      assert.equal(successAttempt.status, 200);

      const dbPaymentAfter = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPaymentAfter.status, 'SUCCESS');
    });

    it('success arrives after hold expired and slot was rebooked: confirm fails, remaining holds released, refund issued, payment REFUNDED, order FAILED', async () => {
      const { orderId } = await createHeldOrder(customerUser, 85);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      // Simulate hold expiring and reservations becoming EXPIRED before payment capture webhook arrives
      await pool.query(
        "UPDATE reservations SET status = 'EXPIRED', hold_expires_at = now() - INTERVAL '1 hour' WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)",
        [orderId],
      );

      const payload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };

      const { signatureHeader, rawBody } = fakeProvider.signWebhookPayload(payload);

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      assert.equal(res.status, 200);

      // Order should be marked FAILED
      const dbOrder = await ordersRepository.findById(orderId);
      assert.equal(dbOrder.status, 'FAILED');

      // Payment was refunded (BR-05: money never stays captured for lost booking)
      const dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'REFUNDED');

      // Provider should record the refund
      assert.equal(fakeProvider.refunds.size, 1);
    });

    it('retryPendingRefunds: retries and completes refund after initial provider refund error', async () => {
      const { orderId } = await createHeldOrder(customerUser, 90);
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: orderId });
      createdPaymentIds.push(payRes.body.id);

      // Make hold expired
      await pool.query(
        "UPDATE reservations SET status = 'EXPIRED', hold_expires_at = now() - INTERVAL '1 hour' WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = $1)",
        [orderId],
      );

      // Simulate provider refund gateway temporary outage
      fakeProvider.shouldThrowOnRefund = true;

      const payload = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };
      const { signatureHeader, rawBody } = fakeProvider.signWebhookPayload(payload);

      await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signatureHeader)
        .set('Content-Type', 'application/json')
        .send(rawBody);

      // Because refund threw, order is FAILED and payment is SUCCESS (needs refund retry)
      let dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'SUCCESS');
      const dbOrder = await ordersRepository.findById(orderId);
      assert.equal(dbOrder.status, 'FAILED');

      // Provider outage resolves
      fakeProvider.shouldThrowOnRefund = false;

      // Run background retryPendingRefunds
      const retryResults = await paymentsService.retryPendingRefunds();
      assert.ok(retryResults.length >= 1);
      const thisRetry = retryResults.find((r) => r.paymentId === payRes.body.id);
      assert.equal(thisRetry.status, 'refunded');

      // Payment moves to REFUNDED
      dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'REFUNDED');
    });
  });

  describe('Reconciliation & Recovery', () => {
    it('provider timeout: payment stays PROCESSING with 202, reconcilePayment later resolves it cleanly', async () => {
      const { orderId } = await createHeldOrder(customerUser, 95);

      // Request payment with scenario 'timeout'
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          order_id: orderId,
          metadata: { scenario: 'timeout' },
        });

      assert.equal(payRes.status, 202);
      createdPaymentIds.push(payRes.body.id);

      const dbPayment = await paymentsRepository.findById(payRes.body.id);
      assert.equal(dbPayment.status, 'PROCESSING');

      // Register the charge at the provider as SUCCESS
      fakeProvider.chargesByRef.set(dbPayment.provider_reference, {
        reference: dbPayment.provider_reference,
        amount_minor: dbPayment.amount_minor,
        currency: dbPayment.currency,
        status: 'SUCCESS',
      });

      // Reconcile payment
      const recRes = await paymentsService.reconcilePayment(dbPayment.id);
      assert.equal(recRes.status, 'processed');

      // Payment and order now confirmed!
      const resolvedPayment = await paymentsRepository.findById(dbPayment.id);
      assert.equal(resolvedPayment.status, 'SUCCESS');
      const resolvedOrder = await ordersRepository.findById(orderId);
      assert.equal(resolvedOrder.status, 'CONFIRMED');
    });

    it('resumePendingPayments: re-calls createCharge for stuck CREATED/PENDING payments', async () => {
      const { orderId } = await createHeldOrder(customerUser, 100);

      // Create a payment record stuck in CREATED
      const stuckPayment = await paymentsRepository.createPayment({
        orderId,
        amountMinor: 500000,
        currency: 'INR',
        status: 'CREATED',
      });
      createdPaymentIds.push(stuckPayment.id);

      // Set created_at to 1 minute ago
      await pool.query(
        "UPDATE payments SET created_at = now() - INTERVAL '1 minute' WHERE id = $1",
        [stuckPayment.id],
      );

      const resumed = await paymentsService.resumePendingPayments(30);
      const thisResumed = resumed.find((r) => r.paymentId === stuckPayment.id);
      assert.equal(thisResumed.status, 'resumed');

      const updated = await paymentsRepository.findById(stuckPayment.id);
      assert.equal(updated.status, 'PROCESSING');
      assert.ok(updated.provider_reference);
    });
  });
});
