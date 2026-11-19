import { db } from '../../infrastructure/postgres.js';

/**
 * Notifications repository: parameterized SQL only.
 * Owns the notifications table.
 */
export const notificationsRepository = {
  /**
   * Insert a PENDING notification with natural deduplication on (user_id, event_id, event_type).
   */
  async insertPending({ userId, eventId, eventType, payload = {} }, client = db) {
    const query = `
      INSERT INTO notifications (user_id, event_id, event_type, payload, status)
      VALUES ($1, $2, $3, $4::jsonb, 'PENDING')
      ON CONFLICT (user_id, event_id, event_type) DO NOTHING
      RETURNING *;
    `;
    const res = await client.query(query, [
      userId,
      eventId,
      eventType,
      JSON.stringify(payload),
    ]);
    return res.rows[0] || null;
  },

  /**
   * Find and lock all PENDING notifications for a specific (event_id, event_type).
   * Uses FOR UPDATE SKIP LOCKED so concurrent duplicate deliveries never send the same row twice.
   */
  async findPendingByEvent(eventId, eventType, client = db) {
    const query = `
      SELECT *
      FROM notifications
      WHERE event_id = $1
        AND event_type = $2
        AND status = 'PENDING'
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED;
    `;
    const res = await client.query(query, [eventId, eventType]);
    return res.rows;
  },

  /**
   * Guarded transition from PENDING to SENT.
   */
  async markSent(id, client = db) {
    const query = `
      UPDATE notifications
      SET status = 'SENT',
          sent_at = now()
      WHERE id = $1
        AND status = 'PENDING'
      RETURNING *;
    `;
    const res = await client.query(query, [id]);
    return res.rows[0] || null;
  },

  /**
   * Find notifications stuck in PENDING for longer than olderThanMinutes (for retry scheduler).
   * Uses the partial index idx_notifications_pending_created with FOR UPDATE SKIP LOCKED.
   */
  async findStalePending(olderThanMinutes, limit = 50, client = db) {
    const query = `
      SELECT *
      FROM notifications
      WHERE status = 'PENDING'
        AND created_at <= now() - make_interval(mins => $1)
      ORDER BY created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED;
    `;
    const res = await client.query(query, [olderThanMinutes, limit]);
    return res.rows;
  },

  /**
   * Find all notifications for an event_id (for testing/inspection).
   */
  async findByEventId(eventId, client = db) {
    const query = `
      SELECT *
      FROM notifications
      WHERE event_id = $1
      ORDER BY created_at ASC;
    `;
    const res = await client.query(query, [eventId]);
    return res.rows;
  },

  /**
   * Find all notifications for a user_id.
   */
  async findByUserId(userId, client = db) {
    const query = `
      SELECT *
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC;
    `;
    const res = await client.query(query, [userId]);
    return res.rows;
  },
};
