import { Router } from 'express';
import { servicesController } from './controller.js';
import { authN } from '../../middleware/authN.js';
import { authZ } from '../../middleware/authZ.js';
import { validate } from '../../middleware/validate.js';
import {
  createServiceSchema,
  updateServiceSchema,
  listServicesQuerySchema,
  serviceIdParamSchema,
} from './validation.js';

const router = Router();

// Public routes
router.get(
  '/',
  validate({ query: listServicesQuerySchema }),
  servicesController.listServices,
);

router.get(
  '/:id',
  validate({ params: serviceIdParamSchema }),
  servicesController.getService,
);

// Protected routes
router.post(
  '/',
  authN,
  authZ('PROVIDER'),
  validate({ body: createServiceSchema }),
  servicesController.createService,
);

router.put(
  '/:id',
  authN,
  authZ('PROVIDER', 'ADMIN'),
  validate({ params: serviceIdParamSchema, body: updateServiceSchema }),
  servicesController.updateService,
);

export default router;
