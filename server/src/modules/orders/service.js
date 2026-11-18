import { ordersRepository } from './repository.js';
import { propertiesService } from '../properties/service.js';
import { servicesService } from '../services/service.js';
import { reservationsService } from '../reservations/service.js';
import { withTx } from '../../infrastructure/postgres.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../middleware/requestLogger.js';

export const ordersService = {
  /**
   * Create a composite order with price snapshots.
   * Reads prices directly from PostgreSQL (bypassing Redis cache).
   * Validates all items in a single pass (returning 422 ITEM_INVALID on any failure).
   * Calculates duration in days and computes total amount authoritatively on the server.
   * Executes order and item insertions inside a single DB transaction.
   */
  async createOrder(data, user) {
    if (user.role !== 'CUSTOMER') {
      throw new AppError('FORBIDDEN', 403, 'Only customers may create orders');
    }

    const issues = [];
    let property = null;

    // 1. Validate property (if included)
    if (data.property_id) {
      try {
        property = await propertiesService.getPropertyById(data.property_id, { bypassCache: true });
        // getPropertyById already filters for ACTIVE; if we reach here, it's active
        if (data.guest_count > property.capacity) {
          issues.push({
            resource_type: 'PROPERTY',
            resource_id: data.property_id,
            message: `guest_count (${data.guest_count}) exceeds property capacity (${property.capacity})`,
          });
        }
      } catch (err) {
        issues.push({
          resource_type: 'PROPERTY',
          resource_id: data.property_id,
          message: err.message || 'Property not found or not active',
        });
      }
    }

    // 2. Validate services
    const serviceMap = new Map();
    if (data.services && data.services.length > 0) {
      for (const item of data.services) {
        try {
          const service = await servicesService.getServiceById(item.service_id, { bypassCache: true });
          // getServiceById already filters for ACTIVE; if we reach here, it's active
          if (service.kind === 'capacity' && !item.slot) {
            issues.push({
              resource_type: 'SERVICE',
              resource_id: item.service_id,
              message: 'Slot identifier is required for capacity-based service',
            });
          }
          serviceMap.set(item.service_id, service);
        } catch (err) {
          issues.push({
            resource_type: 'SERVICE',
            resource_id: item.service_id,
            message: err.message || 'Service not found or not active',
          });
        }
      }
    }

    // 3. Verify single uniform currency across all items
    const allCurrencies = [];
    if (property) allCurrencies.push(property.currency);
    for (const svc of serviceMap.values()) {
      allCurrencies.push(svc.currency);
    }
    if (new Set(allCurrencies).size > 1) {
      issues.push({
        message: 'All items in an order must share the same currency',
      });
    }

    // Reject with 422 if any validation failed
    if (issues.length > 0) {
      throw new AppError('ITEM_INVALID', 422, 'One or more items in the order are invalid', { issues });
    }

    // 4. Calculate duration and build snapshots
    const startMs = new Date(data.during.start).getTime();
    const endMs = new Date(data.during.end).getTime();
    const durationDays = Math.max(1, Math.ceil((endMs - startMs) / (1000 * 60 * 60 * 24)));
    const duringRange = `[${data.during.start}, ${data.during.end})`;

    const items = [];
    if (property) {
      items.push({
        resource_type: 'PROPERTY',
        resource_id: property.id,
        quantity: durationDays,
        unit_price_minor: property.pricing_minor,
        currency: property.currency,
        title: property.title,
        slot: null,
        pricing_unit: 'PER_DAY',
      });
    }

    for (const s of data.services) {
      const service = serviceMap.get(s.service_id);
      items.push({
        resource_type: 'SERVICE',
        resource_id: service.id,
        quantity: s.quantity,
        unit_price_minor: service.price_minor,
        currency: service.currency,
        title: service.title,
        slot: s.slot || null,
        pricing_unit: 'PER_UNIT',
      });
    }

    const totalAmountMinor = items.reduce(
      (sum, it) => sum + it.unit_price_minor * it.quantity,
      0,
    );

    const currency = items[0].currency;

    // 5. Atomic single transaction insert
    return withTx(async (tx) => {
      return ordersRepository.createOrderWithItems(
        {
          userId: user.id,
          status: 'PENDING',
          totalAmountMinor,
          currency,
          during: duringRange,
          guestCount: data.guest_count,
          items,
        },
        tx,
      );
    });
  },

  /**
   * Get an order by ID.
   * Enforces customer ownership or ADMIN access.
   * Reads from orders and order_items only; never joins live catalog tables (BR-04).
   */
  async getOrderById(id, user) {
    const order = await ordersRepository.findById(id);
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 404, 'Order not found');
    }

    if (order.user_id !== user.id && user.role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 403, 'You do not have permission to view this order');
    }

    const items = await ordersRepository.findItemsByOrderId(order.id);
    return {
      ...order,
      items,
    };
  },

  /**
   * Place an order on hold (checkout initiation).
   * Enforces customer ownership and PENDING status.
   * Holds items in fixed order (PROPERTY first, then SERVICES).
   * Runs in-code compensation (releasing all held items) on ANY failure path,
   * including when the final guarded status update affects zero rows.
   */
  async holdOrder(id, user) {
    if (user.role !== 'CUSTOMER') {
      throw new AppError('FORBIDDEN', 403, 'Only customers may place orders on hold');
    }

    const order = await ordersRepository.findById(id);
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 404, 'Order not found');
    }

    if (order.user_id !== user.id) {
      throw new AppError('FORBIDDEN', 403, 'You do not own this order');
    }

    if (order.status !== 'PENDING') {
      throw new AppError('ORDER_NOT_HOLDABLE', 409, 'Only PENDING orders can be placed on hold');
    }

    const items = await ordersRepository.findItemsByOrderId(order.id);
    const heldReservations = [];
    let currentItem = null;

    try {
      for (const item of items) {
        currentItem = item;
        const holdPayload = {
          order_item_id: item.id,
          resource_type: item.resource_type,
          resource_id: item.resource_id,
          quantity: item.quantity,
          slot: item.slot,
        };
        const reservation = await reservationsService.hold(holdPayload, order.during);
        heldReservations.push(reservation);
      }

      // Earliest hold_expires_at among order's reservations
      const earliestExpiry = new Date(
        Math.min(...heldReservations.map((r) => new Date(r.hold_expires_at).getTime())),
      );

      // Guarded update: transition from PENDING to HELD
      const updatedOrder = await ordersRepository.updateStatusGuarded(
        order.id,
        'PENDING',
        'HELD',
        { holdExpiresAt: earliestExpiry },
      );

      if (!updatedOrder) {
        throw new AppError('ORDER_NOT_HOLDABLE', 409, 'Order was already modified or is no longer in PENDING state');
      }

      return {
        order_id: updatedOrder.id,
        status: updatedOrder.status,
        hold_expires_at: updatedOrder.hold_expires_at,
      };
    } catch (err) {
      // In-code compensation: release all holds made so far
      for (const r of heldReservations.slice().reverse()) {
        try {
          await reservationsService.release(r.id);
        } catch (compErr) {
          logger.error(
            { err: compErr.message, reservationId: r.id },
            'Compensation release failed',
          );
        }
      }

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
};
