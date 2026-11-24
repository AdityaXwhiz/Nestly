import { Router } from 'express';
import { ordersController } from './controller.js';
import { authN } from '../../middleware/authN.js';
import { authZ } from '../../middleware/authZ.js';
import { validate } from '../../middleware/validate.js';
import {
  createOrderSchema,
  orderIdParamSchema,
  listOrdersQuerySchema,
} from './validation.js';

const router = Router();

// GET /api/v1/orders (CUSTOMER: own orders; ADMIN: all orders)
router.get(
  '/',
  authN,
  authZ('CUSTOMER', 'ADMIN'),
  validate({ query: listOrdersQuerySchema }),
  ordersController.listOrders,
);

// POST /api/v1/orders (CUSTOMER only)
router.post(
  '/',
  authN,
  authZ('CUSTOMER'),
  validate({ body: createOrderSchema }),
  ordersController.createOrder,
);

// GET /api/v1/orders/:id (Customer owner or ADMIN)
router.get(
  '/:id',
  authN,
  validate({ params: orderIdParamSchema }),
  ordersController.getOrderById,
);

// POST /api/v1/orders/:id/hold (CUSTOMER only, own order only)
router.post(
  '/:id/hold',
  authN,
  authZ('CUSTOMER'),
  validate({ params: orderIdParamSchema }),
  ordersController.holdOrder,
);

export default router;
