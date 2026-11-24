import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { withTx } from '../../infrastructure/postgres.js';
import { sqsClient, QUEUE_DEFINITIONS } from '../../infrastructure/sqs/client.js';
import { env } from '../../config/env.js';
import { logger, runWithRequestContext } from '../../middleware/requestLogger.js';

/**
 * Outbox Event Envelope & aggregateId Semantics (Change #7):
 *
 * Envelope shape (LLD Section 9):
 *   {
 *     eventId: "uuid",          // Primary key (outbox.id)
 *     eventType: "string",      // Domain event name
 *     occurredAt: "ISO-8601",   // Timestamp when outbox row was written
 *     aggregateId: "uuid",      // Root entity ID for this eventType (see table below)
 *     version: 1,
 *     payload: { ... }
 *   }
 *
 * aggregateId meaning by eventType:
 * - "order.confirmed"           -> orders.id (the confirmed order UUID)
 * - "payment.succeeded"         -> payments.id (the payment UUID; payload also contains orderId)
 * - "payment.failed"            -> payments.id (the failed payment UUID; payload also contains orderId)
 * - "payment.refund_required"   -> payments.id (the payment UUID requiring refund; payload contains orderId)
 * - "payment.refunded"          -> payments.id (the refunded payment UUID; payload contains orderId)
 * - "reservation.held"          -> reservations.id (the held reservation UUID)
 * - "reservation.confirmed"     -> reservations.id (the confirmed reservation UUID)
 * - "reservation.released"      -> reservations.id (the cancelled/released reservation UUID)
 * - "reservation.expired"       -> reservations.id (the expired reservation UUID)
 * - "property.*"                -> properties.id (the property UUID for search indexing)
 * - "service.*"                 -> services.id (the service UUID for search indexing)
 */

/**
 * Routing table from eventType to target queue names (Change #3):
 * - reservation.* and payment.succeeded -> analytics ONLY
 * - order.confirmed -> notifications, provider-actions, analytics
 * - payment.failed, payment.refund_required, payment.refunded -> notifications, analytics
 * - property.*, service.* -> search-index, analytics
 * - any other event -> analytics
 */
export function resolveTargetQueues(eventType) {
  if (eventType === 'order.confirmed') {
    return ['notifications', 'provider-actions', 'analytics'];
  }

  if (
    eventType === 'payment.failed' ||
    eventType === 'payment.refund_required' ||
    eventType === 'payment.refunded'
  ) {
    return ['notifications', 'analytics'];
  }

  if (eventType.startsWith('reservation.') || eventType === 'payment.succeeded') {
    return ['analytics'];
  }

  if (eventType.startsWith('property.') || eventType.startsWith('service.')) {
    return ['search-index', 'analytics'];
  }

  return ['analytics'];
}

/**
 * Publisher interface definition.
 * Concrete implementations must implement async publish(envelope).
 */

export class InMemoryPublisher {
  constructor() {
    this.publishedEvents = [];
  }

  reset() {
    this.publishedEvents = [];
  }

  async publish(envelope) {
    this.publishedEvents.push(envelope);
    return { status: 'published', eventId: envelope.eventId };
  }
}

export class LogPublisher {
  async publish(envelope) {
    logger.info(
      {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        aggregateId: envelope.aggregateId,
      },
      'Published outbox event',
    );
    return { status: 'published', eventId: envelope.eventId };
  }
}

export class SqsPublisher {
  constructor(client = sqsClient) {
    this.client = client;
  }

  async publish(envelope) {
    const queueNames = resolveTargetQueues(envelope.eventType);
    const body = JSON.stringify(envelope);

    const messageAttributes = {
      eventType: {
        DataType: 'String',
        StringValue: envelope.eventType,
      },
    };
    if (envelope.requestId) {
      messageAttributes.requestId = {
        DataType: 'String',
        StringValue: String(envelope.requestId),
      };
    }
    if (envelope.originRequestId) {
      messageAttributes.originRequestId = {
        DataType: 'String',
        StringValue: String(envelope.originRequestId),
      };
    }

    for (const qName of queueNames) {
      const def = QUEUE_DEFINITIONS[qName];
      if (!def) continue;

      await this.client.send(
        new SendMessageCommand({
          QueueUrl: def.url,
          MessageBody: body,
          MessageAttributes: messageAttributes,
        }),
      );
    }

    logger.info(
      {
        eventId: envelope.eventId,
        eventType: envelope.eventType,
        aggregateId: envelope.aggregateId,
        queues: queueNames,
      },
      'Published outbox event to SQS',
    );

    return { status: 'published', eventId: envelope.eventId, queues: queueNames };
  }
}

function createDefaultPublisher() {
  if (process.env.NODE_ENV === 'test') {
    return new InMemoryPublisher();
  }
  if (env.PUBLISHER === 'sqs') {
    return new SqsPublisher();
  }
  if (env.PUBLISHER === 'memory') {
    return new InMemoryPublisher();
  }
  return new LogPublisher();
}

let activePublisher = createDefaultPublisher();

export function setPublisher(pub) {
  activePublisher = pub;
}

export function getPublisher() {
  return activePublisher;
}

// Test failure injection hook (active only when NODE_ENV=test)
let outboxFailureHook = null;

export function setOutboxFailureHook(fn) {
  if (process.env.NODE_ENV === 'test') {
    outboxFailureHook = fn;
  }
}

export function clearOutboxFailureHook() {
  outboxFailureHook = null;
}

/**
 * Polls unpublished outbox rows, builds LLD envelopes, and publishes them.
 *
 * NOTE on Ordering:
 * Rows within a single batch are processed ORDER BY created_at ASC, id ASC.
 * However, ordering across multiple concurrent workers or during network retries
 * is NOT guaranteed. Downstream message consumers must tolerate message reordering
 * and duplicate deliveries (at-least-once guarantee).
 */
export async function publishOutbox({
  batchSize = 10,
  timeoutMs = 5000,
  publisher = activePublisher,
  client = null,
} = {}) {
  const execute = async (tx) => {
    const query = `
      SELECT id, aggregate_id, event_type, payload, request_id, created_at
      FROM outbox
      WHERE published_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED;
    `;
    const res = await tx.query(query, [batchSize]);
    const rows = res.rows;

    const published = [];

    for (const row of rows) {
      const originRequestId = row.payload?.origin_request_id || undefined;
      const envelope = {
        eventId: row.id,
        eventType: row.event_type,
        occurredAt: new Date(row.created_at).toISOString(),
        aggregateId: row.aggregate_id,
        ...(row.request_id ? { requestId: row.request_id } : {}),
        ...(originRequestId ? { originRequestId } : {}),
        version: 1,
        payload: row.payload,
      };

      await runWithRequestContext(
        { requestId: row.request_id || null, originRequestId: originRequestId || null },
        async () => {
          // Publish with timeout
          await Promise.race([
            publisher.publish(envelope),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Outbox publisher timeout')), timeoutMs),
            ),
          ]);

          // Test hook: simulated crash after publish but before marking published_at
          if (process.env.NODE_ENV === 'test' && outboxFailureHook) {
            outboxFailureHook(envelope);
          }

          await tx.query('UPDATE outbox SET published_at = now() WHERE id = $1;', [row.id]);
          published.push(envelope);
        },
      );
    }

    return published;
  };

  if (client) {
    return execute(client);
  }
  return withTx(execute);
}
