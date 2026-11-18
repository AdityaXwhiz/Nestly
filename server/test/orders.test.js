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
const { ordersRepository } = await import('../src/modules/orders/repository.js');

describe('Orders and Price Snapshots Test Suite', () => {
  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdProviderIds = [];
  const createdServiceIds = [];
  const createdOrderIds = [];

  const uniqueEmail = () => `ord_${crypto.randomUUID().slice(0, 8)}@example.com`;

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
  let exclusiveService;
  let capacityService;

  before(async () => {
    customerUser = await createAuthenticatedUser('CUSTOMER');
    otherCustomerUser = await createAuthenticatedUser('CUSTOMER');
    hostUser = await createAuthenticatedUser('HOST');
    providerUser = await createAuthenticatedUser('PROVIDER');
    adminUser = await createAuthenticatedUser('ADMIN');

    // Create property: 500000 minor INR per day, capacity 50
    const propRes = await request(app)
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${hostUser.token}`)
      .send({
        title: 'Sunset Beachfront Villa',
        description: 'Luxury villa for events',
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
        business_name: 'Goa Premier Events',
        bio: 'Top tier event services',
      });
    createdProviderIds.push(provRes.body.id);

    // Create exclusive service: 150000 minor INR
    const photoRes = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        name: 'Full Day Photography',
        description: 'Comprehensive high-resolution event photography coverage',
        category: 'photography',
        price_minor: 150000,
        currency: 'INR',
        kind: 'exclusive',
      });
    exclusiveService = photoRes.body.service;
    createdServiceIds.push(exclusiveService.id);

    // Create capacity service: 200000 minor INR, capacity 5
    const caterRes = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerUser.token}`)
      .send({
        name: 'Gourmet Catering Package',
        description: 'Multi-course buffet catering with fresh local produce',
        category: 'catering',
        price_minor: 200000,
        currency: 'INR',
        kind: 'capacity',
        capacity: 5,
      });
    capacityService = caterRes.body.service;
    createdServiceIds.push(capacityService.id);
  });

  after(async () => {
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

  describe('Order Creation & Price Snapshots', () => {
    it('creates a composite order with property and 2 services; totals equal the sum of snapshots', async () => {
      // 2 days range: Dec 20 to Dec 22
      const during = {
        start: '2026-12-20T10:00:00.000Z',
        end: '2026-12-22T10:00:00.000Z',
      };

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 25,
          services: [
            { service_id: exclusiveService.id, quantity: 1 },
            { service_id: capacityService.id, quantity: 2, slot: '2026-12-20-dinner' },
          ],
        });

      assert.equal(res.status, 201);
      createdOrderIds.push(res.body.id);

      assert.equal(res.body.status, 'PENDING');
      assert.equal(res.body.currency, 'INR');
      assert.equal(res.body.guest_count, 25);

      // Total calculation:
      // Property: 500,000 * 2 days = 1,000,000
      // Photography: 150,000 * 1 = 150,000
      // Catering: 200,000 * 2 = 400,000
      // Total: 1,550,000
      assert.equal(res.body.total_amount_minor, 1550000);

      // Verify item snapshots
      assert.equal(res.body.items.length, 3);
      const propItem = res.body.items.find((i) => i.resource_type === 'PROPERTY');
      assert.ok(propItem);
      assert.equal(propItem.unit_price_minor, 500000);
      assert.equal(propItem.quantity, 2);
      assert.equal(propItem.title, 'Sunset Beachfront Villa');
      assert.equal(propItem.pricing_unit, 'PER_DAY');

      const photoItem = res.body.items.find((i) => i.resource_id === exclusiveService.id);
      assert.ok(photoItem);
      assert.equal(photoItem.unit_price_minor, 150000);
      assert.equal(photoItem.quantity, 1);
      assert.equal(photoItem.pricing_unit, 'PER_UNIT');

      const caterItem = res.body.items.find((i) => i.resource_id === capacityService.id);
      assert.ok(caterItem);
      assert.equal(caterItem.unit_price_minor, 200000);
      assert.equal(caterItem.quantity, 2);
      assert.equal(caterItem.slot, '2026-12-20-dinner');
      assert.equal(caterItem.pricing_unit, 'PER_UNIT');
    });

    it('later catalog price changes do not alter existing order or total (BR-04)', async () => {
      const during = {
        start: '2026-12-25T10:00:00.000Z',
        end: '2026-12-26T10:00:00.000Z',
      };

      const createRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 20,
        });

      assert.equal(createRes.status, 201);
      const orderId = createRes.body.id;
      createdOrderIds.push(orderId);
      assert.equal(createRes.body.total_amount_minor, 500000); // 1 day @ 500000

      // Host increases property rate in the catalog to 999,999
      await request(app)
        .put(`/api/v1/properties/${testProperty.id}`)
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          pricing_minor: 999999,
        });

      // Reading the existing order must reflect the original snapshot, not the new price
      const getRes = await request(app)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${customerUser.token}`);

      assert.equal(getRes.status, 200);
      assert.equal(getRes.body.total_amount_minor, 500000);
      assert.equal(getRes.body.items[0].unit_price_minor, 500000);

      // Restore property price
      await request(app)
        .put(`/api/v1/properties/${testProperty.id}`)
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          pricing_minor: 500000,
        });
    });

    it('rejects client-sent price or total fields with 400 VALIDATION_ERROR', async () => {
      const during = {
        start: '2026-12-20T10:00:00.000Z',
        end: '2026-12-21T10:00:00.000Z',
      };

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 10,
          total_amount_minor: 100, // Client attempting to dictate price
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('returns 422 ITEM_INVALID when property or service is missing or inactive', async () => {
      const during = {
        start: '2026-12-20T10:00:00.000Z',
        end: '2026-12-21T10:00:00.000Z',
      };

      const nonExistentId = crypto.randomUUID();
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: nonExistentId,
          during,
          guest_count: 10,
        });

      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'ITEM_INVALID');
      assert.ok(res.body.error.details.issues.length > 0);
    });

    it('rejects guest_count exceeding property capacity with 422 ITEM_INVALID', async () => {
      const during = {
        start: '2026-12-20T10:00:00.000Z',
        end: '2026-12-21T10:00:00.000Z',
      };

      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 100, // Capacity is 50
        });

      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'ITEM_INVALID');
      assert.ok(
        res.body.error.details.issues.some((i) => i.message.includes('exceeds property capacity')),
      );
    });

    it('enforces validation limits on booking duration, service count, past dates, and duplicates', async () => {
      // 1. Duration > 30 days
      const resDuration = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during: {
            start: '2026-12-01T00:00:00.000Z',
            end: '2027-01-15T00:00:00.000Z', // 45 days
          },
          guest_count: 10,
        });
      assert.equal(resDuration.status, 400);

      // 2. Start date in the past
      const resPast = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during: {
            start: '2020-01-01T00:00:00.000Z',
            end: '2020-01-05T00:00:00.000Z',
          },
          guest_count: 10,
        });
      assert.equal(resPast.status, 400);

      // 3. Duplicate (service_id, slot) lines
      const resDup = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          during: {
            start: '2026-12-10T00:00:00.000Z',
            end: '2026-12-12T00:00:00.000Z',
          },
          guest_count: 10,
          services: [
            { service_id: capacityService.id, quantity: 1, slot: 'evening' },
            { service_id: capacityService.id, quantity: 1, slot: 'evening' },
          ],
        });
      assert.equal(resDup.status, 400);
    });

    it('enforces RBAC on order creation and reading', async () => {
      const during = {
        start: '2026-12-20T10:00:00.000Z',
        end: '2026-12-21T10:00:00.000Z',
      };

      // HOST cannot create orders
      const hostRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 10,
        });
      assert.equal(hostRes.status, 403);

      // PROVIDER cannot create orders
      const provRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 10,
        });
      assert.equal(provRes.status, 403);

      // Customer creates order
      const custRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 10,
        });
      assert.equal(custRes.status, 201);
      const orderId = custRes.body.id;
      createdOrderIds.push(orderId);

      // Other customer gets 403 on reading
      const otherGet = await request(app)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${otherCustomerUser.token}`);
      assert.equal(otherGet.status, 403);

      // Other customer gets 403 on hold
      const otherHold = await request(app)
        .post(`/api/v1/orders/${orderId}/hold`)
        .set('Authorization', `Bearer ${otherCustomerUser.token}`);
      assert.equal(otherHold.status, 403);

      // ADMIN can read order
      const adminGet = await request(app)
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${adminUser.token}`);
      assert.equal(adminGet.status, 200);
      assert.equal(adminGet.body.id, orderId);
    });
  });

  describe('Order Hold & In-Code Compensation', () => {
    it('holds an order successfully: transitions to HELD and creates reservations', async () => {
      const during = {
        start: '2026-12-28T10:00:00.000Z',
        end: '2026-12-29T10:00:00.000Z',
      };

      const orderRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 15,
          services: [
            { service_id: exclusiveService.id, quantity: 1 },
          ],
        });
      const orderId = orderRes.body.id;
      createdOrderIds.push(orderId);

      const holdRes = await request(app)
        .post(`/api/v1/orders/${orderId}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);

      assert.equal(holdRes.status, 200);
      assert.equal(holdRes.body.order_id, orderId);
      assert.equal(holdRes.body.status, 'HELD');
      assert.ok(holdRes.body.hold_expires_at);

      // Verify in DB that order is HELD and hold_expires_at matches
      const dbOrder = await ordersRepository.findById(orderId);
      assert.equal(dbOrder.status, 'HELD');
      assert.ok(dbOrder.hold_expires_at);

      // Verify reservations created in DB
      const resDb = await pool.query(
        `SELECT r.* FROM reservations r
         JOIN order_items oi ON oi.id = r.order_item_id
         WHERE oi.order_id = $1`,
        [orderId],
      );
      assert.equal(resDb.rows.length, 2);
      for (const row of resDb.rows) {
        assert.equal(row.status, 'HELD');
      }

      // Check earliest hold_expires_at rule (Change #3)
      const earliestReservationExpiry = Math.min(
        ...resDb.rows.map((r) => new Date(r.hold_expires_at).getTime()),
      );
      assert.equal(new Date(dbOrder.hold_expires_at).getTime(), earliestReservationExpiry);
    });

    it('rejects a second hold on the same order with 409 ORDER_NOT_HOLDABLE', async () => {
      const during = {
        start: '2026-12-30T10:00:00.000Z',
        end: '2026-12-31T10:00:00.000Z',
      };

      const orderRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 10,
        });
      const orderId = orderRes.body.id;
      createdOrderIds.push(orderId);

      // First hold: succeeds
      const hold1 = await request(app)
        .post(`/api/v1/orders/${orderId}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);
      assert.equal(hold1.status, 200);
      assert.equal(hold1.body.status, 'HELD');

      // Second hold: rejected with 409 ORDER_NOT_HOLDABLE
      const hold2 = await request(app)
        .post(`/api/v1/orders/${orderId}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);
      assert.equal(hold2.status, 409);
      assert.equal(hold2.body.error.code, 'ORDER_NOT_HOLDABLE');
    });

    it('partial failure triggers compensation: when second service fails, property hold is released and order stays PENDING', async () => {
      // 1. Create a limited capacity service (capacity: 1)
      const limitedServiceRes = await request(app)
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          name: 'Solo Musician',
          description: 'Acoustic guitar performance for evening dinner events',
          category: 'music',
          price_minor: 100000,
          currency: 'INR',
          kind: 'capacity',
          capacity: 1,
        });
      const limitedService = limitedServiceRes.body.service;
      createdServiceIds.push(limitedService.id);

      // 2. Pre-fill the only available slot for this service
      const slot = '2026-12-23-solo';
      await pool.query(
        `INSERT INTO service_capacity (service_id, slot, capacity, reserved)
         VALUES ($1, $2, 1, 1)
         ON CONFLICT (service_id, slot) DO UPDATE SET reserved = 1`,
        [limitedService.id, slot],
      );

      // 3. Customer creates order with property and this full service
      const during = {
        start: '2026-12-23T10:00:00.000Z',
        end: '2026-12-24T10:00:00.000Z',
      };
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 10,
          services: [
            { service_id: limitedService.id, quantity: 1, slot },
          ],
        });
      assert.equal(orderRes.status, 201);
      const orderId = orderRes.body.id;
      createdOrderIds.push(orderId);

      // 4. Call hold: Property hold succeeds first, but limitedService hold fails
      const holdRes = await request(app)
        .post(`/api/v1/orders/${orderId}/hold`)
        .set('Authorization', `Bearer ${customerUser.token}`);

      assert.equal(holdRes.status, 409);
      assert.equal(holdRes.body.error.code, 'RESOURCE_CONFLICT');

      // 5. Verify compensation:
      // Order stays PENDING
      const dbOrder = await ordersRepository.findById(orderId);
      assert.equal(dbOrder.status, 'PENDING');

      // Property hold was released (marked CANCELLED, not HELD)
      const resDb = await pool.query(
        `SELECT r.* FROM reservations r
         JOIN order_items oi ON oi.id = r.order_item_id
         WHERE oi.order_id = $1`,
        [orderId],
      );
      // No active reservations stay HELD
      const activeHolds = resDb.rows.filter((r) => r.status === 'HELD');
      assert.equal(activeHolds.length, 0);

      const cancelledHolds = resDb.rows.filter((r) => r.status === 'CANCELLED');
      assert.equal(cancelledHolds.length, 1); // The property hold was released
    });

    it('two parallel hold calls on the same order: order ends HELD at most once and no orphan reservation stays active', async () => {
      const during = {
        start: '2026-12-27T10:00:00.000Z',
        end: '2026-12-28T10:00:00.000Z',
      };

      const orderRes = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          property_id: testProperty.id,
          during,
          guest_count: 10,
          services: [
            { service_id: exclusiveService.id, quantity: 1 },
          ],
        });
      const orderId = orderRes.body.id;
      createdOrderIds.push(orderId);

      // Fire 2 concurrent hold calls on the same order
      const [r1, r2] = await Promise.allSettled([
        request(app)
          .post(`/api/v1/orders/${orderId}/hold`)
          .set('Authorization', `Bearer ${customerUser.token}`),
        request(app)
          .post(`/api/v1/orders/${orderId}/hold`)
          .set('Authorization', `Bearer ${customerUser.token}`),
      ]);

      const responses = [r1.value, r2.value];
      const successes = responses.filter((r) => r && r.status === 200);
      const rejections = responses.filter((r) => r && r.status === 409);

      assert.equal(successes.length, 1, 'Exactly one parallel hold call must succeed');
      assert.equal(rejections.length, 1, 'Contending hold call must be rejected with 409');

      // The order in DB is HELD
      const dbOrder = await ordersRepository.findById(orderId);
      assert.equal(dbOrder.status, 'HELD');

      // Verify active reservations count equals exactly the items in the order (2 items)
      const resDb = await pool.query(
        `SELECT r.* FROM reservations r
         JOIN order_items oi ON oi.id = r.order_item_id
         WHERE oi.order_id = $1 AND r.status = 'HELD'`,
        [orderId],
      );
      assert.equal(resDb.rows.length, 2, 'No orphan active reservations remain from losing call');
    });

    it('high contention: 10 customers create orders for same property and dates and hold in parallel: exactly 1 order reaches HELD', async () => {
      // Use a dedicated property to avoid cross-test HELD reservation collision
      const contentionPropRes = await request(app)
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          title: 'Contention Test Venue',
          description: 'Property dedicated to contention test',
          location: 'Mumbai',
          capacity: 100,
          pricing_minor: 100000,
          currency: 'INR',
        });
      const contentionProperty = contentionPropRes.body.property;
      createdPropertyIds.push(contentionProperty.id);

      const during = {
        start: '2027-03-01T10:00:00.000Z',
        end: '2027-03-03T10:00:00.000Z',
      };

      // Create 10 customers and 10 orders for the same property & dates
      const contestants = [];
      for (let i = 0; i < 10; i++) {
        const user = await createAuthenticatedUser('CUSTOMER');
        const orderRes = await request(app)
          .post('/api/v1/orders')
          .set('Authorization', `Bearer ${user.token}`)
          .send({
            property_id: contentionProperty.id,
            during,
            guest_count: 10,
          });
        assert.equal(orderRes.status, 201);
        createdOrderIds.push(orderRes.body.id);
        contestants.push({ user, orderId: orderRes.body.id });
      }

      // Fire 10 simultaneous hold requests
      const holdResults = await Promise.allSettled(
        contestants.map(({ user, orderId }) =>
          request(app)
            .post(`/api/v1/orders/${orderId}/hold`)
            .set('Authorization', `Bearer ${user.token}`),
        ),
      );

      const successes = holdResults.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 200,
      );
      const rejections = holdResults.filter(
        (r) => r.status === 'fulfilled' && r.value.status === 409,
      );

      assert.equal(successes.length, 1, 'Exactly one order must succeed under contention');
      assert.equal(rejections.length, 9, 'All 9 other orders must fail with 409');

      // Database verification: exactly 1 active HELD reservation for this property
      const dbRes = await pool.query(
        `SELECT * FROM reservations
         WHERE resource_id = $1 AND status = 'HELD'`,
        [contentionProperty.id],
      );
      assert.equal(dbRes.rows.length, 1, 'Only 1 active reservation in DB for this property');
    });
  });
});
