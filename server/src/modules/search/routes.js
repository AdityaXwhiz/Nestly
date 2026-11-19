import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { searchController } from './controller.js';
import {
  searchPropertiesQuerySchema,
  searchServicesQuerySchema,
} from './validation.js';

const router = Router();

// Public discovery endpoints
router.get(
  '/properties',
  validate({ query: searchPropertiesQuerySchema }),
  searchController.searchProperties,
);

router.get(
  '/services',
  validate({ query: searchServicesQuerySchema }),
  searchController.searchServices,
);

export default router;
