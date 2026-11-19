import { openSearchClient } from './client.js';
import {
  getPropertiesIndexAlias,
  getServicesIndexAlias,
  propertiesIndexSettings,
  servicesIndexSettings,
} from './mappings.js';
import { pool } from '../postgres.js';
import { propertiesRepository } from '../../modules/properties/repository.js';
import { propertyImagesRepository } from '../../modules/properties/imagesRepository.js';
import { formatImage } from '../../modules/properties/imagesService.js';
import { env } from '../../config/env.js';
import { logger } from '../../middleware/requestLogger.js';

/**
 * Reindexes properties:
 * 1. Records start timestamp (Change #3)
 * 2. Builds a new versioned concrete index
 * 3. Bulk copies all ACTIVE records from Postgres in batches
 * 4. Swaps the alias atomically
 * 5. Runs catch-up pass re-indexing rows with updated_at >= startTime (Change #3)
 * 6. Deletes the old index
 */
export async function reindexProperties({
  client = openSearchClient,
  indexPrefix = env.OPENSEARCH_INDEX_PREFIX,
  batchSize = 100,
} = {}) {
  const startTime = new Date();
  const alias = getPropertiesIndexAlias(indexPrefix);
  const newIndex = `${alias}_${Date.now()}`;

  console.log(`[reindex:properties] Starting reindex. New index: ${newIndex}, Alias: ${alias}`);

  // 1. Create new concrete index
  await client.indices.create({
    index: newIndex,
    body: propertiesIndexSettings,
  });

  // 2. Fetch and index ALL properties in batches (Change #1: Index every existing record with status)
  let offset = 0;
  let totalIndexed = 0;

  while (true) {
    const res = await pool.query(
      `SELECT id, host_id, title, description, location, capacity, pricing_minor, currency, status, version, created_at, updated_at
       FROM properties
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [batchSize, offset],
    );

    if (res.rows.length === 0) break;

    const propertyIds = res.rows.map((r) => r.id);
    const [amenityMap, imageMap] = await Promise.all([
      propertiesRepository.getAmenitiesByPropertyIds(propertyIds),
      propertyImagesRepository.getReadyImagesByPropertyIds(propertyIds),
    ]);

    const operations = [];
    for (const prop of res.rows) {
      const amenities = amenityMap.get(prop.id) || [];
      const images = imageMap.get(prop.id) || [];
      const coverImageUrl = images[0] ? formatImage(images[0]).url : null;

      operations.push({
        index: {
          _index: newIndex,
          _id: prop.id,
        },
      });
      operations.push({
        id: prop.id,
        host_id: prop.host_id,
        title: prop.title,
        description: prop.description,
        location: prop.location,
        capacity: Number(prop.capacity),
        pricing_minor: Number(prop.pricing_minor),
        currency: prop.currency,
        status: prop.status,
        amenities,
        cover_image_url: coverImageUrl,
        version: Number(prop.version || 1),
        created_at: prop.created_at,
        updated_at: prop.updated_at,
      });
    }

    if (operations.length > 0) {
      await client.bulk({ body: operations });
      totalIndexed += res.rows.length;
    }

    offset += batchSize;
  }

  // Refresh new index so documents are visible
  await client.indices.refresh({ index: newIndex });

  // 3. Atomically swap alias
  const aliasInfo = await client.indices.getAlias({ name: alias }).catch(() => null);
  const oldIndices = aliasInfo?.body ? Object.keys(aliasInfo.body) : [];

  const actions = [
    ...oldIndices.map((oldIdx) => ({ remove: { index: oldIdx, alias } })),
    { add: { index: newIndex, alias } },
  ];

  console.log(`[reindex:properties] Swapping alias ${alias} to ${newIndex}...`);
  await client.indices.updateAliases({ body: { actions } });

  // 4. Catch-up pass: re-index any records with updated_at >= startTime (Change #3)
  const catchUpRes = await pool.query(
    `SELECT id, host_id, title, description, location, capacity, pricing_minor, currency, status, version, created_at, updated_at
     FROM properties
     WHERE updated_at >= $1`,
    [startTime],
  );

  if (catchUpRes.rows.length > 0) {
    console.log(`[reindex:properties] Catch-up pass indexing ${catchUpRes.rows.length} records updated during reindex...`);
    const propertyIds = catchUpRes.rows.map((r) => r.id);
    const [amenityMap, imageMap] = await Promise.all([
      propertiesRepository.getAmenitiesByPropertyIds(propertyIds),
      propertyImagesRepository.getReadyImagesByPropertyIds(propertyIds),
    ]);

    for (const prop of catchUpRes.rows) {
      const amenities = amenityMap.get(prop.id) || [];
      const images = imageMap.get(prop.id) || [];
      const coverImageUrl = images[0] ? formatImage(images[0]).url : null;

      const doc = {
        id: prop.id,
        host_id: prop.host_id,
        title: prop.title,
        description: prop.description,
        location: prop.location,
        capacity: Number(prop.capacity),
        pricing_minor: Number(prop.pricing_minor),
        currency: prop.currency,
        status: prop.status,
        amenities,
        cover_image_url: coverImageUrl,
        version: Number(prop.version || 1),
        created_at: prop.created_at,
        updated_at: prop.updated_at,
      };

      await client.index({
        index: alias,
        id: prop.id,
        body: doc,
        version: doc.version,
        version_type: 'external_gte',
      });
    }
    await client.indices.refresh({ index: alias });
  }

  // 5. Delete old indexes
  for (const oldIdx of oldIndices) {
    if (oldIdx !== newIndex) {
      console.log(`[reindex:properties] Deleting old index ${oldIdx}...`);
      await client.indices.delete({ index: oldIdx }).catch(() => {});
    }
  }

  console.log(`[reindex:properties] Reindex complete. Total indexed: ${totalIndexed}`);
  return { newIndex, totalIndexed };
}

/**
 * Reindexes services:
 * 1. Records start timestamp (Change #3)
 * 2. Builds a new versioned concrete index
 * 3. Bulk copies all ACTIVE records from Postgres in batches
 * 4. Swaps the alias atomically
 * 5. Runs catch-up pass re-indexing rows with updated_at >= startTime (Change #3)
 * 6. Deletes the old index
 */
export async function reindexServices({
  client = openSearchClient,
  indexPrefix = env.OPENSEARCH_INDEX_PREFIX,
  batchSize = 100,
} = {}) {
  const startTime = new Date();
  const alias = getServicesIndexAlias(indexPrefix);
  const newIndex = `${alias}_${Date.now()}`;

  console.log(`[reindex:services] Starting reindex. New index: ${newIndex}, Alias: ${alias}`);

  // 1. Create new concrete index
  await client.indices.create({
    index: newIndex,
    body: servicesIndexSettings,
  });

  // 2. Fetch and index ALL services in batches (Change #1: Index every existing record with status)
  let offset = 0;
  let totalIndexed = 0;

  while (true) {
    const res = await pool.query(
      `SELECT id, provider_id, title, description, category, kind, price_minor, currency, duration_minutes, capacity, status, version, created_at, updated_at
       FROM services
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [batchSize, offset],
    );

    if (res.rows.length === 0) break;

    const operations = [];
    for (const svc of res.rows) {
      operations.push({
        index: {
          _index: newIndex,
          _id: svc.id,
        },
      });
      operations.push({
        id: svc.id,
        provider_id: svc.provider_id,
        title: svc.title,
        description: svc.description,
        category: svc.category,
        kind: svc.kind,
        price_minor: Number(svc.price_minor),
        currency: svc.currency,
        duration_minutes: svc.duration_minutes ? Number(svc.duration_minutes) : null,
        capacity: svc.capacity ? Number(svc.capacity) : null,
        status: svc.status,
        version: Number(svc.version || 1),
        created_at: svc.created_at,
        updated_at: svc.updated_at,
      });
    }

    if (operations.length > 0) {
      await client.bulk({ body: operations });
      totalIndexed += res.rows.length;
    }

    offset += batchSize;
  }

  await client.indices.refresh({ index: newIndex });

  // 3. Atomically swap alias
  const aliasInfo = await client.indices.getAlias({ name: alias }).catch(() => null);
  const oldIndices = aliasInfo?.body ? Object.keys(aliasInfo.body) : [];

  const actions = [
    ...oldIndices.map((oldIdx) => ({ remove: { index: oldIdx, alias } })),
    { add: { index: newIndex, alias } },
  ];

  console.log(`[reindex:services] Swapping alias ${alias} to ${newIndex}...`);
  await client.indices.updateAliases({ body: { actions } });

  // 4. Catch-up pass (Change #3)
  const catchUpRes = await pool.query(
    `SELECT id, provider_id, title, description, category, kind, price_minor, currency, duration_minutes, capacity, status, version, created_at, updated_at
     FROM services
     WHERE updated_at >= $1`,
    [startTime],
  );

  if (catchUpRes.rows.length > 0) {
    console.log(`[reindex:services] Catch-up pass indexing ${catchUpRes.rows.length} records updated during reindex...`);
    for (const svc of catchUpRes.rows) {
      const doc = {
        id: svc.id,
        provider_id: svc.provider_id,
        title: svc.title,
        description: svc.description,
        category: svc.category,
        kind: svc.kind,
        price_minor: Number(svc.price_minor),
        currency: svc.currency,
        duration_minutes: svc.duration_minutes ? Number(svc.duration_minutes) : null,
        capacity: svc.capacity ? Number(svc.capacity) : null,
        status: svc.status,
        version: Number(svc.version || 1),
        created_at: svc.created_at,
        updated_at: svc.updated_at,
      };

      await client.index({
        index: alias,
        id: svc.id,
        body: doc,
        version: doc.version,
        version_type: 'external_gte',
      });
    }
    await client.indices.refresh({ index: alias });
  }

  // 5. Delete old indexes
  for (const oldIdx of oldIndices) {
    if (oldIdx !== newIndex) {
      console.log(`[reindex:services] Deleting old index ${oldIdx}...`);
      await client.indices.delete({ index: oldIdx }).catch(() => {});
    }
  }

  console.log(`[reindex:services] Reindex complete. Total indexed: ${totalIndexed}`);
  return { newIndex, totalIndexed };
}

// CLI runner
if (process.argv[1]?.endsWith('reindex.js')) {
  const target = process.argv[2] || 'all';
  (async () => {
    if (target === 'properties' || target === 'all') {
      await reindexProperties();
    }
    if (target === 'services' || target === 'all') {
      await reindexServices();
    }
    process.exit(0);
  })().catch((err) => {
    console.error('Reindexing failed:', err);
    process.exit(1);
  });
}
