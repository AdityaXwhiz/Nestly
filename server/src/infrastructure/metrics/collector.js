import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { pool, pingPostgres } from '../postgres.js';
import { pingRedis } from '../redis.js';
import { sqsClient, QUEUE_DEFINITIONS } from '../sqs/client.js';
import { s3Client } from '../s3/client.js';
import { env } from '../../config/env.js';
import { logger } from '../../middleware/requestLogger.js';
import {
  dependencyUp,
  outboxUnpublishedCount,
  outboxOldestUnpublishedAgeSeconds,
  sqsQueueDepth,
  sqsDlqDepth,
  paymentsStuckProcessingCount,
  paymentsStuckOldestAgeSeconds,
  sagasStaleNonTerminalCount,
} from './index.js';

async function probeOpenSearch() {
  try {
    const res = await fetch(`${env.OPENSEARCH_ENDPOINT}/_cluster/health?local=true`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? 1 : 0;
  } catch {
    return 0;
  }
}

async function probeElasticMq() {
  try {
    await sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: QUEUE_DEFINITIONS.notifications.url,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return 1;
  } catch {
    return 0;
  }
}

async function probeMinio() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return 1;
  } catch {
    return 0;
  }
}

/**
 * Periodically collects queue, DB backlog, stuck payment, stale saga, and dependency
 * gauges. Runs ONLY inside the scheduler worker role (Step 13B Changes #2 & #3).
 */
export async function collectSchedulerGauges() {
  // 1. Dependency health probes (Change #3)
  const [pgOk, redisOk, osUp, sqsUp, minioUp] = await Promise.all([
    pingPostgres().then((ok) => (ok ? 1 : 0)).catch(() => 0),
    pingRedis().then((ok) => (ok ? 1 : 0)).catch(() => 0),
    probeOpenSearch(),
    probeElasticMq(),
    probeMinio(),
  ]);

  dependencyUp.set({ dependency: 'postgres' }, pgOk);
  dependencyUp.set({ dependency: 'redis' }, redisOk);
  dependencyUp.set({ dependency: 'opensearch' }, osUp);
  dependencyUp.set({ dependency: 'elasticmq' }, sqsUp);
  dependencyUp.set({ dependency: 'minio' }, minioUp);

  // 2. Database backlog & stuck entity gauges
  if (pgOk) {
    try {
      const [outboxRes, stuckRes, sagaRes] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*)::int AS unpublished_count,
            COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))), 0)::float AS oldest_age_seconds
          FROM outbox
          WHERE published_at IS NULL;
        `),
        pool.query(
          `
            SELECT
              COUNT(*)::int AS stuck_count,
              COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at))), 0)::float AS oldest_age_seconds
            FROM payments
            WHERE status = 'PROCESSING'
              AND created_at <= now() - make_interval(secs => $1);
          `,
          [env.SAGA_STALE_SECONDS],
        ),
        pool.query(
          `
            SELECT COUNT(*)::int AS stale_count
            FROM saga_instances s
            JOIN orders o ON o.id = s.order_id
            WHERE s.state NOT IN ('COMPLETED', 'FAILED')
              AND s.updated_at <= now() - make_interval(secs => $1)
              AND (s.state <> 'AWAITING_PAYMENT' OR o.hold_expires_at <= now());
          `,
          [env.SAGA_STALE_SECONDS],
        ),
      ]);

      outboxUnpublishedCount.set(outboxRes.rows[0]?.unpublished_count ?? 0);
      outboxOldestUnpublishedAgeSeconds.set(
        Math.max(0, outboxRes.rows[0]?.oldest_age_seconds ?? 0),
      );

      paymentsStuckProcessingCount.set(stuckRes.rows[0]?.stuck_count ?? 0);
      paymentsStuckOldestAgeSeconds.set(
        Math.max(0, stuckRes.rows[0]?.oldest_age_seconds ?? 0),
      );

      sagasStaleNonTerminalCount.set(sagaRes.rows[0]?.stale_count ?? 0);
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed collecting DB backlog gauges');
    }
  }

  // 3. SQS primary queue depth & DLQ depth via GetQueueAttributes
  // Note: queue depth uses ApproximateNumberOfMessages + NotVisible; never claims oldest age from attributes (Change #6).
  if (sqsUp) {
    for (const [qName, def] of Object.entries(QUEUE_DEFINITIONS)) {
      try {
        const [mainAttrs, dlqAttrs] = await Promise.all([
          sqsClient.send(
            new GetQueueAttributesCommand({
              QueueUrl: def.url,
              AttributeNames: [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
              ],
            }),
          ),
          sqsClient.send(
            new GetQueueAttributesCommand({
              QueueUrl: def.dlqUrl,
              AttributeNames: [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
              ],
            }),
          ),
        ]);

        const visible = Number(mainAttrs.Attributes?.ApproximateNumberOfMessages || 0);
        const notVisible = Number(mainAttrs.Attributes?.ApproximateNumberOfMessagesNotVisible || 0);
        sqsQueueDepth.set({ queue: qName }, visible + notVisible);

        const dlqVisible = Number(dlqAttrs.Attributes?.ApproximateNumberOfMessages || 0);
        const dlqNotVisible = Number(dlqAttrs.Attributes?.ApproximateNumberOfMessagesNotVisible || 0);
        sqsDlqDepth.set({ queue: qName }, dlqVisible + dlqNotVisible);
      } catch (err) {
        logger.warn({ queue: qName, err: err.message }, 'Failed collecting SQS queue depth gauges');
      }
    }
  }
}
