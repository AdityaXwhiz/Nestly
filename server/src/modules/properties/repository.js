import { db } from '../../infrastructure/postgres.js';

/**
 * Escapes characters with special meaning in SQL LIKE patterns (_, %, \).
 */
export function escapeLikePattern(str) {
  return str.replace(/[%_\\]/g, '\\$&');
}

export const propertiesRepository = {
  async createProperty(
    { hostId, title, description, location, capacity, pricingMinor, currency, status },
    client = db,
  ) {
    const query = `
      INSERT INTO properties (
        host_id, title, description, location, capacity, pricing_minor, currency, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, host_id, title, description, location, capacity, pricing_minor, currency, status, created_at, updated_at
    `;
    const result = await client.query(query, [
      hostId,
      title,
      description,
      location,
      capacity,
      pricingMinor,
      currency || 'INR',
      status || 'ACTIVE',
    ]);
    return result.rows[0];
  },

  async updateProperty(id, fields, client = db) {
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    const columnMap = {
      title: 'title',
      description: 'description',
      location: 'location',
      capacity: 'capacity',
      pricing_minor: 'pricing_minor',
      currency: 'currency',
      status: 'status',
    };

    for (const [key, col] of Object.entries(columnMap)) {
      if (fields[key] !== undefined) {
        setClauses.push(`${col} = $${paramIndex}`);
        values.push(fields[key]);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return this.findById(id, client);
    }

    setClauses.push(`updated_at = now()`);
    values.push(id);

    const query = `
      UPDATE properties
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, host_id, title, description, location, capacity, pricing_minor, currency, status, created_at, updated_at
    `;

    const result = await client.query(query, values);
    return result.rows[0] || null;
  },

  async findById(id, client = db) {
    const query = `
      SELECT id, host_id, title, description, location, capacity, pricing_minor, currency, status, created_at, updated_at
      FROM properties
      WHERE id = $1
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },

  async findActiveById(id, client = db) {
    const query = `
      SELECT id, host_id, title, description, location, capacity, pricing_minor, currency, status, created_at, updated_at
      FROM properties
      WHERE id = $1 AND status = 'ACTIVE'
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },

  async listActive(filters, { limit, offset }, client = db) {
    const conditions = ["status = 'ACTIVE'"];
    const values = [];
    let paramIndex = 1;

    if (filters.location) {
      const escaped = escapeLikePattern(filters.location.trim().toLowerCase());
      conditions.push(`lower(location) LIKE $${paramIndex} || '%' ESCAPE '\\'`);
      values.push(escaped);
      paramIndex++;
    }

    if (filters.min_capacity !== undefined) {
      conditions.push(`capacity >= $${paramIndex}`);
      values.push(filters.min_capacity);
      paramIndex++;
    }

    if (filters.max_price !== undefined) {
      conditions.push(`pricing_minor <= $${paramIndex}`);
      values.push(filters.max_price);
      paramIndex++;
    }

    values.push(limit);
    const limitParam = `$${paramIndex++}`;
    values.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const query = `
      SELECT id, host_id, title, description, location, capacity, pricing_minor, currency, status, created_at, updated_at
      FROM properties
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const result = await client.query(query, values);
    return result.rows;
  },

  async countActive(filters, client = db) {
    const conditions = ["status = 'ACTIVE'"];
    const values = [];
    let paramIndex = 1;

    if (filters.location) {
      const escaped = escapeLikePattern(filters.location.trim().toLowerCase());
      conditions.push(`lower(location) LIKE $${paramIndex} || '%' ESCAPE '\\'`);
      values.push(escaped);
      paramIndex++;
    }

    if (filters.min_capacity !== undefined) {
      conditions.push(`capacity >= $${paramIndex}`);
      values.push(filters.min_capacity);
      paramIndex++;
    }

    if (filters.max_price !== undefined) {
      conditions.push(`pricing_minor <= $${paramIndex}`);
      values.push(filters.max_price);
      paramIndex++;
    }

    const query = `
      SELECT count(*)::int AS total
      FROM properties
      WHERE ${conditions.join(' AND ')}
    `;

    const result = await client.query(query, values);
    return result.rows[0].total;
  },

  async setAmenities(propertyId, amenityNames, client = db) {
    await client.query('DELETE FROM amenities WHERE property_id = $1', [propertyId]);

    if (!amenityNames || amenityNames.length === 0) {
      return [];
    }

    const uniqueNames = [...new Set(amenityNames.map((a) => a.trim()).filter(Boolean))];
    if (uniqueNames.length === 0) return [];

    const valueRows = [];
    const values = [propertyId];
    let paramIndex = 2;

    for (const name of uniqueNames) {
      valueRows.push(`($1, $${paramIndex})`);
      values.push(name);
      paramIndex++;
    }

    const query = `
      INSERT INTO amenities (property_id, name)
      VALUES ${valueRows.join(', ')}
      RETURNING name
    `;
    const result = await client.query(query, values);
    return result.rows.map((r) => r.name);
  },

  async getAmenitiesByPropertyIds(propertyIds, client = db) {
    if (!propertyIds || propertyIds.length === 0) {
      return new Map();
    }

    const query = `
      SELECT property_id, name
      FROM amenities
      WHERE property_id = ANY($1::uuid[])
      ORDER BY created_at ASC
    `;
    const result = await client.query(query, [propertyIds]);

    const map = new Map();
    for (const id of propertyIds) {
      map.set(id, []);
    }
    for (const row of result.rows) {
      map.get(row.property_id).push(row.name);
    }
    return map;
  },

  async deleteById(id, client = db) {
    const query = 'DELETE FROM properties WHERE id = $1 RETURNING id';
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },
};
