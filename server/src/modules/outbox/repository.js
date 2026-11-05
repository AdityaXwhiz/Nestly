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
};
