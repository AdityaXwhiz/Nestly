import { ordersService } from './service.js';

export const ordersController = {
  async createOrder(req, res, next) {
    try {
      const order = await ordersService.createOrder(req.body, req.user);
      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  },

  async getOrderById(req, res, next) {
    try {
      const order = await ordersService.getOrderById(req.params.id, req.user);
      res.status(200).json(order);
    } catch (err) {
      next(err);
    }
  },

  async holdOrder(req, res, next) {
    try {
      const result = await ordersService.holdOrder(req.params.id, req.user);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
