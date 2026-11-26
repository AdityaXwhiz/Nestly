import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';

/**
 * Builds S3Client configuration, omitting endpoint and static credentials in AWS IAM environments.
 */
export function buildS3ClientConfig(envConfig = env, endpoint = envConfig.S3_ENDPOINT) {
  const config = {
    region: envConfig.AWS_REGION,
    forcePathStyle: envConfig.S3_FORCE_PATH_STYLE,
  };

  if (endpoint) {
    config.endpoint = endpoint;
  }

  if (envConfig.AWS_ACCESS_KEY_ID && envConfig.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: envConfig.AWS_ACCESS_KEY_ID,
      secretAccessKey: envConfig.AWS_SECRET_ACCESS_KEY,
    };
  }

  return config;
}

function createClient(endpoint) {
  return new S3Client(buildS3ClientConfig(env, endpoint));
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
