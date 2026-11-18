import { z } from 'zod';

export const serviceItemSchema = z
  .object({
    service_id: z.string().uuid('Invalid service_id format'),
    quantity: z
      .number({ invalid_type_error: 'Quantity must be an integer' })
      .int('Quantity must be an integer')
      .positive('Quantity must be a positive integer')
      .max(100, 'Quantity cannot exceed 100 per line'),
    slot: z.string().trim().min(1, 'Slot cannot be empty').optional(),
  })
  .strict();

export const createOrderSchema = z
  .object({
    property_id: z.string().uuid('Invalid property_id format').optional(),
    during: z
      .object({
        start: z.string().datetime({ offset: true, message: 'start must be an ISO datetime string with timezone offset' }),
        end: z.string().datetime({ offset: true, message: 'end must be an ISO datetime string with timezone offset' }),
      })
      .strict(),
    guest_count: z
      .number({ invalid_type_error: 'guest_count must be an integer' })
      .int('guest_count must be an integer')
      .positive('guest_count must be a positive integer'),
    services: z
      .array(serviceItemSchema)
      .max(20, 'Maximum 20 service lines permitted')
      .default([]),
  })
  .strict()
  .superRefine((data, ctx) => {
    // 1. Must have at least one item overall (property or service)
    if (!data.property_id && (!data.services || data.services.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['services'],
        message: 'Order must contain at least one item (property or service)',
      });
    }

    // 2. Validate booking time window
    const startMs = new Date(data.during.start).getTime();
    const endMs = new Date(data.during.end).getTime();

    // Start must not be in the past (allow 60s tolerance for clock skew)
    if (startMs < Date.now() - 60000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['during', 'start'],
        message: 'Booking start date cannot be in the past',
      });
    }

    // End must be strictly after start
    if (endMs <= startMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['during', 'end'],
        message: 'Booking end date must be strictly after start date',
      });
    }

    // Maximum 30 days duration limit
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    if (endMs - startMs > thirtyDaysMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['during', 'end'],
        message: 'Booking duration cannot exceed 30 days',
      });
    }

    // 3. Reject duplicate (service_id, slot) lines
    if (data.services && data.services.length > 0) {
      const seen = new Set();
      for (let i = 0; i < data.services.length; i++) {
        const item = data.services[i];
        const key = `${item.service_id}:${item.slot || ''}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['services', i],
            message: `Duplicate service line detected for service ${item.service_id}${item.slot ? ` and slot ${item.slot}` : ''}`,
          });
        }
        seen.add(key);
      }
    }
  });

export const orderIdParamSchema = z
  .object({
    id: z.string().uuid('Invalid order ID format'),
  })
  .strict();
