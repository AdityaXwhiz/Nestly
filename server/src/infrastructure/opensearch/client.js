import { Client } from '@opensearch-project/opensearch';
import { env } from '../../config/env.js';

/**
 * OpenSearch client instance configured with the environment endpoint.
 */
export const openSearchClient = new Client({
  node: env.OPENSEARCH_ENDPOINT,
  // Short timeout for fast search failover to Postgres fallback
  requestTimeout: 2000,
  ssl: {
    rejectUnauthorized: false,
  },
});
