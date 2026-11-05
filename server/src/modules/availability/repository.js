import { db } from '../../infrastructure/postgres.js';

export const availabilityRepository = {
  /**
   * Fetch active confirmed or non-expired held reservations overlapping the window.
   */
  async getActiveReservations(propertyId, from, to, client = db) {
    const query = `
      SELECT lower(during) AS start, upper(during) AS end, status
      FROM reservations
      WHERE resource_type = 'PROPERTY'
        AND resource_id = $1
        AND (
          status = 'CONFIRMED'
          OR (status IN ('HELD', 'PAYMENT_PENDING') AND hold_expires_at > now())
        )
        AND during && tstzrange($2, $3, '[)')
      ORDER BY lower(during) ASC
    `;
    const result = await client.query(query, [propertyId, from, to]);
    return result.rows;
  },

  /**
   * Fetch host-blocked date ranges (is_available = false) overlapping the window.
   */
  async getHostBlockedRanges(propertyId, from, to, client = db) {
    const query = `
      SELECT slot_start AS start, slot_end AS end
      FROM availability
      WHERE resource_type = 'PROPERTY'
        AND resource_id = $1
        AND is_available = false
        AND tstzrange(slot_start, slot_end, '[)') && tstzrange($2, $3, '[)')
      ORDER BY slot_start ASC
    `;
    const result = await client.query(query, [propertyId, from, to]);
    return result.rows;
  },
};
