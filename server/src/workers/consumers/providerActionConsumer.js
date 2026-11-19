import { createConsumer } from '../consumer.js';
import { QUEUE_DEFINITIONS } from '../../infrastructure/sqs/client.js';
import { ordersService } from '../../modules/orders/service.js';
import { propertiesService } from '../../modules/properties/service.js';
import { servicesService } from '../../modules/services/service.js';
import { providersService } from '../../modules/providers/service.js';
import { logger } from '../../middleware/requestLogger.js';

/**
 * Provider-Action Worker:
 * Creates one fulfilment record per confirmed order item, unique on (order_item_id, action).
 * Change #1: Shares ONE transaction between processed_events and provider_actions inserts.
 * Change #2: Uses service methods only (no direct cross-module table queries).
 * Change #6: Unknown event types or missing entities are logged and acked, never thrown.
 */
export async function handleProviderActionMessage(envelope, { tx } = {}) {
  const { eventId, eventType, aggregateId, payload = {} } = envelope;

  if (eventType !== 'order.confirmed') {
    logger.warn(
      { eventId, eventType, aggregateId },
      'Provider-action worker: unsupported eventType; logging and acking',
    );
    return { status: 'ignored_unknown_event', createdCount: 0 };
  }

  const orderId = payload.orderId || aggregateId;
  const order = await ordersService.findOrderInternal(orderId, tx);

  if (!order) {
    logger.warn(
      { eventId, eventType, orderId },
      'Provider-action worker: order not found; logging and acking',
    );
    return { status: 'ignored_missing_entity', createdCount: 0 };
  }

  let createdCount = 0;

  for (const item of order.items || []) {
    let providerUserId = null;

    if (item.resource_type === 'PROPERTY') {
      const property = await propertiesService.findPropertyInternal(item.resource_id, tx);
      providerUserId = property?.host_id || null;
    } else if (item.resource_type === 'SERVICE') {
      providerUserId = await servicesService.resolveServiceOwnerUserId(item.resource_id, tx);
    }

    if (!providerUserId) {
      logger.warn(
        {
          eventId,
          orderId: order.id,
          orderItemId: item.id,
          resourceType: item.resource_type,
          resourceId: item.resource_id,
        },
        'Provider-action worker: owner not found for order item; skipping item',
      );
      continue;
    }

    const row = await providersService.createProviderAction(
      {
        orderId: order.id,
        orderItemId: item.id,
        providerUserId,
        resourceType: item.resource_type,
        resourceId: item.resource_id,
        action: 'FULFIL_ITEM',
        payload: {
          title: item.title,
          quantity: item.quantity,
          slot: item.slot,
          during: order.during,
          guestCount: order.guest_count,
          unitPriceMinor: item.unit_price_minor,
          currency: item.currency,
        },
      },
      tx,
    );

    if (row) {
      createdCount += 1;
    }
  }

  return { status: 'processed', createdCount };
}

export function createProviderActionConsumer(options = {}) {
  return createConsumer({
    name: 'provider-actions',
    queueUrl: QUEUE_DEFINITIONS['provider-actions'].url,
    handler: handleProviderActionMessage,
    useProcessedEvents: true,
    ...options,
  });
}
