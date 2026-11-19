import {
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import { s3Client } from './client.js';
import { env } from '../../config/env.js';

export async function setupStorage({
  bucketName = env.S3_BUCKET,
  client = s3Client,
} = {}) {
  console.log(`[storage:setup] Checking bucket "${bucketName}" on endpoint ${env.S3_ENDPOINT || 'AWS default'}...`);

  // 1. Ensure bucket exists
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketName }));
    console.log(`[storage:setup] Bucket "${bucketName}" already exists.`);
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      console.log(`[storage:setup] Creating bucket "${bucketName}"...`);
      await client.send(new CreateBucketCommand({ Bucket: bucketName }));
      console.log(`[storage:setup] Bucket "${bucketName}" created successfully.`);
    } else {
      throw err;
    }
  }

  // 2. Set CORS configuration allowing browser PUT/GET from client origins
  console.log(`[storage:setup] Applying CORS configuration...`);
  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucketName,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ['*'],
              AllowedMethods: ['GET', 'PUT', 'HEAD'],
              AllowedOrigins: ['*'],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    );
    console.log(`[storage:setup] CORS configuration applied.`);
  } catch (err) {
    if (err.name === 'NotImplemented' || err.Code === 'NotImplemented') {
      console.log(`[storage:setup] Note: Per-bucket CORS API not supported by endpoint (handled globally via MINIO_API_CORS_ALLOW_ORIGIN). Skipping.`);
    } else {
      throw err;
    }
  }

  // 3. Set Bucket Policy: Public read ONLY on properties/*, NO ListBucket (Change #1)
  console.log(`[storage:setup] Applying public read policy strictly for properties/*...`);
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'PublicReadPropertyImages',
        Effect: 'Allow',
        Principal: '*',
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${bucketName}/properties/*`],
      },
    ],
  };

  await client.send(
    new PutBucketPolicyCommand({
      Bucket: bucketName,
      Policy: JSON.stringify(policy),
    }),
  );
  console.log(`[storage:setup] Bucket policy applied. Private prefix: uploads/pending/*, Public prefix: properties/*`);
}

// Direct script execution
if (process.argv[1]?.endsWith('setupStorage.js')) {
  setupStorage()
    .then(() => {
      console.log('[storage:setup] Storage initialization completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[storage:setup] Failed to initialize storage:', err);
      process.exit(1);
    });
}
