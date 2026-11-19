import { paymentsService } from './service.js';

export const paymentsController = {
  async createPayment(req, res, next) {
    try {
      const idempotencyKey = req.header('Idempotency-Key');
      const result = await paymentsService.createPayment({
        userId: req.user.id,
        orderId: req.body.order_id,
        idempotencyKey,
        metadata: req.body.metadata,
      });
      res.status(result.status).json(result.payment);
    } catch (err) {
      next(err);
    }
  },

  async getPaymentById(req, res, next) {
    try {
      const payment = await paymentsService.getPaymentById(req.params.id, req.user);
      res.status(200).json(payment);
    } catch (err) {
      next(err);
    }
  },

  async handleWebhook(req, res, next) {
    try {
      const rawBody = req.rawBody || JSON.stringify(req.body);
      const result = await paymentsService.handleWebhook({
        rawBody,
        headers: req.headers,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
};
