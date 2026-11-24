import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';

function createClient(endpoint) {
  return new S3Client({
    region: env.AWS_REGION,
    endpoint,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
}

/**
 * Internal S3Client used for all server-side S3/MinIO operations
 * (HeadObject, GetObject, CopyObject, DeleteObject, bucket setup).
 */
export const s3Client = createClient(env.S3_ENDPOINT);

/**
 * Browser-facing S3Client used ONLY for generating presigned PUT URLs (Change #1).
 * Uses S3_PUBLIC_ENDPOINT so the signed Host header matches the browser's upload target.
 */
export const s3PublicClient =
  env.S3_PUBLIC_ENDPOINT && env.S3_PUBLIC_ENDPOINT !== env.S3_ENDPOINT
    ? createClient(env.S3_PUBLIC_ENDPOINT)
    : s3Client;
