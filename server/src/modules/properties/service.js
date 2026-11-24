import { propertiesRepository } from './repository.js';
import { propertyImagesRepository } from './imagesRepository.js';
import { formatImage } from './imagesService.js';
import { outboxRepository } from '../outbox/repository.js';
import { withTx } from '../../infrastructure/postgres.js';
import { remember, del, generateSearchCacheKey } from '../../infrastructure/redis/cache.js';
import { AppError } from '../../errors/AppError.js';

export const propertiesService = {
  async createProperty(data, user) {
    return withTx(async (tx) => {
      const property = await propertiesRepository.createProperty(
        {
          hostId: user.id,
          title: data.title,
          description: data.description,
          location: data.location,
          capacity: data.capacity,
          pricingMinor: data.pricing_minor,
          currency: data.currency,
          status: data.status,
        },
        tx,
      );

      const amenities = await propertiesRepository.setAmenities(
        property.id,
        data.amenities || [],
        tx,
      );

      // Emit property.created event in outbox
      await outboxRepository.createEvent(
        {
          aggregateId: property.id,
          eventType: 'property.created',
          payload: {
            id: property.id,
            hostId: property.host_id,
            version: Number(property.version || 1),
          },
        },
        tx,
      );

      return {
        ...property,
        amenities,
        images: [],
      };
    });
  },

  async updateProperty(id, data, user) {
    const existing = await propertiesRepository.findById(id);
    if (!existing) {
      throw new AppError('PROPERTY_NOT_FOUND', 404, 'Property not found');
    }

    // Service-layer ownership verification
    const isAdmin = user.role === 'ADMIN';
    if (!isAdmin && existing.host_id !== user.id) {
      throw new AppError('FORBIDDEN', 403, 'You do not own this property');
    }

    // Role-based status constraints: hosts can only toggle ACTIVE/INACTIVE
    if (data.status && !isAdmin) {
      if (data.status !== 'ACTIVE' && data.status !== 'INACTIVE') {
        throw new AppError(
          'FORBIDDEN',
          403,
          'Hosts may only set status to ACTIVE or INACTIVE',
        );
      }
    }

    const result = await withTx(async (tx) => {
      let updated = await propertiesRepository.updateProperty(id, data, tx);

      let amenities;
      if (data.amenities !== undefined) {
        amenities = await propertiesRepository.setAmenities(id, data.amenities, tx);
        // If no direct property columns changed but amenities changed, bump property version explicitly (Change #2)
        const directFields = ['title', 'description', 'location', 'capacity', 'pricing_minor', 'currency', 'status'];
        const hasDirectUpdates = directFields.some((f) => data[f] !== undefined);
        if (!hasDirectUpdates) {
          updated = await propertiesRepository.bumpPropertyVersion(id, tx);
        }
      } else {
        const amenityMap = await propertiesRepository.getAmenitiesByPropertyIds([id], tx);
        amenities = amenityMap.get(id) || [];
      }

      const imageRows = await propertyImagesRepository.listReadyByPropertyId(id, tx);
      const images = imageRows.map(formatImage);

      const eventType =
        data.status && data.status !== existing.status
          ? 'property.status_changed'
          : 'property.updated';

      await outboxRepository.createEvent(
        {
          aggregateId: id,
          eventType,
          payload: {
            id,
            hostId: updated.host_id,
            status: updated.status,
            version: Number(updated.version || 1),
          },
        },
        tx,
      );

      return {
        ...updated,
        amenities,
        images,
      };
    });

    // Invalidate entity cache on update
    await del(`cache:property:${id}`);

    return result;
  },

  async getPropertyById(id, { bypassCache = false } = {}) {
    const fetchDirect = async () => {
      const property = await propertiesRepository.findActiveById(id);
      if (!property) {
        throw new AppError('PROPERTY_NOT_FOUND', 404, 'Property not found');
      }

      const [amenityMap, imageRows] = await Promise.all([
        propertiesRepository.getAmenitiesByPropertyIds([property.id]),
        propertyImagesRepository.listReadyByPropertyId(property.id),
      ]);
      const amenities = amenityMap.get(property.id) || [];
      const images = imageRows.map(formatImage);

      return {
        ...property,
        amenities,
        images,
      };
    };

    if (bypassCache) {
      return fetchDirect();
    }

    return remember(`cache:property:${id}`, 300, fetchDirect);
  },

  async listProperties(query = {}, { bypassCache = false } = {}) {
    const fetchDirect = async () => {
      const limit = Math.min(query.limit || 20, 50);
      const page = query.page || 1;
      const offset = (page - 1) * limit;

      const filters = {
        q: query.q,
        location: query.location || query.city,
        min_capacity: query.min_capacity,
        max_price: query.max_price,
        amenities: query.amenities,
      };

      const [properties, total] = await Promise.all([
        propertiesRepository.listActive(filters, { limit, offset }),
        propertiesRepository.countActive(filters),
      ]);

      const propertyIds = properties.map((p) => p.id);
      const [amenityMap, imageMap] = await Promise.all([
        propertiesRepository.getAmenitiesByPropertyIds(propertyIds),
        propertyImagesRepository.getReadyImagesByPropertyIds(propertyIds),
      ]);

      const propertiesWithAmenities = properties.map((p) => ({
        ...p,
        amenities: amenityMap.get(p.id) || [],
        images: (imageMap.get(p.id) || []).map(formatImage),
      }));

      return {
        properties: propertiesWithAmenities,
        pagination: {
          page,
          limit,
          total,
          has_more: offset + properties.length < total,
        },
      };
    };

    if (bypassCache) {
      return fetchDirect();
    }

    const cacheKey = generateSearchCacheKey('properties', query);
    return remember(cacheKey, 30, fetchDirect, { jitterSec: 10 });
  },

  async deleteProperty(id) {
    await del(`cache:property:${id}`);
    return propertiesRepository.deleteById(id);
  },

  async listMyProperties(hostId) {
    const properties = await propertiesRepository.findByHostId(hostId);
    if (!properties || properties.length === 0) {
      return { properties: [] };
    }

    const propertyIds = properties.map((p) => p.id);
    const [amenityMap, imageMap] = await Promise.all([
      propertiesRepository.getAmenitiesByPropertyIds(propertyIds),
      propertyImagesRepository.getReadyImagesByPropertyIds(propertyIds),
    ]);

    const enriched = properties.map((p) => ({
      ...p,
      amenities: amenityMap.get(p.id) || [],
      images: imageMap.get(p.id) || [],
      cover_image_url: (imageMap.get(p.id) && imageMap.get(p.id)[0]) ? imageMap.get(p.id)[0].url : null,
    }));

    return { properties: enriched };
  },

  /**
   * Internal cross-module lookup (does not filter out INACTIVE properties).
   */
  async findPropertyInternal(id, client = undefined) {
    return propertiesRepository.findById(id, client);
  },
};
