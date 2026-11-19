import { env } from '../../config/env.js';

export function getPropertiesIndexAlias(prefix = env.OPENSEARCH_INDEX_PREFIX) {
  return `${prefix}_properties`;
}

export function getServicesIndexAlias(prefix = env.OPENSEARCH_INDEX_PREFIX) {
  return `${prefix}_services`;
}

export const propertiesIndexSettings = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      normalizer: {
        lowercase_normalizer: {
          type: 'custom',
          filter: ['lowercase'],
        },
      },
    },
  },
  mappings: {
    properties: {
      id: { type: 'keyword' },
      host_id: { type: 'keyword' },
      title: {
        type: 'text',
        fields: {
          keyword: { type: 'keyword' },
        },
      },
      description: { type: 'text' },
      location: {
        type: 'keyword',
        normalizer: 'lowercase_normalizer',
      },
      capacity: { type: 'integer' },
      pricing_minor: { type: 'long' },
      currency: { type: 'keyword' },
      status: { type: 'keyword' },
      amenities: { type: 'keyword' },
      cover_image_url: { type: 'keyword' },
      version: { type: 'long' },
      created_at: { type: 'date' },
      updated_at: { type: 'date' },
    },
  },
};

export const servicesIndexSettings = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
  },
  mappings: {
    properties: {
      id: { type: 'keyword' },
      provider_id: { type: 'keyword' },
      title: {
        type: 'text',
        fields: {
          keyword: { type: 'keyword' },
        },
      },
      description: { type: 'text' },
      category: { type: 'keyword' },
      kind: { type: 'keyword' },
      price_minor: { type: 'long' },
      currency: { type: 'keyword' },
      duration_minutes: { type: 'integer' },
      capacity: { type: 'integer' },
      status: { type: 'keyword' },
      version: { type: 'long' },
      created_at: { type: 'date' },
      updated_at: { type: 'date' },
    },
  },
};
