import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../lib/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPublic } from '../middleware/rate-limit.js';
import { waitlistBody, claimRequestBody } from '../schemas/public.js';
import type { AppEnv } from '../types/env.js';

export const publicRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// POST /waitlist — Premium waitlist signup (public, rate-limited)
// ---------------------------------------------------------------------------
publicRouter.post(
  '/waitlist',
  rateLimitPublic,
  zValidator('json', waitlistBody),
  async (c) => {
    const { email, source } = c.req.valid('json');
    const db = getDb();

    // Deduplicate by email
    const existing = await db
      .collection('waitlist')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (!existing.empty) {
      return c.json({ success: true, message: 'Already on waitlist' });
    }

    await db.collection('waitlist').add({
      email,
      source,
      createdAt: FieldValue.serverTimestamp(),
    });

    return c.json({ success: true, message: 'Added to waitlist' }, 201);
  },
);

// ---------------------------------------------------------------------------
// POST /claim-requests — Submit profile claim (authenticated, rate-limited)
// ---------------------------------------------------------------------------
publicRouter.post(
  '/claim-requests',
  rateLimitPublic,
  requireAuth,
  zValidator('json', claimRequestBody),
  async (c) => {
    const userId = c.get('userId');
    const {
      creatorId,
      creatorName,
      method,
      socialLinks,
      officialEmail,
      additionalNotes,
    } = c.req.valid('json');

    const db = getDb();

    // Check for existing pending claim
    const existing = await db
      .collection('claimRequests')
      .where('creatorProfileId', '==', creatorId)
      .where('claimantUserId', '==', userId)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (!existing.empty) {
      return c.json(
        { success: false, message: 'You already have a pending claim for this profile' },
        409,
      );
    }

    await db.collection('claimRequests').add({
      creatorProfileId: creatorId,
      creatorName,
      claimantUserId: userId,
      claimantEmail: '', // populated from token in future iteration
      evidence: {
        method,
        socialMediaLinks: socialLinks ?? [],
        officialEmail: officialEmail ?? null,
        additionalNotes: additionalNotes ?? null,
      },
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return c.json({ success: true, message: 'Claim submitted' }, 201);
  },
);
