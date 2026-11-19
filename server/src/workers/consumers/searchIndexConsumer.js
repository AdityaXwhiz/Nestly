import { createConsumer } from '../consumer.js';
import { openSearchClient } from '../../infrastructure/opensearch/client.js';
import {
  getPropertiesIndexAlias,
  getServicesIndexAlias,
} from '../../infrastructure/opensearch/mappings.js';
import { propertiesService } from '../../modules/properties/service.js';
import { propertiesRepository } from '../../modules/properties/repository.js';
import { propertyImagesRepository } from '../../modules/properties/imagesRepository.js';
import { formatImage } from '../../modules/properties/imagesService.js';
import { servicesRepository } from '../../modules/services/repository.js';
import { logger } from '../../middleware/requestLogger.js';
import { env } from '../../config/env.js';

export function createSearchIndexConsumer({
  queueUrl = env.SQS_QUEUE_URL_SEARCH_INDEX,
  client = openSearchClient,
  indexPrefix = env.OPENSEARCH_INDEX_PREFIX,
} = {}) {
  const propertiesAlias = getPropertiesIndexAlias(indexPrefix);
  const servicesAlias = getServicesIndexAlias(indexPrefix);

  return createConsumer({
    name: 'search-index',
    queueUrl,
    useProcessedEvents: false, // OpenSearch external versioning handles idempotency and ordering
    handler: async (envelope) => {
      const { eventType, aggregateId } = envelope;

      // 1. Property catalog events
      if (eventType.startsWith('property.')) {
        const property = await propertiesService.findPropertyInternal(aggregateId);

        // If hard-deleted from DB, delete from OpenSearch index
        if (!property) {
          logger.info({ propertyId: aggregateId }, 'Property not found in DB; deleting from search index');
          try {
            await client.delete({
              index: propertiesAlias,
              id: aggregateId,
            });
          } catch (err) {
            if (err.meta?.statusCode === 404 || err.statusCode === 404) {
              // Document already gone
              return;
            }
            throw err;
          }
          return;
        }

        // Fetch amenities and cover image
        const [amenityMap, imageRows] = await Promise.all([
          propertiesRepository.getAmenitiesByPropertyIds([property.id]),
          propertyImagesRepository.listReadyByPropertyId(property.id),
        ]);

        const amenities = amenityMap.get(property.id) || [];
        const coverImageUrl = imageRows[0] ? formatImage(imageRows[0]).url : null;

        // Build document representation (Change #1: Index every record with status and version)
        const doc = {
          id: property.id,
          host_id: property.host_id,
          title: property.title,
          description: property.description,
          location: property.location,
          capacity: Number(property.capacity),
          pricing_minor: Number(property.pricing_minor),
          currency: property.currency,
          status: property.status,
          amenities,
          cover_image_url: coverImageUrl,
          version: Number(property.version || 1),
          created_at: property.created_at,
          updated_at: property.updated_at,
        };

        // Upsert with external_gte versioning (Change #4 & #11)
        try {
          await client.index({
            index: propertiesAlias,
            id: property.id,
            body: doc,
            version: doc.version,
            version_type: 'external_gte',
          });
          logger.debug({ propertyId: property.id, version: doc.version }, 'Property indexed in OpenSearch');
        } catch (err) {
          // Stale write (version <= existing document version): safely ignore (Change #11)
          if (
            err.meta?.statusCode === 409 ||
            err.statusCode === 409 ||
            err.message?.includes('version_conflict_engine_exception')
          ) {
            logger.info(
              { propertyId: property.id, version: doc.version },
              'Stale index write ignored due to existing higher/equal document version (409)',
            );
            return;
          }
          throw err;
        }
        return;
      }

      // 2. Service catalog events
      if (eventType.startsWith('service.')) {
        const service = await servicesRepository.findById(aggregateId);

        // If hard-deleted from DB, delete from OpenSearch index
        if (!service) {
          logger.info({ serviceId: aggregateId }, 'Service not found in DB; deleting from search index');
          try {
            await client.delete({
              index: servicesAlias,
              id: aggregateId,
            });
          } catch (err) {
            if (err.meta?.statusCode === 404 || err.statusCode === 404) {
              return;
            }
            throw err;
          }
          return;
        }

        // Build document representation (Change #1: Index every record with status and version)
        const doc = {
          id: service.id,
          provider_id: service.provider_id,
          title: service.title,
          description: service.description,
          category: service.category,
          kind: service.kind,
          price_minor: Number(service.price_minor),
          currency: service.currency,
          duration_minutes: service.duration_minutes ? Number(service.duration_minutes) : null,
          capacity: service.capacity ? Number(service.capacity) : null,
          status: service.status,
          version: Number(service.version || 1),
          created_at: service.created_at,
          updated_at: service.updated_at,
        };

        // Upsert with external_gte versioning (Change #4 & #11)
        try {
          await client.index({
            index: servicesAlias,
            id: service.id,
            body: doc,
            version: doc.version,
            version_type: 'external_gte',
          });
          logger.debug({ serviceId: service.id, version: doc.version }, 'Service indexed in OpenSearch');
        } catch (err) {
          if (
            err.meta?.statusCode === 409 ||
            err.statusCode === 409 ||
            err.message?.includes('version_conflict_engine_exception')
          ) {
            logger.info(
              { serviceId: service.id, version: doc.version },
              'Stale index write ignored due to existing higher/equal document version (409)',
            );
            return;
          }
          throw err;
        }
        return;
      }

      // 3. Unknown or unsupported event type: log and ack (Requirement 4)
      logger.warn({ eventType, aggregateId }, 'Search index consumer: unknown event type; skipping and acking');
    },
  });
}
