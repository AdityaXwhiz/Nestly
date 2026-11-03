import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password cannot exceed 72 characters'),
  role: z.enum(['CUSTOMER', 'HOST', 'PROVIDER'], {
    errorMap: () => ({ message: 'Role must be CUSTOMER, HOST, or PROVIDER' }),
  }),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z
    .string()
    .min(1, 'Password is required')
    .max(72, 'Password cannot exceed 72 characters'),
});
