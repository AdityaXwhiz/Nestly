import { servicesRepository } from './repository.js';
import { providersService } from '../providers/service.js';
import { remember, del, generateSearchCacheKey } from '../../infrastructure/redis/cache.js';
import { AppError } from '../../errors/AppError.js';

export const servicesService = {
  async createService(data, user) {
    // Cross-module service call: services module never queries providers table directly
    const provider = await providersService.getProviderByUserId(user.id);
    if (!provider) {
      throw new AppError(
        'PROVIDER_PROFILE_REQUIRED',
        400,
        'Provider profile required before creating services',
      );
    }

    const title = data.title || data.name;

    if (data.kind === 'capacity' && (!data.capacity || data.capacity <= 0)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'Capacity is required and must be greater than 0 for capacity-based services',
      );
    }

    return servicesRepository.createService({
      providerId: provider.id,
      title,
      description: data.description,
      category: data.category,
      kind: data.kind,
      priceMinor: data.price_minor,
      currency: data.currency,
      durationMinutes: data.duration_minutes,
      capacity: data.capacity,
      status: data.status,
    });
  },

  async updateService(id, data, user) {
    const existing = await servicesRepository.findById(id);
    if (!existing) {
      throw new AppError('SERVICE_NOT_FOUND', 404, 'Service not found');
    }

    // Service-layer ownership verification
    const isAdmin = user.role === 'ADMIN';
    if (!isAdmin) {
      const provider = await providersService.getProviderByUserId(user.id);
      if (!provider || existing.provider_id !== provider.id) {
        throw new AppError('FORBIDDEN', 403, 'You do not own this service');
      }
    }

    const updatePayload = { ...data };
    if (updatePayload.name && !updatePayload.title) {
      updatePayload.title = updatePayload.name;
      delete updatePayload.name;
    }

    // Validate kind and capacity against merged (existing + changed) values
    const merged = { ...existing, ...updatePayload };
    if (merged.kind === 'capacity' && (!merged.capacity || Number(merged.capacity) <= 0)) {
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'Capacity is required and must be greater than 0 for capacity-based services',
      );
    }

    const updated = await servicesRepository.updateService(id, updatePayload);
    await del(`cache:service:${id}`);
    return updated;
  },

  async getServiceById(id, { bypassCache = false } = {}) {
    const fetchDirect = async () => {
      const service = await servicesRepository.findActiveById(id);
      if (!service) {
        throw new AppError('SERVICE_NOT_FOUND', 404, 'Service not found');
      }
      return service;
    };

    if (bypassCache) {
      return fetchDirect();
    }

    return remember(`cache:service:${id}`, 300, fetchDirect);
  },

  async listServices(query = {}) {
    const cacheKey = generateSearchCacheKey('services', query);
    return remember(
      cacheKey,
      30,
      async () => {
        const limit = Math.min(query.limit || 20, 50);
        const page = query.page || 1;
        const offset = (page - 1) * limit;

        const filters = {
          category: query.category,
          max_price: query.max_price,
        };

        const [services, total] = await Promise.all([
          servicesRepository.listActive(filters, { limit, offset }),
          servicesRepository.countActive(filters),
        ]);

        return {
          services,
          pagination: {
            page,
            limit,
            total,
            has_more: offset + services.length < total,
          },
        };
      },
      { jitterSec: 10 },
    );
  },

  async deleteService(id) {
    await del(`cache:service:${id}`);
    return servicesRepository.deleteById(id);
  },
};
