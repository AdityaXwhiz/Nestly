import { providersRepository } from './repository.js';
import { AppError } from '../../errors/AppError.js';

export const providersService = {
  /**
   * Create a provider profile for the authenticated user.
   * Enforces 1 profile per user.
   */
  async createProvider(data, user) {
    const existing = await providersRepository.findByUserId(user.id);
    if (existing) {
      throw new AppError(
        'PROVIDER_ALREADY_EXISTS',
        409,
        'A provider profile already exists for this account',
      );
    }

    return providersRepository.createProvider({
      userId: user.id,
      businessName: data.business_name,
      bio: data.bio,
    });
  },

  /**
   * Internal service lookup called by services module.
   */
  async getProviderByUserId(userId) {
    return providersRepository.findByUserId(userId);
  },

  /**
   * Public or authenticated lookup by provider ID.
   */
  async getProviderById(id) {
    const provider = await providersRepository.findById(id);
    if (!provider) {
      throw new AppError('PROVIDER_NOT_FOUND', 404, 'Provider profile not found');
    }
    return provider;
  },

  /**
   * Delete provider profile (for test cleanup).
   */
  async deleteProvider(id) {
    return providersRepository.deleteById(id);
  },

  /**
   * Internal lookup by provider ID without throwing 404.
   */
  async findProviderInternal(id, client = undefined) {
    return providersRepository.findById(id, client);
  },

  /**
   * Create a fulfilment action record per confirmed order item.
   * Natural idempotency enforced by UNIQUE (order_item_id, action).
   */
  async createProviderAction(data, client = undefined) {
    return providersRepository.createProviderAction(data, client);
  },

  /**
   * List fulfilment actions for an order.
   */
  async listActionsByOrderId(orderId, client = undefined) {
    return providersRepository.findActionsByOrderId(orderId, client);
  },
};
