import { apiFetch } from './client.js';

export const propertiesApi = {
  /**
   * Search active properties with faceted filtering.
   * @param {Object} query - { q, location, min_capacity, max_price, amenities, limit, page }
   */
  async searchProperties(query = {}) {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.location) params.set('location', query.location);
    if (query.min_capacity) params.set('min_capacity', String(query.min_capacity));
    if (query.max_price) params.set('max_price', String(query.max_price));
    if (query.amenities && query.amenities.length > 0) {
      params.set('amenities', Array.isArray(query.amenities) ? query.amenities.join(',') : query.amenities);
    }
    if (query.page) params.set('page', String(query.page));
    if (query.limit) params.set('limit', String(query.limit));

    const qs = params.toString();
    return apiFetch(`/search/properties${qs ? `?${qs}` : ''}`);
  },

  /**
   * Fetch active property details by ID (including confirmed images and amenities).
   */
  async getPropertyById(id) {
    const data = await apiFetch(`/properties/${id}`);
    return data.property;
  },

  /**
   * Fetch indicative availability window for a property.
   * Window cannot exceed 90 days (Change #8).
   * @param {string} id
   * @param {string} from - ISO timestamp
   * @param {string} to - ISO timestamp
   */
  async getPropertyAvailability(id, from, to) {
    const params = new URLSearchParams({ from, to });
    return apiFetch(`/properties/${id}/availability?${params.toString()}`);
  },
};
