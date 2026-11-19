import { createConsumer } from '../consumer.js';
import { QUEUE_DEFINITIONS } from '../../infrastructure/sqs/client.js';
import { logger } from '../../middleware/requestLogger.js';

/**
 * Analytics Worker:
 * Loss-tolerant consumer that maintains a structured log and simple event counter.
 */
export const analyticsCounters = {
  byEventType: new Map(),
  totalProcessed: 0,

  reset() {
    this.byEventType.clear();
    this.totalProcessed = 0;
  },

  increment(eventType) {
    const prev = this.byEventType.get(eventType) || 0;
    this.byEventType.set(eventType, prev + 1);
    this.totalProcessed += 1;
  },
};

export async function handleAnalyticsMessage(envelope) {
  const { eventId, eventType, aggregateId, occurredAt } = envelope;

  if (!eventType || typeof eventType !== 'string') {
    logger.warn({ eventId }, 'Analytics worker: missing eventType; logging and acking');
    return { status: 'ignored_unknown_event' };
  }

  analyticsCounters.increment(eventType);

  logger.info(
    {
      eventId,
      eventType,
      aggregateId,
      occurredAt,
      eventTypeCount: analyticsCounters.byEventType.get(eventType),
      totalAnalyticsEvents: analyticsCounters.totalProcessed,
    },
    'Analytics event recorded',
  );

  return { status: 'recorded' };
}

export function createAnalyticsConsumer(options = {}) {
  return createConsumer({
    name: 'analytics',
    queueUrl: QUEUE_DEFINITIONS.analytics.url,
    handler: handleAnalyticsMessage,
    useProcessedEvents: false,
    ...options,
  });
}
