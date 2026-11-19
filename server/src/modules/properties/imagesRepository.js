import { db } from '../../infrastructure/postgres.js';

export const propertyImagesRepository = {
  /**
   * Locks the property row for update.
   */
  async lockPropertyForUpdate(propertyId, client = db) {
    const query = `
      SELECT id, host_id, status
      FROM properties
      WHERE id = $1
      FOR UPDATE
    `;
    const result = await client.query(query, [propertyId]);
    return result.rows[0] || null;
  },

  /**
   * Counts active images (READY + unexpired PENDING within 5 minutes) for a property.
   * Used for the 10-image limit check (Change #3).
   */
  async countActiveImages(propertyId, client = db) {
    const query = `
      SELECT count(*)::int AS count
      FROM property_images
      WHERE property_id = $1
        AND (
          status = 'READY'
          OR (status = 'PENDING' AND created_at > now() - interval '5 minutes')
        )
    `;
    const result = await client.query(query, [propertyId]);
    return result.rows[0]?.count || 0;
  },

  /**
   * Gets the next sort_order for a property.
   */
  async getNextSortOrder(propertyId, client = db) {
    const query = `
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort
      FROM property_images
      WHERE property_id = $1
    `;
    const result = await client.query(query, [propertyId]);
    return result.rows[0]?.next_sort || 0;
  },

  /**
   * Inserts a pending property image record.
   */
  async createPendingImage(
    { propertyId, key, contentType, sizeBytes, sortOrder },
    client = db,
  ) {
    const query = `
      INSERT INTO property_images (
        property_id, key, status, content_type, size_bytes, sort_order
      )
      VALUES ($1, $2, 'PENDING', $3, $4, $5)
      RETURNING id, property_id, key, url, status, content_type, size_bytes, sort_order, created_at, updated_at
    `;
    const result = await client.query(query, [
      propertyId,
      key,
      contentType,
      sizeBytes,
      sortOrder,
    ]);
    return result.rows[0];
  },

  /**
   * Finds an image by ID and optional propertyId.
   */
  async findById(imageId, propertyId = null, client = db) {
    const conditions = ['id = $1'];
    const values = [imageId];

    if (propertyId) {
      conditions.push('property_id = $2');
      values.push(propertyId);
    }

    const query = `
      SELECT id, property_id, key, url, status, content_type, size_bytes, sort_order, created_at, updated_at
      FROM property_images
      WHERE ${conditions.join(' AND ')}
    `;
    const result = await client.query(query, values);
    return result.rows[0] || null;
  },

  /**
   * Guarded update: transitions PENDING -> READY (Change #5).
   */
  async markReady(imageId, { publicKey, publicUrl }, client = db) {
    const query = `
      UPDATE property_images
      SET status = 'READY',
          key = $1,
          url = $2,
          updated_at = now()
      WHERE id = $3 AND status = 'PENDING'
      RETURNING id, property_id, key, url, status, content_type, size_bytes, sort_order, created_at, updated_at
    `;
    const result = await client.query(query, [publicKey, publicUrl, imageId]);
    return result.rows[0] || null;
  },

  /**
   * Deletes an image record by ID.
   */
  async deleteById(imageId, client = db) {
    const query = `
      DELETE FROM property_images
      WHERE id = $1
      RETURNING id, property_id, key, url, status, content_type, size_bytes, sort_order, created_at, updated_at
    `;
    const result = await client.query(query, [imageId]);
    return result.rows[0] || null;
  },

  /**
   * Lists all READY images for a property ordered by sort_order.
   */
  async listReadyByPropertyId(propertyId, client = db) {
    const query = `
      SELECT id, property_id, key, url, status, content_type, size_bytes, sort_order, created_at, updated_at
      FROM property_images
      WHERE property_id = $1 AND status = 'READY'
      ORDER BY sort_order ASC, created_at ASC
    `;
    const result = await client.query(query, [propertyId]);
    return result.rows;
  },

  /**
   * Batched lookup of READY images for multiple property IDs.
   */
  async getReadyImagesByPropertyIds(propertyIds, client = db) {
    if (!propertyIds || propertyIds.length === 0) {
      return new Map();
    }

    const query = `
      SELECT id, property_id, key, url, status, content_type, size_bytes, sort_order, created_at, updated_at
      FROM property_images
      WHERE property_id = ANY($1::uuid[]) AND status = 'READY'
      ORDER BY property_id, sort_order ASC, created_at ASC
    `;
    const result = await client.query(query, [propertyIds]);

    const map = new Map();
    for (const id of propertyIds) {
      map.set(id, []);
    }
    for (const row of result.rows) {
      map.get(row.property_id).push(row);
    }
    return map;
  },

  /**
   * Finds orphaned PENDING images older than given hours.
   */
  async findOrphanedPending(olderThanHours = 24, limit = 100, client = db) {
    const query = `
      SELECT id, property_id, key, status, created_at
      FROM property_images
      WHERE status = 'PENDING'
        AND created_at < now() - ($1 || ' hours')::interval
      ORDER BY created_at ASC
      LIMIT $2
    `;
    const result = await client.query(query, [olderThanHours, limit]);
    return result.rows;
  },
};
