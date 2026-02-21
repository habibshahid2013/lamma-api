/**
 * Fuse.js keyword search service.
 *
 * Builds a Fuse.js index from the cached creator list and reuses it
 * across warm invocations. The index is rebuilt whenever the underlying
 * cache refreshes (every 5 minutes).
 *
 * Optimisations:
 *   1. In-memory cache — the full (unfiltered) index survives warm invocations.
 *   2. Redis persistence — the serialised index is written to Upstash Redis so
 *      cold starts can restore the index without re-building it from scratch.
 *   3. Filtered-index LRU — the 20 most-recently-used filter combinations are
 *      kept in memory instead of being rebuilt on every request.
 */

import Fuse, { type IFuseOptions, type FuseIndex } from 'fuse.js';
import {
  getCachedCreators,
  filterCreators,
  type CachedCreator,
} from './creator-cache.js';
import { redis } from '../lib/redis.js';

const fuseOptions: IFuseOptions<CachedCreator> = {
  keys: [
    { name: 'name', weight: 1.0 },
    { name: 'profile.displayName', weight: 1.0 },
    { name: 'topics', weight: 0.8 },
    { name: 'categories', weight: 0.6 },
    { name: 'category', weight: 0.4 },
    { name: 'profile.shortBio', weight: 0.5 },
    { name: 'profile.bio', weight: 0.3 },
  ],
  threshold: 0.4,
  includeScore: true,
  minMatchCharLength: 2,
};

// ---------------------------------------------------------------------------
// Redis key & TTL for persisted Fuse index
// ---------------------------------------------------------------------------

const REDIS_INDEX_KEY = 'fuse:keyword-index';
const REDIS_INDEX_TTL = 600; // 10 minutes (longer than creator cache's 5 min)

// ---------------------------------------------------------------------------
// In-memory Fuse index (reused across warm invocations)
// ---------------------------------------------------------------------------

let cachedIndex: Fuse<CachedCreator> | null = null;
let cachedCreatorRef: CachedCreator[] | null = null;

// ---------------------------------------------------------------------------
// Filtered-index LRU cache
// ---------------------------------------------------------------------------

interface FilteredCacheEntry {
  index: Fuse<CachedCreator>;
  creatorRef: CachedCreator[];
  timestamp: number;
}

const filteredCache = new Map<string, FilteredCacheEntry>();
const FILTERED_MAX_ENTRIES = 20;
const FILTERED_TTL_MS = 5 * 60 * 1000; // 5 minutes

function makeFilterKey(filters: {
  category?: string;
  region?: string;
  language?: string;
  gender?: string;
}): string {
  return `${filters.category || ''}|${filters.region || ''}|${filters.language || ''}|${filters.gender || ''}`;
}

function evictFilteredLRU(): void {
  if (filteredCache.size <= FILTERED_MAX_ENTRIES) return;
  const toDelete = filteredCache.size - FILTERED_MAX_ENTRIES;
  let count = 0;
  for (const key of filteredCache.keys()) {
    if (count >= toDelete) break;
    filteredCache.delete(key);
    count++;
  }
}

// ---------------------------------------------------------------------------
// Redis index persistence helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to restore the Fuse index from Redis (cold-start fast path).
 * Returns null if unavailable or on error.
 */
async function restoreIndexFromRedis(
  creators: CachedCreator[],
): Promise<Fuse<CachedCreator> | null> {
  if (!redis) return null;

  try {
    const raw = await redis.get<{ keys: readonly string[]; records: unknown }>(
      REDIS_INDEX_KEY,
    );
    if (!raw || !raw.keys || !raw.records) return null;

    const parsed: FuseIndex<CachedCreator> = Fuse.parseIndex(
      raw as { keys: readonly string[]; records: any },
    );
    return new Fuse(creators, fuseOptions, parsed);
  } catch (err) {
    console.warn('[keyword-search] Failed to restore Fuse index from Redis:', err);
    return null;
  }
}

