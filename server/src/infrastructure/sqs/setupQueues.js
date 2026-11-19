import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import { sqsClient, QUEUE_DEFINITIONS } from './client.js';
import { logger } from '../../middleware/requestLogger.js';

/**
 * Idempotently creates the 4 primary queues and their DLQs with a RedrivePolicy (maxReceiveCount = 5).
 */
export async function setupQueues({ maxReceiveCount = 5, visibilityTimeout = 30 } = {}) {
  const results = {};

  for (const [key, def] of Object.entries(QUEUE_DEFINITIONS)) {
    // 1. Create DLQ idempotently
    const dlqCreate = await sqsClient.send(
      new CreateQueueCommand({
        QueueName: def.dlqName,
      }),
    );
    const dlqUrl = dlqCreate.QueueUrl || def.dlqUrl;

    // 2. Get DLQ ARN
    const dlqAttrs = await sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const dlqArn = dlqAttrs.Attributes?.QueueArn;

    // 3. Create primary queue idempotently
    const mainCreate = await sqsClient.send(
      new CreateQueueCommand({
        QueueName: def.name,
      }),
    );
    const mainUrl = mainCreate.QueueUrl || def.url;

    // 4. Ensure RedrivePolicy and default VisibilityTimeout are applied idempotently
    const redrivePolicy = JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: String(maxReceiveCount),
    });

    await sqsClient.send(
      new SetQueueAttributesCommand({
        QueueUrl: mainUrl,
        Attributes: {
          RedrivePolicy: redrivePolicy,
          VisibilityTimeout: String(visibilityTimeout),
        },
      }),
    );

    results[key] = {
      name: def.name,
      queueUrl: mainUrl,
      dlqName: def.dlqName,
      dlqUrl,
      dlqArn,
      maxReceiveCount,
    };

    logger.info(
      {
        queue: def.name,
        queueUrl: mainUrl,
        dlqUrl,
        maxReceiveCount,
      },
      'SQS queue and DLQ configured',
    );
  }

  return results;
}

/**
 * Purge all primary queues and DLQs (used in tests for deterministic runs, Change #10).
 */
export async function purgeAllQueues() {
  for (const def of Object.values(QUEUE_DEFINITIONS)) {
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.url })).catch(() => {});
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: def.dlqUrl })).catch(() => {});
  }
}

// Auto-run when invoked via `npm run queues:setup`
if (process.argv[1] && process.argv[1].endsWith('setupQueues.js')) {
  setupQueues()
    .then((res) => {
      console.log('✅ All SQS queues and DLQs created successfully:', Object.keys(res));
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Failed to set up SQS queues:', err);
      process.exit(1);
    });
}
