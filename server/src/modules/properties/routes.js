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
  imageUploadUrlSchema,
  imageIdParamSchema,
} from './validation.js';

const router = Router();

// Public routes
router.get(
  '/',
  validate({ query: listPropertiesQuerySchema }),
  propertiesController.listProperties,
);

// Host own properties (including non-active ones)
router.get(
  '/mine',
  authN,
  authZ('HOST'),
  propertiesController.listMyProperties,
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

// Image routes (HOST own property, ADMIN)
router.post(
  '/:id/images/upload-url',
  authN,
  authZ('HOST', 'ADMIN'),
  validate({ params: propertyIdParamSchema, body: imageUploadUrlSchema }),
  propertiesController.requestImageUploadUrl,
);

router.post(
  '/:id/images/:imageId/confirm',
  authN,
  authZ('HOST', 'ADMIN'),
  validate({ params: imageIdParamSchema }),
  propertiesController.confirmImage,
);

router.delete(
  '/:id/images/:imageId',
  authN,
  authZ('HOST', 'ADMIN'),
  validate({ params: imageIdParamSchema }),
  propertiesController.deleteImage,
);

export default router;
