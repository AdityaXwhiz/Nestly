import { providersService } from './service.js';

export const providersController = {
  async createProvider(req, res, next) {
    try {
      const provider = await providersService.createProvider(req.body, req.user);
      res.status(201).json({ provider });
    } catch (err) {
      next(err);
    }
  },

  async getMyProvider(req, res, next) {
    try {
      const provider = await providersService.getProviderByUserId(req.user.id);
      if (!provider) {
        return res.status(404).json({
          error: {
            code: 'PROVIDER_NOT_FOUND',
            message: 'No provider profile found for this user',
            requestId: req.id,
            details: {},
          },
        });
      }
      res.status(200).json({ provider });
    } catch (err) {
      next(err);
    }
  },
};
