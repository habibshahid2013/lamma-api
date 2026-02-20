import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../lib/firebase.js';
import { rateLimitSearch } from '../middleware/rate-limit.js';
import { semanticSearchBody, similarQuery } from '../schemas/search.js';
import { embedQuery } from '../services/voyage-embedder.js';
import { keywordSearch } from '../services/keyword-search.js';
import type { AppEnv } from '../types/env.js';

export const searchRouter = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the `embedding` field from a doc before returning to clients.
 */
function stripEmbedding(
  data: Record<string, unknown>,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { embedding, ...rest } = data;
  return rest;
}

/**
 * Extract the embedding vector from a Firestore doc.
 * Handles both VectorValue objects (with toArray()) and plain number arrays.
 */
function extractVector(raw: unknown): number[] | null {
  if (!raw) return null;
  if (typeof (raw as { toArray?: unknown }).toArray === 'function') {
    return (raw as { toArray: () => number[] }).toArray();
  }
  if (Array.isArray(raw)) return raw as number[];
  return null;
}

// ---------------------------------------------------------------------------
// POST / — Hybrid search (semantic + keyword)
// ---------------------------------------------------------------------------
searchRouter.post(
  '/',
  rateLimitSearch,
  zValidator('json', semanticSearchBody),
  async (c) => {
    const { query, mode, limit, semanticWeight, filters } = c.req.valid('json');

    const db = getDb();

    // ---------- Semantic Search ----------
    const semanticResults: Map<string, number> = new Map();
    const semanticDocs: Map<string, Record<string, unknown>> = new Map();

    if (mode === 'semantic' || mode === 'hybrid') {
      try {
        const queryVector = await embedQuery(query);

        // findNearest without where clauses to avoid requiring composite vector indexes.
        // All filters (is_published, category, region, language, gender) are post-filtered.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const baseQuery: any = db.collection('creators');

        const snapshot = await baseQuery
          .findNearest({
            vectorField: 'embedding',
            queryVector: FieldValue.vector(queryVector),
            limit: limit * 4, // Over-fetch to account for post-filtering
            distanceMeasure: 'COSINE',
            distanceResultField: '_distance',
          })
          .get();

        for (const doc of snapshot.docs) {
          const data = doc.data();

          // Post-filter: only published creators
          if (!data.is_published) continue;
          // Post-filter: category
          if (filters.category && !(Array.isArray(data.categories) && data.categories.includes(filters.category))) continue;
          // Post-filter: region
          if (filters.region && data.region !== filters.region) continue;
          // Post-filter: language
          if (filters.language && !(Array.isArray(data.languages) && data.languages.includes(filters.language))) continue;
          // Post-filter: gender
          if (filters.gender && data.gender !== filters.gender) continue;

          const similarity = data._distance !== undefined ? 1 - data._distance : 0;
          semanticResults.set(doc.id, similarity);
          semanticDocs.set(doc.id, { id: doc.id, ...stripEmbedding(data) });
        }
      } catch (err) {
        console.error('[search] Semantic search failed:', err);
        if (mode === 'semantic') throw err;
        // In hybrid mode, fall through to keyword-only
      }
    }

    // ---------- Keyword Search ----------
    const keywordResults: Map<string, number> = new Map();
    let allCreatorsMap: Map<string, Record<string, unknown>> = new Map();

    if (mode === 'keyword' || mode === 'hybrid') {
      // Fetch published creators for Fuse.js — use select() to avoid pulling
      // large embedding arrays and other heavy fields over the wire.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = db.collection('creators').where('is_published', '==', true);

      // Apply filters that don't conflict with array-contains
      if (filters.category) q = q.where('categories', 'array-contains', filters.category);
      if (filters.region) q = q.where('region', '==', filters.region);
      if (filters.gender) q = q.where('gender', '==', filters.gender);
      // Language post-filtered if category is also set

      const snapshot = await q
        .select(
          'name',
          'slug',
          'categories',
          'category',
          'topics',
          'region',
          'languages',
          'gender',
          'is_published',
          'profile',
        )
        .limit(50)
        .get();

      let creators = snapshot.docs.map(
        (doc: FirebaseFirestore.DocumentSnapshot) => {
          const data = doc.data()!;
          return { id: doc.id, ...data };
        },
      );

      // Post-filter language when category already consumed array-contains
      if (filters.language && filters.category) {
        creators = creators.filter((c: Record<string, unknown>) => {
          const langs = Array.isArray(c.languages) ? c.languages : [];
          return langs.includes(filters.language!);
        });
      }

      // Store for merged result building
      for (const c of creators) {
        allCreatorsMap.set(c.id as string, c as Record<string, unknown>);
      }

      const kwResults = keywordSearch(creators, query, limit * 2);
      for (const r of kwResults) {
        keywordResults.set(r.id, r.score);
      }
    }

    // ---------- Merge Results ----------
    const allIds = new Set([...semanticResults.keys(), ...keywordResults.keys()]);
    const merged: {
      id: string;
      name: unknown;
      slug: unknown;
      semanticScore: number;
      keywordScore: number;
      combinedScore: number;
      creator: Record<string, unknown> | undefined;
    }[] = [];

    for (const id of allIds) {
      const semanticScore = semanticResults.get(id) || 0;
      const keywordScore = keywordResults.get(id) || 0;

      let combinedScore: number;
      if (mode === 'semantic') {
        combinedScore = semanticScore;
      } else if (mode === 'keyword') {
        combinedScore = keywordScore;
      } else {
        combinedScore = semanticWeight * semanticScore + (1 - semanticWeight) * keywordScore;
      }

      const creatorData = semanticDocs.get(id) || allCreatorsMap.get(id);
      const creator = creatorData ? stripEmbedding(creatorData) : undefined;

      merged.push({
        id,
        name: creator?.name || '',
        slug: creator?.slug || '',
        semanticScore,
        keywordScore,
        combinedScore,
        creator,
      });
    }

    merged.sort((a, b) => b.combinedScore - a.combinedScore);

    const results = merged.slice(0, limit);

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

  // Try live vector KNN using the creator's embedding
  const queryVector = extractVector(creatorData.embedding);

  if (queryVector && queryVector.length > 0) {
    // findNearest without where clauses to avoid requiring composite vector indexes.
    // Post-filter is_published and self-exclusion instead.
    const snapshot = await (db.collection('creators') as any)
      .findNearest({
        vectorField: 'embedding',
        queryVector: FieldValue.vector(queryVector),
        limit: (limit + 1) * 2, // Over-fetch to account for post-filtering
        distanceMeasure: 'COSINE',
        distanceResultField: '_distance',
      })
      .get();

    const similar = snapshot.docs
      .filter((doc: FirebaseFirestore.DocumentSnapshot) => {
        if (doc.id === creatorId) return false;
        const data = doc.data()!;
        return data.is_published === true;
      })
      .slice(0, limit)
      .map((doc: FirebaseFirestore.DocumentSnapshot) => {
        const data = doc.data()!;
        const distance = data._distance as number | undefined;
        const creator = stripEmbedding(data);
        delete creator._distance;
        return {
          id: doc.id,
          ...creator,
          similarity: distance !== undefined ? 1 - distance : 0,
          distance,
        };
      });

    // Lazy write-back: cache results for future requests (fire-and-forget)
    if (similar.length > 0) {
      const precomputedData = similar.map((r: { id: string; slug: unknown; name: unknown; similarity: number }) => ({
        id: r.id,
        score: r.similarity,
        slug: r.slug,
        name: r.name,
      }));
      db.collection('creators').doc(creatorId).update({
        precomputed_similar: precomputedData,
        precomputed_similar_at: new Date(),
      }).catch((err) => console.warn('[similar-search] Failed to cache:', err));
    }

    c.header(
      'Cache-Control',
      'public, s-maxage=3600, stale-while-revalidate=86400',
    );
    return c.json({ results: similar, fallback: false });
  }

  // No embedding available — fall back to category-based similarity
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
