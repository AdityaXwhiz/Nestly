import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';

/**
 * Creates and exports a configured S3Client.
 * Compatible with local MinIO and AWS S3 in production.
 */
export const s3Client = new S3Client({
  region: env.AWS_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});
