import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../lib/firebase.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPublic } from '../middleware/rate-limit.js';
import {
  userPatchBody,
  userCreateBody,
  followBody,
  savedBody,
} from '../schemas/user.js';
import type { AppEnv } from '../types/env.js';

export const usersRouter = new Hono<AppEnv>();

// All user routes require authentication
usersRouter.use('*', requireAuth);
usersRouter.use('*', rateLimitPublic);

// ---------------------------------------------------------------------------
// GET /me — Read current user profile
// ---------------------------------------------------------------------------
usersRouter.get('/me', async (c) => {
  const userId = c.get('userId') as string;
  const db = getDb();

  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({ user: userDoc.data() });
});

// ---------------------------------------------------------------------------
// PUT /me — Create user profile (signup)
// ---------------------------------------------------------------------------
usersRouter.put('/me', zValidator('json', userCreateBody), async (c) => {
  const userId = c.get('userId') as string;
  const body = c.req.valid('json');
  const db = getDb();

  // Return existing doc if user already registered
  const existing = await db.collection('users').doc(userId).get();
  if (existing.exists) {
    return c.json({ user: existing.data(), created: false });
  }

  const newUser = {
    userId,
    email: '', // filled from token in a future iteration
    displayName: body.displayName,
    photoURL: body.photoURL ?? null,
    role: 'user',
    creatorProfileId: null,
    subscription: { plan: 'free', status: 'active' },
    following: [],
    followingCount: 0,
    saved: [],
    preferences: {
      languages: ['English'],
      regions: [],
      topics: [],
      theme: 'system',
    },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await db.collection('users').doc(userId).set(newUser);
  return c.json({ user: newUser, created: true }, 201);
});

// ---------------------------------------------------------------------------
// PATCH /me — Update user profile
// ---------------------------------------------------------------------------
usersRouter.patch('/me', zValidator('json', userPatchBody), async (c) => {
  const userId = c.get('userId') as string;
  const body = c.req.valid('json');
  const db = getDb();

  const updates = { ...body, updatedAt: FieldValue.serverTimestamp() };
  await db.collection('users').doc(userId).update(updates);

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// POST /me/following — Follow / unfollow a creator
// ---------------------------------------------------------------------------
usersRouter.post(
  '/me/following',
  zValidator('json', followBody),
  async (c) => {
    const userId = c.get('userId') as string;
    const { creatorId, action } = c.req.valid('json');
    const db = getDb();

    const batch = db.batch();
    const userRef = db.collection('users').doc(userId);
    const creatorRef = db.collection('creators').doc(creatorId);

    if (action === 'follow') {
      batch.update(userRef, {
        following: FieldValue.arrayUnion(creatorId),
        followingCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(creatorRef, {
        'stats.followerCount': FieldValue.increment(1),
      });
    } else {
      batch.update(userRef, {
        following: FieldValue.arrayRemove(creatorId),
        followingCount: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.update(creatorRef, {
        'stats.followerCount': FieldValue.increment(-1),
      });
    }

    await batch.commit();
    return c.json({ success: true, action });
  },
);

// ---------------------------------------------------------------------------
// POST /me/saved — Save / unsave a creator
// ---------------------------------------------------------------------------
usersRouter.post(
  '/me/saved',
  zValidator('json', savedBody),
  async (c) => {
    const userId = c.get('userId') as string;
    const { itemId, action } = c.req.valid('json');
    const db = getDb();

    const update =
      action === 'save'
        ? {
            saved: FieldValue.arrayUnion(itemId),
            updatedAt: FieldValue.serverTimestamp(),
          }
        : {
            saved: FieldValue.arrayRemove(itemId),
            updatedAt: FieldValue.serverTimestamp(),
          };

    await db.collection('users').doc(userId).update(update);
    return c.json({ success: true, action });
  },
);
