import { db } from '../../infrastructure/postgres.js';
import { getRequestId } from '../../middleware/requestLogger.js';

export const outboxRepository = {
  /**
   * Insert an event into the outbox table within the caller's transaction.
   * Captures request_id explicitly or from AsyncLocalStorage request context.
   */
  async createEvent({ aggregateId, eventType, payload, requestId = null }, client = db) {
    const resolvedRequestId = requestId || getRequestId();
    const query = `
      INSERT INTO outbox (aggregate_id, event_type, payload, request_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id, aggregate_id, event_type, payload, request_id, created_at
    `;
    const result = await client.query(query, [
      aggregateId,
      eventType,
      JSON.stringify(payload),
      resolvedRequestId,
    ]);
    return result.rows[0];
  },

  /**
   * Delete published outbox rows older than retentionDays (cleanup scheduler).
   * Uses the partial index idx_outbox_published_at.
   */
  async deleteOldPublished(retentionDays, client = db) {
    const query = `
      DELETE FROM outbox
      WHERE published_at IS NOT NULL
        AND published_at <= now() - make_interval(days => $1)
      RETURNING id;
    `;
    const result = await client.query(query, [retentionDays]);
    return result.rowCount;
  },
};
