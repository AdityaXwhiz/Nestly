import { db } from '../../infrastructure/postgres.js';

export const reservationsRepository = {
  /**
   * Insert a HELD reservation row inside a transaction.
   */
  async insertHeld(
    {
      orderItemId,
      resourceType,
      resourceId,
      during,
      holdExpiresAt,
      isExclusive,
      quantity,
      slot,
    },
    client = db,
  ) {
    const query = `
      INSERT INTO reservations (
        order_item_id, resource_type, resource_id, during,
        status, hold_expires_at, is_exclusive, quantity, slot
      )
      VALUES ($1, $2, $3, $4::tstzrange, 'HELD', $5, $6, $7, $8)
      RETURNING id, order_item_id, resource_type, resource_id, during,
                status, hold_expires_at, is_exclusive, quantity, slot, created_at
    `;
    const result = await client.query(query, [
      orderItemId,
      resourceType,
      resourceId,
      during,
      holdExpiresAt,
      isExclusive,
      quantity || 1,
      slot || null,
    ]);
    return result.rows[0];
  },

  /**
   * Guarded transition to CONFIRMED.
   * Only succeeds if status is HELD/PAYMENT_PENDING and hold has not expired.
   */
  async confirm(reservationId, client = db) {
    const query = `
      UPDATE reservations
      SET status = 'CONFIRMED'
      WHERE id = $1
        AND status IN ('HELD', 'PAYMENT_PENDING')
        AND hold_expires_at > now()
      RETURNING id, order_item_id, resource_type, resource_id, during,
                status, hold_expires_at, is_exclusive, quantity, slot, created_at
    `;
    const result = await client.query(query, [reservationId]);
    return result.rows[0] || null;
  },

  /**
   * Guarded transition to CANCELLED.
   * Returns the row ONLY if status was previously active, ensuring exactly-once release.
   */
  async release(reservationId, client = db) {
    const query = `
      UPDATE reservations
      SET status = 'CANCELLED'
      WHERE id = $1
        AND status IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED')
      RETURNING id, order_item_id, resource_type, resource_id, during,
                status, is_exclusive, quantity, slot
    `;
    const result = await client.query(query, [reservationId]);
    return result.rows[0] || null;
  },

  /**
   * Expire stale HELD reservations for a given resource.
   * Returns the expired rows so capacity can be restored for capacity-based services.
   */
  async expireStaleHolds(resourceId, client = db) {
    const query = `
      UPDATE reservations
      SET status = 'EXPIRED'
      WHERE resource_id = $1
        AND status = 'HELD'
        AND hold_expires_at <= now()
      RETURNING id, resource_type, resource_id, is_exclusive, quantity, slot
    `;
    const result = await client.query(query, [resourceId]);
    return result.rows;
  },

  /**
   * Hold sweeper batch query (Change #5):
   * Uses the partial index reservations_hold_sweep (WHERE status = 'HELD' AND hold_expires_at <= now())
   * in batches (LIMIT $1) with FOR UPDATE SKIP LOCKED and guarded status = 'HELD' check,
   * guaranteeing that if lazy expiry and the sweeper race on the same row,
   * exactly ONE updates the row and receives it in RETURNING.
   */
  async expireStaleHoldsBatch(batchSize = 200, client = db) {
    const query = `
      WITH to_expire AS (
        SELECT id
        FROM reservations
        WHERE status = 'HELD'
          AND hold_expires_at <= now()
        ORDER BY hold_expires_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE reservations r
      SET status = 'EXPIRED'
      FROM to_expire
      WHERE r.id = to_expire.id
        AND r.status = 'HELD'
      RETURNING r.id, r.order_item_id, r.resource_type, r.resource_id, r.during,
                r.status, r.hold_expires_at, r.is_exclusive, r.quantity, r.slot;
    `;
    const result = await client.query(query, [batchSize]);
    return result.rows;
  },

  /**
   * Check if a property has host-blocked intervals (is_available = false) in availability table.
   */
  async checkPropertyBlocked(propertyId, during, client = db) {
    const query = `
      SELECT 1 FROM availability
      WHERE resource_type = 'PROPERTY'
        AND resource_id = $1
        AND is_available = false
        AND tstzrange(slot_start, slot_end, '[)') && $2::tstzrange
      LIMIT 1
    `;
    const result = await client.query(query, [propertyId, during]);
    return result.rowCount > 0;
  },

  /**
   * Atomic conditional capacity reservation.
   * Inserts row if absent (seeding capacity from services table) or updates existing.
   * Returns empty array if capacity would be exceeded.
   */
  async incrementCapacity(serviceId, slot, quantity, client = db) {
    const query = `
      INSERT INTO service_capacity (service_id, slot, capacity, reserved)
      SELECT id, $2, capacity, $3
      FROM services
      WHERE id = $1 AND capacity >= $3
      ON CONFLICT (service_id, slot)
      DO UPDATE SET
        reserved = service_capacity.reserved + $3,
        updated_at = now()
      WHERE (service_capacity.reserved + $3) <= service_capacity.capacity
      RETURNING id, service_id, slot, capacity, reserved
    `;
    const result = await client.query(query, [serviceId, slot, quantity]);
    return result.rows[0] || null;
  },

  /**
   * Decrements reserved capacity, strictly relying on check_reserved_capacity constraint.
   */
  async decrementCapacity(serviceId, slot, quantity, client = db) {
    const query = `
      UPDATE service_capacity
      SET reserved = reserved - $3,
          updated_at = now()
      WHERE service_id = $1
        AND slot = $2
      RETURNING id, service_id, slot, capacity, reserved
    `;
    const result = await client.query(query, [serviceId, slot, quantity]);
    return result.rows[0] || null;
  },

  async findById(id, client = db) {
    const query = `
      SELECT id, order_item_id, resource_type, resource_id, during,
             status, hold_expires_at, is_exclusive, quantity, slot, created_at
      FROM reservations
      WHERE id = $1
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },

  /**
   * Find an active reservation for an order item (idempotency check).
   */
  async findActiveByOrderItemId(orderItemId, client = db) {
    const query = `
      SELECT id, order_item_id, resource_type, resource_id, during,
             status, hold_expires_at, is_exclusive, quantity, slot, created_at
      FROM reservations
      WHERE order_item_id = $1
        AND status IN ('HELD', 'PAYMENT_PENDING', 'CONFIRMED')
      LIMIT 1;
    `;
    const result = await client.query(query, [orderItemId]);
    return result.rows[0] || null;
  },

  /**
   * Find all reservations linked to order items of an order.
   */
  async findByOrderId(orderId, client = db) {
    const query = `
      SELECT r.id, r.order_item_id, r.resource_type, r.resource_id, r.during,
             r.status, r.hold_expires_at, r.is_exclusive, r.quantity, r.slot, r.created_at
      FROM reservations r
      JOIN order_items oi ON oi.id = r.order_item_id
      WHERE oi.order_id = $1
      ORDER BY r.created_at ASC;
    `;
    const result = await client.query(query, [orderId]);
    return result.rows;
  },
};
