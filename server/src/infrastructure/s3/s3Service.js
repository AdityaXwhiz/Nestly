import {
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3Client } from './client.js';
import { verifyMagicBytes } from './magicBytes.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../middleware/requestLogger.js';

export const s3Service = {
  /**
   * Generates a presigned PUT URL for uploading an object directly to S3.
   * Signs Content-Type and Content-Length (Change #2).
   */
  async createPresignedUploadUrl({
    key,
    contentType,
    sizeBytes,
    expiresInSeconds = 300,
    client = s3Client,
    bucket = env.S3_BUCKET,
  }) {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: Number(sizeBytes),
    });

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });

    return uploadUrl;
  },

  /**
   * Verifies that the uploaded object exists, size equals declared size_bytes,
   * content type matches, and initial bytes match binary magic bytes (Change #2).
   */
  async verifyUploadedObject({
    key,
    expectedContentType,
    expectedSizeBytes,
    client = s3Client,
    bucket = env.S3_BUCKET,
  }) {
    // 1. HeadObject: check existence, size equality, content type
    let head;
    try {
      head = await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        throw new AppError('IMAGE_NOT_UPLOADED', 400, 'Image has not been uploaded to storage');
      }
      throw err;
    }

    // Exact size check (Change #2)
    if (Number(head.ContentLength) !== Number(expectedSizeBytes)) {
      throw new AppError(
        'IMAGE_SIZE_MISMATCH',
        400,
        `Uploaded image size (${head.ContentLength} bytes) does not match declared size (${expectedSizeBytes} bytes)`,
      );
    }

    // Content-Type check
    if (head.ContentType && head.ContentType !== expectedContentType) {
      throw new AppError(
        'IMAGE_CONTENT_TYPE_MISMATCH',
        400,
        `Uploaded content type (${head.ContentType}) does not match declared type (${expectedContentType})`,
      );
    }

    // 2. Read first 16 bytes via range GetObject to verify magic bytes
    let initialBytes;
    try {
      const getRes = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          Range: 'bytes=0-15',
        }),
      );

      const chunks = [];
      for await (const chunk of getRes.Body) {
        chunks.push(chunk);
      }
      initialBytes = Buffer.concat(chunks);
    } catch (err) {
      logger.error({ err, key }, 'Failed to read initial bytes for magic byte verification');
      throw new AppError('IMAGE_VERIFICATION_FAILED', 400, 'Could not read uploaded image bytes');
    }

    const isValidMagic = verifyMagicBytes(initialBytes, expectedContentType);
    if (!isValidMagic) {
      throw new AppError(
        'INVALID_IMAGE_SIGNATURE',
        400,
        `File binary signature does not match declared format ${expectedContentType}`,
      );
    }

    return true;
  },

  /**
   * Two-prefix flow: Copies object from private pending prefix to public prefix,
   * then deletes the pending object (Change #1).
   */
  async promotePendingToPublic({
    pendingKey,
    publicKey,
    contentType,
    client = s3Client,
    bucket = env.S3_BUCKET,
  }) {
    // 1. CopyObject to public key
    const copySource = `${bucket}/${pendingKey}`;
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: encodeURIComponent(copySource),
        Key: publicKey,
        ContentType: contentType,
      }),
    );

    // 2. Delete pending object
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: pendingKey,
        }),
      );
    } catch (err) {
      logger.warn({ err, pendingKey }, 'Failed to delete pending object after promotion');
    }
  },

  /**
   * Deletes an object from S3/MinIO. Logs failures without throwing fatal crashes.
   */
  async deleteObject({ key, client = s3Client, bucket = env.S3_BUCKET }) {
    if (!key) return;
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    } catch (err) {
      logger.error({ err, key }, 'Failed to delete object from S3');
      throw err;
    }
  },
};
