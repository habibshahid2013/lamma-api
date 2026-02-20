import { z } from 'zod';

/**
 * Zod schemas for public write endpoints (waitlist, claims).
 */

export const waitlistBody = z.object({
  email: z
    .string()
    .email('Invalid email format')
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  source: z
    .string()
    .max(50)
    .regex(/^[a-z0-9_]+$/, 'Invalid source identifier')
    .optional()
    .default('premium_page'),
});

const docId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const claimRequestBody = z.object({
  creatorId: docId,
  creatorName: z.string().min(1).max(200),
  method: z.enum(['social_media', 'email', 'video']),
  socialLinks: z.array(z.string().url().max(500)).max(10).optional().default([]),
  officialEmail: z.string().email().max(254).optional().nullable(),
  additionalNotes: z.string().max(2000).optional().nullable(),
});
