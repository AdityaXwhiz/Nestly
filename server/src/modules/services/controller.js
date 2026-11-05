import { servicesService } from './service.js';

export const servicesController = {
  async createService(req, res, next) {
    try {
      const service = await servicesService.createService(req.body, req.user);
      res.status(201).json({ service });
    } catch (err) {
      next(err);
    }
  },

  async updateService(req, res, next) {
    try {
      const service = await servicesService.updateService(
        req.params.id,
        req.body,
        req.user,
      );
      res.status(200).json({ service });
    } catch (err) {
      next(err);
    }
  },

  async getService(req, res, next) {
    try {
      const service = await servicesService.getServiceById(req.params.id);
      res.status(200).json({ service });
    } catch (err) {
      next(err);
    }
  },

  async listServices(req, res, next) {
    try {
      const result = await servicesService.listServices(req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
