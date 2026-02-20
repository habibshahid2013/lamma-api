import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { getDb } from '../lib/firebase.js';
import { rateLimitPublic } from '../middleware/rate-limit.js';
import { creatorsListQuery, slugParam, byIdsBody } from '../schemas/creator.js';
import type { AppEnv } from '../types/env.js';

export const creatorsRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the `embedding` field from a Firestore doc before returning.
 * Embeddings are large float arrays — never send to clients.
 */
function stripEmbedding(
  data: Record<string, unknown>,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { embedding, ...rest } = data;
  return rest;
}

// ---------------------------------------------------------------------------
// GET / — List creators with optional filters
// ---------------------------------------------------------------------------
creatorsRouter.get('/', rateLimitPublic, async (c) => {
  const url = new URL(c.req.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });

  const parsed = creatorsListQuery.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  const {
    category,
    region,
    language,
    gender,
    featured,
    trending,
    isHistorical,
    showDrafts,
    limit: queryLimit,
  } = parsed.data;

  const pageLimit = queryLimit ?? 50;
  const db = getDb();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = db.collection('creators');

  if (!showDrafts) {
    q = q.where('is_published', '==', true);
  }
  if (category) q = q.where('categories', 'array-contains', category);
  if (region) q = q.where('region', '==', region);
  if (language) q = q.where('languages', 'array-contains', language);
  if (gender) q = q.where('gender', '==', gender);
  if (featured !== undefined) q = q.where('featured', '==', featured);
  if (trending !== undefined) q = q.where('trending', '==', trending);
  if (isHistorical !== undefined)
    q = q.where('isHistorical', '==', isHistorical);

  q = q.limit(pageLimit);

  const snapshot = await q.get();
  const creators = snapshot.docs.map(
    (doc: FirebaseFirestore.DocumentSnapshot) => {
      return { id: doc.id, creatorId: doc.id, ...stripEmbedding(doc.data()!) };
    },
  );

  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return c.json({ creators, total: creators.length });
});

// ---------------------------------------------------------------------------
// GET /by-slug/:slug — Single creator by slug
// ---------------------------------------------------------------------------
creatorsRouter.get('/by-slug/:slug', rateLimitPublic, async (c) => {
  const parsed = slugParam.safeParse({ slug: c.req.param('slug') });
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid slug', details: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  const db = getDb();

  // Slug → creatorId lookup
  const slugDoc = await db.collection('slugs').doc(parsed.data.slug).get();
  if (!slugDoc.exists) {
    return c.json({ error: 'Creator not found' }, 404);
  }

  const creatorId = slugDoc.data()?.creatorId;
  if (!creatorId) {
    return c.json({ error: 'Creator not found' }, 404);
  }

  const creatorDoc = await db.collection('creators').doc(creatorId).get();
  if (!creatorDoc.exists) {
    return c.json({ error: 'Creator not found' }, 404);
  }

  const creator = {
    id: creatorDoc.id,
    creatorId: creatorDoc.id,
    ...stripEmbedding(creatorDoc.data()!),
  };

  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return c.json({ creator });
});

// ---------------------------------------------------------------------------
// POST /by-ids — Batch fetch creators by IDs (max 50)
// ---------------------------------------------------------------------------
creatorsRouter.post(
  '/by-ids',
  rateLimitPublic,
  zValidator('json', byIdsBody),
  async (c) => {
    const { ids } = c.req.valid('json');
    const db = getDb();

    const refs = ids.map((id) => db.collection('creators').doc(id));
    const snapshots = await db.getAll(...refs);

    const creators = snapshots
      .filter((doc) => doc.exists)
      .map((doc) => ({
        id: doc.id,
        creatorId: doc.id,
        ...stripEmbedding(doc.data()!),
      }));

    return c.json({ creators, total: creators.length });
  },
);

// ---------------------------------------------------------------------------
// GET /counts — Creator counts per category
// ---------------------------------------------------------------------------
creatorsRouter.get('/counts', rateLimitPublic, async (c) => {
  const db = getDb();

  // Fetch distinct categories from a metadata doc or use a fixed list.
  // For now, query all published creators and aggregate in-memory.
  // This is acceptable because counts endpoint is heavily cached.
  const snapshot = await db
    .collection('creators')
    .where('is_published', '==', true)
    .select('categories')
    .get();

  const counts: Record<string, number> = {};
  for (const doc of snapshot.docs) {
    const cats = doc.data().categories;
    if (Array.isArray(cats)) {
      for (const cat of cats) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
  }

  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return c.json({ counts });
});
