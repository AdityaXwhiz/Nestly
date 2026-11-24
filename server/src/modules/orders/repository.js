import { db } from '../../infrastructure/postgres.js';

export const ordersRepository = {
  /**
   * Insert an order and all its order items within a single database transaction.
   * Parameterized SQL only.
   */
  async createOrderWithItems({ userId, status, totalAmountMinor, currency, during, guestCount, items }, client = db) {
    const orderSql = `
      INSERT INTO orders (
        user_id,
        status,
        total_amount_minor,
        currency,
        during,
        guest_count
      )
      VALUES ($1, $2, $3, $4, $5::tstzrange, $6)
      RETURNING *;
    `;

    const orderRes = await client.query(orderSql, [
      userId,
      status,
      totalAmountMinor,
      currency,
      during,
      guestCount,
    ]);
    const order = orderRes.rows[0];

    const insertedItems = [];
    for (const item of items) {
      const itemSql = `
        INSERT INTO order_items (
          order_id,
          resource_type,
          resource_id,
          quantity,
          unit_price_minor,
          currency,
          title,
          slot,
          pricing_unit
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *;
      `;
      const itemRes = await client.query(itemSql, [
        order.id,
        item.resource_type,
        item.resource_id,
        item.quantity,
        item.unit_price_minor,
        item.currency,
        item.title,
        item.slot || null,
        item.pricing_unit,
      ]);
      insertedItems.push(itemRes.rows[0]);
    }

    return {
      ...order,
      items: insertedItems,
    };
  },

  /**
   * Find an order by its primary key ID.
   */
  async findById(id, client = db) {
    const res = await client.query('SELECT * FROM orders WHERE id = $1;', [id]);
    return res.rows[0] || null;
  },

  /**
   * Find an order by its primary key ID and lock the row for update.
   */
  async findByIdForUpdate(id, client = db) {
    const res = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE;', [id]);
    return res.rows[0] || null;
  },

  /**
   * Find all items belonging to an order, ordered deterministically
   * (PROPERTY first, then SERVICE).
   */
  async findItemsByOrderId(orderId, client = db) {
    const sql = `
      SELECT *
      FROM order_items
      WHERE order_id = $1
      ORDER BY resource_type ASC, created_at ASC, id ASC;
    `;
    const res = await client.query(sql, [orderId]);
    return res.rows;
  },

  /**
   * Guarded update of order status.
   * fromStatus can be a string or array of allowed current statuses.
   * Returns updated row if transition succeeded from fromStatus; null otherwise.
   */
  async updateStatusGuarded(id, fromStatus, toStatus, { holdExpiresAt = null } = {}, client = db) {
    const fromStatuses = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
    const sql = `
      UPDATE orders
      SET status = $1,
          hold_expires_at = COALESCE($2, hold_expires_at),
          updated_at = now()
      WHERE id = $3 AND status = ANY($4)
      RETURNING *;
    `;
    const res = await client.query(sql, [toStatus, holdExpiresAt, id, fromStatuses]);
    return res.rows[0] || null;
  },

  /**
   * Delete an order by ID (cascades to order_items and reservations).
   */
  async deleteById(id, client = db) {
    await client.query('DELETE FROM orders WHERE id = $1;', [id]);
  },

  /**
   * List orders paginated, newest first. If userId is provided, filters by user_id.
   */
  async listOrders({ userId = null, limit = 20, offset = 0 } = {}, client = db) {
    const whereClauses = [];
    const params = [];

    if (userId) {
      params.push(userId);
      whereClauses.push(`user_id = $${params.length}`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countSql = `SELECT count(*)::int as total FROM orders ${whereSql};`;
    const countRes = await client.query(countSql, params);
    const total = countRes.rows[0]?.total || 0;

    params.push(limit);
    const limitParam = `$${params.length}`;
    params.push(offset);
    const offsetParam = `$${params.length}`;

    const listSql = `
      SELECT *
      FROM orders
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam};
    `;
    const listRes = await client.query(listSql, params);
    return {
      orders: listRes.rows,
      total,
    };
  },
};
