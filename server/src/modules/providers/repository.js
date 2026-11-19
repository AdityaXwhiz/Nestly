import { db } from '../../infrastructure/postgres.js';

/**
 * Providers repository: parameterized SQL only.
 * Accepts an optional db client to participate in transactions.
 */
export const providersRepository = {
  async createProvider({ userId, businessName, bio }, client = db) {
    const query = `
      INSERT INTO providers (user_id, business_name, bio)
      VALUES ($1, $2, $3)
      RETURNING id, user_id, business_name, bio, status, created_at, updated_at
    `;
    const result = await client.query(query, [userId, businessName, bio || null]);
    return result.rows[0];
  },

  async findByUserId(userId, client = db) {
    const query = `
      SELECT id, user_id, business_name, bio, status, created_at, updated_at
      FROM providers
      WHERE user_id = $1
    `;
    const result = await client.query(query, [userId]);
    return result.rows[0] || null;
  },

  async findById(id, client = db) {
    const query = `
      SELECT id, user_id, business_name, bio, status, created_at, updated_at
      FROM providers
      WHERE id = $1
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },

  async deleteById(id, client = db) {
    const query = `
      DELETE FROM providers
      WHERE id = $1
      RETURNING id
    `;
    const result = await client.query(query, [id]);
    return result.rows[0] || null;
  },

  // ------------------ Provider Fulfilment Actions ------------------
  async createProviderAction(
    {
      orderId,
      orderItemId,
      providerUserId,
      resourceType,
      resourceId,
      action = 'FULFIL_ITEM',
      payload = {},
    },
    client = db,
  ) {
    const query = `
      INSERT INTO provider_actions (
        order_id, order_item_id, provider_user_id, resource_type, resource_id, action, status, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7::jsonb)
      ON CONFLICT (order_item_id, action) DO NOTHING
      RETURNING *;
    `;
    const result = await client.query(query, [
      orderId,
      orderItemId,
      providerUserId,
      resourceType,
      resourceId,
      action,
      JSON.stringify(payload),
    ]);
    return result.rows[0] || null;
  },

  async findActionsByOrderId(orderId, client = db) {
    const query = `
      SELECT *
      FROM provider_actions
      WHERE order_id = $1
      ORDER BY created_at ASC;
    `;
    const result = await client.query(query, [orderId]);
    return result.rows;
  },
};
