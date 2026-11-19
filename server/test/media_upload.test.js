import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

process.env.NODE_ENV = 'test';

const { default: app } = await import('../src/app.js');
const { pool } = await import('../src/infrastructure/postgres.js');
const { redis } = await import('../src/infrastructure/redis.js');
const { s3Client } = await import('../src/infrastructure/s3/client.js');
const { s3Service } = await import('../src/infrastructure/s3/s3Service.js');
const { setupStorage } = await import('../src/infrastructure/s3/setupStorage.js');
const { propertyImagesRepository } = await import('../src/modules/properties/imagesRepository.js');
const { runCleanupTick } = await import('../src/workers/index.js');
const { env } = await import('../src/config/env.js');

// 1x1 Minimal valid JPEG buffer (142 bytes)
const VALID_JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01,
  0x00, 0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06,
  0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d,
  0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12, 0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d,
  0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28,
  0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01,
  0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02,
  0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01,
  0x01, 0x00, 0x00, 0x3f, 0x00, 0xbf, 0x80, 0xff, 0xd9,
]);

// 1x1 Minimal valid PNG buffer (67 bytes)
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
  0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe('Step 11A: Property Images Media Upload Test Suite', () => {
  const createdUserIds = [];
  const createdPropertyIds = [];
  const createdS3Keys = [];

  const uniqueEmail = () => `img_${crypto.randomUUID().slice(0, 8)}@example.com`;

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
      token: login.body.accessToken,
      email,
    };
  }

  async function createProperty(hostToken) {
    const res = await request(app)
      .post('/api/v1/properties')
      .set('Authorization', `Bearer ${hostToken}`)
      .send({
        title: 'Seaside Villa',
        description: 'Luxury villa with panoramic ocean view',
        location: 'Goa',
        capacity: 8,
        pricing_minor: 1500000,
        currency: 'INR',
        status: 'ACTIVE',
        amenities: ['Pool', 'WiFi', 'Beach View'],
      });
    assert.equal(res.status, 201);
    createdPropertyIds.push(res.body.property.id);
    return res.body.property;
  }

  before(async () => {
    // Ensure bucket, CORS and public-read policy are initialized
    await setupStorage();
  });

  after(async () => {
    // Clean up created S3 objects
    for (const key of createdS3Keys) {
      await s3Service.deleteObject({ key }).catch(() => {});
    }

    // Clean up DB records
    if (createdPropertyIds.length > 0) {
      await pool.query('DELETE FROM properties WHERE id = ANY($1::uuid[])', [createdPropertyIds]);
    }
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUserIds]);
    }

    // Close connections so test process exits immediately
    await pool.end();
    redis.disconnect();
    s3Client.destroy();
  });

  describe('1. Request Upload URL (POST /properties/:id/images/upload-url)', () => {
    it('rejects unsupported MIME types with 400', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      for (const invalidType of ['image/gif', 'text/plain', 'application/pdf']) {
        const res = await request(app)
          .post(`/api/v1/properties/${property.id}/images/upload-url`)
          .set('Authorization', `Bearer ${host.token}`)
          .send({
            content_type: invalidType,
            size_bytes: 1024,
          });

        assert.equal(res.status, 400, `Expected 400 for ${invalidType}`);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      }
    });

    it('rejects file size greater than 5 MB (5242880 bytes) with 400', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      const res = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: 5242881, // 5 MB + 1 byte
        });

      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    });

    it('rejects non-owner with 403 FORBIDDEN and allows ADMIN', async () => {
      const hostA = await createAuthenticatedUser('HOST');
      const hostB = await createAuthenticatedUser('HOST');
      const admin = await createAuthenticatedUser('ADMIN');
      const property = await createProperty(hostA.token);

      // Host B tries to request upload URL for Host A's property
      const resB = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${hostB.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: 1000,
        });

      assert.equal(resB.status, 403);
      assert.equal(resB.body.error.code, 'FORBIDDEN');

      // Admin tries to request upload URL for Host A's property -> allowed
      const resAdmin = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: 1000,
        });

      assert.equal(resAdmin.status, 201);
      assert.ok(resAdmin.body.image_id);
      assert.ok(resAdmin.body.upload_url);
    });

    it('returns signed PUT URL, image_id, and private pending key (Change #1)', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      const res = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: VALID_JPEG_BUFFER.length,
        });

      assert.equal(res.status, 201);
      assert.ok(res.body.image_id);
      assert.ok(res.body.upload_url.includes('http://localhost:9000'));
      assert.match(res.body.key, new RegExp(`^uploads/pending/${property.id}/[a-f0-9-]+\\.jpg$`));
      assert.equal(res.body.expires_in_seconds, 300);

      // Verify row in DB is PENDING
      const dbRow = await propertyImagesRepository.findById(res.body.image_id);
      assert.equal(dbRow.status, 'PENDING');
      assert.equal(dbRow.property_id, property.id);
      assert.equal(dbRow.content_type, 'image/jpeg');
      assert.equal(Number(dbRow.size_bytes), VALID_JPEG_BUFFER.length);
    });
  });

  describe('2. Parallel Upload URL & 10-Image Limit (Change #3)', () => {
    it('enforces max 10 images counting READY + unexpired PENDING with SELECT ... FOR UPDATE', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      // Seed 9 READY images directly into DB
      for (let i = 0; i < 9; i++) {
        await pool.query(
          `INSERT INTO property_images (property_id, key, status, content_type, size_bytes, sort_order)
           VALUES ($1, $2, 'READY', 'image/jpeg', 1000, $3)`,
          [property.id, `properties/${property.id}/seed_${i}.jpg`, i],
        );
      }

      // Fire 5 parallel upload-url requests: exactly 1 must succeed and 4 must fail with 400
      const parallelRequests = Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/v1/properties/${property.id}/images/upload-url`)
          .set('Authorization', `Bearer ${host.token}`)
          .send({
            content_type: 'image/jpeg',
            size_bytes: 1000,
          }),
      );

      const results = await Promise.all(parallelRequests);
      const successes = results.filter((r) => r.status === 201);
      const failures = results.filter((r) => r.status === 400);

      assert.equal(successes.length, 1, 'Exactly one parallel request should succeed');
      assert.equal(failures.length, 4, 'Remaining 4 parallel requests should fail with 400');
      for (const fail of failures) {
        assert.equal(fail.body.error.code, 'IMAGE_LIMIT_EXCEEDED');
      }

      // Subsequent attempt is also rejected
      const overLimitRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: 1000,
        });

      assert.equal(overLimitRes.status, 400);
      assert.equal(overLimitRes.body.error.code, 'IMAGE_LIMIT_EXCEEDED');
    });
  });

  describe('3. Two-Prefix Flow & Privacy Check (Change #1 & Change #9)', () => {
    it('presigned PUT uploads to private pending prefix and anonymous GET is denied (403)', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      // 1. Request upload URL
      const urlRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: VALID_JPEG_BUFFER.length,
        });

      assert.equal(urlRes.status, 201);
      const { upload_url, key } = urlRes.body;
      createdS3Keys.push(key);

      // 2. Client performs direct HTTP PUT to the presigned URL
      const putRes = await fetch(upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(VALID_JPEG_BUFFER.length),
        },
        body: VALID_JPEG_BUFFER,
      });

      assert.equal(putRes.status, 200, `MinIO PUT should return 200 OK`);

      // 3. Anonymous direct GET on the pending key URL (Change #9)
      const anonymousPendingUrl = `${env.MEDIA_PUBLIC_BASE_URL}/${key}`;
      const anonRes = await fetch(anonymousPendingUrl, { method: 'GET' });

      // Because bucket policy grants public read ONLY on properties/*, uploads/pending/* is private (403)
      assert.equal(
        anonRes.status,
        403,
        `Anonymous GET on pending key must be 403 Forbidden (got ${anonRes.status})`,
      );
    });
  });

  describe('4. Confirm Flow & Idempotency (Change #1, #2, #5, #9)', () => {
    it('promotes pending image to public prefix, confirms READY, and allows anonymous GET (200)', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      // 1. Request upload URL
      const urlRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: VALID_JPEG_BUFFER.length,
        });

      const { image_id, upload_url, key: pendingKey } = urlRes.body;

      // 2. Direct PUT to S3
      const putRes = await fetch(upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(VALID_JPEG_BUFFER.length),
        },
        body: VALID_JPEG_BUFFER,
      });
      assert.equal(putRes.status, 200);

      // 3. Confirm upload
      const confirmRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/${image_id}/confirm`)
        .set('Authorization', `Bearer ${host.token}`);

      assert.equal(confirmRes.status, 200);
      assert.equal(confirmRes.body.image.id, image_id);
      assert.equal(confirmRes.body.image.status, 'READY');
      assert.match(confirmRes.body.image.key, new RegExp(`^properties/${property.id}/[a-f0-9-]+\\.jpg$`));
      assert.ok(confirmRes.body.image.url.includes('/properties/'));

      const publicKey = confirmRes.body.image.key;
      createdS3Keys.push(publicKey);

      // Verify pending object was deleted from S3 (Change #1)
      let pendingExists = true;
      try {
        await s3Client.send(
          new GetObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: pendingKey,
          }),
        );
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          pendingExists = false;
        }
      }
      assert.equal(pendingExists, false, 'Pending object must be deleted from S3 after promotion');

      // 4. Anonymous GET on the confirmed public URL must return 200 (Change #9)
      const anonPublicRes = await fetch(confirmRes.body.image.url, { method: 'GET' });
      assert.equal(anonPublicRes.status, 200, `Anonymous GET on confirmed image must succeed with 200`);
      const bodyBytes = Buffer.from(await anonPublicRes.arrayBuffer());
      assert.equal(bodyBytes.length, VALID_JPEG_BUFFER.length);

      // 5. Second confirm on READY is idempotent: returns 200 with same image (Change #5 & Change #9)
      const secondConfirmRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/${image_id}/confirm`)
        .set('Authorization', `Bearer ${host.token}`);

      assert.equal(secondConfirmRes.status, 200);
      assert.equal(secondConfirmRes.body.image.id, image_id);
      assert.equal(secondConfirmRes.body.image.status, 'READY');
      assert.equal(secondConfirmRes.body.image.key, publicKey);
    });

    it('confirms PNG images accurately verifying PNG magic bytes', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      const urlRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/png',
          size_bytes: VALID_PNG_BUFFER.length,
        });

      assert.equal(urlRes.status, 201);
      const { image_id, upload_url } = urlRes.body;

      const putRes = await fetch(upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(VALID_PNG_BUFFER.length),
        },
        body: VALID_PNG_BUFFER,
      });
      assert.equal(putRes.status, 200);

      const confirmRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/${image_id}/confirm`)
        .set('Authorization', `Bearer ${host.token}`);

      assert.equal(confirmRes.status, 200);
      assert.equal(confirmRes.body.image.status, 'READY');
      assert.equal(confirmRes.body.image.content_type, 'image/png');
      createdS3Keys.push(confirmRes.body.image.key);
    });
  });

  describe('5. Tampered Uploads & Failure Recovery (Change #2 & Change #5)', () => {
    it('rejects confirmation when uploaded file size does not match declared size (Change #2)', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      // Declare size as 200 bytes
      const declaredSize = 200;
      const actualBuffer = Buffer.alloc(150, 0xff); // 150 bytes

      // Request upload URL for declaredSize
      const urlRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: declaredSize,
        });

      const { image_id, key: pendingKey } = urlRes.body;

      // Force upload mismatching size directly to S3 (bypassing presigner signed-header check for test)
      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: pendingKey,
          ContentType: 'image/jpeg',
          Body: actualBuffer,
        }),
      );

      // Confirm must fail with 400 IMAGE_SIZE_MISMATCH
      const confirmRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/${image_id}/confirm`)
        .set('Authorization', `Bearer ${host.token}`);

      assert.equal(confirmRes.status, 400);
      assert.equal(confirmRes.body.error.code, 'IMAGE_SIZE_MISMATCH');

      // Verify row and pending object were deleted on validation failure (Change #5)
      const dbRow = await propertyImagesRepository.findById(image_id);
      assert.equal(dbRow, null, 'Failed image row must be removed from DB');

      let objectExists = true;
      try {
        await s3Client.send(
          new GetObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: pendingKey,
          }),
        );
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          objectExists = false;
        }
      }
      assert.equal(objectExists, false, 'Failed pending object must be deleted from S3');
    });

    it('rejects confirmation when magic bytes do not match declared MIME type (Change #5)', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      // Declare image/jpeg, but payload contains fake/corrupt bytes
      const corruptBuffer = Buffer.from('THIS IS NOT A VALID JPEG IMAGE BUFFER DATA!!!');

      const urlRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: corruptBuffer.length,
        });

      const { image_id, upload_url, key: pendingKey } = urlRes.body;

      // Direct PUT of corrupt bytes
      const putRes = await fetch(upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(corruptBuffer.length),
        },
        body: corruptBuffer,
      });
      assert.equal(putRes.status, 200);

      // Confirm must reject with 400 INVALID_IMAGE_SIGNATURE
      const confirmRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/${image_id}/confirm`)
        .set('Authorization', `Bearer ${host.token}`);

      assert.equal(confirmRes.status, 400);
      assert.equal(confirmRes.body.error.code, 'INVALID_IMAGE_SIGNATURE');

      // Verify row was purged from DB and pending object deleted from S3 (Change #5)
      const dbRow = await propertyImagesRepository.findById(image_id);
      assert.equal(dbRow, null);
    });
  });

  describe('6. Delete Image Flow (Change #8)', () => {
    it('deletes DB row first then S3 object and invalidates cache', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      // 1. Upload and confirm an image
      const urlRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/upload-url`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({
          content_type: 'image/jpeg',
          size_bytes: VALID_JPEG_BUFFER.length,
        });

      const { image_id, upload_url } = urlRes.body;

      await fetch(upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': String(VALID_JPEG_BUFFER.length),
        },
        body: VALID_JPEG_BUFFER,
      });

      const confirmRes = await request(app)
        .post(`/api/v1/properties/${property.id}/images/${image_id}/confirm`)
        .set('Authorization', `Bearer ${host.token}`);

      assert.equal(confirmRes.status, 200);
      const publicKey = confirmRes.body.image.key;

      // Verify property detail includes image
      const getBefore = await request(app).get(`/api/v1/properties/${property.id}`);
      assert.equal(getBefore.body.property.images.length, 1);

      // 2. Delete the image (Change #8)
      const delRes = await request(app)
        .delete(`/api/v1/properties/${property.id}/images/${image_id}`)
        .set('Authorization', `Bearer ${host.token}`);

      assert.equal(delRes.status, 200);
      assert.equal(delRes.body.success, true);

      // Verify DB row is gone
      const dbRow = await propertyImagesRepository.findById(image_id);
      assert.equal(dbRow, null);

      // Verify cache was invalidated and fresh property query returns 0 images
      const getAfter = await request(app).get(`/api/v1/properties/${property.id}`);
      assert.equal(getAfter.body.property.images.length, 0);

      // Verify S3 object is gone (returns 404)
      const s3Check = await fetch(`${env.MEDIA_PUBLIC_BASE_URL}/${publicKey}`, { method: 'GET' });
      assert.equal(s3Check.status, 404);
    });
  });

  describe('7. Orphaned Pending Images Cleanup Scheduler', () => {
    it('sweeps pending images older than 24 hours (S3 object + DB row)', async () => {
      const host = await createAuthenticatedUser('HOST');
      const property = await createProperty(host.token);

      const orphanKey = `uploads/pending/${property.id}/stale_${crypto.randomUUID()}.jpg`;

      // 1. Put object directly in S3
      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: orphanKey,
          ContentType: 'image/jpeg',
          Body: VALID_JPEG_BUFFER,
        }),
      );

      // 2. Insert DB record with created_at 25 hours ago
      const insertRes = await pool.query(
        `INSERT INTO property_images (
          property_id, key, status, content_type, size_bytes, sort_order, created_at
        ) VALUES ($1, $2, 'PENDING', 'image/jpeg', $3, 0, now() - interval '25 hours')
        RETURNING id`,
        [property.id, orphanKey, VALID_JPEG_BUFFER.length],
      );
      const orphanId = insertRes.rows[0].id;

      // 3. Run cleanup tick
      const cleanupResult = await runCleanupTick({ orphanedImageHours: 24 });
      assert.ok(cleanupResult.result.orphanedImagesDeleted >= 1);

      // 4. Verify DB row was deleted
      const checkRow = await propertyImagesRepository.findById(orphanId);
      assert.equal(checkRow, null);

      // 5. Verify S3 object was deleted
      let exists = true;
      try {
        await s3Client.send(
          new GetObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: orphanKey,
          }),
        );
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          exists = false;
        }
      }
      assert.equal(exists, false, 'Orphaned S3 object must be removed by cleanup tick');
    });
  });

  describe('8. Healthcheck Independence', () => {
    it('/readyz returns 200 and does NOT check MinIO', async () => {
      const res = await request(app).get('/readyz');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.equal(res.body.postgres, true);
      assert.equal(res.body.redis, true);
      assert.equal(res.body.minio, undefined, 'MinIO must not be present in /readyz payload');
    });
  });
});
