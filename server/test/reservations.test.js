import { describe, it, before, after } from 'node:test';
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
const { reservationsService } = await import('../src/modules/reservations/service.js');
const { reservationsRepository } = await import('../src/modules/reservations/repository.js');

describe('Availability & Reservations Test Suite', () => {
  let customerUser;
  let hostUser;
  let providerUser;
  let testProperty1;
  let testProperty2;
  let capacityService;

  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdProviderIds = [];
  const createdServiceIds = [];
  const createdOrderIds = [];

  const uniqueEmail = () => `res_${crypto.randomUUID().slice(0, 8)}@example.com`;

  // Test helper to generate an order and order_item fixture
  async function createOrderItemFixture(resourceType, resourceId, quantity = 1) {
    const orderRes = await pool.query(
      `INSERT INTO orders (user_id, status, total_amount_minor, currency)
       VALUES ($1, 'DRAFT', 10000, 'INR')
       RETURNING id`,
      [customerUser.id],
    );
    const orderId = orderRes.rows[0].id;
    createdOrderIds.push(orderId);

    const itemRes = await pool.query(
      `INSERT INTO order_items (order_id, resource_type, resource_id, quantity, unit_price_minor, currency)
       VALUES ($1, $2, $3, $4, 10000, 'INR')
       RETURNING id`,
      [orderId, resourceType, resourceId, quantity],
    );
    return itemRes.rows[0].id;
  }

  before(async () => {
    // 1. Create Customer
    const custHash = await bcrypt.hash('Password123!', 10);
    customerUser = await usersRepository.createUser({
      email: uniqueEmail(),
      role: 'CUSTOMER',
      passwordHash: custHash,
    });
    createdUserIds.push(customerUser.id);

    // 2. Create Host
    const hostHash = await bcrypt.hash('Password123!', 10);
    hostUser = await usersRepository.createUser({
      email: uniqueEmail(),
      role: 'HOST',
      passwordHash: hostHash,
    });
    createdUserIds.push(hostUser.id);

    // 3. Create Provider
    const provHash = await bcrypt.hash('Password123!', 10);
    providerUser = await usersRepository.createUser({
      email: uniqueEmail(),
      role: 'PROVIDER',
      passwordHash: provHash,
    });
    createdUserIds.push(providerUser.id);

    // 4. Create Properties
    testProperty1 = await propertiesRepository.createProperty({
      hostId: hostUser.id,
      title: 'Oceanfront Villa',
      description: 'Luxury beachfront villa for weddings',
      location: 'Goa',
      capacity: 100,
      pricingMinor: 2000000,
      currency: 'INR',
      status: 'ACTIVE',
    });
    createdPropertyIds.push(testProperty1.id);

    testProperty2 = await propertiesRepository.createProperty({
      hostId: hostUser.id,
      title: 'Mountain Retreat',
      description: 'Panoramic mountain lodge',
      location: 'Manali',
      capacity: 80,
      pricingMinor: 1500000,
      currency: 'INR',
      status: 'ACTIVE',
    });
    createdPropertyIds.push(testProperty2.id);

    // 5. Create Provider Profile & Capacity Service
    const provider = await providersRepository.createProvider({
      userId: providerUser.id,
      businessName: 'Ace Banquet Caterers',
    });
    createdProviderIds.push(provider.id);

    capacityService = await servicesRepository.createService({
      providerId: provider.id,
      title: 'Buffet Catering Package',
      description: 'Full course wedding buffet',
      category: 'catering',
      kind: 'capacity',
      capacity: 3, // Capacity of 3 events per slot
      priceMinor: 50000,
      currency: 'INR',
      status: 'ACTIVE',
    });
    createdServiceIds.push(capacityService.id);
  });

  after(async () => {
    for (const id of createdOrderIds) {
      await pool.query('DELETE FROM orders WHERE id = $1', [id]);
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

  describe('Exclusive Resource Reservations (Properties)', () => {
    it('allows a hold, and rejects overlapping hold with 409 RESOURCE_CONFLICT', async () => {
      const orderItemId1 = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const orderItemId2 = await createOrderItemFixture('PROPERTY', testProperty1.id);

      const during1 = '[2026-12-01 10:00:00+00, 2026-12-01 18:00:00+00)';
      const during2 = '[2026-12-01 14:00:00+00, 2026-12-01 22:00:00+00)'; // Overlaps!

      const hold1 = await reservationsService.hold(
        { order_item_id: orderItemId1, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        during1,
      );
      assert.ok(hold1.id);
      assert.equal(hold1.status, 'HELD');

      await assert.rejects(
        () =>
          reservationsService.hold(
            { order_item_id: orderItemId2, resource_type: 'PROPERTY', resource_id: testProperty1.id },
            during2,
          ),
        (err) => {
          assert.equal(err.code, 'RESOURCE_CONFLICT');
          assert.equal(err.httpStatus, 409);
          return true;
        },
      );
    });

    it('handles high concurrency: exactly 1 of 20 parallel holds succeeds, 19 get 409 (repeated 3x)', async () => {
      for (let run = 1; run <= 3; run++) {
        const dateStr = `2026-12-${String(10 + run).padStart(2, '0')}`;
        const during = `[${dateStr} 10:00:00+00, ${dateStr} 20:00:00+00)`;

        const orderItemIds = await Promise.all(
          Array.from({ length: 20 }, () => createOrderItemFixture('PROPERTY', testProperty1.id)),
        );

        const results = await Promise.allSettled(
          orderItemIds.map((orderItemId) =>
            reservationsService.hold(
              { order_item_id: orderItemId, resource_type: 'PROPERTY', resource_id: testProperty1.id },
              during,
            ),
          ),
        );

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        assert.equal(fulfilled.length, 1, `Run ${run}: exactly 1 hold must succeed`);
        assert.equal(rejected.length, 19, `Run ${run}: 19 holds must be rejected`);

        for (const rej of rejected) {
          assert.equal(rej.reason.code, 'RESOURCE_CONFLICT');
          assert.equal(rej.reason.httpStatus, 409);
        }
      }
    });

    it('allows back-to-back ranges [10:00, 12:00) and [12:00, 14:00) without collision', async () => {
      const orderItemId1 = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const orderItemId2 = await createOrderItemFixture('PROPERTY', testProperty1.id);

      const range1 = '[2026-12-05 10:00:00+00, 2026-12-05 12:00:00+00)';
      const range2 = '[2026-12-05 12:00:00+00, 2026-12-05 14:00:00+00)';

      const hold1 = await reservationsService.hold(
        { order_item_id: orderItemId1, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        range1,
      );
      const hold2 = await reservationsService.hold(
        { order_item_id: orderItemId2, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        range2,
      );

      assert.ok(hold1.id);
      assert.ok(hold2.id);
    });

    it('allows same dates for two different properties', async () => {
      const orderItemId1 = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const orderItemId2 = await createOrderItemFixture('PROPERTY', testProperty2.id);

      const range = '[2026-12-06 10:00:00+00, 2026-12-06 18:00:00+00)';

      const hold1 = await reservationsService.hold(
        { order_item_id: orderItemId1, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        range,
      );
      const hold2 = await reservationsService.hold(
        { order_item_id: orderItemId2, resource_type: 'PROPERTY', resource_id: testProperty2.id },
        range,
      );

      assert.ok(hold1.id);
      assert.ok(hold2.id);
    });

    it('lazy expiry: an expired HELD reservation no longer blocks a new hold', async () => {
      const orderItemId1 = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const orderItemId2 = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const range = '[2026-12-07 10:00:00+00, 2026-12-07 18:00:00+00)';

      const hold1 = await reservationsService.hold(
        { order_item_id: orderItemId1, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        range,
      );

      // Backdate hold1 expiry in database to simulate passage of time
      await pool.query(
        `UPDATE reservations SET hold_expires_at = now() - interval '1 second' WHERE id = $1`,
        [hold1.id],
      );

      // Next hold on identical range must succeed due to lazy expiry
      const hold2 = await reservationsService.hold(
        { order_item_id: orderItemId2, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        range,
      );
      assert.ok(hold2.id);
    });

    it('confirm() fails with 410 HOLD_EXPIRED when hold has expired', async () => {
      const orderItemId = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const range = '[2026-12-08 10:00:00+00, 2026-12-08 18:00:00+00)';

      const hold = await reservationsService.hold(
        { order_item_id: orderItemId, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        range,
      );

      await pool.query(
        `UPDATE reservations SET hold_expires_at = now() - interval '1 second' WHERE id = $1`,
        [hold.id],
      );

      await assert.rejects(
        () => reservationsService.confirm(hold.id),
        (err) => {
          assert.equal(err.code, 'HOLD_EXPIRED');
          assert.equal(err.httpStatus, 410);
          return true;
        },
      );

      // Verify row was NOT marked CONFIRMED
      const check = await reservationsRepository.findById(hold.id);
      assert.notEqual(check.status, 'CONFIRMED');
    });

    it('release() frees the slot so it can be booked again', async () => {
      const orderItemId1 = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const orderItemId2 = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const range = '[2026-12-09 10:00:00+00, 2026-12-09 18:00:00+00)';

      const hold1 = await reservationsService.hold(
        { order_item_id: orderItemId1, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        range,
      );

      await reservationsService.release(hold1.id);

      const hold2 = await reservationsService.hold(
        { order_item_id: orderItemId2, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        range,
      );
      assert.ok(hold2.id);
    });

    it('rejects holds overlapping with host-blocked dates (is_available = false)', async () => {
      const blockStart = new Date('2026-12-15T10:00:00.000Z');
      const blockEnd = new Date('2026-12-15T18:00:00.000Z');

      await pool.query(
        `INSERT INTO availability (resource_type, resource_id, slot_start, slot_end, is_available)
         VALUES ('PROPERTY', $1, $2, $3, false)`,
        [testProperty1.id, blockStart, blockEnd],
      );

      const orderItemId = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const range = '[2026-12-15 12:00:00+00, 2026-12-15 16:00:00+00)'; // Overlaps host block

      await assert.rejects(
        () =>
          reservationsService.hold(
            { order_item_id: orderItemId, resource_type: 'PROPERTY', resource_id: testProperty1.id },
            range,
          ),
        (err) => {
          assert.equal(err.code, 'RESOURCE_CONFLICT');
          assert.equal(err.httpStatus, 409);
          assert.ok(err.message.includes('blocked'));
          return true;
        },
      );
    });
  });

  describe('Capacity-Based Service Reservations', () => {
    it('allows up to capacity=3 parallel holds, rejects the 4th with 409, and gives capacity back on release', async () => {
      const slot = '2026-12-20-evening';
      const range = '[2026-12-20 18:00:00+00, 2026-12-20 23:00:00+00)';

      const orderItemIds = await Promise.all(
        Array.from({ length: 10 }, () =>
          createOrderItemFixture('SERVICE', capacityService.id, 1),
        ),
      );

      // Fire 10 parallel holds
      const results = await Promise.allSettled(
        orderItemIds.map((orderItemId) =>
          reservationsService.hold(
            {
              order_item_id: orderItemId,
              resource_type: 'SERVICE',
              resource_id: capacityService.id,
              slot,
              quantity: 1,
            },
            range,
          ),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 3, 'Exactly 3 holds must succeed for capacity=3');
      assert.equal(rejected.length, 7, 'Remaining 7 holds must fail with 409');

      // Release one of the 3 holds
      const released = await reservationsService.release(fulfilled[0].value.id);
      assert.equal(released.status, 'CANCELLED');

      // Now exactly one more hold must succeed
      const extraItemId = await createOrderItemFixture('SERVICE', capacityService.id, 1);
      const extraHold = await reservationsService.hold(
        {
          order_item_id: extraItemId,
          resource_type: 'SERVICE',
          resource_id: capacityService.id,
          slot,
          quantity: 1,
        },
        range,
      );
      assert.ok(extraHold.id);

      // Another hold immediately fails because capacity is full again
      const failItemId = await createOrderItemFixture('SERVICE', capacityService.id, 1);
      await assert.rejects(
        () =>
          reservationsService.hold(
            {
              order_item_id: failItemId,
              resource_type: 'SERVICE',
              resource_id: capacityService.id,
              slot,
              quantity: 1,
            },
            range,
          ),
        (err) => {
          assert.equal(err.code, 'RESOURCE_CONFLICT');
          return true;
        },
      );
    });

    it('expired capacity hold gives capacity back on next hold', async () => {
      const slot = '2026-12-21-slot';
      const range = '[2026-12-21 10:00:00+00, 2026-12-21 14:00:00+00)';

      // Fill capacity with 3 holds
      const item1 = await createOrderItemFixture('SERVICE', capacityService.id, 1);
      const item2 = await createOrderItemFixture('SERVICE', capacityService.id, 1);
      const item3 = await createOrderItemFixture('SERVICE', capacityService.id, 1);

      const h1 = await reservationsService.hold(
        { order_item_id: item1, resource_type: 'SERVICE', resource_id: capacityService.id, slot, quantity: 1 },
        range,
      );
      await reservationsService.hold(
        { order_item_id: item2, resource_type: 'SERVICE', resource_id: capacityService.id, slot, quantity: 1 },
        range,
      );
      await reservationsService.hold(
        { order_item_id: item3, resource_type: 'SERVICE', resource_id: capacityService.id, slot, quantity: 1 },
        range,
      );

      // Backdate h1 to expired
      await pool.query(
        `UPDATE reservations SET hold_expires_at = now() - interval '1 second' WHERE id = $1`,
        [h1.id],
      );

      // Next hold must trigger lazy expiry, decrementing reserved count and succeeding
      const item4 = await createOrderItemFixture('SERVICE', capacityService.id, 1);
      const h4 = await reservationsService.hold(
        { order_item_id: item4, resource_type: 'SERVICE', resource_id: capacityService.id, slot, quantity: 1 },
        range,
      );
      assert.ok(h4.id);
    });

    it('double release gives back capacity once (idempotent)', async () => {
      const slot = '2026-12-22-slot';
      const range = '[2026-12-22 10:00:00+00, 2026-12-22 14:00:00+00)';

      const item = await createOrderItemFixture('SERVICE', capacityService.id, 1);
      const hold = await reservationsService.hold(
        { order_item_id: item, resource_type: 'SERVICE', resource_id: capacityService.id, slot, quantity: 1 },
        range,
      );

      // Check reserved is 1
      const capBefore = await pool.query(
        `SELECT reserved FROM service_capacity WHERE service_id = $1 AND slot = $2`,
        [capacityService.id, slot],
      );
      assert.equal(capBefore.rows[0].reserved, 1);

      // First release
      await reservationsService.release(hold.id);
      const capAfter1 = await pool.query(
        `SELECT reserved FROM service_capacity WHERE service_id = $1 AND slot = $2`,
        [capacityService.id, slot],
      );
      assert.equal(capAfter1.rows[0].reserved, 0);

      // Second release: must not decrement below 0 or fail CHECK constraint
      await reservationsService.release(hold.id);
      const capAfter2 = await pool.query(
        `SELECT reserved FROM service_capacity WHERE service_id = $1 AND slot = $2`,
        [capacityService.id, slot],
      );
      assert.equal(capAfter2.rows[0].reserved, 0);
    });
  });

  describe('Availability HTTP Endpoint', () => {
    it('GET /api/v1/properties/:id/availability returns indicative unavailable ranges and hides expired holds', async () => {
      const orderItem = await createOrderItemFixture('PROPERTY', testProperty1.id);
      const hold = await reservationsService.hold(
        { order_item_id: orderItem, resource_type: 'PROPERTY', resource_id: testProperty1.id },
        '[2026-12-25 10:00:00+00, 2026-12-25 18:00:00+00)',
      );

      const res = await request(app)
        .get(`/api/v1/properties/${testProperty1.id}/availability`)
        .query({
          from: '2026-12-24T00:00:00.000Z',
          to: '2026-12-26T00:00:00.000Z',
        });

      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.body.indicative, true);
      assert.ok(Array.isArray(res.body.unavailable_ranges));
      assert.ok(res.body.unavailable_ranges.some((r) => r.reason === 'RESERVED'));

      // Expire the hold
      await pool.query(
        `UPDATE reservations SET hold_expires_at = now() - interval '1 second' WHERE id = $1`,
        [hold.id],
      );

      // Query again: the expired hold must be excluded
      const resAfter = await request(app)
        .get(`/api/v1/properties/${testProperty1.id}/availability`)
        .query({
          from: '2026-12-24T00:00:00.000Z',
          to: '2026-12-26T00:00:00.000Z',
        });

      assert.equal(resAfter.status, 200);
      assert.ok(
        !resAfter.body.unavailable_ranges.some(
          (r) => r.start === '2026-12-25 10:00:00+00' || r.start.includes('2026-12-25T10:00:00'),
        ),
      );
    });

    it('returns 404 for missing or non-ACTIVE property', async () => {
      const res = await request(app)
        .get(`/api/v1/properties/${crypto.randomUUID()}/availability`)
        .query({
          from: '2026-12-24T00:00:00.000Z',
          to: '2026-12-26T00:00:00.000Z',
        });

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'PROPERTY_NOT_FOUND');
    });

    it('returns 400 when to <= from or window > 90 days', async () => {
      const resInverted = await request(app)
        .get(`/api/v1/properties/${testProperty1.id}/availability`)
        .query({
          from: '2026-12-26T00:00:00.000Z',
          to: '2026-12-24T00:00:00.000Z',
        });
      assert.equal(resInverted.status, 400);
      assert.equal(resInverted.body.error.code, 'VALIDATION_ERROR');

      const resTooWide = await request(app)
        .get(`/api/v1/properties/${testProperty1.id}/availability`)
        .query({
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-06-01T00:00:00.000Z', // > 90 days
        });
      assert.equal(resTooWide.status, 400);
      assert.equal(resTooWide.body.error.code, 'VALIDATION_ERROR');
    });
  });
});
