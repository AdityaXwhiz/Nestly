import { openSearchClient } from './client.js';
import {
  getPropertiesIndexAlias,
  getServicesIndexAlias,
  propertiesIndexSettings,
  servicesIndexSettings,
} from './mappings.js';
import { env } from '../../config/env.js';
import { logger } from '../../middleware/requestLogger.js';

/**
 * Ensures that OpenSearch indexes and aliases exist.
 * Concurrency-safe: treats 'resource_already_exists_exception' as success (Change #8).
 */
export async function ensureAliasesExist({
  client = openSearchClient,
  indexPrefix = env.OPENSEARCH_INDEX_PREFIX,
} = {}) {
  if (!client) {
    logger.info('OpenSearch endpoint disabled; skipping index/alias setup');
    return { skipped: true, reason: 'OPENSEARCH_DISABLED' };
  }

  const propertiesAlias = getPropertiesIndexAlias(indexPrefix);
  const servicesAlias = getServicesIndexAlias(indexPrefix);

  // 1. Properties alias & initial concrete index
  try {
    const aliasRes = await client.indices.existsAlias({ name: propertiesAlias });
    const exists = aliasRes.body ?? aliasRes;
    if (!exists) {
      const concreteIndex = `${propertiesAlias}_v1`;
      logger.info({ propertiesAlias, concreteIndex }, 'Creating initial properties index and alias...');
      try {
        await client.indices.create({
          index: concreteIndex,
          body: propertiesIndexSettings,
        });
        await client.indices.putAlias({
          index: concreteIndex,
          name: propertiesAlias,
        });
      } catch (createErr) {
        if (
          createErr.meta?.body?.error?.type === 'resource_already_exists_exception' ||
          createErr.message?.includes('resource_already_exists_exception')
        ) {
          logger.debug('Properties index already created concurrently');
        } else {
          throw createErr;
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error ensuring properties alias exists');
    throw err;
  }

  // 2. Services alias & initial concrete index
  try {
    const aliasRes = await client.indices.existsAlias({ name: servicesAlias });
    const exists = aliasRes.body ?? aliasRes;
    if (!exists) {
      const concreteIndex = `${servicesAlias}_v1`;
      logger.info({ servicesAlias, concreteIndex }, 'Creating initial services index and alias...');
      try {
        await client.indices.create({
          index: concreteIndex,
          body: servicesIndexSettings,
        });
        await client.indices.putAlias({
          index: concreteIndex,
          name: servicesAlias,
        });
      } catch (createErr) {
        if (
          createErr.meta?.body?.error?.type === 'resource_already_exists_exception' ||
          createErr.message?.includes('resource_already_exists_exception')
        ) {
          logger.debug('Services index already created concurrently');
        } else {
          throw createErr;
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error ensuring services alias exists');
    throw err;
  }
}
