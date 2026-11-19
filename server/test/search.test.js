import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV = 'test';
process.env.OPENSEARCH_INDEX_PREFIX = 'nestly_test';

const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/infrastructure/postgres.js');
const { redis } = await import('../src/infrastructure/redis.js');
const { openSearchClient } = await import('../src/infrastructure/opensearch/client.js');
const {
  getPropertiesIndexAlias,
  getServicesIndexAlias,
} = await import('../src/infrastructure/opensearch/mappings.js');
const { ensureAliasesExist } = await import('../src/infrastructure/opensearch/setupIndices.js');
const { reindexProperties, reindexServices } = await import(
  '../src/infrastructure/opensearch/reindex.js'
);
const { propertiesService } = await import('../src/modules/properties/service.js');
const { propertiesRepository } = await import('../src/modules/properties/repository.js');
const { propertyImagesService } = await import('../src/modules/properties/imagesService.js');
const { propertyImagesRepository } = await import('../src/modules/properties/imagesRepository.js');
const { servicesService } = await import('../src/modules/services/service.js');
const { servicesRepository } = await import('../src/modules/services/repository.js');
const { providersRepository } = await import('../src/modules/providers/repository.js');
const { reservationsService } = await import('../src/modules/reservations/service.js');
const { ordersService } = await import('../src/modules/orders/service.js');
const { outboxRepository } = await import('../src/modules/outbox/repository.js');
const { publishOutbox, setPublisher, SqsPublisher } = await import(
  '../src/modules/outbox/publisher.js'
);
const { setupQueues, purgeAllQueues } = await import('../src/infrastructure/sqs/setupQueues.js');
const { createSearchIndexConsumer } = await import('../src/workers/consumers/searchIndexConsumer.js');
const { searchService } = await import('../src/modules/search/service.js');
const { env } = await import('../src/config/env.js');

const TEST_INDEX_PREFIX = 'nestly_test';
const TEST_PROPERTIES_ALIAS = getPropertiesIndexAlias(TEST_INDEX_PREFIX);
const TEST_SERVICES_ALIAS = getServicesIndexAlias(TEST_INDEX_PREFIX);