/**
 * Persist the current Fuse index to Redis (fire-and-forget).
 */
function persistIndexToRedis(index: Fuse<CachedCreator>): void {
  if (!redis) return;

  try {
    const serialised = index.getIndex().toJSON();
    redis
      .set(REDIS_INDEX_KEY, serialised, { ex: REDIS_INDEX_TTL })
      .catch((err) =>
        console.warn('[keyword-search] Failed to persist Fuse index to Redis:', err),
      );
  } catch (err) {
    console.warn('[keyword-search] Failed to serialise Fuse index:', err);
  }
}

// ---------------------------------------------------------------------------
// Build-or-restore the full (unfiltered) index
// ---------------------------------------------------------------------------

async function getOrBuildFullIndex(
  creators: CachedCreator[],
): Promise<Fuse<CachedCreator>> {
  // 1. Warm invocation — reference unchanged → reuse
  if (cachedIndex && cachedCreatorRef === creators) {
    return cachedIndex;
  }

  // 2. Cold start — try restoring from Redis
  const restored = await restoreIndexFromRedis(creators);
  if (restored) {
    cachedIndex = restored;
    cachedCreatorRef = creators;
    return restored;
  }

  // 3. Build from scratch and persist
  const index = new Fuse(creators, fuseOptions);
  cachedIndex = index;
  cachedCreatorRef = creators;
  persistIndexToRedis(index);
  return index;
}

/**
 * Run a keyword search against all published creators.
 *
 * Loads the creator cache, applies optional filters, then searches
 * using Fuse.js. Returns scored results with creator data attached.
 */
export async function keywordSearchCached(
  query: string,
  limit: number,
  filters: {
    category?: string;
    region?: string;
    language?: string;
    gender?: string;
  } = {},
): Promise<{ id: string; score: number; creator: CachedCreator }[]> {
  const allCreators = await getCachedCreators();
  const hasFilters =
    filters.category || filters.region || filters.language || filters.gender;

  if (hasFilters) {
    const filterKey = makeFilterKey(filters);
    const now = Date.now();

    // Check filtered-index LRU cache
    const cached = filteredCache.get(filterKey);
    if (
      cached &&
      cached.creatorRef === allCreators &&
      now - cached.timestamp < FILTERED_TTL_MS
    ) {
      // Move to end (most recently used)
      filteredCache.delete(filterKey);
      filteredCache.set(filterKey, cached);

      return cached.index
        .search(query)
        .slice(0, limit)
        .map((r) => ({
          id: r.item.id,
          score: 1 - (r.score || 0),
          creator: r.item,
        }));
    }

    // Build filtered index and cache it
    const filtered = filterCreators(allCreators, filters);
    const index = new Fuse(filtered, fuseOptions);
    filteredCache.set(filterKey, {
      index,
      creatorRef: allCreators,
      timestamp: now,
    });
    evictFilteredLRU();

    return index
      .search(query)
      .slice(0, limit)
      .map((r) => ({
        id: r.item.id,
        score: 1 - (r.score || 0),
        creator: r.item,
      }));
  }

  // Unfiltered search — reuse the cached full index
  const index = await getOrBuildFullIndex(allCreators);

  return index
    .search(query)
    .slice(0, limit)
    .map((r) => ({
      id: r.item.id,
      score: 1 - (r.score || 0),
      creator: r.item,
    }));
}

/**
 * Legacy synchronous keyword search (for tests or one-off usage).
 */
export function keywordSearch(
  creators: Record<string, unknown>[],
  query: string,
  limit: number,
): { id: string; score: number }[] {
  const index = new Fuse(creators, fuseOptions as unknown as IFuseOptions<Record<string, unknown>>);
  return index
    .search(query)
    .slice(0, limit)
    .map((r) => ({
      id: r.item.id as string,
      score: 1 - (r.score || 0),
    }));
}
