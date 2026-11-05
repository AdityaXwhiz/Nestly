import { z } from 'zod';

export const serviceIdParamSchema = z.object({
  id: z.string().uuid('Invalid service ID format'),
});

const serviceCategories = [
  'catering',
  'decoration',
  'cake',
  'photography',
  'music',
  'other',
];

export const createServiceSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, 'Title must be at least 3 characters')
      .max(200, 'Title cannot exceed 200 characters')
      .optional(),
    name: z
      .string()
      .trim()
      .min(3, 'Name must be at least 3 characters')
      .max(200, 'Name cannot exceed 200 characters')
      .optional(),
    description: z
      .string()
      .trim()
      .min(10, 'Description must be at least 10 characters'),
    category: z.enum(serviceCategories, {
      errorMap: () => ({
        message:
          'Category must be one of: catering, decoration, cake, photography, music, other',
      }),
    }),
    kind: z.enum(['exclusive', 'capacity'], {
      errorMap: () => ({ message: 'Kind must be either exclusive or capacity' }),
    }),
    price_minor: z
      .number({ invalid_type_error: 'price_minor must be an integer' })
      .int('price_minor must be an integer')
      .nonnegative('price_minor cannot be negative'),
    currency: z
      .string()
      .length(3, 'Currency must be a 3-character code')
      .toUpperCase()
      .default('INR'),
    duration_minutes: z
      .number()
      .int('Duration must be an integer')
      .positive('Duration must be greater than 0')
      .optional(),
    capacity: z
      .number()
      .int('Capacity must be an integer')
      .positive('Capacity must be greater than 0')
      .optional(),
    status: z
      .enum(['ACTIVE', 'INACTIVE'])
      .default('ACTIVE'),
  })
  .superRefine((data, ctx) => {
    if (!data.title && !data.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either title or name is required',
        path: ['title'],
      });
    }

    if (data.kind === 'capacity' && (!data.capacity || data.capacity <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Capacity must be a positive integer for capacity-based services',
        path: ['capacity'],
      });
    }
  });

export const updateServiceSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, 'Title must be at least 3 characters')
    .max(200, 'Title cannot exceed 200 characters')
    .optional(),
  name: z
    .string()
    .trim()
    .min(3, 'Name must be at least 3 characters')
    .max(200, 'Name cannot exceed 200 characters')
    .optional(),
  description: z
    .string()
    .trim()
    .min(10, 'Description must be at least 10 characters')
    .optional(),
  category: z.enum(serviceCategories).optional(),
  kind: z.enum(['exclusive', 'capacity']).optional(),
  price_minor: z
    .number()
    .int('price_minor must be an integer')
    .nonnegative('price_minor cannot be negative')
    .optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  duration_minutes: z
    .number()
    .int()
    .positive()
    .optional(),
  capacity: z
    .number()
    .int()
    .positive()
    .optional(),
  status: z
    .enum(['ACTIVE', 'INACTIVE', 'DRAFT', 'DELETED', 'SUSPENDED'])
    .optional(),
});

export const listServicesQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20))
    .pipe(
      z.number().int().min(1).max(50, 'Pagination limit cannot exceed 50'),
    ),
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1))
    .pipe(z.number().int().min(1)),
  category: z.enum(serviceCategories).optional(),
  max_price: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().nonnegative().optional()),
});
