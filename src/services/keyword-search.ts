/**
 * Fuse.js keyword search service.
 *
 * Builds a Fuse.js index from the cached creator list and reuses it
 * across warm invocations. The index is rebuilt whenever the underlying
 * cache refreshes (every 5 minutes).
 */

import Fuse, { type IFuseOptions } from 'fuse.js';
import {
  getCachedCreators,
  filterCreators,
  type CachedCreator,
} from './creator-cache.js';

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
// In-memory Fuse index (reused across warm invocations)
// ---------------------------------------------------------------------------

let cachedIndex: Fuse<CachedCreator> | null = null;
let cachedCreatorRef: CachedCreator[] | null = null;

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
    // Filtered search — build a one-off index for the filtered set
    const filtered = filterCreators(allCreators, filters);
    const index = new Fuse(filtered, fuseOptions);
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
  if (cachedCreatorRef !== allCreators) {
    // Creator list reference changed (cache refreshed) — rebuild index
    cachedIndex = new Fuse(allCreators, fuseOptions);
    cachedCreatorRef = allCreators;
  }

  return cachedIndex!
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
