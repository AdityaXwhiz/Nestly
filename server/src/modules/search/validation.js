import { z } from 'zod';

const propertiesBaseSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    location: z.string().trim().max(100).optional(),
    min_capacity: z.coerce.number().int().positive().optional(),
    max_price: z.coerce.number().int().positive().optional(),
    amenities: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((val) => {
        if (!val) return undefined;
        if (Array.isArray(val)) {
          return val.map((s) => s.trim().toLowerCase()).filter(Boolean);
        }
        return val
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
      }),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    page: z.coerce.number().int().min(1).default(1),
  })
  .strict();

export const searchPropertiesQuerySchema = propertiesBaseSchema.refine(
  (data) => data.page * data.limit <= 1000,
  {
    message: 'Deep paging beyond 1000 results is not supported',
    path: ['page'],
  },
);

const servicesBaseSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(50).optional(),
    max_price: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    page: z.coerce.number().int().min(1).default(1),
  })
  .strict();

export const searchServicesQuerySchema = servicesBaseSchema.refine(
  (data) => data.page * data.limit <= 1000,
  {
    message: 'Deep paging beyond 1000 results is not supported',
    path: ['page'],
  },
);
