import { notificationsRepository } from './repository.js';
import { ordersService } from '../orders/service.js';
import { paymentsService } from '../payments/service.js';
import { propertiesService } from '../properties/service.js';
import { servicesService } from '../services/service.js';
import { usersService } from '../users/service.js';
import { withTx } from '../../infrastructure/postgres.js';
import { env } from '../../config/env.js';
import { logger } from '../../middleware/requestLogger.js';

/**
 * Fake mailer that logs structured email deliveries and records send count for tests.
 */
export const fakeMailer = {
  sentMessages: [],

  reset() {
    this.sentMessages = [];
  },

  async send(notification) {
    logger.info(
      {
        notificationId: notification.id,
        userId: notification.user_id,
        eventId: notification.event_id,
        eventType: notification.event_type,
      },
      'FakeMailer: sent notification email',
    );
    this.sentMessages.push({
      notificationId: notification.id,
      userId: notification.user_id,
      eventId: notification.event_id,
      eventType: notification.event_type,
      sentAt: new Date().toISOString(),
    });
    return { delivered: true };
  },
};

// Test hook for simulating crash after DB insert and before mailer send (Change #1)
let notificationAfterInsertHook = null;

export function setNotificationAfterInsertHook(fn) {
  if (process.env.NODE_ENV === 'test') {
    notificationAfterInsertHook = fn;
  }
}

export function clearNotificationAfterInsertHook() {
  notificationAfterInsertHook = null;
}

const SUPPORTED_NOTIFICATION_EVENTS = new Set([
  'order.confirmed',
  'payment.failed',
  'payment.refund_required',
  'payment.refunded',
]);

export const notificationsService = {
  /**
   * Resolve recipients and deliver notifications for a domain event.
   * Change #1: Does NOT use processed_events.
   * 1. Inserts notification rows with ON CONFLICT (user_id, event_id, event_type) DO NOTHING.
   * 2. Sends every row still PENDING via fakeMailer and marks it SENT.
   * Change #2: Uses service methods only (no direct cross-module table queries).
   * Change #6: Unknown event types or missing entities are logged and acked, never thrown.
   */
  async processEvent(envelope) {
    const { eventId, eventType, aggregateId, payload = {} } = envelope;

    if (!SUPPORTED_NOTIFICATION_EVENTS.has(eventType)) {
      logger.warn(
        { eventId, eventType, aggregateId },
        'Notification worker: unknown or unsupported eventType; skipping and acking',
      );
      return { status: 'ignored_unknown_event', sentCount: 0 };
    }

    const recipients = new Map(); // userId -> notification payload

    if (eventType === 'order.confirmed') {
      const orderId = payload.orderId || aggregateId;
      const order = await ordersService.findOrderInternal(orderId);
      if (!order) {
        logger.warn(
          { eventId, eventType, orderId },
          'Notification worker: order not found; logging and acking',
        );
        return { status: 'ignored_missing_entity', sentCount: 0 };
      }

      // 1. Customer notification
      recipients.set(order.user_id, {
        orderId: order.id,
        recipientRole: 'CUSTOMER',
        totalAmountMinor: order.total_amount_minor,
        currency: order.currency,
        during: order.during,
      });

      // 2. Host & Service Provider notifications
      for (const item of order.items || []) {
        if (item.resource_type === 'PROPERTY') {
          const property = await propertiesService.findPropertyInternal(item.resource_id);
          if (property?.host_id) {
            recipients.set(property.host_id, {
              orderId: order.id,
              orderItemId: item.id,
              recipientRole: 'HOST',
              resourceType: 'PROPERTY',
              resourceId: property.id,
              title: item.title,
              during: order.during,
            });
          }
        } else if (item.resource_type === 'SERVICE') {
          const providerUserId = await servicesService.resolveServiceOwnerUserId(item.resource_id);
          if (providerUserId) {
            recipients.set(providerUserId, {
              orderId: order.id,
              orderItemId: item.id,
              recipientRole: 'PROVIDER',
              resourceType: 'SERVICE',
              resourceId: item.resource_id,
              title: item.title,
              quantity: item.quantity,
              slot: item.slot,
              during: order.during,
            });
          }
        }
      }
    } else if (
      eventType === 'payment.failed' ||
      eventType === 'payment.refund_required' ||
      eventType === 'payment.refunded'
    ) {
      const paymentId = payload.paymentId || aggregateId;
      const payment = await paymentsService.findPaymentInternal(paymentId);
      const orderId = payload.orderId || payment?.order_id;
      const order = orderId ? await ordersService.findOrderInternal(orderId) : null;

      if (!order) {
        logger.warn(
          { eventId, eventType, paymentId, orderId },
          'Notification worker: order/payment not found; logging and acking',
        );
        return { status: 'ignored_missing_entity', sentCount: 0 };
      }

      recipients.set(order.user_id, {
        orderId: order.id,
        paymentId: payment?.id || paymentId,
        recipientRole: 'CUSTOMER',
        amountMinor: payment?.amount_minor || payload.amountMinor,
        currency: payment?.currency || payload.currency || order.currency,
      });
    }

    // Step 1: Insert PENDING rows with ON CONFLICT (user_id, event_id, event_type) DO NOTHING
    for (const [userId, notifPayload] of recipients.entries()) {
      const user = await usersService.findUserInternal(userId);
      if (!user) {
        logger.warn({ eventId, userId }, 'Notification worker: recipient user missing; skipping user');
        continue;
      }

      await notificationsRepository.insertPending({
        userId,
        eventId,
        eventType,
        payload: notifPayload,
      });
    }

    // Test hook: simulate crash right after inserting PENDING rows, before sending
    if (process.env.NODE_ENV === 'test' && notificationAfterInsertHook) {
      notificationAfterInsertHook(envelope);
    }

    // Step 2: Send every row still PENDING for this event and mark it SENT
    const sentCount = await withTx(async (tx) => {
      const pendingRows = await notificationsRepository.findPendingByEvent(eventId, eventType, tx);
      let count = 0;

      for (const row of pendingRows) {
        await fakeMailer.send(row);
        const updated = await notificationsRepository.markSent(row.id, tx);
        if (updated) {
          count += 1;
        }
      }

      return count;
    });

    return { status: 'processed', sentCount };
  },

  /**
   * Scheduler job (Change #1):
   * Retries notifications stuck in PENDING for over olderThanMinutes.
   */
  async retryPendingNotifications({
    olderThanMinutes = env.NOTIFICATION_RETRY_MINUTES,
    limit = 50,
  } = {}) {
    return withTx(async (tx) => {
      const staleRows = await notificationsRepository.findStalePending(olderThanMinutes, limit, tx);
      let sentCount = 0;

      for (const row of staleRows) {
        await fakeMailer.send(row);
        const updated = await notificationsRepository.markSent(row.id, tx);
        if (updated) {
          sentCount += 1;
        }
      }

      return { checkedCount: staleRows.length, sentCount };
    });
  },

  async listByEventId(eventId) {
    return notificationsRepository.findByEventId(eventId);
  },

  async listByUserId(userId) {
    return notificationsRepository.findByUserId(userId);
  },
};
