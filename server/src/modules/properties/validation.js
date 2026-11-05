import { z } from 'zod';

export const propertyIdParamSchema = z.object({
  id: z.string().uuid('Invalid property ID format'),
});

export const createPropertySchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, 'Title must be at least 3 characters')
    .max(200, 'Title cannot exceed 200 characters'),
  description: z
    .string()
    .trim()
    .min(10, 'Description must be at least 10 characters'),
  location: z
    .string()
    .trim()
    .min(2, 'Location must be at least 2 characters')
    .max(200, 'Location cannot exceed 200 characters'),
  capacity: z
    .number({ invalid_type_error: 'Capacity must be a number' })
    .int('Capacity must be an integer')
    .positive('Capacity must be greater than 0'),
  pricing_minor: z
    .number({ invalid_type_error: 'pricing_minor must be an integer' })
    .int('pricing_minor must be an integer')
    .nonnegative('pricing_minor cannot be negative'),
  currency: z
    .string()
    .length(3, 'Currency must be a 3-character code')
    .toUpperCase()
    .default('INR'),
  status: z
    .enum(['ACTIVE', 'INACTIVE'])
    .default('ACTIVE'),
  amenities: z
    .array(z.string().trim().min(1, 'Amenity name cannot be empty'))
    .optional(),
});

export const updatePropertySchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, 'Title must be at least 3 characters')
    .max(200, 'Title cannot exceed 200 characters')
    .optional(),
  description: z
    .string()
    .trim()
    .min(10, 'Description must be at least 10 characters')
    .optional(),
  location: z
    .string()
    .trim()
    .min(2, 'Location must be at least 2 characters')
    .max(200, 'Location cannot exceed 200 characters')
    .optional(),
  capacity: z
    .number()
    .int('Capacity must be an integer')
    .positive('Capacity must be greater than 0')
    .optional(),
  pricing_minor: z
    .number()
    .int('pricing_minor must be an integer')
    .nonnegative('pricing_minor cannot be negative')
    .optional(),
  currency: z
    .string()
    .length(3)
    .toUpperCase()
    .optional(),
  status: z
    .enum(['ACTIVE', 'INACTIVE', 'DRAFT', 'DELETED', 'SUSPENDED'])
    .optional(),
  amenities: z
    .array(z.string().trim().min(1, 'Amenity name cannot be empty'))
    .optional(),
});

export const listPropertiesQuerySchema = z.object({
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
  location: z.string().trim().min(1).optional(),
  city: z.string().trim().min(1).optional(),
  min_capacity: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().positive().optional()),
  max_price: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().nonnegative().optional()),
});
