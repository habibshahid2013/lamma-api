import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { getDb } from '../lib/firebase.js';
import { rateLimitSearch } from '../middleware/rate-limit.js';
import { semanticSearchBody, similarQuery } from '../schemas/search.js';
import type { AppEnv } from '../types/env.js';

export const searchRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// POST / — Semantic/hybrid search
// ---------------------------------------------------------------------------
searchRouter.post(
  '/',
  rateLimitSearch,
  zValidator('json', semanticSearchBody),
  async (c) => {
    const { query, mode, limit, filters } = c.req.valid('json');

    const db = getDb();

    // Build Firestore query for keyword/hybrid modes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = db.collection('creators').where('is_published', '==', true);

    if (filters.category) q = q.where('categories', 'array-contains', filters.category);
    if (filters.region) q = q.where('region', '==', filters.region);
    if (filters.language) q = q.where('languages', 'array-contains', filters.language);
    if (filters.gender) q = q.where('gender', '==', filters.gender);

    const snapshot = await q.limit(500).get();

    const allCreators = snapshot.docs.map(
      (doc: FirebaseFirestore.DocumentSnapshot) => {
        const data = doc.data()!;
        return { id: doc.id, ...data };
      },
    );

    // Basic keyword scoring — Fuse.js can be added as a dependency later.
    // For now use simple substring matching as a functional baseline.
    const queryLower = query.toLowerCase();
    const scored = allCreators
      .map((creator: Record<string, unknown>) => {
        let score = 0;
        const name = String(creator.name || '').toLowerCase();
        const bio = String(creator.aiSummary || creator.ai_summary || '').toLowerCase();
        const cats = Array.isArray(creator.categories)
          ? creator.categories.join(' ').toLowerCase()
          : '';

        if (name.includes(queryLower)) score += 10;
        if (bio.includes(queryLower)) score += 5;
        if (cats.includes(queryLower)) score += 3;

        // Partial word matching
        const queryWords = queryLower.split(/\s+/);
        for (const word of queryWords) {
          if (name.includes(word)) score += 2;
          if (bio.includes(word)) score += 1;
        }

        return { ...creator, _score: score };
      })
      .filter((c: { _score: number }) => c._score > 0)
      .sort((a: { _score: number }, b: { _score: number }) => b._score - a._score)
      .slice(0, limit);

    // Strip embeddings and internal fields from results
    const results = scored.map((r: Record<string, unknown>) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { embedding, _score, ...rest } = r;
      return {
        id: rest.id,
        name: rest.name,
        slug: rest.slug,
        combinedScore: _score,
        creator: rest,
      };
    });

    return c.json({
      results,
      meta: {
        query,
        mode,
        resultCount: results.length,
        timestamp: new Date().toISOString(),
      },
    });
  },
);

// ---------------------------------------------------------------------------
// GET /similar?creatorId=xxx&limit=8
// ---------------------------------------------------------------------------
searchRouter.get('/similar', rateLimitSearch, async (c) => {
  const raw = {
    creatorId: c.req.query('creatorId') ?? '',
    limit: c.req.query('limit') ?? '8',
  };

  const parsed = similarQuery.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid parameters', details: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  const { creatorId, limit } = parsed.data;
  const db = getDb();

  const creatorDoc = await db.collection('creators').doc(creatorId).get();
  if (!creatorDoc.exists) {
    return c.json({ error: 'Creator not found' }, 404);
  }

  const creatorData = creatorDoc.data()!;

  // Check for precomputed similar creators first
  const precomputed = creatorData.precomputed_similar;
  if (Array.isArray(precomputed) && precomputed.length > 0) {
    c.header(
      'Cache-Control',
      'public, s-maxage=3600, stale-while-revalidate=86400',
    );
    return c.json({
      results: precomputed
        .slice(0, limit)
        .map((r: Record<string, unknown>) => ({
          id: r.id,
          similarity: r.score,
          slug: r.slug,
          name: r.name,
          precomputed: true,
        })),
      fallback: false,
      precomputed: true,
    });
  }

  // No precomputed data — fall back to category-based similarity
  // Full vector KNN requires the Voyage AI provider (can be added later).
  const categories = creatorData.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    return c.json({ results: [], fallback: true });
  }

  const similarSnapshot = await db
    .collection('creators')
    .where('is_published', '==', true)
    .where('categories', 'array-contains', categories[0])
    .limit(limit + 1)
    .get();

  const similar = similarSnapshot.docs
    .filter((doc) => doc.id !== creatorId)
    .slice(0, limit)
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        slug: data.slug,
        similarity: 0,
      };
    });

  c.header(
    'Cache-Control',
    'public, s-maxage=3600, stale-while-revalidate=86400',
  );
  return c.json({ results: similar, fallback: true });
});
