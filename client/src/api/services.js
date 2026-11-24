import { apiFetch } from './client.js';

export const servicesApi = {
  /**
   * Search active event services with category and price filtering.
   * @param {Object} query - { q, category, max_price, limit, page }
   */
  async searchServices(query = {}) {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.category) params.set('category', query.category);
    if (query.max_price) params.set('max_price', String(query.max_price));
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));

    const qs = params.toString();
    return apiFetch(`/search/services${qs ? `?${qs}` : ''}`);
  },

  /**
   * Fetch provider's own services (PROVIDER only).
   */
  async getMyServices() {
    const data = await apiFetch('/services/mine');
    return data.services || [];
  },

  /**
   * Create a new service (PROVIDER only).
   */
  async createService(data) {
    const res = await apiFetch('/services', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.service;
  },

  /**
   * Fetch current user's provider profile (Change #5).
   * Returns null if 404 (no profile yet).
   */
  async getMyProviderProfile() {
    try {
      const data = await apiFetch('/providers/me');
      return data.provider;
    } catch (err) {
      if (err.status === 404 || err.code === 'PROVIDER_NOT_FOUND') {
        return null;
      }
      throw err;
    }
  },

  /**
   * Create a provider profile for the authenticated user (PROVIDER only).
   */
  async createProviderProfile(data) {
    const res = await apiFetch('/providers', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.provider;
  },
};
