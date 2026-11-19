import {
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { sqsClient, QUEUE_DEFINITIONS } from './client.js';
import { logger } from '../../middleware/requestLogger.js';

/**
 * Peek at messages across DLQs with VisibilityTimeout: 0 and NEVER delete them (Change #8).
 */
export async function inspectDlqs({ queueNames = Object.keys(QUEUE_DEFINITIONS), maxMessages = 10 } = {}) {
  const results = {};

  for (const name of queueNames) {
    const def = QUEUE_DEFINITIONS[name];
    if (!def) continue;

    const res = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: def.dlqUrl,
        MaxNumberOfMessages: Math.min(maxMessages, 10),
        VisibilityTimeout: 0,
        WaitTimeSeconds: 0,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );

    const messages = (res.Messages || []).map((msg) => {
      let parsedBody = msg.Body;
      try {
        parsedBody = JSON.parse(msg.Body);
      } catch {
        // leave raw string if not JSON
      }
      return {
        messageId: msg.MessageId,
        receiveCount: Number(msg.Attributes?.ApproximateReceiveCount || 1),
        sentTimestamp: msg.Attributes?.SentTimestamp ? Number(msg.Attributes.SentTimestamp) : null,
        eventType: msg.MessageAttributes?.eventType?.StringValue || parsedBody?.eventType || null,
        eventId: parsedBody?.eventId || null,
        body: parsedBody,
      };
    });

    results[def.dlqName] = messages;
  }

  return results;
}

/**
 * Move messages from DLQs back to their source queues.
 * Change #8: Sends to the source queue FIRST, and deletes from the DLQ ONLY after a successful send.
 */
export async function redriveDlqs({ queueNames = Object.keys(QUEUE_DEFINITIONS), maxMessages = 50 } = {}) {
  const redrivenCount = {};

  for (const name of queueNames) {
    const def = QUEUE_DEFINITIONS[name];
    if (!def) continue;

    let moved = 0;
    while (moved < maxMessages) {
      const batchLimit = Math.min(10, maxMessages - moved);
      const res = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: def.dlqUrl,
          MaxNumberOfMessages: batchLimit,
          VisibilityTimeout: 15,
          WaitTimeSeconds: 0,
          AttributeNames: ['All'],
          MessageAttributeNames: ['All'],
        }),
      );

      const messages = res.Messages || [];
      if (messages.length === 0) {
        break;
      }

      for (const msg of messages) {
        // 1. Send to source queue FIRST
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: def.url,
            MessageBody: msg.Body,
            MessageAttributes: msg.MessageAttributes,
          }),
        );

        // 2. Delete from DLQ ONLY after send succeeded
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: def.dlqUrl,
            ReceiptHandle: msg.ReceiptHandle,
          }),
        );

        moved += 1;
        logger.info(
          {
            fromDlq: def.dlqName,
            toQueue: def.name,
            messageId: msg.MessageId,
          },
          'Redrove message from DLQ to source queue',
        );
      }
    }

    redrivenCount[def.dlqName] = moved;
  }

  return redrivenCount;
}

/**
 * Monitor all DLQs for depth > 0 or oldest message age > maxAgeSeconds.
 * Logs a WARNING whenever any DLQ has messages or stale messages.
 */
export async function monitorDlqs({ maxAgeSeconds = 300 } = {}) {
  const report = {};

  for (const def of Object.values(QUEUE_DEFINITIONS)) {
    const attrsRes = await sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: def.dlqUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
        ],
      }),
    );

    const visible = Number(attrsRes.Attributes?.ApproximateNumberOfMessages || 0);
    const notVisible = Number(attrsRes.Attributes?.ApproximateNumberOfMessagesNotVisible || 0);
    const depth = visible + notVisible;

    let oldestAgeSeconds = 0;
    if (visible > 0) {
      const peekRes = await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: def.dlqUrl,
          MaxNumberOfMessages: 1,
          VisibilityTimeout: 0,
          WaitTimeSeconds: 0,
          AttributeNames: ['SentTimestamp'],
        }),
      );
      const msg = peekRes.Messages?.[0];
      if (msg?.Attributes?.SentTimestamp) {
        oldestAgeSeconds = Math.max(
          0,
          Math.floor((Date.now() - Number(msg.Attributes.SentTimestamp)) / 1000),
        );
      }
    }

    report[def.dlqName] = { depth, visible, notVisible, oldestAgeSeconds };

    if (depth > 0 || oldestAgeSeconds > maxAgeSeconds) {
      logger.warn(
        {
          dlq: def.dlqName,
          depth,
          visible,
          notVisible,
          oldestAgeSeconds,
          maxAgeSeconds,
        },
        'DLQ alert: dead-letter queue depth is above zero or oldest message is too old',
      );
    }
  }

  return report;
}

// CLI entrypoint for `npm run dlq:inspect` and `npm run dlq:redrive`
if (process.argv[1] && process.argv[1].endsWith('dlqTool.js')) {
  const action = process.argv[2];
  const queueFilter = process.argv[3] ? [process.argv[3]] : undefined;

  if (action === 'inspect') {
    inspectDlqs({ queueNames: queueFilter })
      .then((res) => {
        console.log(JSON.stringify(res, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error('DLQ inspect failed:', err);
        process.exit(1);
      });
  } else if (action === 'redrive') {
    redriveDlqs({ queueNames: queueFilter })
      .then((res) => {
        console.log('DLQ redrive summary:', JSON.stringify(res, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error('DLQ redrive failed:', err);
        process.exit(1);
      });
  } else {
    console.error('Usage: node dlqTool.js <inspect|redrive> [queueName]');
    process.exit(1);
  }
}
