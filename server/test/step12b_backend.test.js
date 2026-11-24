import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { pool } from '../src/infrastructure/postgres.js';
import { redis } from '../src/infrastructure/redis.js';
import { reservationsRepository } from '../src/modules/reservations/repository.js';
import { runDemoSeed } from '../src/infrastructure/seed/seedDemo.js';

describe('Step 12B Backend Additions & Concurrency Tests', () => {
  let customerToken;
  let customerUser;
  let hostToken;
  let hostUser;
  let providerToken;
  let providerUser;
  let adminToken;
  let testPropertyId;
  let testServiceId;
  let testCapacityServiceId;

  before(async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { env } = await import('../src/config/env.js');
    const { usersRepository } = await import('../src/modules/users/repository.js');
    const bcrypt = (await import('bcryptjs')).default;
    const pwdHash = await bcrypt.hash('Password123!', 10);

    const makeUserAndToken = async (role) => {
      const email = `${role.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`;
      const u = await usersRepository.createUser({ email, role, passwordHash: pwdHash });
      const token = jwt.sign({ sub: u.id, role: u.role }, env.JWT_ACCESS_SECRET, {
        algorithm: 'HS256',
        expiresIn: '1h',
        audience: env.JWT_AUDIENCE,
      });
      return { user: u, token };
    };

    // 1. Create Customer
    const cust = await makeUserAndToken('CUSTOMER');
    customerUser = cust.user;
    customerToken = cust.token;

    // 2. Create Host
    const host = await makeUserAndToken('HOST');
    hostUser = host.user;
    hostToken = host.token;

    // 3. Create Provider
    const prov = await makeUserAndToken('PROVIDER');
    providerUser = prov.user;
    providerToken = prov.token;

    // 4. Create Admin
    const admin = await makeUserAndToken('ADMIN');
    adminToken = admin.token;

    // 5. Host creates 2 properties (one ACTIVE, one INACTIVE)
    const prop1 = await request(app)
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({
        title: 'Active Property 12B',
        description: 'Active property description',
        location: 'Bangalore',
        capacity: 10,
        pricing_minor: 1000000,
        status: 'ACTIVE',
      });
    testPropertyId = prop1.body.property.id;

    await request(app)
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({
        title: 'Inactive Property 12B',
        description: 'Inactive property description',
        location: 'Bangalore',
        capacity: 8,
        pricing_minor: 800000,
        status: 'INACTIVE',
      });

    // 6. Provider creates provider profile and 2 services (exclusive and capacity)
    await request(app)
      .post('/api/v1/providers')
      .set('Authorization', `Bearer ${providerToken}`)
      .send({ business_name: 'Test 12B Services Ltd', bio: 'Audio and catering services' });

    const svc1 = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerToken}`)
      .send({
        title: 'Exclusive DJ Setup',
        description: 'Sound setup',
        category: 'music',
        kind: 'exclusive',
        price_minor: 500000,
        currency: 'INR',
      });
    testServiceId = svc1.body.service.id;

    const svc2 = await request(app)
      .post('/api/v1/services')
      .set('Authorization', `Bearer ${providerToken}`)
      .send({
        title: 'Capacity Buffet Dinner',
        description: 'Buffet plates',
        category: 'catering',
        kind: 'capacity',
        capacity: 20, // 20 capacity limit
        price_minor: 50000,
        currency: 'INR',
      });
    testCapacityServiceId = svc2.body.service.id;
  });

  after(async () => {
    await pool.end();
    await redis.quit();
  });

  describe('1. GET /api/v1/properties/mine', () => {
    it('allows HOST to fetch own properties, including INACTIVE ones', async () => {
      const res = await request(app)
        .get('/api/v1/properties/mine')
        .set('Authorization', `Bearer ${hostToken}`);

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.properties));
      assert.equal(res.body.properties.length, 2);

      const titles = res.body.properties.map((p) => p.title);
      assert.ok(titles.includes('Active Property 12B'));
      assert.ok(titles.includes('Inactive Property 12B'));

      const inactive = res.body.properties.find((p) => p.title === 'Inactive Property 12B');
      assert.equal(inactive.status, 'INACTIVE');
    });

    it('blocks non-HOST from accessing /properties/mine with 403', async () => {
      const res = await request(app)
        .get('/api/v1/properties/mine')
        .set('Authorization', `Bearer ${customerToken}`);

      assert.equal(res.status, 403);
    });
  });

  describe('2. GET /api/v1/services/mine', () => {
    it('allows PROVIDER to fetch own services', async () => {
      const res = await request(app)
        .get('/api/v1/services/mine')
        .set('Authorization', `Bearer ${providerToken}`);

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.services));
      assert.equal(res.body.services.length, 2);

      const titles = res.body.services.map((s) => s.title);
      assert.ok(titles.includes('Exclusive DJ Setup'));
      assert.ok(titles.includes('Capacity Buffet Dinner'));
    });

    it('blocks non-PROVIDER from accessing /services/mine with 403', async () => {
      const res = await request(app)
        .get('/api/v1/services/mine')
        .set('Authorization', `Bearer ${hostToken}`);

      assert.equal(res.status, 403);
    });
  });

  describe('3. GET /api/v1/providers/me (Change #5)', () => {
    it('returns caller provider profile', async () => {
      const res = await request(app)
        .get('/api/v1/providers/me')
        .set('Authorization', `Bearer ${providerToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.provider.business_name, 'Test 12B Services Ltd');
    });

    it('returns 404 PROVIDER_NOT_FOUND if user has no provider profile', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const { env } = await import('../src/config/env.js');
      const { usersRepository } = await import('../src/modules/users/repository.js');

      const email = `prov_noprofile_${Date.now()}@example.com`;
      const u = await usersRepository.createUser({ email, role: 'PROVIDER', passwordHash: 'hash' });
      const token = jwt.sign({ sub: u.id, role: u.role }, env.JWT_ACCESS_SECRET, {
        algorithm: 'HS256',
        expiresIn: '1h',
        audience: env.JWT_AUDIENCE,
      });

      const res = await request(app)
        .get('/api/v1/providers/me')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'PROVIDER_NOT_FOUND');
    });
  });

  describe('4. Slot Format & Date Range Validation (Change #3 & Change #4)', () => {
    it('rejects capacity service without slot with 422 ITEM_INVALID', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          during: {
            start: '2026-12-01T00:00:00.000Z',
            end: '2026-12-03T23:59:59.999Z',
          },
          guest_count: 5,
          services: [
            {
              service_id: testCapacityServiceId,
              quantity: 5,
              // slot missing
            },
          ],
        });

      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'ITEM_INVALID');
      assert.ok(res.body.error.details.issues.some((i) => i.message.includes('Slot identifier is required')));
    });

    it('rejects slot format not matching YYYY-MM-DD with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          during: {
            start: '2026-12-01T00:00:00.000Z',
            end: '2026-12-03T23:59:59.999Z',
          },
          guest_count: 5,
          services: [
            {
              service_id: testCapacityServiceId,
              quantity: 5,
              slot: '2026-12-01-morning', // Invalid format!
            },
          ],
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects slot date falling outside order date range with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          during: {
            start: '2026-12-01T00:00:00.000Z',
            end: '2026-12-03T23:59:59.999Z',
          },
          guest_count: 5,
          services: [
            {
              service_id: testCapacityServiceId,
              quantity: 5,
              slot: '2026-12-10', // Outside [2026-12-01, 2026-12-03]
            },
          ],
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('accepts valid YYYY-MM-DD slot date within order date range and returns server_time', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          property_id: testPropertyId,
          during: {
            start: '2026-12-01T00:00:00.000Z',
            end: '2026-12-03T23:59:59.999Z',
          },
          guest_count: 5,
          services: [
            {
              service_id: testCapacityServiceId,
              quantity: 4,
              slot: '2026-12-02',
            },
          ],
        });

      assert.equal(res.status, 201);
      assert.ok(res.body.id);
      assert.ok(res.body.server_time, 'Response must include server_time (Change #1)');
      assert.equal(res.body.status, 'PENDING');
      assert.equal(res.body.total_amount_minor, 3000000 + 4 * 50000); // 3 days * 10k + 4 plates * 500
    });
  });

  describe('5. Concurrency Test: N Parallel First Holds on a New Slot (Change #3)', () => {
    it('creates service_capacity row on first use and parallel holds never exceed base capacity', async () => {
      // testCapacityServiceId has capacity: 20
      const brandNewSlot = `2027-05-15`; // No existing row in service_capacity

      // N = 10 concurrent holds, each asking for 4 units.
      // Total requested = 10 * 4 = 40 units.
      // But base capacity is 20, so exactly 5 should succeed (5 * 4 = 20) and 5 must fail!
      const promises = Array.from({ length: 10 }, () =>
        reservationsRepository.incrementCapacity(testCapacityServiceId, brandNewSlot, 4),
      );

      const results = await Promise.all(promises);

      const successful = results.filter(Boolean);
      const failed = results.filter((r) => r === null);

      assert.equal(successful.length, 5, 'Exactly 5 holds of 4 units must succeed to reach capacity 20');
      assert.equal(failed.length, 5, '5 holds must be rejected when capacity limit of 20 is reached');

      // Verify the final reserved count in the DB is exactly 20 (and <= 20)
      const row = await pool.query(
        'SELECT capacity, reserved FROM service_capacity WHERE service_id = $1 AND slot = $2',
        [testCapacityServiceId, brandNewSlot],
      );

      assert.equal(row.rows.length, 1);
      assert.equal(row.rows[0].capacity, 20);
      assert.equal(row.rows[0].reserved, 20);
    });
  });

  describe('6. GET /api/v1/orders (Change #1 & Change #2)', () => {
    it('allows CUSTOMER to fetch own orders paginated with server_time and latest payment', async () => {
      const res = await request(app)
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${customerToken}`);

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.orders));
      assert.ok(res.body.orders.length >= 1);
      assert.ok(res.body.server_time, 'Response must include server_time (Change #1)');
      assert.ok('pagination' in res.body);

      // Verify payment structure on order (Change #2)
      const order = res.body.orders[0];
      assert.ok('payment' in order);
      assert.equal(order.user_id, customerUser.id);
    });

    it('allows ADMIN to view all orders', async () => {
      const res = await request(app)
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${adminToken}`);

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.orders));
      assert.ok(res.body.pagination.total >= 1);
    });
  });

  describe('7. Dev Seed Script Idempotence (Change #12)', () => {
    it('refuses to run when NODE_ENV is production', async () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      await assert.rejects(
        async () => {
          await runDemoSeed({ client: pool });
        },
        /Refusing to run seed:demo in production environment/,
      );

      process.env.NODE_ENV = origEnv;
    });

    it('executes idempotently multiple times without errors', async () => {
      const res1 = await runDemoSeed({ client: pool });
      assert.equal(res1.host, 'host@example.test');
      assert.equal(res1.provider, 'provider@example.test');
      assert.equal(res1.customer, 'customer@example.test');

      // Second run produces identical clean completion without constraint violations
      const res2 = await runDemoSeed({ client: pool });
      assert.equal(res2.host, 'host@example.test');
    });
  });
});
