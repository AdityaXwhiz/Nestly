import { reservationsRepository } from './repository.js';
import { servicesRepository } from '../services/repository.js';
import { outboxRepository } from '../outbox/repository.js';
import { withTx } from '../../infrastructure/postgres.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/AppError.js';

export const reservationsService = {
  /**
   * Place a temporary hold on a resource within a transaction.
   * Enforces exclusion constraints, capacity bounds, and host-blocked calendar rules.
   */
  async hold(item, during, holdSeconds = env.HOLD_TTL_SECONDS) {
    return withTx(async (tx) => {
      // 1. Expire stale holds for this resource and give back capacity for capacity services
      const staleHolds = await reservationsRepository.expireStaleHolds(item.resource_id, tx);
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
        if (err.code === '23P01') {
          throw new AppError(
            'RESOURCE_CONFLICT',
            409,
            'Resource is no longer available for this time range',
          );
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

      return reservation;
    });
  },

  /**
   * Confirm an existing hold.
   * Throws 410 HOLD_EXPIRED if hold has expired.
   */
  async confirm(reservationId) {
    return withTx(async (tx) => {
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

      return confirmed;
    });
  },

  /**
   * Release a reservation (transition to CANCELLED).
   * Safe to call multiple times (idempotent); capacity is given back exactly once.
   */
  async release(reservationId) {
    return withTx(async (tx) => {
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
        return row;
      }

      // If already cancelled or not found, return existing record without duplicate decrement
      return reservationsRepository.findById(reservationId, tx);
    });
  },
};
