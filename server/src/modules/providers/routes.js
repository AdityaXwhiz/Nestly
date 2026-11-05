import { Router } from 'express';
import { providersController } from './controller.js';
import { authN } from '../../middleware/authN.js';
import { authZ } from '../../middleware/authZ.js';
import { validate } from '../../middleware/validate.js';
import { createProviderSchema } from './validation.js';

const router = Router();

router.post(
  '/',
  authN,
  authZ('PROVIDER'),
  validate({ body: createProviderSchema }),
  providersController.createProvider,
);

router.get(
  '/me',
  authN,
  authZ('PROVIDER'),
  providersController.getMyProvider,
);

export default router;
