import { z } from 'zod';

export const propertyAvailabilityParamSchema = z.object({
  id: z.string().uuid('Invalid property ID format'),
});

const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export const propertyAvailabilityQuerySchema = z
  .object({
    from: z.string().datetime({ message: 'From must be a valid ISO-8601 timestamp' }),
    to: z.string().datetime({ message: 'To must be a valid ISO-8601 timestamp' }),
  })
  .superRefine((data, ctx) => {
    const fromDate = new Date(data.from);
    const toDate = new Date(data.to);

    if (toDate <= fromDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'End time (to) must be strictly after start time (from)',
        path: ['to'],
      });
    }

    if (toDate - fromDate > MAX_WINDOW_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Availability query window cannot exceed 90 days',
        path: ['to'],
      });
    }
  });
