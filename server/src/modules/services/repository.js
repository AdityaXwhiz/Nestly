import { db } from '../../infrastructure/postgres.js';

export const servicesRepository = {
  async createService(
    {
      providerId,
      title,
      description,
      category,
      kind,
      priceMinor,
      currency,
      durationMinutes,
      capacity,
      status,
    },
    client = db,
  ) {
    const query = `
      INSERT INTO services (
        provider_id, title, description, category, kind, price_minor,
        currency, duration_minutes, capacity, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, provider_id, title, description, category, kind, price_minor,
                currency, duration_minutes, capacity, status, created_at, updated_at
    `;
    const result = await client.query(query, [
      providerId,
      title,
      description,
      category || 'other',
      kind,
      priceMinor,
      currency || 'INR',
      durationMinutes || null,
      capacity || null,
      status || 'ACTIVE',
    ]);
    return result.rows[0];
  },

  async updateService(id, fields, client = db) {
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    const columnMap = {
      title: 'title',
      description: 'description',
      category: 'category',
      kind: 'kind',
      price_minor: 'price_minor',
      currency: 'currency',
      duration_minutes: 'duration_minutes',
      capacity: 'capacity',
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
      UPDATE services
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, provider_id, title, description, category, kind, price_minor,
                currency, duration_minutes, capacity, status, created_at, updated_at
    `;

    const result = await client.query(query, values);
    return result.rows[0] || null;
  },

  async findById(id, client = db) {
    const query = `
      SELECT id, provider_id, title, description, category, kind, price_minor,
             currency, duration_minutes, capacity, status, created_at, updated_at
      FROM services
      WHERE id = $1
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },

  async findActiveById(id, client = db) {
    const query = `
      SELECT id, provider_id, title, description, category, kind, price_minor,
             currency, duration_minutes, capacity, status, created_at, updated_at
      FROM services
      WHERE id = $1 AND status = 'ACTIVE'
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },

  async listActive(filters, { limit, offset }, client = db) {
    const conditions = ["status = 'ACTIVE'"];
    const values = [];
    let paramIndex = 1;

    if (filters.category) {
      conditions.push(`category = $${paramIndex}`);
      values.push(filters.category);
      paramIndex++;
    }

    if (filters.max_price !== undefined) {
      conditions.push(`price_minor <= $${paramIndex}`);
      values.push(filters.max_price);
      paramIndex++;
    }

    values.push(limit);
    const limitParam = `$${paramIndex++}`;
    values.push(offset);
    const offsetParam = `$${paramIndex++}`;

    const query = `
      SELECT id, provider_id, title, description, category, kind, price_minor,
             currency, duration_minutes, capacity, status, created_at, updated_at
      FROM services
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

    if (filters.category) {
      conditions.push(`category = $${paramIndex}`);
      values.push(filters.category);
      paramIndex++;
    }

    if (filters.max_price !== undefined) {
      conditions.push(`price_minor <= $${paramIndex}`);
      values.push(filters.max_price);
      paramIndex++;
    }

    const query = `
      SELECT count(*)::int AS total
      FROM services
      WHERE ${conditions.join(' AND ')}
    `;

    const result = await client.query(query, values);
    return result.rows[0].total;
  },

  async deleteById(id, client = db) {
    const query = 'DELETE FROM services WHERE id = $1 RETURNING id';
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },
};
