import { db } from '../../infrastructure/postgres.js';

export const sagaRepository = {
  async insertSaga({ orderId, state = 'STARTED', step = 0, context = {} }, client = db) {
    const query = `
      INSERT INTO saga_instances (order_id, state, step, context)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (order_id) DO NOTHING
      RETURNING *;
    `;
    const res = await client.query(query, [orderId, state, step, JSON.stringify(context)]);
    return res.rows[0] || null;
  },

  async findByOrderId(orderId, client = db) {
    const query = 'SELECT * FROM saga_instances WHERE order_id = $1;';
    const res = await client.query(query, [orderId]);
    return res.rows[0] || null;
  },

  async findByOrderIdForUpdate(orderId, client = db) {
    const query = 'SELECT * FROM saga_instances WHERE order_id = $1 FOR UPDATE;';
    const res = await client.query(query, [orderId]);
    return res.rows[0] || null;
  },

  /**
   * Guarded reset of a FAILED saga back to STARTED for order hold retry.
   */
  async resetFailedSaga(orderId, context = {}, client = db) {
    const query = `
      UPDATE saga_instances
      SET state = 'STARTED',
          step = 0,
          context = $1,
          updated_at = now()
      WHERE order_id = $2 AND state = 'FAILED'
      RETURNING *;
    `;
    const res = await client.query(query, [JSON.stringify(context), orderId]);
    return res.rows[0] || null;
  },

  async updateState(id, { state, step, context }, client = db) {
    let query = `
      UPDATE saga_instances
      SET state = $1,
          step = COALESCE($2, step),
          context = COALESCE($3, context),
          updated_at = now()
      WHERE id = $4
      RETURNING *;
    `;
    const ctxVal = context !== undefined ? JSON.stringify(context) : null;
    const res = await client.query(query, [state, step, ctxVal, id]);
    return res.rows[0] || null;
  },

  async updateStateByOrderId(orderId, { state, step, context }, client = db) {
    let query = `
      UPDATE saga_instances
      SET state = $1,
          step = COALESCE($2, step),
          context = COALESCE($3, context),
          updated_at = now()
      WHERE order_id = $4
      RETURNING *;
    `;
    const ctxVal = context !== undefined ? JSON.stringify(context) : null;
    const res = await client.query(query, [state, step, ctxVal, orderId]);
    return res.rows[0] || null;
  },

  /**
   * Find unsettled sagas updated before a threshold, locking each row.
   */
  async findStaleUnsettledSagas(staleSeconds, limit = 20, client = db) {
    const query = `
      SELECT s.*, o.hold_expires_at, o.status as order_status
      FROM saga_instances s
      JOIN orders o ON o.id = s.order_id
      WHERE s.state NOT IN ('COMPLETED', 'FAILED')
        AND s.updated_at <= now() - make_interval(secs => $1)
      ORDER BY s.updated_at ASC
      LIMIT $2
      FOR UPDATE OF s SKIP LOCKED;
    `;
    const res = await client.query(query, [staleSeconds, limit]);
    return res.rows;
  },

  async deleteByOrderId(orderId, client = db) {
    await client.query('DELETE FROM saga_instances WHERE order_id = $1;', [orderId]);
  },
};
