import { Router } from 'express';
import { availabilityController } from './controller.js';
import { validate } from '../../middleware/validate.js';
import {
  propertyAvailabilityParamSchema,
  propertyAvailabilityQuerySchema,
} from './validation.js';

const router = Router({ mergeParams: true });

router.get(
  '/',
  validate({
    params: propertyAvailabilityParamSchema,
    query: propertyAvailabilityQuerySchema,
  }),
  availabilityController.getPropertyAvailability,
);

export default router;
