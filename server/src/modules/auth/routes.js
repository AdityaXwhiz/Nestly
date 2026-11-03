import { Router } from 'express';
import { authController } from './controller.js';
import { validate } from '../../middleware/validate.js';
import { registerSchema, loginSchema } from './validation.js';
import { authN } from '../../middleware/authN.js';
import { rateLimit } from '../../middleware/rateLimit.js';

const router = Router();

const authRateLimiter = rateLimit({ scope: 'auth' });

router.post(
  '/register',
  authRateLimiter,
  validate({ body: registerSchema }),
  authController.register,
);

router.post(
  '/login',
  authRateLimiter,
  validate({ body: loginSchema }),
  authController.login,
);

router.get(
  '/me',
  authN,
  authController.getMe,
);

export default router;
