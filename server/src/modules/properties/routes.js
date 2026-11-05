import { Router } from 'express';
import { propertiesController } from './controller.js';
import { authN } from '../../middleware/authN.js';
import { authZ } from '../../middleware/authZ.js';
import { validate } from '../../middleware/validate.js';
import {
  createPropertySchema,
  updatePropertySchema,
  listPropertiesQuerySchema,
  propertyIdParamSchema,
} from './validation.js';

const router = Router();

// Public routes
router.get(
  '/',
  validate({ query: listPropertiesQuerySchema }),
  propertiesController.listProperties,
);

router.get(
  '/:id',
  validate({ params: propertyIdParamSchema }),
  propertiesController.getProperty,
);

// Protected routes
router.post(
  '/',
  authN,
  authZ('HOST'),
  validate({ body: createPropertySchema }),
  propertiesController.createProperty,
);

router.put(
  '/:id',
  authN,
  authZ('HOST', 'ADMIN'),
  validate({ params: propertyIdParamSchema, body: updatePropertySchema }),
  propertiesController.updateProperty,
);

export default router;
