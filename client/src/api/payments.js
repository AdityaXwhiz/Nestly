import { apiFetch } from './client.js';

// The UI never collects card data (the mock provider has no card form).
// Payments are authorized via order reference with an Idempotency-Key.
export const paymentsApi = {
  /**
   * Initiate payment for a held order with an Idempotency-Key.
   * Generated once per order attempt and persisted across retries.
   */
  async createPayment({ orderId, idempotencyKey }) {
    return apiFetch('/payments', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ order_id: orderId }),
    });
  },

  /**
   * Fetch payment status by ID.
   */
  async getPaymentById(id) {
    return apiFetch(`/payments/${id}`);
  },
};
