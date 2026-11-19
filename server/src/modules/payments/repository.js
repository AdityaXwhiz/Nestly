import { db } from '../../infrastructure/postgres.js';

export const paymentsRepository = {
  // ------------------ Idempotency Keys ------------------
  async insertIdempotencyKey(
    { userId, operation, idempotencyKey, requestHash, status = 'IN_PROGRESS', responseReference = null, expiresAt },
    client = db,
  ) {
    const query = `
      INSERT INTO idempotency_keys (
        user_id, operation, idempotency_key, request_hash, status, response_reference, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, operation, idempotency_key) DO NOTHING
      RETURNING *;
    `;
    const res = await client.query(query, [
      userId,
      operation,
      idempotencyKey,
      requestHash,
      status,
      responseReference,
      expiresAt,
    ]);
    return res.rows[0] || null;
  },

  async findIdempotencyKey({ userId, operation, idempotencyKey }, client = db) {
    const query = `
      SELECT *
      FROM idempotency_keys
      WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3;
    `;
    const res = await client.query(query, [userId, operation, idempotencyKey]);
    return res.rows[0] || null;
  },

  async updateIdempotencyKey(
    { userId, operation, idempotencyKey, status, responseReference },
    client = db,
  ) {
    const query = `
      UPDATE idempotency_keys
      SET status = $1, response_reference = $2
      WHERE user_id = $3 AND operation = $4 AND idempotency_key = $5
      RETURNING *;
    `;
    const res = await client.query(query, [
      status,
      responseReference,
      userId,
      operation,
      idempotencyKey,
    ]);
    return res.rows[0] || null;
  },

  // ------------------ Payments ------------------
  async createPayment(
    { orderId, amountMinor, currency, status = 'CREATED', providerReference = null },
    client = db,
  ) {
    const query = `
      INSERT INTO payments (
        order_id, amount_minor, currency, status, provider_reference
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const res = await client.query(query, [
      orderId,
      amountMinor,
      currency,
      status,
      providerReference,
    ]);
    return res.rows[0];
  },

  async findById(id, client = db) {
    const query = 'SELECT * FROM payments WHERE id = $1;';
    const res = await client.query(query, [id]);
    return res.rows[0] || null;
  },

  async findByOrderId(orderId, client = db) {
    const query = 'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC;';
    const res = await client.query(query, [orderId]);
    return res.rows;
  },

  async findByProviderReference(providerReference, client = db) {
    const query = 'SELECT * FROM payments WHERE provider_reference = $1;';
    const res = await client.query(query, [providerReference]);
    return res.rows[0] || null;
  },

  /**
   * Guarded update of payment status.
   * fromStatuses: array or string of allowed current statuses.
   * If row was already modified or not in allowed statuses, returns null (no-op).
   */
  async updateStatusGuarded(
    id,
    fromStatuses,
    toStatus,
    { providerReference = null } = {},
    client = db,
  ) {
    const statuses = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
    const query = `
      UPDATE payments
      SET status = $1,
          provider_reference = COALESCE($2, provider_reference),
          updated_at = now()
      WHERE id = $3 AND status = ANY($4)
      RETURNING *;
    `;
    const res = await client.query(query, [toStatus, providerReference, id, statuses]);
    return res.rows[0] || null;
  },

  /**
   * Find payments in SUCCESS status whose order has FAILED (need refund).
   */
  async findPendingRefunds(client = db) {
    const query = `
      SELECT p.*
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'SUCCESS' AND o.status = 'FAILED'
      ORDER BY p.created_at ASC;
    `;
    const res = await client.query(query);
    return res.rows;
  },

  /**
   * Find payments in CREATED or PENDING status older than a threshold (for resume).
   */
  async findStuckCreatedOrPending(olderThanSeconds, client = db) {
    const query = `
      SELECT *
      FROM payments
      WHERE status IN ('CREATED', 'PENDING')
        AND created_at <= now() - make_interval(secs => $1)
      ORDER BY created_at ASC;
    `;
    const res = await client.query(query, [olderThanSeconds]);
    return res.rows;
  },

  /**
   * Find payments stuck in PROCESSING status older than a threshold (for reconciliation).
   */
  async findStuckProcessing(olderThanSeconds, client = db) {
    const query = `
      SELECT *
      FROM payments
      WHERE status = 'PROCESSING'
        AND updated_at <= now() - make_interval(secs => $1)
      ORDER BY updated_at ASC;
    `;
    const res = await client.query(query, [olderThanSeconds]);
    return res.rows;
  },

  // ------------------ Payment Transactions ------------------
  async insertTransaction(
    { paymentId, providerEventId, type, amountMinor },
    client = db,
  ) {
    const query = `
      INSERT INTO payment_transactions (
        payment_id, provider_event_id, type, amount_minor
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (provider_event_id) DO NOTHING
      RETURNING *;
    `;
    const res = await client.query(query, [paymentId, providerEventId, type, amountMinor]);
    return res.rows[0] || null;
  },

  async deleteById(id, client = db) {
    await client.query('DELETE FROM payments WHERE id = $1;', [id]);
  },
};
