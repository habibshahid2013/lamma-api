/**
 * Cached creator index for keyword search.
 *
 * Loads all published creators (lightweight fields only) from Firestore,
 * caches them in memory + Upstash Redis, and serves a pre-built Fuse.js
 * index for keyword search.
 *
 * Without this cache the keyword search path fetched only 50 docs from
 * Firestore per request, missing the vast majority of creators.
 */

import { getDb } from '../lib/firebase.js';
import { redis } from '../lib/redis.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CachedCreator {
  id: string;
  name: string;
  slug: string;
  categories: string[];
  category?: string;
  topics: string[];
  region?: string;
  languages: string[];
  gender?: string;
  is_published: boolean;
  profile?: {
    displayName?: string;
    shortBio?: string;
    bio?: string;
  };
}

// ---------------------------------------------------------------------------
// Cache config
// ---------------------------------------------------------------------------

const REDIS_KEY = 'creators:keyword-cache';
const CACHE_TTL_SECONDS = 300; // 5 minutes

/** Fields fetched from Firestore via select(). */
const SELECT_FIELDS = [
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
] as const;

// ---------------------------------------------------------------------------
// In-memory state (survives across warm Vercel invocations)
// ---------------------------------------------------------------------------

let memCache: CachedCreator[] | null = null;
let memCacheTime = 0;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadFromFirestore(): Promise<CachedCreator[]> {
  const db = getDb();
  const snapshot = await db
    .collection('creators')
    .where('is_published', '==', true)
    .select(...SELECT_FIELDS)
    .get();

  return snapshot.docs.map((doc: FirebaseFirestore.DocumentSnapshot) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      name: (data.name as string) ?? '',
      slug: (data.slug as string) ?? '',
      categories: Array.isArray(data.categories) ? data.categories : [],
      category: (data.category as string) ?? undefined,
      topics: Array.isArray(data.topics) ? data.topics : [],
      region: (data.region as string) ?? undefined,
      languages: Array.isArray(data.languages) ? data.languages : [],
      gender: (data.gender as string) ?? undefined,
      is_published: true,
      profile: data.profile as CachedCreator['profile'],
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all published creators (lightweight fields).
 *
 * Resolution order:
 *   1. In-memory cache (instant, survives warm invocations)
 *   2. Upstash Redis cache (fast, survives cold starts)
 *   3. Firestore query (authoritative, repopulates caches)
 */
export async function getCachedCreators(): Promise<CachedCreator[]> {
  const now = Date.now();

  // 1. In-memory (warm invocation)
  if (memCache && now - memCacheTime < CACHE_TTL_SECONDS * 1_000) {
    return memCache;
  }

  // 2. Upstash Redis
  if (redis) {
    try {
      const cached = await redis.get<CachedCreator[]>(REDIS_KEY);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        memCache = cached;
        memCacheTime = now;
        return cached;
      }
    } catch (err) {
      console.warn('[creator-cache] Redis read failed:', err);
    }
  }

  // 3. Firestore
  const creators = await loadFromFirestore();
  memCache = creators;
  memCacheTime = now;

  // Write-through to Redis (fire-and-forget)
  if (redis) {
    redis
      .set(REDIS_KEY, creators, { ex: CACHE_TTL_SECONDS })
      .catch((err) => console.warn('[creator-cache] Redis write failed:', err));
  }

  return creators;
}

/**
 * Filter the cached creator list using the same filter criteria
 * that the search route accepts.
 */
export function filterCreators(
  creators: CachedCreator[],
  filters: {
    category?: string;
    region?: string;
    language?: string;
    gender?: string;
  },
): CachedCreator[] {
  let result = creators;

  if (filters.category) {
    result = result.filter((c) => c.categories.includes(filters.category!));
  }
  if (filters.region) {
    result = result.filter((c) => c.region === filters.region);
  }
  if (filters.language) {
    result = result.filter((c) => c.languages.includes(filters.language!));
  }
  if (filters.gender) {
    result = result.filter((c) => c.gender === filters.gender);
  }

  return result;
}

/**
 * Invalidate caches. Useful after bulk creator updates.
 */
export function invalidateCache(): void {
  memCache = null;
  memCacheTime = 0;
  if (redis) {
    redis.del(REDIS_KEY).catch(() => {});
  }
}
