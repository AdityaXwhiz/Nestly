import { Router } from 'express';
import { z } from 'zod';
import { paymentsController } from './controller.js';
import { authN } from '../../middleware/authN.js';
import { authZ } from '../../middleware/authZ.js';
import { validate } from '../../middleware/validate.js';
import {
  createPaymentSchema,
  idempotencyHeaderSchema,
  paymentIdParamSchema,
} from './validation.js';

const router = Router();

// POST /api/v1/payments/webhook (Public, signature-verified, no JWT)
router.post(
  '/webhook',
  paymentsController.handleWebhook,
);

// POST /api/v1/payments (CUSTOMER only, Idempotency-Key required)
router.post(
  '/',
  authN,
  authZ('CUSTOMER'),
  validate({
    body: createPaymentSchema,
    headers: z
      .object({
        'idempotency-key': idempotencyHeaderSchema,
      })
      .passthrough(),
  }),
  paymentsController.createPayment,
);

// GET /api/v1/payments/:id (Owner or ADMIN)
router.get(
  '/:id',
  authN,
  validate({ params: paymentIdParamSchema }),
  paymentsController.getPaymentById,
);

export default router;
