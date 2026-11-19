import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/infrastructure/postgres.js');
const { redis } = await import('../src/infrastructure/redis.js');
const { sqsClient, QUEUE_DEFINITIONS } = await import('../src/infrastructure/sqs/client.js');
const { setupQueues, purgeAllQueues } = await import('../src/infrastructure/sqs/setupQueues.js');
const { inspectDlqs, redriveDlqs } = await import('../src/infrastructure/sqs/dlqTool.js');
const {
  SqsPublisher,
  InMemoryPublisher,
  setPublisher,
  publishOutbox,
  resolveTargetQueues,
} = await import('../src/modules/outbox/publisher.js');
const {
  fakeMailer,
  notificationsService,
  setNotificationAfterInsertHook,
  clearNotificationAfterInsertHook,
} = await import('../src/modules/notifications/service.js');
const { providersService } = await import('../src/modules/providers/service.js');
const { reservationsService } = await import('../src/modules/reservations/service.js');
const { paymentsRepository } = await import('../src/modules/payments/repository.js');
const { ordersRepository } = await import('../src/modules/orders/repository.js');
const { FakePaymentProvider } = await import('../src/infrastructure/payment/fakeProvider.js');
const { paymentProvider } = await import('../src/infrastructure/payment/index.js');
const { createConsumer } = await import('../src/workers/consumer.js');
const { createNotificationConsumer } = await import(
  '../src/workers/consumers/notificationConsumer.js'
);
const { createProviderActionConsumer } = await import(
  '../src/workers/consumers/providerActionConsumer.js'
);
const { createAnalyticsConsumer, analyticsCounters } = await import(
  '../src/workers/consumers/analyticsConsumer.js'
);
const {
  runSchedulerTick,
  runHoldSweeperTick,
  runPaymentReconcilerTick,
  runNotificationRetryTick,
  runCleanupTick,
  runDlqMonitorTick,
} = await import('../src/workers/index.js');

// Helper to wait until a predicate returns truthy or timeout expires
async function waitFor(predicateFn, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await predicateFn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

let customerUser;
let hostUser;
let providerUser;
let testProperty;
let testCapacityService;
let testExclusiveService;
let fakePaymentProvider;
let sqsPublisher;

const createdUserIds = [];
const createdOrderIds = [];
const createdPaymentIds = [];

async function registerAndLogin(role, prefix) {
  const email = `${prefix}_${crypto.randomUUID()}@nestly.test`;
  const password = 'Password123!';

  const regRes = await request(app).post('/api/v1/auth/register').send({
    email,
    password,
    role,
  });
  assert.equal(regRes.status, 201);
  createdUserIds.push(regRes.body.user.id);

  const loginRes = await request(app).post('/api/v1/auth/login').send({
    email,
    password,
  });
  assert.equal(loginRes.status, 200);

  return {
    id: regRes.body.user.id,
    userId: regRes.body.user.id,
    role,
    token: loginRes.body.accessToken,
  };
}

async function createCompositeOrder(dayOffset = 60) {
  const start = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);

  const res = await request(app)
    .post('/api/v1/orders')
    .set('Authorization', `Bearer ${customerUser.token}`)
    .send({
      property_id: testProperty.id,
      during: { start: start.toISOString(), end: end.toISOString() },
      guest_count: 10,
      services: [
        {
          service_id: testCapacityService.id,
          quantity: 2,
          slot: start.toISOString().slice(0, 10),
        },
        {
          service_id: testExclusiveService.id,
          quantity: 1,
        },
      ],
    });

  assert.equal(res.status, 201);
  createdOrderIds.push(res.body.id);
  return res.body;
}

