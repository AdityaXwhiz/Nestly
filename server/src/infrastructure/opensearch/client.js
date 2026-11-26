import { Client } from '@opensearch-project/opensearch';
import { env } from '../../config/env.js';

/**
 * Creates an OpenSearch client or returns null when OPENSEARCH_ENDPOINT is disabled/unset.
 */
export function createOpenSearchClient(endpoint = env.OPENSEARCH_ENDPOINT, nodeEnv = env.NODE_ENV) {
  if (!endpoint) {
    return null;
  }

  return new Client({
    node: endpoint,
    // Short timeout for fast search failover to Postgres fallback
    requestTimeout: 2000,
    ssl: {
      rejectUnauthorized: nodeEnv === 'production',
    },
  });
}

export const openSearchClient = createOpenSearchClient();