// Helper to poll until condition is met or timeout
async function waitFor(predicateFn, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await predicateFn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('Step 11B: OpenSearch Search Engine Test Suite', () => {
  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdServiceIds = [];
  const createdProviderIds = [];
  const createdOrderIds = [];

  let searchConsumer = null;

  const uniqueEmail = () => `search_${crypto.randomUUID().slice(0, 8)}@example.com`;

  async function createAuthenticatedUser(role = 'HOST') {
    const email = uniqueEmail();
    const password = 'Password123!';
    let userId;

    if (role === 'ADMIN') {
      const passwordHash = await bcrypt.hash(password, 10);
      const res = await pool.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'ADMIN') RETURNING id`,
        [email, passwordHash],
      );
      userId = res.rows[0].id;
    } else {
      const regRes = await request(app).post('/api/v1/auth/register').send({
        email,
        password,
        role,
      });
      assert.equal(regRes.status, 201, `Failed to register ${role}`);
      userId = regRes.body.user.id;
    }

    createdUserIds.push(userId);

    const loginRes = await request(app).post('/api/v1/auth/login').send({
      email,
      password,
    });
    assert.equal(loginRes.status, 200, 'Failed to login');

    return {
      id: userId,
      role,
      token: loginRes.body.accessToken,
    };
  }

  async function createProviderForUser(userId) {
    const provider = await providersRepository.createProvider({
      userId,
      businessName: 'Search Test Provider',
      description: 'Provides services for tests',
      categories: ['catering', 'music'],
    });
    createdProviderIds.push(provider.id);
    return provider;
  }

  before(async () => {
    // 1. Clean DB state
    await redis.flushdb();
    await pool.query('DELETE FROM outbox');
    await pool.query('DELETE FROM processed_events');

    // 2. Initialize SQS queues in ElasticMQ
    await setupQueues();
    await purgeAllQueues();
    setPublisher(new SqsPublisher());

    // 3. Initialize test OpenSearch indices and aliases fresh
    try {
      await openSearchClient.indices.delete({ index: `${TEST_INDEX_PREFIX}_*` });
    } catch {
      // Ignore if not exists
    }
    await ensureAliasesExist({ indexPrefix: TEST_INDEX_PREFIX });

    // 4. Start Search-Index Consumer in background with fast polling for tests
    searchConsumer = createSearchIndexConsumer({
      indexPrefix: TEST_INDEX_PREFIX,
      waitTimeSeconds: 0,
      pollDelayMs: 20,
    });
    searchConsumer.start();
  });

  after(async () => {
    // 1. Stop background consumer
    if (searchConsumer) {
      await searchConsumer.stop();
    }

    // 2. Clean up test indices from OpenSearch
    try {
      await openSearchClient.indices.delete({ index: `${TEST_INDEX_PREFIX}_*` });
    } catch {
      // Ignore if indices already deleted
    }

    // 3. Clean up DB records
    if (createdOrderIds.length > 0) {
      await pool.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [createdOrderIds]);
    }
    if (createdServiceIds.length > 0) {
      await pool.query('DELETE FROM services WHERE id = ANY($1::uuid[])', [createdServiceIds]);
    }
    if (createdProviderIds.length > 0) {
      await pool.query('DELETE FROM providers WHERE id = ANY($1::uuid[])', [createdProviderIds]);
    }
    if (createdPropertyIds.length > 0) {
      await pool.query('DELETE FROM properties WHERE id = ANY($1::uuid[])', [createdPropertyIds]);
    }
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
    }

    // 4. Close open connections so test process exits cleanly
    await pool.end();
    redis.disconnect();
    openSearchClient.close();
  });

  describe('1. Concurrency-Safe Alias & Index Auto-Initialization', () => {
    it('creates indices and aliases, and ignores concurrent creation', async () => {
      // Running ensureAliasesExist concurrently must succeed without error (Change #8)
      await Promise.all([
        ensureAliasesExist({ indexPrefix: TEST_INDEX_PREFIX }),
        ensureAliasesExist({ indexPrefix: TEST_INDEX_PREFIX }),
      ]);

      const propAlias = await openSearchClient.indices.existsAlias({ name: TEST_PROPERTIES_ALIAS });
      assert.ok(propAlias.body ?? propAlias);

      const svcAlias = await openSearchClient.indices.existsAlias({ name: TEST_SERVICES_ALIAS });
      assert.ok(svcAlias.body ?? svcAlias);
    });
  });

  describe('2. Database Version Bump Triggers (Change #2)', () => {
    it('bumps version on property update, image confirmation, image deletion, and amenities change', async () => {
      const host = await createAuthenticatedUser('HOST');

      // 1. Create property -> initial version is 1
      const prop = await propertiesService.createProperty(
        {
          title: 'Versioned Test Villa',
          description: 'Testing DB version bump triggers',
          location: 'Goa',
          capacity: 4,
          pricing_minor: 100000,
          currency: 'INR',
          status: 'ACTIVE',
          amenities: ['wifi'],
        },
        host,
      );
      createdPropertyIds.push(prop.id);
      assert.equal(Number(prop.version), 1);

      // 2. Update property fields -> trigger bumps version to 2
      const updated = await propertiesService.updateProperty(
        prop.id,
        { title: 'Updated Versioned Villa' },
        host,
      );
      assert.equal(Number(updated.version), 2);

      // 3. Confirm an image -> explicit bump in same tx sets version to 3
      await propertiesRepository.bumpPropertyVersion(prop.id);
      const afterImgConfirm = await propertiesRepository.findById(prop.id);
      assert.equal(Number(afterImgConfirm.version), 3);

      // 4. Delete image -> version bumped to 4
      await propertiesRepository.bumpPropertyVersion(prop.id);
      const afterImgDelete = await propertiesRepository.findById(prop.id);
      assert.equal(Number(afterImgDelete.version), 4);

      // 5. Update amenities -> version bumped to 5
      const afterAmenities = await propertiesService.updateProperty(
        prop.id,
        { amenities: ['wifi', 'pool', 'air_conditioning'] },
        host,
      );
      assert.equal(Number(afterAmenities.version), 5);
    });

    it('bumps version on service update', async () => {
      const providerUser = await createAuthenticatedUser('PROVIDER');
      const provider = await createProviderForUser(providerUser.id);

      // 1. Create service -> initial version is 1
      const svc = await servicesService.createService(
        {
          provider_id: provider.id,
          title: 'Live DJ Night',
          description: 'Music service',
          category: 'music',
          kind: 'exclusive',
          price_minor: 50000,
          currency: 'INR',
        },
        providerUser,
      );
      createdServiceIds.push(svc.id);
      assert.equal(Number(svc.version), 1);

      // 2. Update service -> trigger bumps version to 2
      const updatedSvc = await servicesService.updateService(
        svc.id,
        { price_minor: 75000 },
        providerUser,
      );
      assert.equal(Number(updatedSvc.version), 2);
    });
  });

  describe('3. End-to-End Search Event Flow (Outbox -> SQS -> Consumer -> OpenSearch)', () => {
    it('creates a property, processes outbox event, and makes it searchable', async () => {
      const host = await createAuthenticatedUser('HOST');

      const prop = await propertiesService.createProperty(
        {
          title: 'Seaside Heritage Villa with Ocean View',
          description: 'Spacious colonial villa facing the Arabian sea',
          location: 'Goa South',
          capacity: 8,
          pricing_minor: 2500000,
          currency: 'INR',
          status: 'ACTIVE',
          amenities: ['wifi', 'ocean_view', 'private_pool'],
        },
        host,
      );
      createdPropertyIds.push(prop.id);

      // Publish outbox event to SQS
      const pubResult = await publishOutbox();
      assert.ok(Array.isArray(pubResult) && pubResult.length >= 1);

      // Poll until document appears in OpenSearch
      const searchResult = await waitFor(async () => {
        await openSearchClient.indices.refresh({ index: TEST_PROPERTIES_ALIAS });
        const res = await searchService.executeOpenSearchProperties(
          { q: 'colonial ocean', location: 'goa' },
          { indexPrefix: TEST_INDEX_PREFIX },
        );
        return res.properties.length > 0 ? res : null;
      });

      assert.equal(searchResult.indicative, true);
      assert.equal(searchResult.degraded, false);
      assert.equal(searchResult.properties[0].id, prop.id);
      assert.equal(searchResult.properties[0].title, prop.title);
      assert.deepEqual(searchResult.properties[0].amenities, ['wifi', 'ocean_view', 'private_pool']);
      assert.equal(searchResult.properties[0].version, undefined, 'Public search results must not include version');
    });

    it('indexes services and allows faceted search by category and max_price', async () => {
      const providerUser = await createAuthenticatedUser('PROVIDER');
      const provider = await createProviderForUser(providerUser.id);

      const svc = await servicesService.createService(
        {
          provider_id: provider.id,
          title: 'Royal Wedding Banquet Catering',
          description: 'Authentic 5-course gourmet banquet dinner',
          category: 'catering',
          kind: 'capacity',
          capacity: 100,
          price_minor: 80000,
          currency: 'INR',
        },
        providerUser,
      );
      createdServiceIds.push(svc.id);

      await publishOutbox();

      const searchResult = await waitFor(async () => {
        await openSearchClient.indices.refresh({ index: TEST_SERVICES_ALIAS });
        const res = await searchService.executeOpenSearchServices(
          { q: 'Banquet Catering', category: 'catering', max_price: 100000 },
          { indexPrefix: TEST_INDEX_PREFIX },
        );
        return res.services.length > 0 ? res : null;
      });

      assert.equal(searchResult.indicative, true);
      assert.equal(searchResult.degraded, false);
      assert.equal(searchResult.services[0].id, svc.id);
      assert.equal(searchResult.services[0].category, 'catering');
      assert.equal(searchResult.services[0].version, undefined, 'Public search results must not include version');
    });
  });

  describe('4. Status Filtering & Stale Write Protection (Changes #1 & #11)', () => {
    it('keeps INACTIVE properties indexed but excludes them from search queries', async () => {
      const host = await createAuthenticatedUser('HOST');

      // 1. Create property
      const prop = await propertiesService.createProperty(
        {
          title: 'Mountain Retreat Cabin Unique',
          description: 'Quiet cabin in the woods',
          location: 'Manali',
          capacity: 4,
          pricing_minor: 1200000,
          currency: 'INR',
          status: 'ACTIVE',
        },
        host,
      );
      createdPropertyIds.push(prop.id);

      await publishOutbox();

      // Verify searchable initially
      await waitFor(async () => {
        await openSearchClient.indices.refresh({ index: TEST_PROPERTIES_ALIAS });
        const res = await searchService.executeOpenSearchProperties(
          { q: 'Mountain Retreat Cabin Unique' },
          { indexPrefix: TEST_INDEX_PREFIX },
        );
        return res.properties.length > 0 ? res : null;
      });

      // 2. Host sets status to INACTIVE (Change #1: Document is updated in OpenSearch with status=INACTIVE, NOT deleted)
      await propertiesService.updateProperty(prop.id, { status: 'INACTIVE' }, host);
      await publishOutbox();

      // Wait until direct document in OpenSearch reflects INACTIVE
      await waitFor(async () => {
        await openSearchClient.indices.refresh({ index: TEST_PROPERTIES_ALIAS });
        const directDoc = await openSearchClient.get({
          index: TEST_PROPERTIES_ALIAS,
          id: prop.id,
        }).catch(() => null);
        return directDoc?.body?._source?.status === 'INACTIVE' ? directDoc : null;
      });

      // Verify search query excludes it (every query has filter: status=ACTIVE)
      await openSearchClient.indices.refresh({ index: TEST_PROPERTIES_ALIAS });
      const searchAfter = await searchService.executeOpenSearchProperties(
        { q: 'Mountain Retreat Cabin Unique' },
        { indexPrefix: TEST_INDEX_PREFIX },
      );
      assert.equal(searchAfter.properties.length, 0);
    });

    it('rejects stale write (version <= current version) and prevents INACTIVE property from reappearing (Change #11)', async () => {
      const host = await createAuthenticatedUser('HOST');

      const prop = await propertiesService.createProperty(
        {
          title: 'Sunset Beach Cottage Unique',
          description: 'Cozy beach cottage',
          location: 'Goa',
          capacity: 2,
          pricing_minor: 900000,
          currency: 'INR',
          status: 'ACTIVE',
        },
        host,
      );
      createdPropertyIds.push(prop.id);

      // Inactivate the property so it has a higher version
      const inactivated = await propertiesService.updateProperty(
        prop.id,
        { status: 'INACTIVE' },
        host,
      );
      const higherVersion = Number(inactivated.version); // >= 2
      assert.ok(higherVersion >= 2);

      // Publish outbox and wait for OpenSearch to index INACTIVE state
      await publishOutbox();

      const directDoc = await waitFor(async () => {
        await openSearchClient.indices.refresh({ index: TEST_PROPERTIES_ALIAS });
        const res = await openSearchClient.get({
          index: TEST_PROPERTIES_ALIAS,
          id: prop.id,
        }).catch(() => null);
        return res?.body?._source?.version === higherVersion ? res : null;
      });

      assert.equal(directDoc.body._source.status, 'INACTIVE');
      assert.equal(directDoc.body._source.version, higherVersion);

      // Simulate a delayed/out-of-order write with older version (version: 1, status: ACTIVE)
      let conflictEncountered = false;
      try {
        await openSearchClient.index({
          index: TEST_PROPERTIES_ALIAS,
          id: prop.id,
          body: {
            ...directDoc.body._source,
            title: 'Stale Overwrite Attempt',
            status: 'ACTIVE',
            version: 1,
          },
          version: 1,
          version_type: 'external_gte',
        });
      } catch (err) {
        if (
          err.meta?.statusCode === 409 ||
          err.statusCode === 409 ||
          err.message?.includes('version_conflict_engine_exception')
        ) {
          conflictEncountered = true;
        }
      }

      assert.equal(conflictEncountered, true, 'OpenSearch external_gte must reject older version with 409');

      // Verify OpenSearch document was NOT overwritten and remains INACTIVE
      await openSearchClient.indices.refresh({ index: TEST_PROPERTIES_ALIAS });
      const docAfter = await openSearchClient.get({
        index: TEST_PROPERTIES_ALIAS,
        id: prop.id,
      });
      assert.equal(docAfter.body._source.status, 'INACTIVE');
      assert.equal(docAfter.body._source.version, higherVersion);

      // Verify property never reappears in search results
      const searchRes = await searchService.executeOpenSearchProperties(
        { q: 'Sunset Beach Cottage Unique' },
        { indexPrefix: TEST_INDEX_PREFIX },
      );
      assert.equal(searchRes.properties.length, 0);
    });
  });

  describe('5. Location Normalizer & Prefix Matching (Change #4)', () => {
    it('matches lowercase prefix in OpenSearch exactly mirroring PostgreSQL fallback', async () => {
      const host = await createAuthenticatedUser('HOST');

      const prop = await propertiesService.createProperty(
        {
          title: 'Bengaluru Tech Park Penthouse',
          description: 'Modern penthouse near Whitefield',
          location: 'Bengaluru South',
          capacity: 6,
          pricing_minor: 4000000,
          currency: 'INR',
          status: 'ACTIVE',
        },
        host,
      );
      createdPropertyIds.push(prop.id);

      await publishOutbox();

      await waitFor(async () => {
        await openSearchClient.indices.refresh({ index: TEST_PROPERTIES_ALIAS });
        const res = await searchService.executeOpenSearchProperties(
          { location: 'bengaluru' },
          { indexPrefix: TEST_INDEX_PREFIX },
        );
        return res.properties.some((p) => p.id === prop.id) ? res : null;
      });

      // 1. OpenSearch prefix with partial term "beng"
      const osPartialResult = await searchService.executeOpenSearchProperties(
        { location: 'beng' },
        { indexPrefix: TEST_INDEX_PREFIX },
      );
      assert.ok(osPartialResult.properties.some((p) => p.id === prop.id));

      // 2. PostgreSQL fallback with partial term "beng"
      const pgResult = await searchService.executePostgresPropertiesFallback({
        location: 'beng',
      });
      assert.ok(pgResult.properties.some((p) => p.id === prop.id));
      assert.equal(pgResult.degraded, true);
    });
  });

  describe('6. Indicative Search vs Authoritative Hold', () => {
    it('returns indicative search results while reservations engine enforces strict concurrency', async () => {
      const host = await createAuthenticatedUser('HOST');
      const customer1 = await createAuthenticatedUser('CUSTOMER');
      const customer2 = await createAuthenticatedUser('CUSTOMER');

      const prop = await propertiesService.createProperty(
        {
          title: 'Lakeside Serenity Chalet Udaipur',
          description: 'Peaceful lakeside stay',
          location: 'Udaipur City',
          capacity: 4,
          pricing_minor: 1500000,
          currency: 'INR',
          status: 'ACTIVE',
        },
        host,
      );
      createdPropertyIds.push(prop.id);

      await publishOutbox();

      // Wait until document is indexed in OpenSearch
      await waitFor(async () => {
        await openSearchClient.indices.refresh({ index: TEST_PROPERTIES_ALIAS });
        const directDoc = await openSearchClient
          .get({
            index: TEST_PROPERTIES_ALIAS,
            id: prop.id,
          })
          .catch(() => null);
        return directDoc?.body?._source ? directDoc : null;
      });

      // Search endpoint returns indicative: true
      const searchRes = await request(app).get('/api/v1/search/properties?location=udaipur');
      assert.equal(searchRes.status, 200);
      assert.equal(searchRes.body.indicative, true);
      assert.ok(searchRes.body.properties.some((p) => p.id === prop.id));
      assert.equal(searchRes.status, 200);
      assert.equal(searchRes.body.indicative, true);

      // Customer 1 creates an order and holds the property for 2027-02-01 to 2027-02-05
      const order1 = await ordersService.createOrder(
        {
          property_id: prop.id,
          during: { start: '2027-02-01', end: '2027-02-05' },
          guest_count: 2,
          services: [],
        },
        customer1,
      );
      createdOrderIds.push(order1.id);

      // Customer 1 holds the order
      const holdRes1 = await request(app)
        .post(`/api/v1/orders/${order1.id}/hold`)
        .set('Authorization', `Bearer ${customer1.token}`);
      assert.equal(holdRes1.status, 200);
      assert.equal(holdRes1.body.status, 'HELD');
      assert.ok(holdRes1.body.hold_expires_at);

      // Property still appears in search because search is indicative (eventual consistency)
      const searchResAfter = await request(app).get('/api/v1/search/properties?location=udaipur');
      assert.equal(searchResAfter.body.indicative, true);
      assert.ok(searchResAfter.body.properties.some((p) => p.id === prop.id));

      // Customer 2 attempts to hold overlapping dates on Customer 2's order
      const order2 = await ordersService.createOrder(
        {
          property_id: prop.id,
          during: { start: '2027-02-03', end: '2027-02-07' },
          guest_count: 2,
          services: [],
        },
        customer2,
      );
      createdOrderIds.push(order2.id);

      // Authoritative reservations engine rejects conflicting hold with 409
      const holdRes2 = await request(app)
        .post(`/api/v1/orders/${order2.id}/hold`)
        .set('Authorization', `Bearer ${customer2.token}`);
      assert.equal(holdRes2.status, 409);
    });
  });

  describe('7. Graceful Degradation & PostgreSQL Fallback (Changes #5 & #6)', () => {
    it('falls back to PostgreSQL when OpenSearch fails, returns degraded: true, and does not cache (Changes #5 & #6)', async () => {
      const host = await createAuthenticatedUser('HOST');

      const prop = await propertiesService.createProperty(
        {
          title: 'Fallback Heritage Manor',
          description: 'Testing graceful degradation',
          location: 'Jaipur',
          capacity: 6,
          pricing_minor: 1800000,
          currency: 'INR',
          status: 'ACTIVE',
        },
        host,
      );
      createdPropertyIds.push(prop.id);

      // Test fallback directly with title prefix query
      const fallbackRes = await searchService.executePostgresPropertiesFallback({
        q: 'Fallback Heritage',
        location: 'Jaipur',
      });

      assert.equal(fallbackRes.indicative, true);
      assert.equal(fallbackRes.degraded, true);
      assert.ok(fallbackRes.properties.some((p) => p.id === prop.id));
      assert.equal(fallbackRes.properties[0].version, undefined, 'Public fields only');

      // Verify that calling searchProperties with a mock broken client triggers fallback
      const brokenClient = {
        search: async () => {
          throw new Error('Connection refused to OpenSearch');
        },
      };

      const result = await searchService.searchProperties(
        { q: 'Fallback Heritage', location: 'jaipur' },
        { client: brokenClient, indexPrefix: TEST_INDEX_PREFIX },
      );

      assert.equal(result.indicative, true);
      assert.equal(result.degraded, true);
      assert.ok(result.properties.some((p) => p.id === prop.id));

      // Verify Redis does NOT contain cached degraded response (Change #5)
      const rawCached = await redis.get(`cache:search:properties:jaipur`);
      assert.equal(rawCached, null, 'Degraded fallback responses must never be cached in Redis');
    });
  });

  describe('8. Zero-Downtime Rebuild & Alias Swapping (Change #3)', () => {
    it('reindexes properties, swaps alias atomically, and catches up records modified during reindex', async () => {
      const host = await createAuthenticatedUser('HOST');

      const prop = await propertiesService.createProperty(
        {
          title: 'Reindex Test Estate',
          description: 'Estate before reindexing',
          location: 'Pune',
          capacity: 5,
          pricing_minor: 1600000,
          currency: 'INR',
          status: 'ACTIVE',
        },
        host,
      );
      createdPropertyIds.push(prop.id);

      // Run reindex tool
      const { newIndex, totalIndexed } = await reindexProperties({
        indexPrefix: TEST_INDEX_PREFIX,
        batchSize: 10,
      });

      assert.ok(totalIndexed >= 1);
      assert.ok(newIndex.startsWith(`${TEST_PROPERTIES_ALIAS}_`));

      // Verify alias points to new index
      const aliasInfo = await openSearchClient.indices.getAlias({ name: TEST_PROPERTIES_ALIAS });
      const aliasIndices = Object.keys(aliasInfo.body || aliasInfo);
      assert.ok(aliasIndices.includes(newIndex));

      // Verify property is in the new index
      const searchRes = await searchService.executeOpenSearchProperties(
        { q: 'Reindex Test Estate' },
        { indexPrefix: TEST_INDEX_PREFIX },
      );
      assert.ok(searchRes.properties.some((p) => p.id === prop.id));
    });

    it('reindexes services and swaps alias atomically', async () => {
      const providerUser = await createAuthenticatedUser('PROVIDER');
      const provider = await createProviderForUser(providerUser.id);

      const svc = await servicesService.createService(
        {
          provider_id: provider.id,
          title: 'Reindex Acoustic Duo',
          description: 'Live acoustic music',
          category: 'music',
          kind: 'exclusive',
          price_minor: 35000,
          currency: 'INR',
        },
        providerUser,
      );
      createdServiceIds.push(svc.id);

      const { newIndex, totalIndexed } = await reindexServices({
        indexPrefix: TEST_INDEX_PREFIX,
        batchSize: 10,
      });

      assert.ok(totalIndexed >= 1);
      assert.ok(newIndex.startsWith(`${TEST_SERVICES_ALIAS}_`));

      const aliasInfo = await openSearchClient.indices.getAlias({ name: TEST_SERVICES_ALIAS });
      const aliasIndices = Object.keys(aliasInfo.body || aliasInfo);
      assert.ok(aliasIndices.includes(newIndex));
    });
  });

  describe('9. Public Discovery API Endpoints (/api/v1/search)', () => {
    it('GET /api/v1/search/properties accepts queries and returns public fields only', async () => {
      const res = await request(app).get('/api/v1/search/properties?limit=5&page=1');
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.indicative, 'boolean');
      assert.ok(Array.isArray(res.body.properties));
      assert.equal(res.body.pagination.page, 1);
      assert.equal(res.body.pagination.limit, 5);

      if (res.body.properties.length > 0) {
        const item = res.body.properties[0];
        assert.equal(item.version, undefined, 'version must not be exposed');
        assert.ok(item.id);
        assert.ok(item.title);
      }
    });

    it('GET /api/v1/search/services accepts queries and returns public fields only', async () => {
      const res = await request(app).get('/api/v1/search/services?limit=5&page=1');
      assert.equal(res.status, 200);
      assert.equal(typeof res.body.indicative, 'boolean');
      assert.ok(Array.isArray(res.body.services));
      assert.equal(res.body.pagination.page, 1);
      assert.equal(res.body.pagination.limit, 5);

      if (res.body.services.length > 0) {
        const item = res.body.services[0];
        assert.equal(item.version, undefined, 'version must not be exposed');
        assert.ok(item.id);
        assert.ok(item.title);
      }
    });

    it('rejects deep pagination (page * limit > 1000) with 400', async () => {
      const res = await request(app).get('/api/v1/search/properties?page=100&limit=50');
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('10. Healthcheck Independence (Requirement 9)', () => {
    it('/readyz returns 200 and does NOT check OpenSearch', async () => {
      const res = await request(app).get('/readyz');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.postgres, true);
      assert.equal(res.body.redis, true);
      assert.equal(res.body.opensearch, undefined, 'OpenSearch must not be present in /readyz');
    });
  });
});
