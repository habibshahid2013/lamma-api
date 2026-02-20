import { z } from 'zod';

/**
 * Zod schemas for creator endpoints.
 *
 * Self-contained — does not depend on lamma-app config.
 * Category/region allowlists are validated as reasonable strings;
 * Firestore handles unknown values gracefully (empty result sets).
 */

const safeString = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_ -]+$/);

const docId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const creatorsListQuery = z.object({
  category: safeString.optional(),
  region: safeString.optional(),
  language: safeString.optional(),
  gender: z.enum(['male', 'female', 'non-binary', '']).optional(),
  featured: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  trending: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  isHistorical: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  showDrafts: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z
    .string()
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional(),
});

export type CreatorsListQuery = z.infer<typeof creatorsListQuery>;

export const slugParam = z.object({
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Invalid slug format'),
});

export const byIdsBody = z.object({
  ids: z.array(docId).min(1).max(50),
});
