import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// Ensure test environment
process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/infrastructure/postgres.js');
const { redis } = await import('../src/infrastructure/redis.js');
const { usersRepository } = await import('../src/modules/users/repository.js');
const { env } = await import('../src/config/env.js');

describe('Auth & RBAC Test Suite', () => {
  const createdUserIds = [];

  // Helper to generate unique email
  const uniqueEmail = () => `test_${crypto.randomUUID().slice(0, 8)}@example.com`;

  after(async () => {
    // Cleanup created users
    for (const id of createdUserIds) {
      await usersRepository.deleteById(id);
    }
    await pool.end();
    redis.disconnect();
  });

  describe('POST /api/v1/auth/register', () => {
    it('registers a customer successfully (201) and omits password_hash', async () => {
      const email = uniqueEmail();
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: `  ${email.toUpperCase()}  `, // Test trim & lowercase
          password: 'Password123!',
          role: 'CUSTOMER',
        });

      assert.equal(res.status, 201);
      assert.ok(res.body.user);
      assert.equal(res.body.user.email, email.toLowerCase());
      assert.equal(res.body.user.role, 'CUSTOMER');
      assert.equal(res.body.user.password_hash, undefined);
      assert.ok(res.body.user.id);

      createdUserIds.push(res.body.user.id);
    });

    it('rejects duplicate email with 409 EMAIL_TAKEN', async () => {
      const email = uniqueEmail();
      const first = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: 'Password123!', role: 'CUSTOMER' });

      assert.equal(first.status, 201);
      createdUserIds.push(first.body.user.id);

      const duplicate = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: 'Password123!', role: 'CUSTOMER' });

      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.body.error.code, 'EMAIL_TAKEN');
      assert.ok(duplicate.body.error.requestId);
    });

    it('rejects ADMIN role self-registration with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail(),
          password: 'Password123!',
          role: 'ADMIN',
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects short passwords (< 8 chars) with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail(),
          password: 'short',
          role: 'CUSTOMER',
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects passwords > 72 chars with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail(),
          password: 'a'.repeat(73),
          role: 'CUSTOMER',
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects malformed email format with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'not-an-email',
          password: 'Password123!',
          role: 'CUSTOMER',
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects unknown fields with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail(),
          password: 'Password123!',
          role: 'CUSTOMER',
          extraField: 'malicious_input',
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/auth/login', () => {
    const password = 'CorrectPassword123!';
    let registeredEmail;

    before(async () => {
      registeredEmail = uniqueEmail();
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: registeredEmail, password, role: 'CUSTOMER' });
      createdUserIds.push(res.body.user.id);
    });

    it('logs in successfully and returns JWT access token (200)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: registeredEmail, password });

      assert.equal(res.status, 200);
      assert.ok(res.body.accessToken);
      assert.equal(res.body.tokenType, 'Bearer');
      assert.equal(res.body.expiresIn, '15m');

      // Verify token payload
      const decoded = jwt.verify(res.body.accessToken, env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
        audience: env.JWT_AUDIENCE,
      });
      assert.equal(decoded.role, 'CUSTOMER');
      assert.ok(decoded.sub);
    });

    it('rejects incorrect password with 401 INVALID_CREDENTIALS', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: registeredEmail, password: 'WrongPassword999!' });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(res.body.error.message, 'Invalid email or password');
    });

    it('rejects non-existent email with identical 401 INVALID_CREDENTIALS', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'non_existent_user_999@example.com', password });

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(res.body.error.message, 'Invalid email or password');
    });
  });

  describe('GET /api/v1/auth/me', () => {
    let token;
    let userId;

    before(async () => {
      const email = uniqueEmail();
      const reg = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: 'Password123!', role: 'CUSTOMER' });
      userId = reg.body.user.id;
      createdUserIds.push(userId);

      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'Password123!' });
      token = login.body.accessToken;
    });

    it('returns current user profile when valid token provided (200)', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.ok(res.body.user);
      assert.equal(res.body.user.id, userId);
      assert.equal(res.body.user.password_hash, undefined);
    });

    it('fails with 401 UNAUTHORIZED when no token is provided', async () => {
      const res = await request(app).get('/api/v1/auth/me');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });

    it('fails with 401 INVALID_TOKEN when token is malformed or tampered', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer invalid.tampered.token');

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_TOKEN');
    });

    it('fails with 401 TOKEN_EXPIRED when token has expired', async () => {
      const expiredToken = jwt.sign(
        { sub: userId, role: 'CUSTOMER' },
        env.JWT_ACCESS_SECRET,
        {
          algorithm: 'HS256',
          expiresIn: '0s',
          audience: env.JWT_AUDIENCE,
        },
      );

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'TOKEN_EXPIRED');
    });
  });

  describe('RBAC Authorization (authZ)', () => {
    let customerToken;
    let hostToken;
    let adminToken;

    before(async () => {
      // Create CUSTOMER
      const customerEmail = uniqueEmail();
      const cReg = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: customerEmail, password: 'Password123!', role: 'CUSTOMER' });
      createdUserIds.push(cReg.body.user.id);
      const cLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: customerEmail, password: 'Password123!' });
      customerToken = cLogin.body.accessToken;

      // Create HOST
      const hostEmail = uniqueEmail();
      const hReg = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: hostEmail, password: 'Password123!', role: 'HOST' });
      createdUserIds.push(hReg.body.user.id);
      const hLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: hostEmail, password: 'Password123!' });
      hostToken = hLogin.body.accessToken;

      // Create ADMIN directly in DB (since ADMIN cannot be self-registered)
      const adminEmail = uniqueEmail();
      const adminHash = await bcrypt.hash('AdminSecret123!', 10);
      const adminUser = await usersRepository.createUser({
        email: adminEmail,
        role: 'ADMIN',
        passwordHash: adminHash,
      });
      createdUserIds.push(adminUser.id);
      const aLogin = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: adminEmail, password: 'AdminSecret123!' });
      adminToken = aLogin.body.accessToken;
    });

    it('blocks CUSTOMER from host route with 403 FORBIDDEN', async () => {
      const res = await request(app)
        .get('/api/v1/host/ping')
        .set('Authorization', `Bearer ${customerToken}`);

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('blocks CUSTOMER from admin route with 403 FORBIDDEN', async () => {
      const res = await request(app)
        .get('/api/v1/admin/ping')
        .set('Authorization', `Bearer ${customerToken}`);

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('allows HOST on host route (200)', async () => {
      const res = await request(app)
        .get('/api/v1/host/ping')
        .set('Authorization', `Bearer ${hostToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.message, 'host pong');
    });

    it('blocks HOST from admin route with 403 FORBIDDEN', async () => {
      const res = await request(app)
        .get('/api/v1/admin/ping')
        .set('Authorization', `Bearer ${hostToken}`);

      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'FORBIDDEN');
    });

    it('allows ADMIN on admin route (200)', async () => {
      const res = await request(app)
        .get('/api/v1/admin/ping')
        .set('Authorization', `Bearer ${adminToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.message, 'admin pong');
    });

    it('allows ADMIN on host route (200)', async () => {
      const res = await request(app)
        .get('/api/v1/host/ping')
        .set('Authorization', `Bearer ${adminToken}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.message, 'host pong');
    });
  });

  describe('GET /readyz', () => {
    it('returns 200 with status ok and connected dependencies', async () => {
      const res = await request(app).get('/readyz');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.postgres, true);
      assert.equal(res.body.redis, true);
    });
  });
});
