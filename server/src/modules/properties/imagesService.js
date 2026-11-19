import crypto from 'node:crypto';
import { propertyImagesRepository } from './imagesRepository.js';
import { propertiesRepository } from './repository.js';
import { outboxRepository } from '../outbox/repository.js';
import { s3Service } from '../../infrastructure/s3/s3Service.js';
import { withTx } from '../../infrastructure/postgres.js';
import { del } from '../../infrastructure/redis/cache.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../middleware/requestLogger.js';
import { env } from '../../config/env.js';

export function formatImage(image) {
  const publicUrl = image.url || `${env.MEDIA_PUBLIC_BASE_URL}/${image.key}`;
  return {
    id: image.id,
    property_id: image.property_id,
    key: image.key,
    url: publicUrl,
    status: image.status,
    content_type: image.content_type,
    size_bytes: Number(image.size_bytes),
    sort_order: image.sort_order,
    created_at: image.created_at,
  };
}

function getExtension(contentType) {
  switch (contentType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

export const propertyImagesService = {
  /**
   * Generates a presigned upload URL for a property image.
   * Enforces max 10 images (READY + unexpired PENDING) with SELECT ... FOR UPDATE (Change #3).
   * Targets private pending key uploads/pending/{propertyId}/{uuid}.{ext} (Change #1).
   */
  async requestUploadUrl(propertyId, input, user) {
    const contentType = input.content_type || input.contentType;
    const sizeBytes = input.size_bytes ?? input.sizeBytes;

    return withTx(async (tx) => {
      // 1. Lock property row and verify ownership
      const property = await propertyImagesRepository.lockPropertyForUpdate(propertyId, tx);
      if (!property) {
        throw new AppError('PROPERTY_NOT_FOUND', 404, 'Property not found');
      }

      if (user.role !== 'ADMIN' && property.host_id !== user.id) {
        throw new AppError('FORBIDDEN', 403, 'You do not own this property');
      }

      // 2. Count READY + unexpired PENDING rows inside the transaction (Change #3)
      const activeCount = await propertyImagesRepository.countActiveImages(propertyId, tx);
      if (activeCount >= 10) {
        throw new AppError(
          'IMAGE_LIMIT_EXCEEDED',
          400,
          'Property already has the maximum allowed 10 images',
        );
      }

      const sortOrder = await propertyImagesRepository.getNextSortOrder(propertyId, tx);
      const ext = getExtension(contentType);
      const imageId = crypto.randomUUID();

      // Private pending key
      const pendingKey = `uploads/pending/${propertyId}/${imageId}.${ext}`;

      // Insert PENDING record in DB
      const pendingRow = await propertyImagesRepository.createPendingImage(
        {
          propertyId,
          key: pendingKey,
          contentType,
          sizeBytes,
          sortOrder,
        },
        tx,
      );

      // Generate presigned PUT URL expiring in 5 minutes (300 seconds)
      const uploadUrl = await s3Service.createPresignedUploadUrl({
        key: pendingKey,
        contentType,
        sizeBytes,
        expiresInSeconds: 300,
      });

      return {
        image_id: pendingRow.id,
        upload_url: uploadUrl,
        key: pendingKey,
        expires_in_seconds: 300,
      };
    });
  },

  /**
   * Confirms an uploaded image.
   * Verifies size equality, content-type, and magic bytes (Change #2).
   * Copies from uploads/pending/* to properties/* then deletes pending (Change #1).
   * Idempotent: repeated confirm on READY returns 200 with image (Change #5).
   * On validation failure, deletes pending object and row (Change #5).
   */
  async confirmImageUpload(propertyId, imageId, user) {
    // 1. Verify property ownership
    const property = await propertiesRepository.findById(propertyId);
    if (!property) {
      throw new AppError('PROPERTY_NOT_FOUND', 404, 'Property not found');
    }

    if (user.role !== 'ADMIN' && property.host_id !== user.id) {
      throw new AppError('FORBIDDEN', 403, 'You do not own this property');
    }

    // 2. Find image
    const image = await propertyImagesRepository.findById(imageId, propertyId);
    if (!image) {
      throw new AppError('IMAGE_NOT_FOUND', 404, 'Image record not found');
    }

    // Idempotent: already confirmed
    if (image.status === 'READY') {
      return { image: formatImage(image) };
    }

    if (image.status === 'FAILED') {
      throw new AppError('IMAGE_CONFIRM_FAILED', 409, 'Image upload has failed and cannot be confirmed');
    }

    // 3. Verify uploaded object in S3
    try {
      await s3Service.verifyUploadedObject({
        key: image.key,
        expectedContentType: image.content_type,
        expectedSizeBytes: image.size_bytes,
      });
    } catch (err) {
      // Clean up failed upload from S3 and remove DB row (Change #5)
      await s3Service.deleteObject({ key: image.key }).catch((delErr) => {
        logger.warn({ delErr, key: image.key }, 'Failed to delete invalid pending object');
      });
      await propertyImagesRepository.deleteById(image.id);
      throw err;
    }

    // 4. Promote from pending to public (Change #1)
    const ext = getExtension(image.content_type);
    const publicKey = `properties/${propertyId}/${image.id}.${ext}`;
    const publicUrl = `${env.MEDIA_PUBLIC_BASE_URL}/${publicKey}`;

    await s3Service.promotePendingToPublic({
      pendingKey: image.key,
      publicKey,
      contentType: image.content_type,
    });

    // 5. Guarded DB transition: PENDING -> READY (Change #5)
    let readyRow = await propertyImagesRepository.markReady(image.id, {
      publicKey,
      publicUrl,
    });

    if (!readyRow) {
      // Raced with another confirm call
      const rechecked = await propertyImagesRepository.findById(image.id, propertyId);
      if (rechecked?.status === 'READY') {
        return { image: formatImage(rechecked) };
      }
      throw new AppError('IMAGE_CONFIRM_CONFLICT', 409, 'Concurrent confirm detected');
    }

    // Invalidate property cache
    await del(`cache:property:${propertyId}`);

    // Explicitly bump property version in DB and emit property.updated outbox event (Change #2)
    const bumpedProperty = await propertiesRepository.bumpPropertyVersion(propertyId);
    await outboxRepository.createEvent({
      aggregateId: propertyId,
      eventType: 'property.updated',
      payload: {
        id: propertyId,
        hostId: bumpedProperty?.host_id,
        version: Number(bumpedProperty?.version || 1),
      },
    });

    return { image: formatImage(readyRow) };
  },

  /**
   * Deletes an image: DB row first, then S3 object (Change #8).
   * Invalidates Redis cache.
   */
  async deleteImage(propertyId, imageId, user) {
    // 1. Verify property ownership
    const property = await propertiesRepository.findById(propertyId);
    if (!property) {
      throw new AppError('PROPERTY_NOT_FOUND', 404, 'Property not found');
    }

    if (user.role !== 'ADMIN' && property.host_id !== user.id) {
      throw new AppError('FORBIDDEN', 403, 'You do not own this property');
    }

    // 2. Find image
    const image = await propertyImagesRepository.findById(imageId, propertyId);
    if (!image) {
      throw new AppError('IMAGE_NOT_FOUND', 404, 'Image not found');
    }

    // 3. Delete DB row first (Change #8)
    await propertyImagesRepository.deleteById(imageId);

    // Invalidate Redis cache
    await del(`cache:property:${propertyId}`);

    // Explicitly bump property version in DB and emit property.updated outbox event (Change #2)
    const bumpedProperty = await propertiesRepository.bumpPropertyVersion(propertyId);
    await outboxRepository.createEvent({
      aggregateId: propertyId,
      eventType: 'property.updated',
      payload: {
        id: propertyId,
        hostId: bumpedProperty?.host_id,
        version: Number(bumpedProperty?.version || 1),
      },
    });

    // 4. Delete S3 object (best-effort, log failure)
    try {
      await s3Service.deleteObject({ key: image.key });
    } catch (err) {
      logger.error({ err, key: image.key }, 'Failed to delete S3 object after deleting DB row');
    }

    return { success: true };
  },

  /**
   * Sweeps orphaned PENDING images older than 24 hours.
   */
  async sweepOrphanedPendingImages({ olderThanHours = 24, limit = 100 } = {}) {
    const orphans = await propertyImagesRepository.findOrphanedPending(olderThanHours, limit);
    let deletedCount = 0;

    for (const orphan of orphans) {
      try {
        await s3Service.deleteObject({ key: orphan.key }).catch(() => {});
        await propertyImagesRepository.deleteById(orphan.id);
        deletedCount++;
      } catch (err) {
        logger.error({ err, orphanId: orphan.id }, 'Error sweeping orphaned pending image');
      }
    }

    return deletedCount;
  },
};
