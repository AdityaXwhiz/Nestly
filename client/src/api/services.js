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
};
