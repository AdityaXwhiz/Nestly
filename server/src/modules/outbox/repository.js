import { db } from '../../infrastructure/postgres.js';

export const outboxRepository = {
  /**
   * Insert an event into the outbox table within the caller's transaction.
   */
  async createEvent({ aggregateId, eventType, payload }, client = db) {
    const query = `
      INSERT INTO outbox (aggregate_id, event_type, payload)
      VALUES ($1, $2, $3)
      RETURNING id, aggregate_id, event_type, payload, created_at
    `;
    const result = await client.query(query, [
      aggregateId,
      eventType,
      JSON.stringify(payload),
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
