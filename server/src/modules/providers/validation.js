import { z } from 'zod';

export const createProviderSchema = z.object({
  business_name: z
    .string()
    .trim()
    .min(2, 'Business name must be at least 2 characters')
    .max(100, 'Business name cannot exceed 100 characters'),
  bio: z
    .string()
    .trim()
    .max(1000, 'Bio cannot exceed 1000 characters')
    .optional(),
});
