import { z } from 'zod';

export const createPaymentSchema = z
  .object({
    order_id: z.string().uuid('Invalid order_id format'),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const idempotencyHeaderSchema = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .trim()
  .min(1, 'Idempotency-Key header cannot be empty')
  .max(255, 'Idempotency-Key header cannot exceed 255 characters');

export const paymentIdParamSchema = z
  .object({
    id: z.string().uuid('Invalid payment ID format'),
  })
  .strict();
