/**
 * Fuse.js keyword search wrapper.
 *
 * Uses the same configuration as lamma-app/lib/search.ts
 * for consistent scoring across both codebases.
 */

import Fuse, { type IFuseOptions } from 'fuse.js';

const fuseOptions: IFuseOptions<Record<string, unknown>> = {
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

export function keywordSearch(
  creators: Record<string, unknown>[],
  query: string,
  limit: number,
): { id: string; score: number }[] {
  const index = new Fuse(creators, fuseOptions);
  return index
    .search(query)
    .slice(0, limit)
    .map((r) => ({
      id: r.item.id as string,
      score: 1 - (r.score || 0), // Fuse 0=perfect → invert to similarity
    }));
}
