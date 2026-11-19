import { withTx, db } from '../../infrastructure/postgres.js';
import { logger } from '../../middleware/requestLogger.js';

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

let activePublisher = process.env.NODE_ENV === 'test' ? new InMemoryPublisher() : new LogPublisher();

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
      SELECT id, aggregate_id, event_type, payload, created_at
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
      const envelope = {
        eventId: row.id,
        eventType: row.event_type,
        occurredAt: new Date(row.created_at).toISOString(),
        aggregateId: row.aggregate_id,
        version: 1,
        payload: row.payload,
      };

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
    }

    return published;
  };

  if (client) {
    return execute(client);
  }
  return withTx(execute);
}
