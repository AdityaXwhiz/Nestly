import crypto from 'node:crypto';
import { paymentsRepository } from './repository.js';
import { ordersService } from '../orders/service.js';
import { reservationsService } from '../reservations/service.js';
import { outboxRepository } from '../outbox/repository.js';
import { paymentProvider } from '../../infrastructure/payment/index.js';
import { withTx } from '../../infrastructure/postgres.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../middleware/requestLogger.js';

export const paymentsService = {
  /**
   * Create a payment with strict LLD Section 7 idempotency.
   * In ONE database transaction: insert payment (CREATED) and complete the idempotency record.
   * Call the provider afterwards.
   */
  async createPayment({ userId, orderId, idempotencyKey, metadata = {} }) {
    if (!idempotencyKey) {
      throw new AppError('MISSING_IDEMPOTENCY_KEY', 400, 'Idempotency-Key header is required');
    }

    const canonicalBody = JSON.stringify({ order_id: orderId });
    const requestHash = crypto.createHash('sha256').update(canonicalBody).digest('hex');
    const operation = 'create_payment';
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Phase 1: In ONE transaction, resolve idempotency + validate order + insert payment
    const { isReplay, payment } = await withTx(async (tx) => {
      // 1. Attempt to insert idempotency record as IN_PROGRESS
      const insertedKey = await paymentsRepository.insertIdempotencyKey(
        {
          userId,
          operation,
          idempotencyKey,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt,
        },
        tx,
      );

      // If key already existed, handle conflict
      if (!insertedKey) {
        const existingKey = await paymentsRepository.findIdempotencyKey(
          { userId, operation, idempotencyKey },
          tx,
        );

        if (!existingKey) {
          throw new AppError('CONFLICT', 409, 'Idempotency key collision');
        }

        // Different request hash -> key reused with different parameters
        if (existingKey.request_hash !== requestHash) {
          throw new AppError(
            'IDEMPOTENCY_KEY_REUSED',
            422,
            'Idempotency key was previously used with a different request payload',
          );
        }

        // Same hash + IN_PROGRESS -> concurrent request
        if (existingKey.status === 'IN_PROGRESS') {
          throw new AppError(
            'REQUEST_IN_PROGRESS',
            409,
            'An identical request is currently in progress, please retry shortly',
          );
        }

        // Same hash + COMPLETED -> return stored payment
        if (existingKey.status === 'COMPLETED' && existingKey.response_reference) {
          const storedPayment = await paymentsRepository.findById(existingKey.response_reference, tx);
          if (storedPayment) {
            return { isReplay: true, payment: storedPayment };
          }
        }
      }

      // 2. Validate order
      const order = await ordersService.getOrderInternal(orderId, tx);

      if (order.user_id !== userId) {
        throw new AppError('FORBIDDEN', 403, 'You do not own this order');
      }

      if (order.status !== 'HELD') {
        throw new AppError('ORDER_NOT_HOLDABLE', 409, 'Order must be in HELD status to process payment');
      }

      // Check hold expiry
      const now = Date.now();
      const holdExpiryTime = new Date(order.hold_expires_at).getTime();
      if (holdExpiryTime <= now) {
        throw new AppError('HOLD_EXPIRED', 410, 'Order hold has expired');
      }

      // Reject if hold has less than PAYMENT_MIN_HOLD_SECONDS left (configurable, default 60s)
      const remainingHoldSec = (holdExpiryTime - now) / 1000;
      if (remainingHoldSec < env.PAYMENT_MIN_HOLD_SECONDS) {
        throw new AppError(
          'HOLD_EXPIRING_SOON',
          410,
          `Order hold expires in less than ${env.PAYMENT_MIN_HOLD_SECONDS} seconds; please re-hold the order`,
        );
      }

      // 3. Create payment record (amount strictly from server order total)
      let createdPayment;
      try {
        createdPayment = await paymentsRepository.createPayment(
          {
            orderId: order.id,
            amountMinor: order.total_amount_minor,
            currency: order.currency,
            status: 'CREATED',
          },
          tx,
        );
      } catch (err) {
        // Handle partial unique index violation (idx_payments_order_id_active)
        if (err.code === '23505') {
          throw new AppError('ACTIVE_PAYMENT_EXISTS', 409, 'An active payment already exists for this order');
        }
        throw err;
      }

      // 4. Durably complete idempotency record in the same transaction
      await paymentsRepository.updateIdempotencyKey(
        {
          userId,
          operation,
          idempotencyKey,
          status: 'COMPLETED',
          responseReference: createdPayment.id,
        },
        tx,
      );

      // Saga Hook: Transition saga to PAYING (step 3)
      await ordersService.onPaymentInitiated(order.id, tx);

      return { isReplay: false, payment: createdPayment };
    });

    // Replays return existing payment state with 200 OK
    if (isReplay) {
      return { status: 200, payment };
    }

    // Phase 2: Call provider outside the initial transaction
    // Transition to PENDING
    await paymentsRepository.updateStatusGuarded(payment.id, ['CREATED'], 'PENDING');

    const derivedKey = `charge_${payment.id}`;
    let charge;

    try {
      charge = await paymentProvider.createCharge({
        amount_minor: payment.amount_minor,
        currency: payment.currency,
        idempotencyKey: derivedKey,
        reference: `ch_${payment.id}`,
        metadata,
      });

      // Update provider reference and move to PROCESSING
      const updated = await paymentsRepository.updateStatusGuarded(
        payment.id,
        ['PENDING', 'CREATED'],
        'PROCESSING',
        { providerReference: charge.reference },
      );

      return {
        status: 202,
        payment: updated || { ...payment, status: 'PROCESSING', provider_reference: charge.reference },
      };
    } catch (err) {
      // Timeout or network error leaves payment in PROCESSING (ambiguous) -> return 202
      if (err.code === 'ETIMEDOUT' || err.name === 'TimeoutError' || err.code === 'ECONNRESET') {
        logger.warn({ paymentId: payment.id, err: err.message }, 'Provider call timed out; payment marked PROCESSING');
        await paymentsRepository.updateStatusGuarded(
          payment.id,
          ['PENDING', 'CREATED'],
          'PROCESSING',
          { providerReference: `ch_${payment.id}` },
        );
        return {
          status: 202,
          payment: { ...payment, status: 'PROCESSING' },
          message: 'Payment is processing; confirmation will arrive via webhook or reconciliation',
        };
      }

      // Synchronous failure from provider (e.g. card declined) -> mark FAILED and release holds
      logger.error({ paymentId: payment.id, err: err.message }, 'Payment provider rejected charge');
      await paymentsRepository.updateStatusGuarded(payment.id, ['PENDING', 'CREATED'], 'FAILED');
      try {
        await reservationsService.releaseOrderReservations(payment.order_id);
        await ordersService.updateOrderStatus(payment.order_id, ['HELD'], 'FAILED');
      } catch (cleanupErr) {
        logger.error({ cleanupErr: cleanupErr.message }, 'Failed releasing holds on payment rejection');
      }

      throw new AppError(
        'PAYMENT_FAILED',
        400,
        err.message || 'Payment could not be processed',
      );
    }
  },

  async getPaymentById(id, user) {
    const payment = await paymentsRepository.findById(id);
    if (!payment) {
      throw new AppError('PAYMENT_NOT_FOUND', 404, 'Payment not found');
    }

    if (user.role !== 'ADMIN') {
      const order = await ordersService.getOrderInternal(payment.order_id);
      if (order.user_id !== user.id) {
        throw new AppError('FORBIDDEN', 403, 'You do not have permission to view this payment');
      }
    }

    return payment;
  },

  /**
   * Webhook handler.
   * Entire process runs in ONE transaction:
   * 1. Check signature & timestamp (5 min window).
   * 2. Insert payment_transactions (provider_event_id ON CONFLICT DO NOTHING).
   * 3. Apply guarded transition on payment & reservations & order.
   * 4. Record outbox events.
   * If any step throws, everything rolls back so a redelivery works.
   */
  async handleWebhook({ rawBody, headers }) {
    // 1. Verify signature and timestamp
    const verification = paymentProvider.verifyWebhook(rawBody, headers);
    if (!verification.valid) {
      if (verification.reason === 'STALE_TIMESTAMP') {
        throw new AppError('STALE_TIMESTAMP', 400, 'Webhook timestamp is older than 5 minutes');
      }
      throw new AppError('INVALID_SIGNATURE', 401, 'Invalid webhook signature');
    }

    let event;
    try {
      event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch {
      throw new AppError('VALIDATION_ERROR', 400, 'Malformed webhook JSON payload');
    }

    const { event_id, type, data } = event;
    if (!event_id || !data || !data.reference) {
      throw new AppError('VALIDATION_ERROR', 400, 'Missing event_id or data.reference');
    }

    // Locate payment by reference or ID
    let payment = await paymentsRepository.findByProviderReference(data.reference);
    if (!payment) {
      // Try stripping prefix or checking by ID
      const rawId = data.reference.startsWith('ch_') ? data.reference.slice(3) : data.reference;
      payment = await paymentsRepository.findById(rawId);
    }

    if (!payment) {
      logger.warn({ reference: data.reference }, 'Webhook received for unknown payment reference; ignoring');
      return { status: 'ignored', reason: 'PAYMENT_NOT_FOUND' };
    }

    // Verify amount and currency match
    if (data.amount_minor !== undefined && data.currency !== undefined) {
      if (
        Number(data.amount_minor) !== Number(payment.amount_minor) ||
        data.currency !== payment.currency
      ) {
        logger.warn(
          {
            paymentId: payment.id,
            expected: { amount: payment.amount_minor, currency: payment.currency },
            received: { amount: data.amount_minor, currency: data.currency },
          },
          'Webhook amount or currency mismatch; ignoring',
        );
        return { status: 'ignored', reason: 'AMOUNT_OR_CURRENCY_MISMATCH' };
      }
    }

    const eventStatus = data.status || (type === 'payment.succeeded' ? 'SUCCESS' : 'FAILED');
    let refundNeeded = false;

    // 2. Execute everything in ONE transaction
    await withTx(async (tx) => {
      // Deduplicate: insert transaction log
      const txRow = await paymentsRepository.insertTransaction(
        {
          paymentId: payment.id,
          providerEventId: event_id,
          type: 'WEBHOOK',
          amountMinor: payment.amount_minor,
        },
        tx,
      );

      // Duplicate event: return early (commit empty tx)
      if (!txRow) {
        logger.info({ event_id }, 'Duplicate webhook event received; ignoring');
        return;
      }

      // Check current payment status: if already in a terminal state, don't overwrite
      if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(payment.status)) {
        logger.info({ paymentId: payment.id, status: payment.status }, 'Payment already in terminal state; ignoring transition');
        return;
      }

      if (eventStatus === 'SUCCESS') {
        // Saga Hook: Transition saga to CONFIRMING (step 4)
        await ordersService.onPaymentSucceededBeforeConfirm(payment.order_id, tx);

        // Attempt to confirm reservations
        let confirmError = null;
        try {
          await reservationsService.confirmOrderReservations(payment.order_id, tx);
        } catch (err) {
          if (err.code === 'HOLD_EXPIRED' || err.statusCode === 410) {
            confirmError = err;
          } else {
            // Any unexpected system/database failure throws and rolls back the entire transaction!
            throw err;
          }
        }

        if (confirmError) {
          // If confirm threw HOLD_EXPIRED or capacity unavailable:
          // Money was captured, but booking was lost!
          // Mark order FAILED, release remaining holds, keep payment SUCCESS, emit 'payment.refund_required'
          logger.warn(
            { paymentId: payment.id, err: confirmError.message },
            'Reservations confirmation failed after payment capture; marking order FAILED and scheduling refund',
          );

          await reservationsService.releaseOrderReservations(payment.order_id, tx);
          await ordersService.updateOrderStatus(payment.order_id, ['HELD'], 'FAILED', tx);
          await ordersService.onBookingRefundRequired(payment.order_id, tx);
          await paymentsRepository.updateStatusGuarded(
            payment.id,
            ['CREATED', 'PENDING', 'PROCESSING'],
            'SUCCESS',
            { providerReference: data.reference },
            tx,
          );

          await outboxRepository.createEvent(
            {
              aggregateId: payment.id,
              eventType: 'payment.refund_required',
              payload: {
                paymentId: payment.id,
                orderId: payment.order_id,
                amountMinor: payment.amount_minor,
                currency: payment.currency,
                reason: confirmError.message,
              },
            },
            tx,
          );

          refundNeeded = true;
        } else {
          // Confirm succeeded: complete booking
          await ordersService.updateOrderStatus(payment.order_id, ['HELD'], 'CONFIRMED', tx);
          await ordersService.onBookingConfirmed(payment.order_id, tx);
          await paymentsRepository.updateStatusGuarded(
            payment.id,
            ['CREATED', 'PENDING', 'PROCESSING'],
            'SUCCESS',
            { providerReference: data.reference },
            tx,
          );

          await outboxRepository.createEvent(
            {
              aggregateId: payment.id,
              eventType: 'payment.succeeded',
              payload: {
                paymentId: payment.id,
                orderId: payment.order_id,
                amountMinor: payment.amount_minor,
                currency: payment.currency,
              },
            },
            tx,
          );

          await outboxRepository.createEvent(
            {
              aggregateId: payment.order_id,
              eventType: 'order.confirmed',
              payload: {
                orderId: payment.order_id,
                paymentId: payment.id,
              },
            },
            tx,
          );
        }
      } else {
        // Payment FAILED
        await reservationsService.releaseOrderReservations(payment.order_id, tx);
        await ordersService.updateOrderStatus(payment.order_id, ['HELD'], 'FAILED', tx);
        await ordersService.onPaymentFailed(payment.order_id, tx);
        await paymentsRepository.updateStatusGuarded(
          payment.id,
          ['CREATED', 'PENDING', 'PROCESSING'],
          'FAILED',
          { providerReference: data.reference },
          tx,
        );

        await outboxRepository.createEvent(
          {
            aggregateId: payment.id,
            eventType: 'payment.failed',
            payload: {
              paymentId: payment.id,
              orderId: payment.order_id,
            },
          },
          tx,
        );
      }
    });

    // 3. Post-commit: trigger refund if required (Change #2)
    if (refundNeeded) {
      await this.triggerRefund(payment).catch((err) => {
        logger.error({ paymentId: payment.id, err: err.message }, 'Async refund trigger failed; will be retried');
      });
    }

    return { status: 'processed', event_id };
  },

  /**
   * Execute refund after commit.
   * Calls provider with an idempotency key derived from payment id.
   * Sets REFUNDED only after provider confirms.
   */
  async triggerRefund(payment) {
    const refundIdempotencyKey = `refund_${payment.id}`;
    const chargeRef = payment.provider_reference || `ch_${payment.id}`;

    const refund = await paymentProvider.refund({
      chargeRef,
      amount_minor: payment.amount_minor,
      idempotencyKey: refundIdempotencyKey,
    });

    // Guarded update to REFUNDED
    await paymentsRepository.updateStatusGuarded(payment.id, ['SUCCESS'], 'REFUNDED');

    await outboxRepository.createEvent({
      aggregateId: payment.id,
      eventType: 'payment.refunded',
      payload: {
        paymentId: payment.id,
        orderId: payment.order_id,
        refundReference: refund.refund_reference,
        amountMinor: payment.amount_minor,
      },
    });

    return refund;
  },

  /**
   * Reconcile a single payment stuck in PROCESSING.
   */
  async reconcilePayment(paymentId) {
    const payment = await paymentsRepository.findById(paymentId);
    if (!payment) {
      throw new AppError('PAYMENT_NOT_FOUND', 404, 'Payment not found');
    }

    if (payment.status !== 'PROCESSING') {
      return { status: 'already_terminal', paymentStatus: payment.status };
    }

    const chargeRef = payment.provider_reference || `ch_${payment.id}`;
    let charge;
    try {
      charge = await paymentProvider.getCharge(chargeRef);
    } catch (err) {
      logger.warn({ paymentId, err: err.message }, 'Failed to fetch charge from provider during reconciliation');
      return { status: 'provider_unavailable' };
    }

    // Build synthetic webhook payload and run through handleWebhook
    const syntheticEvent = {
      event_id: `reconcile_${payment.id}_${Date.now()}`,
      type: charge.status === 'SUCCESS' ? 'payment.succeeded' : 'payment.failed',
      data: {
        reference: chargeRef,
        status: charge.status,
        amount_minor: charge.amount_minor,
        currency: charge.currency,
      },
    };

    const timestamp = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify(syntheticEvent);
    const signature = crypto
      .createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    return this.handleWebhook({
      rawBody,
      headers: {
        'x-timestamp': String(timestamp),
        'x-signature': `t=${timestamp},v1=${signature}`,
      },
    });
  },

  /**
   * Retry pending refunds for payments that are SUCCESS with a FAILED order (Change #2).
   */
  async retryPendingRefunds() {
    const pendingRefunds = await paymentsRepository.findPendingRefunds();
    const results = [];
    for (const payment of pendingRefunds) {
      try {
        const res = await this.triggerRefund(payment);
        results.push({ paymentId: payment.id, status: 'refunded', refund: res });
      } catch (err) {
        logger.error({ paymentId: payment.id, err: err.message }, 'Retry pending refund failed');
        results.push({ paymentId: payment.id, status: 'failed', error: err.message });
      }
    }
    return results;
  },

  /**
   * Resume stuck CREATED or PENDING payments older than threshold (Change #3).
   */
  async resumePendingPayments(olderThanSeconds = 30) {
    const stuck = await paymentsRepository.findStuckCreatedOrPending(olderThanSeconds);
    const results = [];
    for (const payment of stuck) {
      const derivedKey = `charge_${payment.id}`;
      try {
        const charge = await paymentProvider.createCharge({
          amount_minor: payment.amount_minor,
          currency: payment.currency,
          idempotencyKey: derivedKey,
          reference: `ch_${payment.id}`,
        });
        await paymentsRepository.updateStatusGuarded(
          payment.id,
          ['CREATED', 'PENDING'],
          'PROCESSING',
          { providerReference: charge.reference },
        );
        results.push({ paymentId: payment.id, status: 'resumed' });
      } catch (err) {
        results.push({ paymentId: payment.id, status: 'failed', error: err.message });
      }
    }
    return results;
  },

  /**
   * Non-throwing internal payment lookup by ID (Change #2 & #6).
   */
  async findPaymentInternal(id, client = undefined) {
    return paymentsRepository.findById(id, client);
  },

  /**
   * Delete expired idempotency_keys on the provided transaction client.
   */
  async deleteExpiredIdempotencyKeys(client = undefined) {
    return paymentsRepository.deleteExpiredIdempotencyKeys(client);
  },

  /**
   * Payment reconciler batch job (Change #4):
   * - Small batch of stuck PROCESSING payments
   * - Max time budget per tick (maxDurationMs)
   * - Also runs resumePendingPayments and retryPendingRefunds within the time budget
   */
  async reconcileStuckPayments({
    olderThanSeconds = 30,
    batchSize = 10,
    maxDurationMs = 8000,
  } = {}) {
    const deadline = Date.now() + maxDurationMs;
    const stuckProcessing = await paymentsRepository.findStuckProcessing(olderThanSeconds, batchSize);
    const reconciled = [];

    for (const payment of stuckProcessing) {
      if (Date.now() >= deadline) break;
      try {
        const res = await this.reconcilePayment(payment.id);
        reconciled.push({ paymentId: payment.id, result: res });
      } catch (err) {
        logger.error({ paymentId: payment.id, err: err.message }, 'Failed reconciling stuck payment');
        reconciled.push({ paymentId: payment.id, status: 'error', error: err.message });
      }
    }

    let resumed = [];
    if (Date.now() < deadline) {
      resumed = await this.resumePendingPayments(olderThanSeconds);
    }

    let refunded = [];
    if (Date.now() < deadline) {
      refunded = await this.retryPendingRefunds();
    }

    return { reconciled, resumed, refunded };
  },
};
