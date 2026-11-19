import { createConsumer } from '../consumer.js';
import { QUEUE_DEFINITIONS } from '../../infrastructure/sqs/client.js';
import { notificationsService } from '../../modules/notifications/service.js';

/**
 * Notification Worker:
 * Change #1: Does NOT use processed_events.
 * Delegates to notificationsService.processEvent(envelope), which inserts
 * PENDING rows with ON CONFLICT (user_id, event_id, event_type) DO NOTHING
 * and sends every row still PENDING via fakeMailer.
 */
export async function handleNotificationMessage(envelope) {
  return notificationsService.processEvent(envelope);
}

export function createNotificationConsumer(options = {}) {
  return createConsumer({
    name: 'notification',
    queueUrl: QUEUE_DEFINITIONS.notifications.url,
    handler: handleNotificationMessage,
    useProcessedEvents: false,
    ...options,
  });
}
