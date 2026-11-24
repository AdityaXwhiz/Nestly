import {
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { sqsClient } from '../infrastructure/sqs/client.js';
import { withTx } from '../infrastructure/postgres.js';
import { logger, runWithRequestContext } from '../middleware/requestLogger.js';
import {
  workerMessagesReceivedTotal,
  workerConsumerFailuresTotal,
  workerConsumerDurationSeconds,
  workerMessageAgeSeconds,
} from '../infrastructure/metrics/index.js';

/**
 * Execute a consumer handler inside a single database transaction shared with
 * the processed_events deduplication insert (PRIMARY KEY (consumer, event_id)).
 */
export async function withProcessedEventDedupe(consumerName, eventId, fn) {
  return withTx(async (tx) => {
    const dedupeRes = await tx.query(
      `
        INSERT INTO processed_events (consumer, event_id)
        VALUES ($1, $2)
        ON CONFLICT (consumer, event_id) DO NOTHING
        RETURNING event_id;
      `,
      [consumerName, eventId],
    );

    if (dedupeRes.rowCount === 0) {
      return { deduplicated: true };
    }

    const result = await fn(tx);
    return { deduplicated: false, result };
  });
}

/**
 * Create a long-polling SQS consumer with bounded concurrency,
 * visibility timeout extension (capped by maxHandlerTimeMs),
 * and graceful shutdown.
 */
export function createConsumer({
  name,
  queueUrl,
  handler,
  useProcessedEvents = true,
  visibilityTimeoutSec = 30,
  maxHandlerTimeMs = 120000,
  waitTimeSeconds = 5,
  concurrency = 5,
  pollDelayMs = 50,
  beforeDeleteHook = null,
}) {
  let running = false;
  let pollLoopPromise = null;
  const inFlight = new Set();

  async function processSingleMessage(message) {
    const attempt = Number(message.Attributes?.ApproximateReceiveCount || 1);
    const startedAt = Date.now();
    const startNs = process.hrtime.bigint();

    workerMessagesReceivedTotal.inc({ queue: name });

    // Record message age at processing start (now - SentTimestamp, Change #6)
    const sentTsMs = Number(message.Attributes?.SentTimestamp);
    if (Number.isFinite(sentTsMs) && sentTsMs > 0) {
      const ageSec = Math.max(0, (startedAt - sentTsMs) / 1000);
      workerMessageAgeSeconds.observe({ queue: name }, ageSec);
    }

    let envelope;
    try {
      envelope = JSON.parse(message.Body);
    } catch (parseErr) {
      workerConsumerFailuresTotal.inc({ queue: name });
      workerConsumerDurationSeconds.observe(
        { queue: name },
        Number(process.hrtime.bigint() - startNs) / 1e9,
      );
      logger.error(
        {
          consumer: name,
          queue: queueUrl,
          messageId: message.MessageId,
          attempt,
          err: parseErr.message,
        },
        'Consumer failed to parse JSON message body; leaving message for DLQ redrive',
      );
      return;
    }

    const eventId = envelope.eventId;
    const eventType = envelope.eventType;
    const reqId =
      envelope.requestId || message.MessageAttributes?.requestId?.StringValue || null;
    const originReqId =
      envelope.originRequestId ||
      message.MessageAttributes?.originRequestId?.StringValue ||
      envelope.payload?.origin_request_id ||
      null;

    // Heartbeat timer: extends visibility timeout for slow jobs, up to maxHandlerTimeMs (Change #6)
    const heartbeatIntervalMs = Math.max(250, Math.floor((visibilityTimeoutSec * 1000) / 2));
    const heartbeat = setInterval(async () => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxHandlerTimeMs) {
        runWithRequestContext({ requestId: reqId, originRequestId: originReqId }, () => {
          logger.warn(
            {
              consumer: name,
              queue: queueUrl,
              eventId,
              eventType,
              attempt,
              elapsedMs,
              maxHandlerTimeMs,
            },
            'Consumer handler exceeded maxHandlerTimeMs; stopping visibility heartbeat',
          );
        });
        clearInterval(heartbeat);
        return;
      }

      try {
        await sqsClient.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: visibilityTimeoutSec,
          }),
        );
      } catch (hbErr) {
        runWithRequestContext({ requestId: reqId, originRequestId: originReqId }, () => {
          logger.warn(
            {
              consumer: name,
              queue: queueUrl,
              eventId,
              attempt,
              err: hbErr.message,
            },
            'Failed to extend message visibility timeout',
          );
        });
      }
    }, heartbeatIntervalMs);

    await runWithRequestContext({ requestId: reqId, originRequestId: originReqId }, async () => {
      try {
        logger.info(
          {
            consumer: name,
            queue: queueUrl,
            eventId,
            eventType,
            attempt,
          },
          'Consumer processing message',
        );

        if (useProcessedEvents && eventId) {
          const outcome = await withProcessedEventDedupe(name, eventId, async (tx) => {
            return handler(envelope, { tx, attempt, message });
          });

          if (outcome.deduplicated) {
            logger.info(
              {
                consumer: name,
                queue: queueUrl,
                eventId,
                eventType,
                attempt,
              },
              'Consumer skipped duplicate event (already in processed_events)',
            );
          }
        } else {
          await handler(envelope, { tx: null, attempt, message });
        }

        // Optional test hook to simulate crash after handler succeeds but BEFORE DeleteMessage
        if (process.env.NODE_ENV === 'test' && beforeDeleteHook) {
          beforeDeleteHook(envelope, { attempt, message });
        }

        // Delete message ONLY after handler succeeds
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );

        logger.info(
          {
            consumer: name,
            queue: queueUrl,
            eventId,
            eventType,
            attempt,
            durationMs: Date.now() - startedAt,
          },
          'Consumer completed and deleted message',
        );
      } catch (err) {
        workerConsumerFailuresTotal.inc({ queue: name });
        logger.error(
          {
            consumer: name,
            queue: queueUrl,
            eventId,
            eventType,
            attempt,
            err: err.message,
          },
          'Consumer handler failed; leaving message in queue for retry',
        );
      } finally {
        clearInterval(heartbeat);
        workerConsumerDurationSeconds.observe(
          { queue: name },
          Number(process.hrtime.bigint() - startNs) / 1e9,
        );
      }
    });
  }

  async function pollLoop() {
    while (running) {
      try {
        const availableSlots = concurrency - inFlight.size;
        if (availableSlots <= 0) {
          await new Promise((r) => setTimeout(r, pollDelayMs));
          continue;
        }

        const maxMessages = Math.min(10, availableSlots);
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: maxMessages,
            WaitTimeSeconds: waitTimeSeconds,
            VisibilityTimeout: visibilityTimeoutSec,
            AttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
            MessageAttributeNames: ['All'],
          }),
        );

        const messages = res.Messages || [];
        if (messages.length === 0) {
          if (waitTimeSeconds === 0 && running) {
            await new Promise((r) => setTimeout(r, pollDelayMs));
          }
          continue;
        }

        for (const msg of messages) {
          const taskPromise = processSingleMessage(msg).finally(() => {
            inFlight.delete(taskPromise);
          });
          inFlight.add(taskPromise);
        }
      } catch (pollErr) {
        if (!running) break;
        logger.error(
          {
            consumer: name,
            queue: queueUrl,
            err: pollErr.message,
          },
          'Consumer poll error',
        );
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    logger.info({ consumer: name, queue: queueUrl, concurrency }, 'Starting SQS consumer');
    pollLoopPromise = pollLoop();
  }

  async function stop() {
    if (!running) return;
    running = false;
    logger.info({ consumer: name, inFlightCount: inFlight.size }, 'Stopping SQS consumer...');
    await Promise.allSettled([...inFlight]);
    if (pollLoopPromise) {
      await pollLoopPromise.catch(() => {});
    }
    logger.info({ consumer: name }, 'SQS consumer stopped cleanly');
  }

  return {
    name,
    queueUrl,
    start,
    stop,
    isRunning: () => running,
  };
}