describe('Step 10: SQS Queues, Consumers, DLQ and Schedulers Test Suite', () => {
  before(async () => {
    if (redis.status === 'wait') {
      await redis.connect();
    }

    // Configure ElasticMQ queues with short visibility timeout (1s) for fast retry/DLQ tests
    await setupQueues({ maxReceiveCount: 5, visibilityTimeout: 1 });

    fakePaymentProvider = new FakePaymentProvider();
    paymentProvider.setProvider(fakePaymentProvider);

    sqsPublisher = new SqsPublisher();
    setPublisher(sqsPublisher);

    customerUser = await registerAndLogin('CUSTOMER', 'step10_cust');
    hostUser = await registerAndLogin('HOST', 'step10_host');
    providerUser = await registerAndLogin('PROVIDER', 'step10_prov');

    // Create property
    const propRes = await request(app)
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${hostUser.token}`)
      .send({
        title: 'Step 10 Grand Villa',
        description: 'Luxury villa for SQS worker tests',
        location: 'Goa',
        capacity: 50,
        pricing_minor: 100000,
        currency: 'INR',
        amenities: ['Pool', 'WiFi'],
      });
    assert.equal(propRes.status, 201);
    testProperty = propRes.body.property;

    // Create provider profile
    const provRes = await request(app)
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        business_name: 'Step 10 Event Masters',
        bio: 'Catering & photography',
      });
    assert.equal(provRes.status, 201);

    // Create capacity-based service (capacity = 5)
    const capSvcRes = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        name: 'Royal Buffet Catering',
        description: 'Per plate catering',
        category: 'catering',
        kind: 'capacity',
        price_minor: 20000,
        currency: 'INR',
        capacity: 5,
      });
    assert.equal(capSvcRes.status, 201);
    testCapacityService = capSvcRes.body.service;

    // Create exclusive service
    const excSvcRes = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        name: 'Candid Wedding Photography',
        description: 'Full event coverage',
        category: 'photography',
        kind: 'exclusive',
        price_minor: 50000,
        currency: 'INR',
      });
    assert.equal(excSvcRes.status, 201);
    testExclusiveService = excSvcRes.body.service;
  });

  beforeEach(async () => {
    clearNotificationAfterInsertHook();
    fakeMailer.reset();
    analyticsCounters.reset();
    fakePaymentProvider.reset();
    paymentProvider.setProvider(fakePaymentProvider);
    setPublisher(sqsPublisher);

    // Mark any leftover outbox rows published and purge all SQS queues (Change #10)
    await pool.query('UPDATE outbox SET published_at = now() WHERE published_at IS NULL;');
    await purgeAllQueues();
  });

  after(async () => {
    clearNotificationAfterInsertHook();
    setPublisher(new InMemoryPublisher());

    for (const pId of createdPaymentIds) {
      await pool.query('DELETE FROM payments WHERE id = $1;', [pId]);
    }
    for (const oId of createdOrderIds) {
      await pool.query('DELETE FROM orders WHERE id = $1;', [oId]);
    }
    for (const uId of createdUserIds) {
      await pool.query('DELETE FROM users WHERE id = $1;', [uId]);
    }

    sqsClient.destroy();
    await pool.end();
    redis.disconnect();
  });

  describe('Event Routing & End-to-End SQS Pipeline', () => {
    it('routes events according to Change #3 routing rules', () => {
      assert.deepEqual(resolveTargetQueues('order.confirmed'), [
        'notifications',
        'provider-actions',
        'analytics',
      ]);
      assert.deepEqual(resolveTargetQueues('payment.failed'), ['notifications', 'analytics']);
      assert.deepEqual(resolveTargetQueues('payment.refund_required'), [
        'notifications',
        'analytics',
      ]);
      assert.deepEqual(resolveTargetQueues('payment.refunded'), ['notifications', 'analytics']);
      assert.deepEqual(resolveTargetQueues('payment.succeeded'), ['analytics']);
      assert.deepEqual(resolveTargetQueues('reservation.held'), ['analytics']);
      assert.deepEqual(resolveTargetQueues('reservation.confirmed'), ['analytics']);
      assert.deepEqual(resolveTargetQueues('reservation.released'), ['analytics']);
      assert.deepEqual(resolveTargetQueues('reservation.expired'), ['analytics']);
      assert.deepEqual(resolveTargetQueues('property.updated'), ['search-index', 'analytics']);
    });

    it('end-to-end: a confirmed order produces SENT notification rows (customer, host, provider) and provider_actions rows', async () => {
      const order = await createCompositeOrder(70);

      // 1. Hold order
      const holdRes = await request(app)
        .post(`/api/v1/orders/${order.id}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);
      assert.equal(holdRes.status, 200);

      // 2. Pay for order
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: order.id });
      assert.equal(payRes.status, 202);
      createdPaymentIds.push(payRes.body.id);

      // 3. Send payment.succeeded webhook -> confirms order & writes outbox rows
      const webhookPayload = {
        event_id: `evt_e2e_${crypto.randomUUID()}`,
        type: 'payment.succeeded',
        data: {
          reference: payRes.body.provider_reference,
          status: 'SUCCESS',
          amount_minor: payRes.body.amount_minor,
          currency: payRes.body.currency,
        },
      };
      const signed = fakePaymentProvider.signWebhookPayload(webhookPayload);
      const whRes = await request(app)
        .post('/api/v1/payments/webhook')
        .set('X-Signature', signed.signatureHeader)
        .set('Content-Type', 'application/json')
        .send(signed.rawBody);
      assert.equal(whRes.status, 200);

      // 4. Publish outbox events to ElasticMQ
      const published = await publishOutbox({ batchSize: 20, publisher: sqsPublisher });
      const confirmedEvent = published.find((e) => e.eventType === 'order.confirmed');
      assert.ok(confirmedEvent, 'order.confirmed event was published from outbox');

      // 5. Start notification, provider-actions, and analytics consumers
      const notifConsumer = createNotificationConsumer({
        waitTimeSeconds: 0,
        visibilityTimeoutSec: 5,
      });
      const providerConsumer = createProviderActionConsumer({
        waitTimeSeconds: 0,
        visibilityTimeoutSec: 5,
      });
      const analyticsConsumer = createAnalyticsConsumer({
        waitTimeSeconds: 0,
        visibilityTimeoutSec: 5,
      });

      notifConsumer.start();
      providerConsumer.start();
      analyticsConsumer.start();

      try {
        // Wait for notifications (3 distinct users: customer, host, provider) and provider actions (3 items)
        await waitFor(async () => {
          const notifs = await notificationsService.listByEventId(confirmedEvent.eventId);
          const actions = await providersService.listActionsByOrderId(order.id);
          return (
            notifs.length === 3 &&
            notifs.every((n) => n.status === 'SENT') &&
            actions.length === 3 &&
            analyticsCounters.totalProcessed >= published.length
          );
        });

        const notifs = await notificationsService.listByEventId(confirmedEvent.eventId);
        const notifUserIds = new Set(notifs.map((n) => n.user_id));
        assert.ok(notifUserIds.has(customerUser.id), 'Customer notified');
        assert.ok(notifUserIds.has(hostUser.id), 'Property host notified');
        assert.ok(notifUserIds.has(providerUser.id), 'Service provider notified');
        assert.equal(fakeMailer.sentMessages.length, 3, 'FakeMailer sent 3 emails');

        const actions = await providersService.listActionsByOrderId(order.id);
        assert.equal(actions.length, 3, 'One provider_action created per confirmed order item');
      } finally {
        await Promise.all([
          notifConsumer.stop(),
          providerConsumer.stop(),
          analyticsConsumer.stop(),
        ]);
      }
    });

    it('duplicate delivery: the same event delivered twice produces ONE notification set and ONE provider action per item', async () => {
      const order = await createCompositeOrder(75);
      const eventId = crypto.randomUUID();
      const envelope = {
        eventId,
        eventType: 'order.confirmed',
        occurredAt: new Date().toISOString(),
        aggregateId: order.id,
        version: 1,
        payload: { orderId: order.id },
      };

      // Publish the exact same envelope TWICE to SQS
      await sqsPublisher.publish(envelope);
      await sqsPublisher.publish(envelope);

      const notifConsumer = createNotificationConsumer({
        waitTimeSeconds: 0,
        visibilityTimeoutSec: 5,
      });
      const providerConsumer = createProviderActionConsumer({
        waitTimeSeconds: 0,
        visibilityTimeoutSec: 5,
      });

      notifConsumer.start();
      providerConsumer.start();

      try {
        await waitFor(async () => {
          const notifs = await notificationsService.listByEventId(eventId);
          const actions = await providersService.listActionsByOrderId(order.id);
          return notifs.length === 3 && actions.length === 3;
        });

        // Wait briefly to ensure the second copy in the queue is also consumed
        await new Promise((r) => setTimeout(r, 400));

        const notifs = await notificationsService.listByEventId(eventId);
        assert.equal(notifs.length, 3, 'Still exactly 3 notification rows');
        assert.equal(fakeMailer.sentMessages.length, 3, 'FakeMailer sent each email only once');

        const actions = await providersService.listActionsByOrderId(order.id);
        assert.equal(actions.length, 3, 'Still exactly 3 provider_action rows');
      } finally {
        await Promise.all([notifConsumer.stop(), providerConsumer.stop()]);
      }
    });

    it('notification crash after insert, before send: redelivery sends each notification exactly once; pending retry scheduler also recovers stale PENDING rows (Change #1)', async () => {
      const order = await createCompositeOrder(80);
      const eventId = crypto.randomUUID();
      const envelope = {
        eventId,
        eventType: 'order.confirmed',
        occurredAt: new Date().toISOString(),
        aggregateId: order.id,
        version: 1,
        payload: { orderId: order.id },
      };

      // Simulate crash on first delivery right after DB insert, before fakeMailer.send()
      let crashedOnce = false;
      setNotificationAfterInsertHook(() => {
        if (!crashedOnce) {
          crashedOnce = true;
          throw new Error('Simulated crash after notification insert before send');
        }
      });

      await sqsPublisher.publish(envelope);

      const notifConsumer = createNotificationConsumer({
        waitTimeSeconds: 0,
        visibilityTimeoutSec: 1,
      });
      notifConsumer.start();

      try {
        await waitFor(async () => {
          const notifs = await notificationsService.listByEventId(eventId);
          return notifs.length === 3 && notifs.every((n) => n.status === 'SENT');
        });

        assert.equal(crashedOnce, true, 'Crash hook fired on first attempt');
        assert.equal(fakeMailer.sentMessages.length, 3, 'Emails sent once after redelivery');

        // Also test the retryPendingNotifications scheduler directly for a stale PENDING row
        fakeMailer.reset();
        const staleEventId = crypto.randomUUID();
        await pool.query(
          `INSERT INTO notifications (user_id, event_id, event_type, payload, status, created_at)
           VALUES ($1, $2, 'payment.failed', '{}'::jsonb, 'PENDING', now() - INTERVAL '10 minutes');`,
          [customerUser.id, staleEventId],
        );

        const retryTick = await runNotificationRetryTick({ olderThanMinutes: 5 });
        assert.equal(retryTick.skipped, false);
        assert.ok(retryTick.result.sentCount >= 1);
        const recovered = await notificationsService.listByEventId(staleEventId);
        assert.equal(recovered[0].status, 'SENT');
      } finally {
        await notifConsumer.stop();
      }
    });
  });

  describe('Consumer Resilience, Retries, DLQ and Crash Before Delete', () => {
    it('a handler that fails twice then succeeds on attempt 3 is processed once, with attempts [1, 2, 3] visible', async () => {
      const eventId = crypto.randomUUID();
      const attemptsSeen = [];
      let sideEffectCount = 0;

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_DEFINITIONS.analytics.url,
          MessageBody: JSON.stringify({
            eventId,
            eventType: 'test.flaky',
            occurredAt: new Date().toISOString(),
            aggregateId: crypto.randomUUID(),
            version: 1,
            payload: {},
          }),
        }),
      );

      const flakyConsumer = createConsumer({
        name: 'flaky-test-consumer',
        queueUrl: QUEUE_DEFINITIONS.analytics.url,
        useProcessedEvents: true,
        visibilityTimeoutSec: 1,
        waitTimeSeconds: 0,
        handler: async (_env, { attempt }) => {
          attemptsSeen.push(attempt);
          if (attempt < 3) {
            throw new Error(`Transient error on attempt ${attempt}`);
          }
          sideEffectCount += 1;
        },
      });

      flakyConsumer.start();
      try {
        await waitFor(() => sideEffectCount === 1, { timeoutMs: 8000 });
        assert.deepEqual(attemptsSeen, [1, 2, 3]);
        assert.equal(sideEffectCount, 1);
      } finally {
        await flakyConsumer.stop();
      }
    });

    it('a poison message (always throws) lands in the DLQ after 5 receives, dlq:inspect peeks with VisibilityTimeout 0, and dlq:redrive moves it back', async () => {
      await setupQueues({ maxReceiveCount: 5, visibilityTimeout: 1 });

      const poisonEventId = crypto.randomUUID();
      const attempts = [];

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_DEFINITIONS.notifications.url,
          MessageBody: JSON.stringify({
            eventId: poisonEventId,
            eventType: 'order.confirmed',
            occurredAt: new Date().toISOString(),
            aggregateId: crypto.randomUUID(),
            version: 1,
            payload: { poison: true },
          }),
        }),
      );

      const poisonConsumer = createConsumer({
        name: 'poison-consumer',
        queueUrl: QUEUE_DEFINITIONS.notifications.url,
        useProcessedEvents: false,
        visibilityTimeoutSec: 1,
        waitTimeSeconds: 0,
        handler: async (_env, { attempt }) => {
          attempts.push(attempt);
          throw new Error('Unrecoverable poison message failure');
        },
      });

      poisonConsumer.start();

      try {
        // Wait for 5 failed attempts and for the 5th visibility timeout (1s) to expire
        await waitFor(() => attempts.length >= 5, { timeoutMs: 12000 });
        await poisonConsumer.stop();

        // Wait for ElasticMQ to redrive the message on next receive / visibility expiry
        await new Promise((r) => setTimeout(r, 1200));
        // Trigger a receive on main queue so ElasticMQ evaluates expiry and moves to DLQ
        await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: QUEUE_DEFINITIONS.notifications.url,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 0,
          }),
        );

        // 1. Inspect DLQ twice with VisibilityTimeout: 0 (Change #8: never deletes or hides)
        const inspect1 = await inspectDlqs({ queueNames: ['notifications'] });
        assert.equal(inspect1['notifications-dlq'].length, 1);
        assert.equal(inspect1['notifications-dlq'][0].eventId, poisonEventId);

        const inspect2 = await inspectDlqs({ queueNames: ['notifications'] });
        assert.equal(
          inspect2['notifications-dlq'].length,
          1,
          'dlq:inspect with VisibilityTimeout 0 keeps message immediately visible',
        );

        // 2. Check DLQ monitor reports depth > 0
        const monitorReport = await runDlqMonitorTick();
        assert.equal(monitorReport.skipped, false);
        assert.equal(monitorReport.result['notifications-dlq'].depth, 1);

        // 3. Redrive from DLQ back to source queue (Change #8: send first, delete after)
        const redriveSummary = await redriveDlqs({ queueNames: ['notifications'] });
        assert.equal(redriveSummary['notifications-dlq'], 1);

        // DLQ is now empty
        const afterRedriveDlq = await inspectDlqs({ queueNames: ['notifications'] });
        assert.equal(afterRedriveDlq['notifications-dlq'].length, 0);

        // Message is back in the source queue and can be processed once fixed
        let fixedProcessed = false;
        const fixedConsumer = createConsumer({
          name: 'fixed-consumer',
          queueUrl: QUEUE_DEFINITIONS.notifications.url,
          useProcessedEvents: false,
          visibilityTimeoutSec: 2,
          waitTimeSeconds: 0,
          handler: async (envMsg) => {
            if (envMsg.eventId === poisonEventId) {
              fixedProcessed = true;
            }
          },
        });

        fixedConsumer.start();
        await waitFor(() => fixedProcessed, { timeoutMs: 5000 });
        await fixedConsumer.stop();
      } finally {
        await poisonConsumer.stop();
      }
    });

    it('consumer crashes after handler commits but before DeleteMessage: message returns and side effect happens ONCE', async () => {
      const order = await createCompositeOrder(85);
      const eventId = crypto.randomUUID();

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_DEFINITIONS['provider-actions'].url,
          MessageBody: JSON.stringify({
            eventId,
            eventType: 'order.confirmed',
            occurredAt: new Date().toISOString(),
            aggregateId: order.id,
            version: 1,
            payload: { orderId: order.id },
          }),
        }),
      );

      let crashedBeforeDelete = false;
      let attemptsReached = 0;

      const consumer = createProviderActionConsumer({
        visibilityTimeoutSec: 1,
        waitTimeSeconds: 0,
        beforeDeleteHook: (_env, { attempt }) => {
          attemptsReached = attempt;
          if (!crashedBeforeDelete) {
            crashedBeforeDelete = true;
            throw new Error('Simulated process crash after DB commit before SQS DeleteMessage');
          }
        },
      });

      consumer.start();
      try {
        await waitFor(() => attemptsReached >= 2, { timeoutMs: 6000 });

        const actions = await providersService.listActionsByOrderId(order.id);
        assert.equal(actions.length, 3, 'Side effect executed once despite redelivery');
      } finally {
        await consumer.stop();
      }
    });

    it('unknown event types and missing entities are logged and acked, never thrown (Change #6)', async () => {
      const unknownEventId = crypto.randomUUID();
      const missingEntityEventId = crypto.randomUUID();

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_DEFINITIONS.notifications.url,
          MessageBody: JSON.stringify({
            eventId: unknownEventId,
            eventType: 'unknown.weird_event',
            occurredAt: new Date().toISOString(),
            aggregateId: crypto.randomUUID(),
            version: 1,
            payload: {},
          }),
        }),
      );

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: QUEUE_DEFINITIONS.notifications.url,
          MessageBody: JSON.stringify({
            eventId: missingEntityEventId,
            eventType: 'order.confirmed',
            occurredAt: new Date().toISOString(),
            aggregateId: crypto.randomUUID(), // non-existent order
            version: 1,
            payload: {},
          }),
        }),
      );

      const notifConsumer = createNotificationConsumer({
        waitTimeSeconds: 0,
        visibilityTimeoutSec: 1,
      });
      notifConsumer.start();

      try {
        await new Promise((r) => setTimeout(r, 600));
        // Queue should be drained and DLQ should be empty
        const dlqInspect = await inspectDlqs({ queueNames: ['notifications'] });
        assert.equal(dlqInspect['notifications-dlq'].length, 0);
      } finally {
        await notifConsumer.stop();
      }
    });
  });

  describe('Schedulers: Hold Sweeper, Lazy Expiry Race, Reconciler, Single-Runner & Cleanup', () => {
    it('hold sweeper: expired HELD reservations are set to EXPIRED and capacity is returned once; CONFIRMED untouched; running twice has same result', async () => {
      const order1 = await createCompositeOrder(90);
      const order2 = await createCompositeOrder(95);

      const slot = '2027-06-01';
      const during1 = '[2027-06-01T10:00:00Z, 2027-06-02T10:00:00Z)';
      const during2 = '[2027-06-03T10:00:00Z, 2027-06-04T10:00:00Z)';

      const capItem1 = order1.items.find((i) => i.resource_id === testCapacityService.id);
      const capItem2 = order2.items.find((i) => i.resource_id === testCapacityService.id);

      // Hold 2 units on order1 and 2 units on order2 for the same capacity slot (reserved = 4)
      const r1 = await reservationsService.hold(
        {
          order_item_id: capItem1.id,
          resource_type: 'SERVICE',
          resource_id: testCapacityService.id,
          quantity: 2,
          slot,
        },
        during1,
        300,
      );

      const r2 = await reservationsService.hold(
        {
          order_item_id: capItem2.id,
          resource_type: 'SERVICE',
          resource_id: testCapacityService.id,
          quantity: 2,
          slot,
        },
        during2,
        300,
      );

      // Confirm r2, and expire r1's hold_expires_at into the past
      await reservationsService.confirm(r2.id);
      await pool.query(
        "UPDATE reservations SET hold_expires_at = now() - INTERVAL '1 minute' WHERE id = $1;",
        [r1.id],
      );

      // Run hold sweeper once
      const sweep1 = await runHoldSweeperTick({ batchSize: 200 });
      assert.equal(sweep1.skipped, false);
      assert.ok(sweep1.result.some((row) => row.id === r1.id));

      // Verify r1 is EXPIRED, r2 is still CONFIRMED, and reserved capacity dropped from 4 to 2
      const dbR1 = await pool.query('SELECT status FROM reservations WHERE id = $1;', [r1.id]);
      const dbR2 = await pool.query('SELECT status FROM reservations WHERE id = $1;', [r2.id]);
      assert.equal(dbR1.rows[0].status, 'EXPIRED');
      assert.equal(dbR2.rows[0].status, 'CONFIRMED');

      const capAfter1 = await pool.query(
        'SELECT reserved FROM service_capacity WHERE service_id = $1 AND slot = $2;',
        [testCapacityService.id, slot],
      );
      assert.equal(capAfter1.rows[0].reserved, 2);

      // Run hold sweeper a second time -> idempotent, capacity still 2
      const sweep2 = await runHoldSweeperTick({ batchSize: 200 });
      assert.equal(sweep2.result.length, 0);

      const capAfter2 = await pool.query(
        'SELECT reserved FROM service_capacity WHERE service_id = $1 AND slot = $2;',
        [testCapacityService.id, slot],
      );
      assert.equal(capAfter2.rows[0].reserved, 2);
    });

    it('hold sweeper and hold() lazy expiry racing on the same expired row return capacity ONCE (Change #5)', async () => {
      const order1 = await createCompositeOrder(100);
      const order2 = await createCompositeOrder(105);

      const slot = '2027-07-15';
      const during1 = '[2027-07-15T10:00:00Z, 2027-07-16T10:00:00Z)';
      const during2 = '[2027-07-17T10:00:00Z, 2027-07-18T10:00:00Z)';

      const capItem1 = order1.items.find((i) => i.resource_id === testCapacityService.id);
      const capItem2 = order2.items.find((i) => i.resource_id === testCapacityService.id);

      // Hold 3 units on order1
      const r1 = await reservationsService.hold(
        {
          order_item_id: capItem1.id,
          resource_type: 'SERVICE',
          resource_id: testCapacityService.id,
          quantity: 3,
          slot,
        },
        during1,
        300,
      );

      // Backdate r1 so it is expired
      await pool.query(
        "UPDATE reservations SET hold_expires_at = now() - INTERVAL '10 seconds' WHERE id = $1;",
        [r1.id],
      );

      // Race hold sweeper and a new hold() (which runs lazy expiry) in parallel
      const [sweepRes, newHold] = await Promise.all([
        runHoldSweeperTick({ batchSize: 200 }),
        reservationsService.hold(
          {
            order_item_id: capItem2.id,
            resource_type: 'SERVICE',
            resource_id: testCapacityService.id,
            quantity: 2,
            slot,
          },
          during2,
          300,
        ),
      ]);

      assert.equal(sweepRes.skipped, false);
      assert.equal(newHold.status, 'HELD');

      // Initial reserved was 3; r1 (3 units) expired once (-3) and newHold added 2 (+2) => reserved MUST be 2!
      const capRow = await pool.query(
        'SELECT reserved FROM service_capacity WHERE service_id = $1 AND slot = $2;',
        [testCapacityService.id, slot],
      );
      assert.equal(
        capRow.rows[0].reserved,
        2,
        'Capacity from expired hold was returned exactly once despite race between sweeper and lazy expiry',
      );
    });

    it('payment reconciler: resolves a payment stuck in PROCESSING beyond the threshold', async () => {
      const order = await createCompositeOrder(110);

      // Hold order
      const holdRes = await request(app)
        .post(`/api/v1/orders/${order.id}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);
      assert.equal(holdRes.status, 200);

      // Create payment
      const payRes = await request(app)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ order_id: order.id });
      assert.equal(payRes.status, 202);
      createdPaymentIds.push(payRes.body.id);

      // Provider has the charge marked SUCCESS, and payment in DB is PROCESSING older than threshold
      fakePaymentProvider.chargesByRef.set(payRes.body.provider_reference, {
        reference: payRes.body.provider_reference,
        amount_minor: payRes.body.amount_minor,
        currency: payRes.body.currency,
        status: 'SUCCESS',
      });

      await pool.query(
        "UPDATE payments SET updated_at = now() - INTERVAL '2 minutes' WHERE id = $1;",
        [payRes.body.id],
      );

      // Run payment reconciler scheduler tick
      const recTick = await runPaymentReconcilerTick({ olderThanSeconds: 30, batchSize: 10 });
      assert.equal(recTick.skipped, false);
      assert.ok(recTick.result.reconciled.some((r) => r.paymentId === payRes.body.id));

      const dbPayment = await paymentsRepository.findById(payRes.body.id);
      const dbOrder = await ordersRepository.findById(order.id);
      assert.equal(dbPayment.status, 'SUCCESS');
      assert.equal(dbOrder.status, 'CONFIRMED');
    });

    it('two concurrent runs of the same scheduler: only one executes', async () => {
      let executions = 0;
      const LOCK_ID = 9910;

      const [run1, run2] = await Promise.all([
        runSchedulerTick(LOCK_ID, 'test_concurrent_scheduler', async () => {
          executions += 1;
          await new Promise((r) => setTimeout(r, 120));
          return 'executed';
        }),
        runSchedulerTick(LOCK_ID, 'test_concurrent_scheduler', async () => {
          executions += 1;
          await new Promise((r) => setTimeout(r, 120));
          return 'executed';
        }),
      ]);

      assert.equal(executions, 1, 'Exactly one concurrent scheduler run executed');
      const skippedCount = [run1, run2].filter((r) => r.skipped).length;
      assert.equal(skippedCount, 1, 'One run was skipped with LOCK_BUSY');
    });

    it('cleanup scheduler removes only expired idempotency_keys and old published outbox rows', async () => {
      const expiredKey = `exp_key_${crypto.randomUUID()}`;
      const freshKey = `fresh_key_${crypto.randomUUID()}`;

      // Insert 1 expired idempotency key and 1 fresh idempotency key
      await pool.query(
        `INSERT INTO idempotency_keys (user_id, operation, idempotency_key, request_hash, status, expires_at)
         VALUES ($1, 'create_payment', $2, 'hash1', 'COMPLETED', now() - INTERVAL '1 hour'),
                ($1, 'create_payment', $3, 'hash2', 'COMPLETED', now() + INTERVAL '23 hours');`,
        [customerUser.id, expiredKey, freshKey],
      );

      // Insert 1 old published outbox row (10 days old), 1 recent published outbox row, and 1 old unpublished outbox row
      const oldPublishedRes = await pool.query(
        `INSERT INTO outbox (aggregate_id, event_type, payload, created_at, published_at)
         VALUES ($1, 'test.old_published', '{}'::jsonb, now() - INTERVAL '10 days', now() - INTERVAL '10 days')
         RETURNING id;`,
        [crypto.randomUUID()],
      );
      const oldPublishedId = oldPublishedRes.rows[0].id;

      const recentPublishedRes = await pool.query(
        `INSERT INTO outbox (aggregate_id, event_type, payload, created_at, published_at)
         VALUES ($1, 'test.recent_published', '{}'::jsonb, now() - INTERVAL '1 day', now() - INTERVAL '1 day')
         RETURNING id;`,
        [crypto.randomUUID()],
      );
      const recentPublishedId = recentPublishedRes.rows[0].id;

      const oldUnpublishedRes = await pool.query(
        `INSERT INTO outbox (aggregate_id, event_type, payload, created_at, published_at)
         VALUES ($1, 'test.old_unpublished', '{}'::jsonb, now() - INTERVAL '10 days', NULL)
         RETURNING id;`,
        [crypto.randomUUID()],
      );
      const oldUnpublishedId = oldUnpublishedRes.rows[0].id;

      try {
        const cleanupTick = await runCleanupTick({ retentionDays: 7 });
        assert.equal(cleanupTick.skipped, false);
        assert.ok(cleanupTick.result.expiredKeysDeleted >= 1);
        assert.ok(cleanupTick.result.oldOutboxDeleted >= 1);

        // Verify expired key was deleted and fresh key remains
        const expCheck = await pool.query(
          'SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1;',
          [expiredKey],
        );
        const freshCheck = await pool.query(
          'SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1;',
          [freshKey],
        );
        assert.equal(expCheck.rowCount, 0, 'Expired idempotency key deleted');
        assert.equal(freshCheck.rowCount, 1, 'Fresh idempotency key preserved');

        // Verify old published outbox row was deleted, while recent published & old unpublished remain
        const oldPubCheck = await pool.query('SELECT 1 FROM outbox WHERE id = $1;', [
          oldPublishedId,
        ]);
        const recentPubCheck = await pool.query('SELECT 1 FROM outbox WHERE id = $1;', [
          recentPublishedId,
        ]);
        const oldUnpubCheck = await pool.query('SELECT 1 FROM outbox WHERE id = $1;', [
          oldUnpublishedId,
        ]);

        assert.equal(oldPubCheck.rowCount, 0, 'Old published outbox row deleted');
        assert.equal(recentPubCheck.rowCount, 1, 'Recent published outbox row preserved');
        assert.equal(oldUnpubCheck.rowCount, 1, 'Unpublished outbox row never deleted by cleanup');
      } finally {
        await pool.query(
          'DELETE FROM outbox WHERE id = ANY($1::uuid[]);',
          [[oldPublishedId, recentPublishedId, oldUnpublishedId]],
        );
      }
    });
  });
});
