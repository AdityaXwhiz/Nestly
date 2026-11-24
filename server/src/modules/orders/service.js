import { ordersRepository } from './repository.js';
import { sagaOrchestrator } from './saga.js';
import { propertiesService } from '../properties/service.js';
import { servicesService } from '../services/service.js';
import { reservationsService } from '../reservations/service.js';
import { paymentsService } from '../payments/service.js';
import { withTx } from '../../infrastructure/postgres.js';
import { AppError } from '../../errors/AppError.js';
import { logger } from '../../middleware/requestLogger.js';
import { ordersTotal } from '../../infrastructure/metrics/index.js';

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
    const createdOrder = await withTx(async (tx) => {
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

    ordersTotal.inc({ status: 'created' });

    return {
      ...createdOrder,
      server_time: new Date().toISOString(),
    };
  },

  /**
   * Get an order by ID.
   * Enforces customer ownership or ADMIN access.
   * Reads from orders and order_items only; never joins live catalog tables (BR-04).
   * Includes latest payment status and server_time (Change #1 & Change #2).
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
    let payment = null;
    try {
      payment = await paymentsService.getLatestPaymentForOrder(order.id);
    } catch {
      // payments module optional or error
    }

    return {
      ...order,
      items,
      payment,
      server_time: new Date().toISOString(),
    };
  },

  /**
   * List orders paginated, newest first.
   * CUSTOMER sees own orders only; ADMIN sees all orders.
   */
  async listOrders(query = {}, user) {
    const page = Number(query.page || 1);
    const limit = Math.min(Number(query.limit || 20), 50);
    const offset = (page - 1) * limit;

    const filterUserId = user.role === 'ADMIN' ? null : user.id;

    const { orders, total } = await ordersRepository.listOrders({
      userId: filterUserId,
      limit,
      offset,
    });

    const enrichedOrders = await Promise.all(
      orders.map(async (o) => {
        const items = await ordersRepository.findItemsByOrderId(o.id);
        let payment = null;
        try {
          payment = await paymentsService.getLatestPaymentForOrder(o.id);
        } catch {
          // ignore
        }
        return {
          ...o,
          items,
          payment,
        };
      }),
    );

    return {
      orders: enrichedOrders,
      pagination: {
        page,
        limit,
        total,
        has_more: offset + orders.length < total,
      },
      server_time: new Date().toISOString(),
    };
  },

  /**
   * Place an order on hold via persisted Saga Orchestrator.
   * Steps: 1 hold property, 2 hold each service, with backward compensation on failure.
   */
  async holdOrder(id, user) {
    return sagaOrchestrator.executeHold(id, user);
  },

  // ------------------ Saga Hooks for Payments Module (Change #6) ------------------

  async onPaymentInitiated(orderId, client = undefined) {
    return sagaOrchestrator.onPaymentInitiated(orderId, client);
  },

  async onPaymentSucceededBeforeConfirm(orderId, client = undefined) {
    return sagaOrchestrator.onPaymentSucceededBeforeConfirm(orderId, client);
  },

  async onBookingConfirmed(orderId, client = undefined) {
    return sagaOrchestrator.onBookingConfirmed(orderId, client);
  },

  async onBookingRefundRequired(orderId, client = undefined) {
    return sagaOrchestrator.onBookingRefundRequired(orderId, client);
  },

  async onPaymentFailed(orderId, client = undefined) {
    return sagaOrchestrator.onPaymentFailed(orderId, client);
  },

  /**
   * Internal service method for cross-module orchestration (e.g. Payments).
   */
  async getOrderInternal(id, client = undefined) {
    const order = await ordersRepository.findById(id, client);
    if (!order) {
      throw new AppError('ORDER_NOT_FOUND', 404, 'Order not found');
    }
    const items = await ordersRepository.findItemsByOrderId(order.id, client);
    return {
      ...order,
      items,
    };
  },

  /**
   * Non-throwing internal lookup for async consumers (returns null if missing, Change #6).
   */
  async findOrderInternal(id, client = undefined) {
    const order = await ordersRepository.findById(id, client);
    if (!order) {
      return null;
    }
    const items = await ordersRepository.findItemsByOrderId(order.id, client);
    return {
      ...order,
      items,
    };
  },

  /**
   * Guarded update of order status across module boundaries.
   */
  async updateOrderStatus(id, fromStatus, toStatus, client = undefined) {
    const updated = await ordersRepository.updateStatusGuarded(id, fromStatus, toStatus, {}, client);
    if (updated && (toStatus === 'CONFIRMED' || toStatus === 'FAILED')) {
      ordersTotal.inc({ status: toStatus.toLowerCase() });
    }
    return updated;
  },
};
