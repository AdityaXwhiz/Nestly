import { Router } from 'express';
import { usersController } from './controller.js';
import { validate } from '../../middleware/validate.js';
import { getUserParamsSchema } from './validation.js';

const router = Router();

router.get('/:id', validate({ params: getUserParamsSchema }), usersController.getUser);

export default router;
