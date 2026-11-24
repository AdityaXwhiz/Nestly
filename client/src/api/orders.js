import { apiFetch } from './client.js';

export const ordersApi = {
  /**
   * Create an order with authoritative price snapshots calculated on server.
   * Client never computes totals.
   */
  async createOrder(data) {
    return apiFetch('/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /**
   * Fetch an order by ID.
   * Includes order items, latest payment status, and server_time (Change #1 & Change #2).
   */
  async getOrderById(id) {
    return apiFetch(`/orders/${id}`);
  },

  /**
   * Place an order on inventory hold.
   * Returns hold_expires_at and server_time (Change #1).
   */
  async holdOrder(id) {
    return apiFetch(`/orders/${id}/hold`, {
      method: 'POST',
    });
  },

  /**
   * List orders for the authenticated customer or admin.
   */
  async listOrders({ page = 1, limit = 20 } = {}) {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    return apiFetch(`/orders?${params.toString()}`);
  },
};
