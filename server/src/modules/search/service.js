import { openSearchClient } from '../../infrastructure/opensearch/client.js';
import {
  getPropertiesIndexAlias,
  getServicesIndexAlias,
} from '../../infrastructure/opensearch/mappings.js';
import { propertiesService } from '../properties/service.js';
import { servicesService } from '../services/service.js';
import { remember, generateSearchCacheKey } from '../../infrastructure/redis/cache.js';
import { logger } from '../../middleware/requestLogger.js';
import { env } from '../../config/env.js';

export function formatPublicProperty(p) {
  return {
    id: p.id,
    host_id: p.host_id,
    title: p.title,
    description: p.description,
    location: p.location,
    capacity: Number(p.capacity),
    pricing_minor: Number(p.pricing_minor),
    currency: p.currency,
    amenities: p.amenities || [],
    cover_image_url:
      p.cover_image_url !== undefined
        ? p.cover_image_url
        : p.images && p.images[0]
          ? p.images[0].url
          : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export function formatPublicService(s) {
  return {
    id: s.id,
    provider_id: s.provider_id,
    title: s.title,
    description: s.description,
    category: s.category,
    kind: s.kind,
    price_minor: Number(s.price_minor),
    currency: s.currency,
    duration_minutes: s.duration_minutes ? Number(s.duration_minutes) : null,
    capacity: s.capacity ? Number(s.capacity) : null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export const searchService = {
  /**
   * Search properties using OpenSearch full-text and faceted search with fallback to PostgreSQL.
   */
  async searchProperties(
    query = {},
    { client = openSearchClient, indexPrefix = env.OPENSEARCH_INDEX_PREFIX } = {},
  ) {
    const cacheKey = generateSearchCacheKey('search:properties', query);

    try {
      return await remember(
        cacheKey,
        15,
        async () => {
          return searchService.executeOpenSearchProperties(query, { client, indexPrefix });
        },
        { jitterSec: 5 },
      );
    } catch (err) {
      logger.warn({ err: err.message }, 'OpenSearch property search failed; falling back to PostgreSQL');
      return searchService.executePostgresPropertiesFallback(query);
    }
  },

  async executeOpenSearchProperties(
    query = {},
    { client = openSearchClient, indexPrefix = env.OPENSEARCH_INDEX_PREFIX } = {},
  ) {
    const propertiesAlias = getPropertiesIndexAlias(indexPrefix);
    const must = [];
    // Change #1: Every search query filters on status = ACTIVE
    const filter = [{ term: { status: 'ACTIVE' } }];

    if (query.q) {
      must.push({
        multi_match: {
          query: query.q,
          fields: ['title^3', 'title.keyword^2', 'description'],
          fuzziness: 'AUTO',
        },
      });
    }

    if (query.location) {
      // Change #4: keyword field with lowercase normalizer and prefix query,
      // matching lower(location) LIKE $1 || '%'
      filter.push({
        prefix: {
          location: query.location.trim().toLowerCase(),
        },
      });
    }

    if (query.min_capacity !== undefined) {
      filter.push({
        range: {
          capacity: { gte: Number(query.min_capacity) },
        },
      });
    }

    if (query.max_price !== undefined) {
      filter.push({
        range: {
          pricing_minor: { lte: Number(query.max_price) },
        },
      });
    }

    if (query.amenities && query.amenities.length > 0) {
      for (const amenity of query.amenities) {
        filter.push({
          term: {
            amenities: amenity.trim().toLowerCase(),
          },
        });
      }
    }

    const page = Number(query.page || 1);
    const limit = Math.min(Number(query.limit || 20), 50);
    const from = (page - 1) * limit;

    const sort = query.q
      ? [{ _score: { order: 'desc' } }, { id: { order: 'asc' } }]
      : [{ created_at: { order: 'desc' } }, { id: { order: 'desc' } }];

    const response = await client.search({
      index: propertiesAlias,
      body: {
        query: {
          bool: {
            must: must.length > 0 ? must : [{ match_all: {} }],
            filter,
          },
        },
        sort,
        from,
        size: limit,
      },
    });

    const hits = response.body ? response.body.hits : response.hits;
    const total = typeof hits.total === 'object' ? hits.total.value : hits.total;
    const properties = hits.hits.map((h) => formatPublicProperty(h._source));

    return {
      indicative: true,
      degraded: false,
      properties,
      pagination: {
        page,
        limit,
        total,
        has_more: from + properties.length < total,
      },
    };
  },

  async executePostgresPropertiesFallback(query = {}) {
    // Change #5: Do not cache degraded fallback responses
    const result = await propertiesService.listProperties(query, { bypassCache: true });
    return {
      indicative: true,
      degraded: true,
      properties: result.properties.map(formatPublicProperty),
      pagination: result.pagination,
    };
  },

  /**
   * Search services using OpenSearch full-text and faceted search with fallback to PostgreSQL.
   */
  async searchServices(
    query = {},
    { client = openSearchClient, indexPrefix = env.OPENSEARCH_INDEX_PREFIX } = {},
  ) {
    const cacheKey = generateSearchCacheKey('search:services', query);

    try {
      return await remember(
        cacheKey,
        15,
        async () => {
          return searchService.executeOpenSearchServices(query, { client, indexPrefix });
        },
        { jitterSec: 5 },
      );
    } catch (err) {
      logger.warn({ err: err.message }, 'OpenSearch service search failed; falling back to PostgreSQL');
      return searchService.executePostgresServicesFallback(query);
    }
  },

  async executeOpenSearchServices(
    query = {},
    { client = openSearchClient, indexPrefix = env.OPENSEARCH_INDEX_PREFIX } = {},
  ) {
    const servicesAlias = getServicesIndexAlias(indexPrefix);
    const must = [];
    // Change #1: Every search query filters on status = ACTIVE
    const filter = [{ term: { status: 'ACTIVE' } }];

    if (query.q) {
      must.push({
        multi_match: {
          query: query.q,
          fields: ['title^3', 'title.keyword^2', 'description'],
          fuzziness: 'AUTO',
        },
      });
    }

    if (query.category) {
      filter.push({
        term: {
          category: query.category.trim(),
        },
      });
    }

    if (query.max_price !== undefined) {
      filter.push({
        range: {
          price_minor: { lte: Number(query.max_price) },
        },
      });
    }

    const page = Number(query.page || 1);
    const limit = Math.min(Number(query.limit || 20), 50);
    const from = (page - 1) * limit;

    const sort = query.q
      ? [{ _score: { order: 'desc' } }, { id: { order: 'asc' } }]
      : [{ created_at: { order: 'desc' } }, { id: { order: 'desc' } }];

    const response = await client.search({
      index: servicesAlias,
      body: {
        query: {
          bool: {
            must: must.length > 0 ? must : [{ match_all: {} }],
            filter,
          },
        },
        sort,
        from,
        size: limit,
      },
    });

    const hits = response.body ? response.body.hits : response.hits;
    const total = typeof hits.total === 'object' ? hits.total.value : hits.total;
    const services = hits.hits.map((h) => formatPublicService(h._source));

    return {
      indicative: true,
      degraded: false,
      services,
      pagination: {
        page,
        limit,
        total,
        has_more: from + services.length < total,
      },
    };
  },

  async executePostgresServicesFallback(query = {}) {
    // Change #5: Do not cache degraded fallback responses
    const result = await servicesService.listServices(query, { bypassCache: true });
    return {
      indicative: true,
      degraded: true,
      services: result.services.map(formatPublicService),
      pagination: result.pagination,
    };
  },
};
