import { availabilityRepository } from './repository.js';
import { propertiesRepository } from '../properties/repository.js';
import { AppError } from '../../errors/AppError.js';

export const availabilityService = {
  async getPropertyAvailability(propertyId, from, to) {
    // 1. Verify property exists and is ACTIVE (rejects missing or non-ACTIVE with 404)
    const property = await propertiesRepository.findActiveById(propertyId);
    if (!property) {
      throw new AppError('PROPERTY_NOT_FOUND', 404, 'Property not found or not active');
    }

    // 2. Fetch reservations and host-blocked dates in parallel
    const [reservations, blocked] = await Promise.all([
      availabilityRepository.getActiveReservations(propertyId, from, to),
      availabilityRepository.getHostBlockedRanges(propertyId, from, to),
    ]);

    const unavailableRanges = [
      ...reservations.map((r) => ({
        start: r.start,
        end: r.end,
        reason: 'RESERVED',
        status: r.status,
      })),
      ...blocked.map((b) => ({
        start: b.start,
        end: b.end,
        reason: 'BLOCKED',
      })),
    ].sort((a, b) => new Date(a.start) - new Date(b.start));

    return {
      property_id: propertyId,
      indicative: true,
      window: {
        from,
        to,
      },
      unavailable_ranges: unavailableRanges,
    };
  },
};
