import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { getDb } from '../lib/firebase.js';
import { rateLimitPublic } from '../middleware/rate-limit.js';
import {
  creatorsListQuery,
  slugParam,
  byIdsBody,
  slugsQuery,
  searchByNameQuery,
} from '../schemas/creator.js';
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
    cursor,
    contentType,
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

  // Cursor-based pagination: stable ordering + startAfter.
  // When using cursor, skip where clauses that require composite indexes
  // with orderBy('name') — post-filter instead.
  let cursorPostFilter = false;
  if (cursor) {
    // Reset query to only use orderBy('name') with startAfter
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursorQ: any = db.collection('creators').orderBy('name');
    const cursorDoc = await db.collection('creators').doc(cursor).get();
    if (cursorDoc.exists) {
      cursorQ = cursorQ.startAfter(cursorDoc);
    }
    // Fetch extra to account for post-filtering
    cursorQ = cursorQ.limit((pageLimit + 1) * 2);
    q = cursorQ;
    cursorPostFilter = true;
  } else {
    q = q.limit(pageLimit);
  }

  const snapshot = await q.get();

  let allDocs = snapshot.docs;

  // When using cursor mode, apply filter criteria that were skipped in the query
  // (to avoid needing composite indexes with orderBy)
  if (cursorPostFilter) {
    allDocs = allDocs.filter((doc: FirebaseFirestore.DocumentSnapshot) => {
      const data = doc.data()!;
      if (!showDrafts && !data.is_published) return false;
      if (category && !(Array.isArray(data.categories) && data.categories.includes(category))) return false;
      if (region && data.region !== region) return false;
      if (language && !(Array.isArray(data.languages) && data.languages.includes(language))) return false;
      if (gender && data.gender !== gender) return false;
      if (featured !== undefined && data.featured !== featured) return false;
      if (trending !== undefined && data.trending !== trending) return false;
      if (isHistorical !== undefined && data.isHistorical !== isHistorical) return false;
      return true;
    });
  }

  // Determine nextCursor: take pageLimit+1, check if more exist
  let nextCursor: string | null = null;
  let docs = allDocs;
  if (cursor && docs.length > pageLimit) {
    docs = docs.slice(0, pageLimit);
    nextCursor = docs[docs.length - 1]?.id ?? null;
  }

  let creators = docs.map(
    (doc: FirebaseFirestore.DocumentSnapshot) => {
      return { id: doc.id, creatorId: doc.id, ...stripEmbedding(doc.data()!) };
    },
  );

  // Post-filter by contentType (checks nested content.* fields)
  if (contentType) {
    creators = creators.filter((creator: Record<string, unknown>) => {
      const content = creator.content as Record<string, unknown> | undefined;
      if (!content) return false;
      const items = content[contentType];
      return Array.isArray(items) && items.length > 0;
    });
  }

  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return c.json({ creators, total: creators.length, nextCursor });
});

// ---------------------------------------------------------------------------
// GET /slugs — Top creator slugs (for sitemap / static generation)
// ---------------------------------------------------------------------------
creatorsRouter.get('/slugs', rateLimitPublic, async (c) => {
  const url = new URL(c.req.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });

  const parsed = slugsQuery.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  const limit = parsed.data.limit ?? 100;
  const db = getDb();
  const snapshot = await db.collection('slugs').limit(limit).get();
  const slugs = snapshot.docs.map(
    (doc: FirebaseFirestore.DocumentSnapshot) => doc.id,
  );

  c.header('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
  return c.json({ slugs, total: slugs.length });
});

// ---------------------------------------------------------------------------
// GET /search-by-name — Name prefix search (unclaimed creators only)
// ---------------------------------------------------------------------------
creatorsRouter.get('/search-by-name', rateLimitPublic, async (c) => {
  const url = new URL(c.req.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    raw[key] = value;
  });

  const parsed = searchByNameQuery.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid query parameters', details: parsed.error.flatten().fieldErrors },
      400,
    );
  }

  const rawQuery = parsed.data.q.trim();
  // Capitalize first letter to match name field casing (e.g., "ahmed" → "Ahmed")
  const query = rawQuery.charAt(0).toUpperCase() + rawQuery.slice(1).toLowerCase();
  const db = getDb();

  // Prefix search on `name` field (ordered).
  // Post-filter is_published to avoid requiring a composite index.
  const snapshot = await db
    .collection('creators')
    .orderBy('name')
    .startAt(query)
    .endAt(query + '\uf8ff')
    .limit(40)
    .get();

  const results = snapshot.docs
    .filter((doc: FirebaseFirestore.DocumentSnapshot) => {
      const data = doc.data()!;
      return data.is_published === true && !data.ownerId;
    })
    .slice(0, 10)
    .map((doc: FirebaseFirestore.DocumentSnapshot) => {
      const data = doc.data()! as Record<string, unknown>;
      const profile = data.profile as Record<string, unknown> | undefined;
      return {
        id: doc.id,
        name: (data.name as string) || profile?.displayName || '',
        slug: (data.slug as string) || '',
        avatar: (data.avatar as string) || profile?.avatar || '',
        categories: (data.categories as string[]) || [],
        location: (data.location as string) || '',
      };
    });

  c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  return c.json({ results, total: results.length });
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
