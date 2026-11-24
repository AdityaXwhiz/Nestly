import { reservationsRepository } from './repository.js';
import { servicesRepository } from '../services/repository.js';
import { outboxRepository } from '../outbox/repository.js';
import { withTx, db } from '../../infrastructure/postgres.js';
import { acquire, release } from '../../infrastructure/redis/lock.js';
import { reservationsTotal } from '../../infrastructure/metrics/index.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';

export const reservationsService = {
  /**
   * Place a temporary hold on a resource within a transaction.
   * Uses Redis locks to serialize contenders and fast-reject (RESOURCE_BUSY),
   * while relying strictly on PostgreSQL constraints for final correctness.
   */
  async hold(item, during, holdSeconds = env.HOLD_TTL_SECONDS) {
    const lockKey =
      item.resource_type === 'PROPERTY' || !item.slot
        ? `lock:resource:${item.resource_id}`
        : `lock:resource:${item.resource_id}:${item.slot}`;

    let lock;
    const isCapacityService = item.resource_type === 'SERVICE' && item.slot;
    const canRetryLock = isCapacityService || Boolean(item.order_item_id);

    if (canRetryLock) {
      // For capacity services and order items, contenders serialize briefly through the lock
      // to increment capacity without colliding on DB row locks, or check for existing holds
      const maxRetries = 10;
      for (let i = 0; i <= maxRetries; i++) {
        lock = await acquire(lockKey, 5000);
        if (lock.status !== 'busy' || i === maxRetries) break;
        if (item.order_item_id) {
          const existing = await reservationsRepository.findActiveByOrderItemId(item.order_item_id, db);
          if (existing) return existing;
        }
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 15));
      }
    } else {
      // For exclusive resources without order_item_id: immediate fast-reject on busy
      lock = await acquire(lockKey, 5000);
    }

    if (lock.status === 'busy') {
      if (item.order_item_id) {
        const existing = await reservationsRepository.findActiveByOrderItemId(item.order_item_id, db);
        if (existing) return existing;
      }
      reservationsTotal.inc({ outcome: 'conflict' });
      throw new AppError(
        'RESOURCE_BUSY',
        409,
        'Resource is currently being booked by someone else, please retry',
      );
    }

    try {
      return await withTx(async (tx) => {
      // 0. Idempotency check: if order_item_id already has an active reservation, return it
      if (item.order_item_id) {
        const existing = await reservationsRepository.findActiveByOrderItemId(item.order_item_id, tx);
        if (existing) {
          return existing;
        }
      }

      // 1. Expire stale holds for this resource and give back capacity for capacity services
      const staleHolds = await reservationsRepository.expireStaleHolds(item.resource_id, tx);
      if (staleHolds.length > 0) {
        reservationsTotal.inc({ outcome: 'expired' }, staleHolds.length);
      }
      for (const stale of staleHolds) {
        if (!stale.is_exclusive && stale.slot) {
          await reservationsRepository.decrementCapacity(
            stale.resource_id,
            stale.slot,
            stale.quantity,
            tx,
          );
        }
      }

      // 2. Derive is_exclusive from resource type and service kind (never caller input)
      let isExclusive = true;
      if (item.resource_type === 'PROPERTY') {
        isExclusive = true;

        // Check if property is blocked by host in availability table
        const isBlocked = await reservationsRepository.checkPropertyBlocked(
          item.resource_id,
          during,
          tx,
        );
        if (isBlocked) {
          throw new AppError(
            'RESOURCE_CONFLICT',
            409,
            'Property is blocked by the host during this time range',
          );
        }
      } else if (item.resource_type === 'SERVICE') {
        const service = await servicesRepository.findById(item.resource_id, tx);
        if (!service) {
          throw new AppError('SERVICE_NOT_FOUND', 404, 'Service not found');
        }
        isExclusive = service.kind === 'exclusive';
      }

      const quantity = item.quantity || 1;
      const slot = item.slot || null;

      // 3. For capacity-based services, atomically increment reserved count
      if (!isExclusive) {
        if (!slot) {
          throw new AppError('VALIDATION_ERROR', 400, 'Slot identifier is required for capacity-based services');
        }
        const cap = await reservationsRepository.incrementCapacity(
          item.resource_id,
          slot,
          quantity,
          tx,
        );
        if (!cap) {
          throw new AppError('RESOURCE_CONFLICT', 409, 'Service capacity is full for this slot');
        }
      }

      // 4. Calculate hold expiry timestamp
      const ttl = holdSeconds !== undefined ? holdSeconds : env.HOLD_TTL_SECONDS;
      const holdExpiresAt = new Date(Date.now() + ttl * 1000);

      // 5. Insert HELD reservation row (protected by GiST exclusion constraint for exclusive items)
      let reservation;
      try {
        reservation = await reservationsRepository.insertHeld(
          {
            orderItemId: item.order_item_id,
            resourceType: item.resource_type,
            resourceId: item.resource_id,
            during,
            holdExpiresAt,
            isExclusive,
            quantity,
            slot,
          },
          tx,
        );
      } catch (err) {
        if (err.code === '23P01' || err.code === '40P01' || err.code === '40001' || err.code === '23505') {
          const conflictErr = new AppError(
            'RESOURCE_CONFLICT',
            409,
            'Resource is no longer available for this time range',
          );
          conflictErr.originalCode = err.code;
          throw conflictErr;
        }
        throw err;
      }

      // 6. Write outbox event in the same transaction
      await outboxRepository.createEvent(
        {
          aggregateId: reservation.id,
          eventType: 'reservation.held',
          payload: {
            reservationId: reservation.id,
            orderItemId: reservation.order_item_id,
            resourceType: reservation.resource_type,
            resourceId: reservation.resource_id,
            during: reservation.during,
            holdExpiresAt: reservation.hold_expires_at,
            quantity: reservation.quantity,
          },
        },
        tx,
      );

      reservationsTotal.inc({ outcome: 'held' });
      return reservation;
    });
    } catch (err) {
      if (item.order_item_id && (err.originalCode === '23505' || err.originalCode === '23P01')) {
        const existing = await reservationsRepository.findActiveByOrderItemId(item.order_item_id, db);
        if (existing) {
          return existing;
        }
      }
      if (err.code === 'RESOURCE_CONFLICT') {
        reservationsTotal.inc({ outcome: 'conflict' });
      }
      throw err;
    } finally {
      if (lock.token) {
        await release(lockKey, lock.token);
      }
    }
  },

  /**
   * Confirm an existing hold.
   * Throws 410 HOLD_EXPIRED if hold has expired.
   * Accepts an optional external transaction client (for atomic multi-entity commits).
   */
  async confirm(reservationId, externalTx = null) {
    const execute = async (tx) => {
      const confirmed = await reservationsRepository.confirm(reservationId, tx);
      if (!confirmed) {
        throw new AppError('HOLD_EXPIRED', 410, 'Reservation hold has expired');
      }

      await outboxRepository.createEvent(
        {
          aggregateId: confirmed.id,
          eventType: 'reservation.confirmed',
          payload: {
            reservationId: confirmed.id,
            resourceId: confirmed.resource_id,
            status: confirmed.status,
          },
        },
        tx,
      );

      reservationsTotal.inc({ outcome: 'confirmed' });
      return confirmed;
    };

    if (externalTx) {
      return execute(externalTx);
    }
    return withTx(execute);
  },

  /**
   * Release a reservation (transition to CANCELLED).
   * Safe to call multiple times (idempotent); capacity is given back exactly once.
   * Accepts an optional external transaction client.
   */
  async release(reservationId, externalTx = null) {
    const execute = async (tx) => {
      const row = await reservationsRepository.release(reservationId, tx);

      // row is non-null only if status was actively changed
      if (row) {
        if (!row.is_exclusive && row.slot) {
          await reservationsRepository.decrementCapacity(
            row.resource_id,
            row.slot,
            row.quantity,
            tx,
          );
        }

        await outboxRepository.createEvent(
          {
            aggregateId: row.id,
            eventType: 'reservation.released',
            payload: {
              reservationId: row.id,
              resourceId: row.resource_id,
              status: row.status,
            },
          },
          tx,
        );
        reservationsTotal.inc({ outcome: 'released' });
        return row;
      }

      // If already cancelled or not found, return existing record without duplicate decrement
      return reservationsRepository.findById(reservationId, tx);
    };

    if (externalTx) {
      return execute(externalTx);
    }
    return withTx(execute);
  },

  /**
   * Find all reservations for an order.
   */
  async getReservationsByOrderId(orderId, client = undefined) {
    return reservationsRepository.findByOrderId(orderId, client);
  },

  /**
   * Confirm all reservations belonging to an order inside an optional or existing transaction.
   * Throws HOLD_EXPIRED (410) if any hold has expired.
   */
  async confirmOrderReservations(orderId, externalTx = null) {
    const execute = async (tx) => {
      const reservations = await reservationsRepository.findByOrderId(orderId, tx);
      const confirmedList = [];
      for (const r of reservations) {
        const confirmed = await reservationsRepository.confirm(r.id, tx);
        if (!confirmed) {
          throw new AppError('HOLD_EXPIRED', 410, `Reservation ${r.id} hold has expired`);
        }
        await outboxRepository.createEvent(
          {
            aggregateId: confirmed.id,
            eventType: 'reservation.confirmed',
            payload: {
              reservationId: confirmed.id,
              resourceId: confirmed.resource_id,
              status: confirmed.status,
            },
          },
          tx,
        );
        confirmedList.push(confirmed);
        reservationsTotal.inc({ outcome: 'confirmed' });
      }
      return confirmedList;
    };

    if (externalTx) {
      return execute(externalTx);
    }
    return withTx(execute);
  },

  /**
   * Release all reservations belonging to an order inside an optional or existing transaction.
   */
  async releaseOrderReservations(orderId, externalTx = null) {
    const execute = async (tx) => {
      const reservations = await reservationsRepository.findByOrderId(orderId, tx);
      const releasedList = [];
      for (const r of reservations) {
        const row = await reservationsRepository.release(r.id, tx);
        if (row) {
          if (!row.is_exclusive && row.slot) {
            await reservationsRepository.decrementCapacity(
              row.resource_id,
              row.slot,
              row.quantity,
              tx,
            );
          }
          await outboxRepository.createEvent(
            {
              aggregateId: row.id,
              eventType: 'reservation.released',
              payload: {
                reservationId: row.id,
                resourceId: row.resource_id,
                status: row.status,
              },
            },
            tx,
          );
          releasedList.push(row);
          reservationsTotal.inc({ outcome: 'released' });
        }
      }
      return releasedList;
    };

    if (externalTx) {
      return execute(externalTx);
    }
    return withTx(execute);
  },

  /**
   * Hold Sweeper (Change #4 & #5):
   * Sets HELD reservations past hold_expires_at to EXPIRED in batches (LIMIT 200),
   * gives capacity back exactly once, and writes reservation.expired outbox events
   * on the same transaction client.
   */
  async sweepExpiredHolds({ batchSize = 200 } = {}, externalTx = null) {
    const execute = async (tx) => {
      const expiredRows = await reservationsRepository.expireStaleHoldsBatch(batchSize, tx);

      for (const row of expiredRows) {
        if (!row.is_exclusive && row.slot) {
          await reservationsRepository.decrementCapacity(
            row.resource_id,
            row.slot,
            row.quantity,
            tx,
          );
        }

        await outboxRepository.createEvent(
          {
            aggregateId: row.id,
            eventType: 'reservation.expired',
            payload: {
              reservationId: row.id,
              orderItemId: row.order_item_id,
              resourceType: row.resource_type,
              resourceId: row.resource_id,
              status: row.status,
              quantity: row.quantity,
              slot: row.slot,
            },
          },
          tx,
        );
      }

      if (expiredRows.length > 0) {
        reservationsTotal.inc({ outcome: 'expired' }, expiredRows.length);
      }

      return expiredRows;
    };

    if (externalTx) {
      return execute(externalTx);
    }
    return withTx(execute);
  },
};
