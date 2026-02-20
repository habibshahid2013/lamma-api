import { z } from 'zod';

/**
 * Zod schemas for user endpoints.
 */

const docId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const userPatchBody = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    photoURL: z.string().url().max(500).optional(),
    following: z.array(docId).optional(),
    followingCount: z.number().int().min(0).optional(),
    saved: z.array(docId).optional(),
    preferences: z
      .object({
        languages: z.array(z.string().max(50)).max(20).optional(),
        regions: z.array(z.string().max(50)).max(20).optional(),
        topics: z.array(z.string().max(50)).max(50).optional(),
        theme: z.enum(['light', 'dark', 'system']).optional(),
      })
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field is required',
  });

export const userCreateBody = z.object({
  displayName: z.string().min(1).max(100).optional().default('User'),
  photoURL: z.string().url().max(500).optional().nullable(),
});

export const followBody = z.object({
  creatorId: docId,
  action: z.enum(['follow', 'unfollow']),
});

export const savedBody = z.object({
  itemId: docId,
  action: z.enum(['save', 'unsave']),
});
