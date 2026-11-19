import { searchService } from './service.js';

export const searchController = {
  async searchProperties(req, res, next) {
    try {
      const result = await searchService.searchProperties(req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async searchServices(req, res, next) {
    try {
      const result = await searchService.searchServices(req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
