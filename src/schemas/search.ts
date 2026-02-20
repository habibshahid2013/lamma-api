import { z } from 'zod';

/**
 * Zod schemas for search endpoints.
 */

export const semanticSearchBody = z.object({
  query: z.string().min(2).max(500).trim(),
  mode: z.enum(['hybrid', 'semantic', 'keyword']).optional().default('hybrid'),
  limit: z.number().int().min(1).max(50).optional().default(20),
  semanticWeight: z.number().min(0).max(1).optional().default(0.7),
  filters: z
    .object({
      category: z.string().max(100).optional(),
      region: z.string().max(100).optional(),
      language: z.string().max(100).optional(),
      gender: z.string().max(20).optional(),
    })
    .optional()
    .default({}),
});

export type SemanticSearchBody = z.infer<typeof semanticSearchBody>;

export const similarQuery = z.object({
  creatorId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  limit: z
    .string()
    .default('8')
    .transform(Number)
    .pipe(z.number().int().min(1).max(20)),
});
