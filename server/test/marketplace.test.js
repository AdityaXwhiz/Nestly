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
const { providersRepository } = await import('../src/modules/providers/repository.js');
const { servicesRepository } = await import('../src/modules/services/repository.js');

describe('Marketplace CRUD Test Suite (Properties, Providers, Services)', () => {
  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdProviderIds = [];
  const createdServiceIds = [];

  const uniqueEmail = () => `market_${crypto.randomUUID().slice(0, 8)}@example.com`;

  // Helper to register and login a user with a given role
  async function createAuthenticatedUser(role) {
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

  let hostUser;
  let otherHostUser;
  let customerUser;
  let providerUser;
  let otherProviderUser;
  let adminUser;

  before(async () => {
    hostUser = await createAuthenticatedUser('HOST');
    otherHostUser = await createAuthenticatedUser('HOST');
    customerUser = await createAuthenticatedUser('CUSTOMER');
    providerUser = await createAuthenticatedUser('PROVIDER');
    otherProviderUser = await createAuthenticatedUser('PROVIDER');
    adminUser = await createAuthenticatedUser('ADMIN');
  });

  after(async () => {
    // Cleanup services
    for (const id of createdServiceIds) {
      await servicesRepository.deleteById(id);
    }
    // Cleanup providers
    for (const id of createdProviderIds) {
      await providersRepository.deleteById(id);
    }
    // Cleanup properties
    for (const id of createdPropertyIds) {
      await propertiesRepository.deleteById(id);
    }
    // Cleanup users
    for (const id of createdUserIds) {
      await usersRepository.deleteById(id);
    }
    await pool.end();
    redis.disconnect();
  });

  describe('Properties Module', () => {
    let testPropertyId;

    it('allows HOST to create property owned by caller (201)', async () => {
      const res = await request(app)
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          title: 'Sunset Villa',
          description: 'A beautiful coastal villa for private gatherings',
          location: 'Goa Coastal Road',
          capacity: 50,
          pricing_minor: 1500000,
          currency: 'INR',
          status: 'ACTIVE',
          amenities: ['WiFi', 'Pool', 'Ocean View'],
        });

      assert.equal(res.status, 201);
      assert.ok(res.body.property);
      assert.equal(res.body.property.title, 'Sunset Villa');
      assert.equal(res.body.property.host_id, hostUser.userId);
      assert.equal(res.body.property.capacity, 50);
      assert.equal(res.body.property.pricing_minor, 1500000);
      assert.equal(res.body.property.currency, 'INR');
      assert.deepEqual(res.body.property.amenities.sort(), ['Ocean View', 'Pool', 'WiFi'].sort());

      testPropertyId = res.body.property.id;
      createdPropertyIds.push(testPropertyId);
    });

    it('rejects host_id passed in create request body with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          title: 'Tampered Villa',
          description: 'Attempting to inject host_id into payload',
          location: 'Mumbai Suburbs',
          capacity: 20,
          pricing_minor: 500000,
          host_id: crypto.randomUUID(),
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('blocks CUSTOMER from creating a property with 403 FORBIDDEN', async () => {
      const res = await request(app)
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${customerUser.token}`)
        .send({
          title: 'Customer Villa',
          description: 'Customer should not be able to create property',
          location: 'Delhi',
          capacity: 10,
          pricing_minor: 100000,
        });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('blocks PROVIDER from creating a property with 403 FORBIDDEN', async () => {
      const res = await request(app)
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          title: 'Provider Villa',
          description: 'Provider should not be able to create property',
          location: 'Delhi',
          capacity: 10,
          pricing_minor: 100000,
        });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('rejects invalid capacity (<= 0) or negative price with 400 VALIDATION_ERROR', async () => {
      const resCap = await request(app)
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          title: 'Bad Capacity Villa',
          description: 'Valid description here',
          location: 'Delhi',
          capacity: 0,
          pricing_minor: 10000,
        });
      assert.equal(resCap.status, 400);
      assert.equal(resCap.body.error.code, 'VALIDATION_ERROR');

      const resPrice = await request(app)
        .post('/api/v1/properties')
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          title: 'Bad Price Villa',
          description: 'Valid description here',
          location: 'Delhi',
          capacity: 10,
          pricing_minor: -500,
        });
      assert.equal(resPrice.status, 400);
      assert.equal(resPrice.body.error.code, 'VALIDATION_ERROR');
    });

    it('allows owner HOST to update own property (200)', async () => {
      const res = await request(app)
        .put(`/api/v1/properties/${testPropertyId}`)
        .set('Authorization', `Bearer ${hostUser.token}`)
        .send({
          title: 'Sunset Villa Deluxe',
          capacity: 65,
          amenities: ['WiFi', 'Pool', 'Ocean View', 'Private Chef Kitchen'],
        });

      assert.equal(res.status, 200);
      assert.equal(res.body.property.title, 'Sunset Villa Deluxe');
      assert.equal(res.body.property.capacity, 65);
      assert.ok(res.body.property.amenities.includes('Private Chef Kitchen'));
    });

    it('blocks another HOST from updating property with 403 FORBIDDEN (ownership check)', async () => {
      const res = await request(app)
        .put(`/api/v1/properties/${testPropertyId}`)
        .set('Authorization', `Bearer ${otherHostUser.token}`)
        .send({
          title: 'Hacked Villa',
        });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('allows ADMIN to update any property (200)', async () => {
      const res = await request(app)
        .put(`/api/v1/properties/${testPropertyId}`)
        .set('Authorization', `Bearer ${adminUser.token}`)
        .send({
          status: 'ACTIVE',
          capacity: 70,
        });

      assert.equal(res.status, 200);
      assert.equal(res.body.property.capacity, 70);
    });

    it('allows public to fetch property by ID without token (200)', async () => {
      const res = await request(app).get(`/api/v1/properties/${testPropertyId}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.property.id, testPropertyId);
      assert.equal(res.body.property.status, 'ACTIVE');
      assert.ok(Array.isArray(res.body.property.amenities));
    });

    it('returns 404 for non-existent property ID', async () => {
      const res = await request(app).get(`/api/v1/properties/${crypto.randomUUID()}`);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'PROPERTY_NOT_FOUND');
    });

    it('public list endpoint returns active properties without a token and respects location prefix filter', async () => {
      const res = await request(app).get('/api/v1/properties?location=goa');

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.properties));
      assert.ok(res.body.pagination);
      assert.ok(res.body.properties.some((p) => p.id === testPropertyId));
    });

    it('caps pagination limit at 50 if higher limit requested', async () => {
      const res = await request(app).get('/api/v1/properties?limit=100');

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('Providers Module', () => {
    let testProviderId;

    it('allows PROVIDER to create provider profile (201)', async () => {
      const res = await request(app)
        .post('/api/v1/providers')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          business_name: 'Royal Feast Caterers',
          bio: 'Premium banquet and buffet catering services',
        });

      assert.equal(res.status, 201);
      assert.ok(res.body.provider);
      assert.equal(res.body.provider.business_name, 'Royal Feast Caterers');
      assert.equal(res.body.provider.user_id, providerUser.userId);
      assert.equal(res.body.provider.status, 'ACTIVE');

      testProviderId = res.body.provider.id;
      createdProviderIds.push(testProviderId);
    });

    it('rejects a second provider profile for same user with 409 PROVIDER_ALREADY_EXISTS', async () => {
      const res = await request(app)
        .post('/api/v1/providers')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          business_name: 'Second Profile Attempt',
        });

      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'PROVIDER_ALREADY_EXISTS');
    });

    it('rejects user_id in provider create body with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/providers')
        .set('Authorization', `Bearer ${otherProviderUser.token}`)
        .send({
          business_name: 'Other Caterer',
          user_id: crypto.randomUUID(),
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('Services Module', () => {
    let testServiceId;

    it('rejects service creation if caller has no provider profile (400)', async () => {
      // otherProviderUser has not created a provider profile yet
      const res = await request(app)
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${otherProviderUser.token}`)
        .send({
          title: 'Orphan Service',
          description: 'Cannot be created without provider profile',
          category: 'catering',
          kind: 'capacity',
          capacity: 100,
          price_minor: 50000,
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'PROVIDER_PROFILE_REQUIRED');
    });

    it('rejects capacity service without positive capacity with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          title: 'Buffet without capacity',
          description: 'Invalid capacity-based service payload',
          category: 'catering',
          kind: 'capacity',
          price_minor: 50000,
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('allows PROVIDER to create valid capacity-based service (201)', async () => {
      const res = await request(app)
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          name: 'Grand Wedding Buffet',
          description: 'Multi-course luxury banquet for large wedding parties',
          category: 'catering',
          kind: 'capacity',
          capacity: 250,
          duration_minutes: 240,
          price_minor: 120000,
          currency: 'INR',
        });

      assert.equal(res.status, 201);
      assert.ok(res.body.service);
      assert.equal(res.body.service.title, 'Grand Wedding Buffet');
      assert.equal(res.body.service.kind, 'capacity');
      assert.equal(res.body.service.capacity, 250);
      assert.equal(res.body.service.price_minor, 120000);
      assert.equal(res.body.service.currency, 'INR');

      testServiceId = res.body.service.id;
      createdServiceIds.push(testServiceId);
    });

    it('rejects provider_id in service create body with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          title: 'Tampered Service',
          description: 'Injecting provider_id into request body',
          category: 'photography',
          kind: 'exclusive',
          price_minor: 50000,
          provider_id: crypto.randomUUID(),
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('allows owner PROVIDER to update service (200)', async () => {
      const res = await request(app)
        .put(`/api/v1/services/${testServiceId}`)
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          title: 'Grand Wedding Buffet Platinum',
          capacity: 300,
          price_minor: 140000,
        });

      assert.equal(res.status, 200);
      assert.equal(res.body.service.title, 'Grand Wedding Buffet Platinum');
      assert.equal(res.body.service.capacity, 300);
      assert.equal(res.body.service.price_minor, 140000);
    });

    it('validates kind/capacity against merged values on service update', async () => {
      // Switching to capacity without providing capacity should fail if existing was exclusive
      const exclRes = await request(app)
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          title: 'Solo Photographer',
          description: 'Single photographer event coverage',
          category: 'photography',
          kind: 'exclusive',
          price_minor: 80000,
        });
      assert.equal(exclRes.status, 201);
      const exclId = exclRes.body.service.id;
      createdServiceIds.push(exclId);

      // Attempt to change kind to capacity without passing a positive capacity
      const updateRes = await request(app)
        .put(`/api/v1/services/${exclId}`)
        .set('Authorization', `Bearer ${providerUser.token}`)
        .send({
          kind: 'capacity',
        });

      assert.equal(updateRes.status, 400);
      assert.equal(updateRes.body.error.code, 'VALIDATION_ERROR');
    });

    it('blocks another PROVIDER from updating service with 403 FORBIDDEN', async () => {
      // Create profile for otherProviderUser
      const pRes = await request(app)
        .post('/api/v1/providers')
        .set('Authorization', `Bearer ${otherProviderUser.token}`)
        .send({
          business_name: 'Distinct Caterer',
        });
      createdProviderIds.push(pRes.body.provider.id);

      const res = await request(app)
        .put(`/api/v1/services/${testServiceId}`)
        .set('Authorization', `Bearer ${otherProviderUser.token}`)
        .send({
          title: 'Hacked Service Title',
        });

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('allows ADMIN to update service owned by another provider (200)', async () => {
      const res = await request(app)
        .put(`/api/v1/services/${testServiceId}`)
        .set('Authorization', `Bearer ${adminUser.token}`)
        .send({
          price_minor: 150000,
        });

      assert.equal(res.status, 200);
      assert.equal(res.body.service.price_minor, 150000);
    });

    it('public list services works without token and filters by category and max_price', async () => {
      const res = await request(app).get(
        '/api/v1/services?category=catering&max_price=200000',
      );

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.services));
      assert.ok(res.body.pagination);
      assert.ok(res.body.services.some((s) => s.id === testServiceId));
    });
  });
});
