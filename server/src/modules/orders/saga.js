import { sagaRepository } from './sagaRepository.js';
import { ordersRepository } from './repository.js';
import { reservationsService } from '../reservations/service.js';
import { withTx, db } from '../../infrastructure/postgres.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../middleware/requestLogger.js';

// Test failure injection hooks (active only when NODE_ENV=test)
const failureHooks = new Map();

export function setFailureHook(name, fn) {
  if (process.env.NODE_ENV === 'test') {
    failureHooks.set(name, fn);
  }
}

export function clearFailureHooks() {
  failureHooks.clear();
}

function triggerFailureHook(name, context) {
  if (process.env.NODE_ENV === 'test' && failureHooks.has(name)) {
    const fn = failureHooks.get(name);
    fn(context);
  }
}

export const sagaOrchestrator = {
  /**
   * Execute hold phase via Saga orchestrator.
   * Steps:
   * 0. Init / reset saga row inside transaction.
   * 1. Hold property (if present).
   * 2. Hold each service sequentially.
   * 3. Update order to HELD with earliest expiry, saga to AWAITING_PAYMENT.
   * Failure at any step triggers backward compensation in reverse order.
   */
  async executeHold(orderId, user) {
    if (user.role !== 'CUSTOMER') {
      throw new AppError('FORBIDDEN', 403, 'Only customers may place orders on hold');
    }

    // Phase 1: Lock order and acquire / reset saga row
    const { order, saga, items } = await withTx(async (tx) => {
      const lockedOrder = await ordersRepository.findByIdForUpdate(orderId, tx);
      if (!lockedOrder) {
        throw new AppError('ORDER_NOT_FOUND', 404, 'Order not found');
      }

      if (lockedOrder.user_id !== user.id) {
        throw new AppError('FORBIDDEN', 403, 'You do not own this order');
      }

      if (lockedOrder.status !== 'PENDING') {
        throw new AppError('ORDER_NOT_HOLDABLE', 409, 'Only PENDING orders can be placed on hold');
      }

      // Try inserting new saga row
      let sagaRow = await sagaRepository.insertSaga(
        { orderId: lockedOrder.id, state: 'STARTED', step: 0, context: { held_reservations: [] } },
        tx,
      );

      // If saga already existed (e.g. from previous attempt)
      if (!sagaRow) {
        const existingSaga = await sagaRepository.findByOrderIdForUpdate(lockedOrder.id, tx);
        if (!existingSaga) {
          throw new AppError('ORDER_NOT_HOLDABLE', 409, 'Order is currently being processed');
        }

        // Change #4: Saga reset from FAILED to STARTED only if order is still PENDING
        if (existingSaga.state === 'FAILED') {
          sagaRow = await sagaRepository.resetFailedSaga(
            lockedOrder.id,
            { held_reservations: [] },
            tx,
          );
        } else {
          // If in any other state (STARTED, HOLDING_*, AWAITING_PAYMENT, etc.), reject parallel hold
          throw new AppError(
            'ORDER_NOT_HOLDABLE',
            409,
            'Order is currently being held or already processed',
          );
        }
      }

      const orderItems = await ordersRepository.findItemsByOrderId(lockedOrder.id, tx);
      return { order: lockedOrder, saga: sagaRow, items: orderItems };
    });

    const heldReservations = [];
    let currentItem = null;

    try {
      // Step 1: Hold Property (if present)
      const propertyItem = items.find((i) => i.resource_type === 'PROPERTY');
      if (propertyItem) {
        currentItem = propertyItem;
        await sagaRepository.updateState(saga.id, {
          state: 'HOLDING_PROPERTY',
          step: 1,
          context: { held_reservations: heldReservations },
        });

        const reservation = await reservationsService.hold(
          {
            order_item_id: propertyItem.id,
            resource_type: propertyItem.resource_type,
            resource_id: propertyItem.resource_id,
            quantity: propertyItem.quantity,
            slot: propertyItem.slot,
          },
          order.during,
        );
        heldReservations.push(reservation);

        await sagaRepository.updateState(saga.id, {
          state: 'HOLDING_PROPERTY',
          step: 1,
          context: { held_reservations: heldReservations },
        });

        triggerFailureHook('after_property_hold', { sagaId: saga.id, orderId: order.id });
      }

      // Step 2: Hold each service
      const serviceItems = items.filter((i) => i.resource_type === 'SERVICE');
      if (serviceItems.length > 0) {
        await sagaRepository.updateState(saga.id, {
          state: 'HOLDING_SERVICES',
          step: 2,
          context: { held_reservations: heldReservations },
        });

        for (const svcItem of serviceItems) {
          currentItem = svcItem;
          const reservation = await reservationsService.hold(
            {
              order_item_id: svcItem.id,
              resource_type: svcItem.resource_type,
              resource_id: svcItem.resource_id,
              quantity: svcItem.quantity,
              slot: svcItem.slot,
            },
            order.during,
          );
          heldReservations.push(reservation);

          await sagaRepository.updateState(saga.id, {
            state: 'HOLDING_SERVICES',
            step: 2,
            context: { held_reservations: heldReservations },
          });

          triggerFailureHook('after_service_hold', {
            sagaId: saga.id,
            orderId: order.id,
            serviceId: svcItem.resource_id,
          });
        }
      }

      // Step 3: Complete hold phase
      const earliestExpiry = new Date(
        Math.min(...heldReservations.map((r) => new Date(r.hold_expires_at).getTime())),
      );

      // Guarded transition to HELD
      const updatedOrder = await ordersRepository.updateStatusGuarded(
        order.id,
        'PENDING',
        'HELD',
        { holdExpiresAt: earliestExpiry },
      );

      if (!updatedOrder) {
        throw new AppError(
          'ORDER_NOT_HOLDABLE',
          409,
          'Order was modified or is no longer in PENDING state',
        );
      }

      // Mark saga AWAITING_PAYMENT (Change #1)
      await sagaRepository.updateState(saga.id, {
        state: 'AWAITING_PAYMENT',
        step: 2,
        context: { held_reservations: heldReservations },
      });

      return {
        order_id: updatedOrder.id,
        status: updatedOrder.status,
        hold_expires_at: updatedOrder.hold_expires_at,
      };
    } catch (err) {
      if (err.isSimulatedCrash) {
        throw err;
      }
      // Failure during holding phase -> run compensations in reverse order (Change #2)
      await sagaRepository.updateState(saga.id, {
        state: 'COMPENSATING',
        step: 0,
        context: { held_reservations: heldReservations, error: err.message },
      });

      for (const r of heldReservations.slice().reverse()) {
        try {
          await reservationsService.release(r.id);
        } catch (compErr) {
          logger.error({ reservationId: r.id, err: compErr.message }, 'Saga compensation release failed');
        }
      }

      // Mark saga FAILED; order stays PENDING
      await sagaRepository.updateState(saga.id, {
        state: 'FAILED',
        step: 0,
        context: { held_reservations: [], error: err.message },
      });

      if (err instanceof AppError) {
        if (currentItem && !err.details?.resource_id) {
          err.details = {
            ...err.details,
            resource_id: currentItem.resource_id,
            resource_type: currentItem.resource_type,
          };
        }
        throw err;
      }

      throw new AppError(
        'RESOURCE_CONFLICT',
        409,
        err.message || 'One or more items could not be held',
        {
          resource_id: currentItem?.resource_id,
          resource_type: currentItem?.resource_type,
        },
      );
    }
  },

  // ------------------ Hooks Called by Payments Module (Change #6) ------------------

  async onPaymentInitiated(orderId, client = db) {
    return sagaRepository.updateStateByOrderId(
      orderId,
      { state: 'PAYING', step: 3 },
      client,
    );
  },

  async onPaymentSucceededBeforeConfirm(orderId, client = db) {
    return sagaRepository.updateStateByOrderId(
      orderId,
      { state: 'CONFIRMING', step: 4 },
      client,
    );
  },

  async onBookingConfirmed(orderId, client = db) {
    return sagaRepository.updateStateByOrderId(
      orderId,
      { state: 'COMPLETED', step: 4 },
      client,
    );
  },

  async onBookingRefundRequired(orderId, client = db) {
    return sagaRepository.updateStateByOrderId(
      orderId,
      { state: 'REFUNDING', step: 4 },
      client,
    );
  },

  async onPaymentFailed(orderId, client = db) {
    return sagaRepository.updateStateByOrderId(
      orderId,
      { state: 'FAILED', step: 0 },
      client,
    );
  },

  // ------------------ Saga Recovery (Changes #1, #2, #5) ------------------

  /**
   * Recovers non-terminal sagas updated before threshold.
   * Claims and processes each stale saga with FOR UPDATE SKIP LOCKED so concurrent
   * recovery passes partition work without self-locking during external provider calls.
   */
  async recoverSagas({ olderThanSeconds = env.SAGA_STALE_SECONDS } = {}) {
    const results = [];

    // 1. Atomically claim a batch of stale unsettled sagas by bumping updated_at = now()
    //    using FOR UPDATE SKIP LOCKED, returning their pre-claim state and order info.
    const claimedSagas = await withTx(async (tx) => {
      const stale = await sagaRepository.findStaleUnsettledSagas(olderThanSeconds, 20, tx);
      for (const s of stale) {
        // Touch updated_at inside the lock transaction so a concurrent recoverSagas()
        // either skips the locked row (while tx is open) or sees updated_at = now() after commit.
        await tx.query('UPDATE saga_instances SET updated_at = now() WHERE id = $1;', [s.id]);
      }
      return stale;
    });

    for (const saga of claimedSagas) {
      try {
        // Rule 1: AWAITING_PAYMENT (Change #1)
        if (saga.state === 'AWAITING_PAYMENT') {
          const holdExpiry = new Date(saga.hold_expires_at).getTime();
          // If hold still active, ignore it (customer still paying)
          if (holdExpiry > Date.now()) {
            results.push({ sagaId: saga.id, orderId: saga.order_id, action: 'ignored_active_hold' });
            continue;
          }

          // Hold expired: fail safe, release leftover holds, return order to PENDING, set saga FAILED
          await reservationsService.releaseOrderReservations(saga.order_id);
          await ordersRepository.updateStatusGuarded(saga.order_id, ['HELD'], 'PENDING');
          await sagaRepository.updateState(saga.id, { state: 'FAILED', step: 0 });
          results.push({
            sagaId: saga.id,
            orderId: saga.order_id,
            action: 'expired_awaiting_payment_recovered',
          });
          continue;
        }

        // Rule 2: Interrupted during pre-payment holding phase (Fail safe: compensate)
        if (
          ['STARTED', 'HOLDING_PROPERTY', 'HOLDING_SERVICES', 'COMPENSATING'].includes(saga.state)
        ) {
          await reservationsService.releaseOrderReservations(saga.order_id);
          await ordersRepository.updateStatusGuarded(saga.order_id, ['HELD'], 'PENDING');
          await sagaRepository.updateState(saga.id, { state: 'FAILED', step: 0 });
          results.push({
            sagaId: saga.id,
            orderId: saga.order_id,
            action: 'holding_phase_compensated',
          });
          continue;
        }

        // Rule 3: PAYING (Change #5: delegate to payment reconciler)
        if (saga.state === 'PAYING') {
          const { paymentsRepository } = await import('../payments/repository.js');
          const { paymentsService } = await import('../payments/service.js');
          const payments = await paymentsRepository.findByOrderId(saga.order_id);
          const activePayment = payments.find(
            (p) => p.status === 'PROCESSING' || p.status === 'PENDING',
          );
          if (activePayment) {
            await paymentsService.reconcilePayment(activePayment.id);
            results.push({ sagaId: saga.id, orderId: saga.order_id, action: 'paying_reconciled' });
          } else {
            results.push({
              sagaId: saga.id,
              orderId: saga.order_id,
              action: 'no_active_payment_to_reconcile',
            });
          }
          continue;
        }

        // Rule 4: CONFIRMING (crashed after payment capture before confirmation)
        if (saga.state === 'CONFIRMING') {
          const { paymentsRepository } = await import('../payments/repository.js');
          const { paymentsService } = await import('../payments/service.js');
          const payments = await paymentsRepository.findByOrderId(saga.order_id);
          const payment = payments.find(
            (p) => p.status === 'SUCCESS' || p.status === 'PROCESSING',
          );

          let confirmOk = true;
          try {
            await reservationsService.confirmOrderReservations(saga.order_id);
          } catch {
            confirmOk = false;
          }

          if (confirmOk) {
            await ordersRepository.updateStatusGuarded(saga.order_id, ['HELD'], 'CONFIRMED');
            await sagaRepository.updateState(saga.id, { state: 'COMPLETED', step: 4 });
            results.push({
              sagaId: saga.id,
              orderId: saga.order_id,
              action: 'confirming_completed',
            });
          } else {
            // Confirm failed: refund customer (BR-05)
            await reservationsService.releaseOrderReservations(saga.order_id);
            await ordersRepository.updateStatusGuarded(saga.order_id, ['HELD'], 'FAILED');
            await sagaRepository.updateState(saga.id, { state: 'REFUNDING', step: 4 });
            if (payment) {
              await paymentsService.triggerRefund(payment);
            }
            await sagaRepository.updateState(saga.id, { state: 'FAILED', step: 0 });
            results.push({
              sagaId: saga.id,
              orderId: saga.order_id,
              action: 'confirming_failed_refunded',
            });
          }
          continue;
        }

        // Rule 5: REFUNDING (Change #2: always continue forward)
        if (saga.state === 'REFUNDING') {
          const { paymentsRepository } = await import('../payments/repository.js');
          const { paymentsService } = await import('../payments/service.js');
          const payments = await paymentsRepository.findByOrderId(saga.order_id);
          const payment = payments.find((p) => p.status === 'SUCCESS');
          if (payment) {
            await paymentsService.triggerRefund(payment);
          }
          await ordersRepository.updateStatusGuarded(saga.order_id, ['HELD'], 'FAILED');
          await sagaRepository.updateState(saga.id, { state: 'FAILED', step: 0 });
          results.push({ sagaId: saga.id, orderId: saga.order_id, action: 'refunding_completed' });
          continue;
        }
      } catch (recoveryErr) {
        logger.error(
          { sagaId: saga.id, err: recoveryErr.message },
          'Saga recovery error on instance',
        );
        results.push({ sagaId: saga.id, orderId: saga.order_id, error: recoveryErr.message });
      }
    }

    return results;
  },
};
