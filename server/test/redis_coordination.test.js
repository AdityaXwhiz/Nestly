import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/infrastructure/postgres.js');
const { redis, setRedisDisabledForTesting, isRedisAvailable } = await import(
  '../src/infrastructure/redis.js'
);
const { acquire, release } = await import('../src/infrastructure/redis/lock.js');
const { get, set, del, remember } = await import('../src/infrastructure/redis/cache.js');
const { usersRepository } = await import('../src/modules/users/repository.js');
const { propertiesRepository } = await import('../src/modules/properties/repository.js');
const { propertiesService } = await import('../src/modules/properties/service.js');
const { reservationsService } = await import('../src/modules/reservations/service.js');

describe('Redis Coordination & Caching Test Suite', () => {
  let hostUser;
  let customerUser;
  let testProperty;

  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdOrderIds = [];

  const uniqueEmail = () => `coord_${crypto.randomUUID().slice(0, 8)}@example.com`;

  async function createOrderItemFixture(propertyId) {
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
       VALUES ($1, 'PROPERTY', $2, 1, 10000, 'INR')
       RETURNING id`,
      [orderId, propertyId],
    );
    return itemRes.rows[0].id;
  }

  before(async () => {
    // 1. Create Host
    const hostHash = await bcrypt.hash('Password123!', 10);
    hostUser = await usersRepository.createUser({
      email: uniqueEmail(),
      role: 'HOST',
      passwordHash: hostHash,
    });
    createdUserIds.push(hostUser.id);

    // 2. Create Customer
    const custHash = await bcrypt.hash('Password123!', 10);
    customerUser = await usersRepository.createUser({
      email: uniqueEmail(),
      role: 'CUSTOMER',
      passwordHash: custHash,
    });
    createdUserIds.push(customerUser.id);

    // 3. Create Property
    testProperty = await propertiesRepository.createProperty({
      hostId: hostUser.id,
      title: 'Seaside Pavilion',
      description: 'Exclusive seaside event venue',
      location: 'Goa South',
      capacity: 150,
      pricingMinor: 2500000,
      currency: 'INR',
      status: 'ACTIVE',
    });
    createdPropertyIds.push(testProperty.id);
  });

  after(async () => {
    setRedisDisabledForTesting(false);
    for (const id of createdOrderIds) {
      await pool.query('DELETE FROM orders WHERE id = $1', [id]);
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

  beforeEach(() => {
    setRedisDisabledForTesting(false);
  });

  describe('Distributed Lock Helper', () => {
    it('acquire returns acquired token, and busy when already held', async () => {
      const lockKey = `test:lock:${crypto.randomUUID()}`;
      const lock1 = await acquire(lockKey, 5000);
      assert.equal(lock1.status, 'acquired');
      assert.ok(lock1.token);

      const lock2 = await acquire(lockKey, 5000);
      assert.equal(lock2.status, 'busy');

      await release(lockKey, lock1.token);
    });

    it('release with a wrong token does NOT delete another owner lock', async () => {
      const lockKey = `test:lock:${crypto.randomUUID()}`;
      const lock = await acquire(lockKey, 5000);
      assert.equal(lock.status, 'acquired');

      // Attempt release with forged token
      const wrongToken = crypto.randomUUID();
      const releasedWrong = await release(lockKey, wrongToken);
      assert.equal(releasedWrong, 0);

      // Lock should still be held in Redis
      const busyAgain = await acquire(lockKey, 5000);
      assert.equal(busyAgain.status, 'busy');

      // Now release with valid token
      const releasedRight = await release(lockKey, lock.token);
      assert.equal(releasedRight, 1);
    });

    it('setRedisDisabledForTesting only takes effect when NODE_ENV === test', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      setRedisDisabledForTesting(true);
      // In production mode, setRedisDisabledForTesting is a no-op
      assert.equal(isRedisAvailable(), true);

      process.env.NODE_ENV = 'test';
      setRedisDisabledForTesting(true);
      assert.equal(isRedisAvailable(), false);

      setRedisDisabledForTesting(false);
      assert.equal(isRedisAvailable(), true);
      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Contention & Resilience: Redis ON vs. Redis OFF', () => {
    it('20 parallel holds on same property with Redis ON: exactly 1 success', async () => {
      const during = '[2026-12-11 10:00:00+00, 2026-12-11 18:00:00+00)';
      const orderItemIds = await Promise.all(
        Array.from({ length: 20 }, () => createOrderItemFixture(testProperty.id)),
      );

      const results = await Promise.allSettled(
        orderItemIds.map((orderItemId) =>
          reservationsService.hold(
            { order_item_id: orderItemId, resource_type: 'PROPERTY', resource_id: testProperty.id },
            during,
          ),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly 1 hold must succeed');
      assert.equal(rejected.length, 19, '19 holds must be rejected');

      // Fast-reject (RESOURCE_BUSY) or DB collision (RESOURCE_CONFLICT)
      for (const rej of rejected) {
        assert.ok(['RESOURCE_BUSY', 'RESOURCE_CONFLICT'].includes(rej.reason.code));
        assert.equal(rej.reason.httpStatus, 409);
      }
    });

    it('20 parallel holds on same property with Redis OFF: STILL exactly 1 success (PostgreSQL constraint holds)', async () => {
      setRedisDisabledForTesting(true); // Disable Redis

      const during = '[2026-12-12 10:00:00+00, 2026-12-12 18:00:00+00)';
      const orderItemIds = await Promise.all(
        Array.from({ length: 20 }, () => createOrderItemFixture(testProperty.id)),
      );

      const results = await Promise.allSettled(
        orderItemIds.map((orderItemId) =>
          reservationsService.hold(
            { order_item_id: orderItemId, resource_type: 'PROPERTY', resource_id: testProperty.id },
            during,
          ),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly 1 hold must succeed even with Redis off');
      assert.equal(rejected.length, 19, '19 holds must be rejected by PostgreSQL GiST constraint');

      for (const rej of rejected) {
        assert.equal(rej.reason.code, 'RESOURCE_CONFLICT');
        assert.equal(rej.reason.httpStatus, 409);
      }
    });

    it('lock TTL expires mid-transaction: still NO double booking due to PostgreSQL constraint', async () => {
      const lockKey = `lock:resource:${testProperty.id}`;
      const during = '[2026-12-13 10:00:00+00, 2026-12-13 18:00:00+00)';

      const item1 = await createOrderItemFixture(testProperty.id);
      const item2 = await createOrderItemFixture(testProperty.id);

      // Acquire lock manually with tiny TTL (30ms)
      const lock = await acquire(lockKey, 30);
      assert.equal(lock.status, 'acquired');

      // Wait 50ms so the lock TTL expires while Tx1 is theoretically working
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Tx1 inserts successfully
      const hold1 = await reservationsService.hold(
        { order_item_id: item1, resource_type: 'PROPERTY', resource_id: testProperty.id },
        during,
      );
      assert.ok(hold1.id);

      // Tx2 attempts to insert on overlapping range: PostgreSQL exclusion constraint catches it
      await assert.rejects(
        () =>
          reservationsService.hold(
            { order_item_id: item2, resource_type: 'PROPERTY', resource_id: testProperty.id },
            during,
          ),
        (err) => {
          assert.equal(err.code, 'RESOURCE_CONFLICT');
          return true;
        },
      );
    });
  });

  describe('Cache-Aside Semantics', () => {
    it('first read is a miss, second is a hit, and cached response deep-equals uncached response', async () => {
      const cacheKey = `cache:property:${testProperty.id}`;
      await del(cacheKey);

      // 1. First read (cache miss)
      const first = await propertiesService.getPropertyById(testProperty.id);
      const cachedRaw = await get(cacheKey);
      assert.ok(cachedRaw, 'Redis cache key must be populated after first read');

      // 2. Second read (cache hit)
      const second = await propertiesService.getPropertyById(testProperty.id);

      // 3. Deep equality check
      assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
    });

    it('cached list response deep-equals uncached list response', async () => {
      const query = { location: 'goa', limit: 5 };

      // 1. First list call
      const first = await propertiesService.listProperties(query);

      // 2. Second list call (served from cache)
      const second = await propertiesService.listProperties(query);

      assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
    });

    it('updating a property deletes the cache key and INACTIVE property is not served from cache', async () => {
      const cacheKey = `cache:property:${testProperty.id}`;

      // Warm up cache
      await propertiesService.getPropertyById(testProperty.id);
      assert.ok(await get(cacheKey));

      // Update property to INACTIVE
      await propertiesService.updateProperty(
        testProperty.id,
        { status: 'INACTIVE' },
        hostUser,
      );

      // Cache key must be gone
      const afterUpdate = await get(cacheKey);
      assert.equal(afterUpdate, null);

      // Calling getPropertyById must now 404 and NEVER populate cache
      await assert.rejects(
        () => propertiesService.getPropertyById(testProperty.id),
        (err) => {
          assert.equal(err.code, 'PROPERTY_NOT_FOUND');
          return true;
        },
      );

      assert.equal(await get(cacheKey), null);

      // Restore status to ACTIVE for subsequent tests
      await propertiesService.updateProperty(
        testProperty.id,
        { status: 'ACTIVE' },
        hostUser,
      );
    });

    it('never caches not-found results (404s)', async () => {
      const nonExistentId = crypto.randomUUID();
      const cacheKey = `cache:property:${nonExistentId}`;

      await assert.rejects(
        () => propertiesService.getPropertyById(nonExistentId),
        (err) => {
          assert.equal(err.code, 'PROPERTY_NOT_FOUND');
          return true;
        },
      );

      const cached = await get(cacheKey);
      assert.equal(cached, null);
    });

    it('Redis outage: reads still return correct data from PostgreSQL', async () => {
      setRedisDisabledForTesting(true);

      const prop = await propertiesService.getPropertyById(testProperty.id);
      assert.equal(prop.id, testProperty.id);

      const list = await propertiesService.listProperties({ location: 'goa' });
      assert.ok(Array.isArray(list.properties));
      assert.ok(list.properties.some((p) => p.id === testProperty.id));
    });

    it('availability endpoint is never cached', async () => {
      const res = await request(app)
        .get(`/api/v1/properties/${testProperty.id}/availability`)
        .query({
          from: '2026-12-01T00:00:00.000Z',
          to: '2026-12-10T00:00:00.000Z',
        });

      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'no-store');

      const availKey = await get(`cache:availability:${testProperty.id}`);
      assert.equal(availKey, null);
    });

    it('rate limiter fails open and /readyz reports degraded (200) when Redis is stopped', async () => {
      setRedisDisabledForTesting(true);

      // 1. Rate limiter fails open: request succeeds rather than blocking
      const authRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'non_existent@example.com', password: 'Password123!' });

      // Returns normal 401 INVALID_CREDENTIALS, not 500 or rate limiter block
      assert.equal(authRes.status, 401);
      assert.equal(authRes.body.error.code, 'INVALID_CREDENTIALS');

      // 2. /readyz returns 200 degraded because PostgreSQL is up even if Redis is down
      const readyRes = await request(app).get('/readyz');
      assert.equal(readyRes.status, 200);
      assert.equal(readyRes.body.status, 'degraded');
      assert.equal(readyRes.body.postgres, true);
      assert.equal(readyRes.body.redis, false);
    });
  });
});
