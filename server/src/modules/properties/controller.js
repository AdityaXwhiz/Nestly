import { propertiesService } from './service.js';

export const propertiesController = {
  async createProperty(req, res, next) {
    try {
      const property = await propertiesService.createProperty(req.body, req.user);
      res.status(201).json({ property });
    } catch (err) {
      next(err);
    }
  },

  async updateProperty(req, res, next) {
    try {
      const property = await propertiesService.updateProperty(
        req.params.id,
        req.body,
        req.user,
      );
      res.status(200).json({ property });
    } catch (err) {
      next(err);
    }
  },

  async getProperty(req, res, next) {
    try {
      const property = await propertiesService.getPropertyById(req.params.id);
      res.status(200).json({ property });
    } catch (err) {
      next(err);
    }
  },

  async listProperties(req, res, next) {
    try {
      const result = await propertiesService.listProperties(req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
