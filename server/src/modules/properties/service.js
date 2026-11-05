import { propertiesRepository } from './repository.js';
import { withTx } from '../../infrastructure/postgres.js';
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

      return {
        ...property,
        amenities,
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

    return withTx(async (tx) => {
      const updated = await propertiesRepository.updateProperty(id, data, tx);

      let amenities;
      if (data.amenities !== undefined) {
        amenities = await propertiesRepository.setAmenities(id, data.amenities, tx);
      } else {
        const amenityMap = await propertiesRepository.getAmenitiesByPropertyIds([id], tx);
        amenities = amenityMap.get(id) || [];
      }

      return {
        ...updated,
        amenities,
      };
    });
  },

  async getPropertyById(id) {
    const property = await propertiesRepository.findActiveById(id);
    if (!property) {
      throw new AppError('PROPERTY_NOT_FOUND', 404, 'Property not found');
    }

    const amenityMap = await propertiesRepository.getAmenitiesByPropertyIds([property.id]);
    const amenities = amenityMap.get(property.id) || [];

    return {
      ...property,
      amenities,
    };
  },

  async listProperties(query = {}) {
    const limit = Math.min(query.limit || 20, 50);
    const page = query.page || 1;
    const offset = (page - 1) * limit;

    const filters = {
      location: query.location || query.city,
      min_capacity: query.min_capacity,
      max_price: query.max_price,
    };

    const [properties, total] = await Promise.all([
      propertiesRepository.listActive(filters, { limit, offset }),
      propertiesRepository.countActive(filters),
    ]);

    const propertyIds = properties.map((p) => p.id);
    const amenityMap = await propertiesRepository.getAmenitiesByPropertyIds(propertyIds);

    const propertiesWithAmenities = properties.map((p) => ({
      ...p,
      amenities: amenityMap.get(p.id) || [],
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
  },

  async deleteProperty(id) {
    return propertiesRepository.deleteById(id);
  },
};
