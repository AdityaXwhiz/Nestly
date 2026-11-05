import { availabilityService } from './service.js';

export const availabilityController = {
  async getPropertyAvailability(req, res, next) {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const data = await availabilityService.getPropertyAvailability(
        req.params.id,
        req.query.from,
        req.query.to,
      );
      res.status(200).json(data);
    } catch (err) {
      next(err);
    }
  },
};
