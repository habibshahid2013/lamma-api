import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../src/app.js';

/**
 * Integration tests for the Central API routes.
 *
 * Uses Hono's built-in test client (app.request) — no HTTP server needed.
 * Firebase and Redis are mocked to test route logic in isolation.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock Firebase Admin
const mockGet = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockSelect = vi.fn();
const mockDoc = vi.fn();
const mockGetAll = vi.fn();
const mockAdd = vi.fn();
const mockUpdate = vi.fn();
const mockBatchUpdate = vi.fn();
const mockBatchCommit = vi.fn();
const mockCount = vi.fn();
const mockOrderBy = vi.fn();
const mockStartAt = vi.fn();
const mockEndAt = vi.fn();
const mockStartAfter = vi.fn();
const mockFindNearest = vi.fn();

const mockQueryChain: Record<string, unknown> = {
  where: mockWhere,
  limit: mockLimit,
  select: mockSelect,
  get: mockGet,
  count: mockCount,
  orderBy: mockOrderBy,
  startAt: mockStartAt,
  endAt: mockEndAt,
  startAfter: mockStartAfter,
  findNearest: mockFindNearest,
};

const mockCollection = vi.fn(() => ({
  where: mockWhere,
  limit: mockLimit,
  select: mockSelect,
  doc: mockDoc,
  get: mockGet,
  add: mockAdd,
  orderBy: mockOrderBy,
}));

mockWhere.mockReturnValue(mockQueryChain);
mockLimit.mockReturnValue({ get: mockGet });
mockSelect.mockReturnValue({ get: mockGet, limit: mockLimit });
mockOrderBy.mockReturnValue(mockQueryChain);
mockStartAt.mockReturnValue(mockQueryChain);
mockEndAt.mockReturnValue(mockQueryChain);
mockStartAfter.mockReturnValue(mockQueryChain);
mockFindNearest.mockReturnValue({ get: mockGet });
mockCount.mockReturnValue({ get: vi.fn().mockResolvedValue({ data: () => ({ count: 5 }) }) });
mockDoc.mockReturnValue({
  get: mockGet,
  update: mockUpdate,
  set: vi.fn(),
});

vi.mock('../src/lib/firebase.js', () => ({
  getDb: () => ({
    collection: mockCollection,
    getAll: mockGetAll,
    batch: () => ({
      update: mockBatchUpdate,
      commit: mockBatchCommit,
    }),
  }),
  getAdminAuth: () => ({
    verifyIdToken: vi.fn().mockResolvedValue({
      uid: 'test-user-123',
      email: 'test@example.com',
      admin: false,
    }),
  }),
}));

// Mock Redis (disabled for tests)
vi.mock('../src/lib/redis.js', () => ({
  redis: null,
}));

// Mock FieldValue from firebase-admin/firestore
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    vector: (arr: number[]) => ({ _vectorValue: arr }),
    serverTimestamp: () => ({ _serverTimestamp: true }),
    arrayUnion: (...items: unknown[]) => ({ _arrayUnion: items }),
    arrayRemove: (...items: unknown[]) => ({ _arrayRemove: items }),
    increment: (n: number) => ({ _increment: n }),
    delete: () => ({ _delete: true }),
  },
}));

// Mock Voyage AI embedder
const mockEmbedQuery = vi.fn();
vi.mock('../src/services/voyage-embedder.js', () => ({
  embedQuery: (...args: unknown[]) => mockEmbedQuery(...args),
}));

// Mock keyword search service (cached version used by search route)
const mockKeywordSearchCached = vi.fn();
const mockKeywordSearch = vi.fn();
vi.mock('../src/services/keyword-search.js', () => ({
  keywordSearchCached: (...args: unknown[]) => mockKeywordSearchCached(...args),
  keywordSearch: (...args: unknown[]) => mockKeywordSearch(...args),
}));

// Mock creator-cache (imported by keyword-search)
vi.mock('../src/services/creator-cache.js', () => ({
  getCachedCreators: vi.fn().mockResolvedValue([]),
  filterCreators: vi.fn((creators: unknown[]) => creators),
  invalidateCache: vi.fn(),
}));

// findNearest mock default return value is set above with other chain mocks

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCreatorDoc(id: string, data: Record<string, unknown> = {}) {
  return {
    id,
    exists: true,
    data: () => ({
      name: `Creator ${id}`,
      slug: `creator-${id}`,
      categories: ['scholar'],
      region: 'americas',
      embedding: [0.1, 0.2, 0.3],
      is_published: true,
      ...data,
    }),
  };
}

function authHeaders() {
  return { Authorization: 'Bearer valid-test-token' };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok when Firestore is reachable', async () => {
    mockCollection.mockReturnValueOnce({
      doc: vi.fn().mockReturnValue({
        get: vi.fn().mockResolvedValue({ exists: true }),
      }),
    });

    const res = await app.request('/health');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.firestore).toBe('ok');
  });

  it('returns degraded when Firestore fails', async () => {
    mockCollection.mockReturnValueOnce({
      doc: vi.fn().mockReturnValue({
        get: vi.fn().mockRejectedValue(new Error('Connection refused')),
      }),
    });

    const res = await app.request('/health');
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.firestore).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

describe('GET /creators', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a list of creators', async () => {
    const docs = [makeCreatorDoc('a1'), makeCreatorDoc('b2')];
    mockGet.mockResolvedValueOnce({ docs });

    const res = await app.request('/creators');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.creators).toHaveLength(2);
    expect(body.creators[0].id).toBe('a1');
    // Embedding should be stripped
    expect(body.creators[0].embedding).toBeUndefined();
  });

  it('applies category filter', async () => {
    mockGet.mockResolvedValueOnce({ docs: [] });

    await app.request('/creators?category=scholar');

    expect(mockWhere).toHaveBeenCalledWith('categories', 'array-contains', 'scholar');
  });

  it('rejects invalid query params', async () => {
    const res = await app.request('/creators?limit=invalid');
    expect(res.status).toBe(400);
  });
});

describe('GET /creators/by-slug/:slug', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a creator by slug', async () => {
    const slugDocGet = vi.fn().mockResolvedValue({
      exists: true,
      data: () => ({ creatorId: 'abc123' }),
    });
    const creatorDocGet = vi.fn().mockResolvedValue(makeCreatorDoc('abc123'));

    mockCollection.mockImplementation((col: string) => {
      if (col === 'slugs') {
        return { doc: () => ({ get: slugDocGet }) };
      }
      return { doc: () => ({ get: creatorDocGet }) };
    });

    const res = await app.request('/creators/by-slug/ahmed-hasan');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.creator.id).toBe('abc123');
    expect(body.creator.embedding).toBeUndefined();
  });

  it('returns 404 for unknown slug', async () => {
    mockCollection.mockReturnValueOnce({
      doc: () => ({
        get: vi.fn().mockResolvedValue({ exists: false }),
      }),
    });

    const res = await app.request('/creators/by-slug/nonexistent-slug');
    expect(res.status).toBe(404);
  });

  it('rejects invalid slug format', async () => {
    const res = await app.request('/creators/by-slug/INVALID_SLUG!');
    expect(res.status).toBe(400);
  });
});

describe('POST /creators/by-ids', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns creators for valid IDs', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeCreatorDoc('a1'),
      makeCreatorDoc('b2'),
      { exists: false, id: 'c3', data: () => null },
    ]);

    const res = await app.request('/creators/by-ids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['a1', 'b2', 'c3'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.creators).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('rejects empty IDs array', async () => {
    const res = await app.request('/creators/by-ids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Creators — Cursor pagination
// ---------------------------------------------------------------------------

describe('GET /creators with cursor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock chain (overridden by by-slug's mockImplementation)
    mockCollection.mockImplementation(() => ({
      where: mockWhere,
      limit: mockLimit,
      select: mockSelect,
      doc: mockDoc,
      get: mockGet,
      add: mockAdd,
      orderBy: mockOrderBy,
    }));
  });

  it('returns nextCursor when more results exist', async () => {
    const docs = [makeCreatorDoc('a1'), makeCreatorDoc('b2'), makeCreatorDoc('c3')];
    // Order: cursor doc lookup first, then main query
    mockGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ name: 'A' }) })
      .mockResolvedValueOnce({ docs });

    const res = await app.request('/creators?limit=2&cursor=a0');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.creators).toHaveLength(2);
    expect(body.nextCursor).toBe('b2');
    expect(mockOrderBy).toHaveBeenCalledWith('name');
    expect(mockStartAfter).toHaveBeenCalled();
  });

  it('returns null nextCursor when no more results', async () => {
    const docs = [makeCreatorDoc('a1')];
    mockGet
      .mockResolvedValueOnce({ exists: true, data: () => ({ name: 'A' }) })
      .mockResolvedValueOnce({ docs });

    const res = await app.request('/creators?limit=2&cursor=a0');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.creators).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  it('filters by contentType post-query', async () => {
    const docs = [
      makeCreatorDoc('a1', { content: { youtube: ['vid1'] } }),
      makeCreatorDoc('b2', { content: { podcast: ['ep1'] } }),
      makeCreatorDoc('c3', { content: { youtube: ['vid2'] } }),
    ];
    mockGet.mockResolvedValueOnce({ docs });

    const res = await app.request('/creators?contentType=youtube');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.creators).toHaveLength(2);
    expect(body.creators[0].id).toBe('a1');
    expect(body.creators[1].id).toBe('c3');
  });
});

// ---------------------------------------------------------------------------
// Creators — Slugs
// ---------------------------------------------------------------------------

describe('GET /creators/slugs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection.mockImplementation(() => ({
      where: mockWhere,
      limit: mockLimit,
      select: mockSelect,
      doc: mockDoc,
      get: mockGet,
      add: mockAdd,
      orderBy: mockOrderBy,
    }));
  });

  it('returns slug IDs from the slugs collection', async () => {
    const docs = [
      { id: 'ahmed-hasan', exists: true, data: () => ({ creatorId: 'x1' }) },
      { id: 'sara-ali', exists: true, data: () => ({ creatorId: 'x2' }) },
    ];
    mockGet.mockResolvedValueOnce({ docs });

    const res = await app.request('/creators/slugs');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.slugs).toEqual(['ahmed-hasan', 'sara-ali']);
    expect(body.total).toBe(2);
    expect(mockCollection).toHaveBeenCalledWith('slugs');
  });

  it('respects limit parameter', async () => {
    mockGet.mockResolvedValueOnce({ docs: [] });

    await app.request('/creators/slugs?limit=5');
    expect(mockLimit).toHaveBeenCalledWith(5);
  });

  it('rejects invalid limit', async () => {
    const res = await app.request('/creators/slugs?limit=abc');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Creators — Search by name
// ---------------------------------------------------------------------------

describe('GET /creators/search-by-name', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection.mockImplementation(() => ({
      where: mockWhere,
      limit: mockLimit,
      select: mockSelect,
      doc: mockDoc,
      get: mockGet,
      add: mockAdd,
      orderBy: mockOrderBy,
    }));
  });

  it('returns matching creators by name prefix', async () => {
    const docs = [
      {
        id: 'x1',
        exists: true,
        data: () => ({
          name: 'Ahmed Hasan',
          slug: 'ahmed-hasan',
          avatar: 'https://img.example.com/ahmed.jpg',
          categories: ['scholar'],
          location: 'Cairo',
          is_published: true,
        }),
      },
    ];
    mockGet.mockResolvedValueOnce({ docs });

    const res = await app.request('/creators/search-by-name?q=ahmed');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].name).toBe('Ahmed Hasan');
    expect(body.results[0].slug).toBe('ahmed-hasan');
    expect(mockOrderBy).toHaveBeenCalledWith('name');
    expect(mockStartAt).toHaveBeenCalledWith('Ahmed');
  });

  it('excludes claimed creators (with ownerId)', async () => {
    const docs = [
      {
        id: 'x1',
        exists: true,
        data: () => ({
          name: 'Ahmed',
          slug: 'ahmed',
          categories: [],
          is_published: true,
        }),
      },
      {
        id: 'x2',
        exists: true,
        data: () => ({
          name: 'Ahmed K',
          slug: 'ahmed-k',
          categories: [],
          is_published: true,
          ownerId: 'user-123',
        }),
      },
    ];
    mockGet.mockResolvedValueOnce({ docs });

    const res = await app.request('/creators/search-by-name?q=ahmed');
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe('x1');
  });

  it('rejects query shorter than 2 characters', async () => {
    const res = await app.request('/creators/search-by-name?q=a');
    expect(res.status).toBe(400);
  });

  it('rejects missing query', async () => {
    const res = await app.request('/creators/search-by-name');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Users (authenticated)
// ---------------------------------------------------------------------------

describe('GET /users/me', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns user profile when authenticated', async () => {
    const userGet = vi.fn().mockResolvedValue({
      exists: true,
      data: () => ({ displayName: 'Test User', following: [] }),
    });

    mockCollection.mockImplementation((col: string) => {
      if (col === 'users') {
        return {
          doc: () => ({ get: userGet, update: vi.fn(), set: vi.fn() }),
          where: mockWhere,
        };
      }
      return { doc: mockDoc, where: mockWhere, limit: mockLimit, get: mockGet, add: mockAdd };
    });

    const res = await app.request('/users/me', {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.user.displayName).toBe('Test User');
  });

  it('returns 401 without auth header', async () => {
    const res = await app.request('/users/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /users/me/following', () => {
  beforeEach(() => vi.clearAllMocks());

  it('follows a creator with batch write', async () => {
    mockBatchCommit.mockResolvedValueOnce(undefined);

    const res = await app.request('/users/me/following', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorId: 'creator-1', action: 'follow' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.action).toBe('follow');
  });

  it('rejects invalid action', async () => {
    const res = await app.request('/users/me/following', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorId: 'creator-1', action: 'like' }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe('GET /search/similar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCollection.mockImplementation(() => ({
      where: mockWhere,
      limit: mockLimit,
      select: mockSelect,
      doc: mockDoc,
      get: mockGet,
      add: mockAdd,
      orderBy: mockOrderBy,
    }));
  });

  it('returns precomputed similar creators', async () => {
    const creatorDocGet = vi.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        precomputed_similar: [
          { id: 'x1', score: 0.95, slug: 'x-one', name: 'X One' },
          { id: 'x2', score: 0.88, slug: 'x-two', name: 'X Two' },
        ],
      }),
    });

    mockCollection.mockImplementation(() => ({
      doc: () => ({ get: creatorDocGet, update: vi.fn(), set: vi.fn() }),
      where: mockWhere,
      limit: mockLimit,
      get: mockGet,
      add: mockAdd,
    }));

    const res = await app.request('/search/similar?creatorId=abc123');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.precomputed).toBe(true);
    expect(body.results).toHaveLength(2);
  });

  it('uses live KNN when embedding exists but no precomputed data', async () => {
    const mockDocUpdate = vi.fn().mockResolvedValue(undefined);
    const creatorDocGet = vi.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        name: 'Source Creator',
        embedding: [0.1, 0.2, 0.3],
        categories: ['scholar'],
        is_published: true,
      }),
    });

    mockCollection.mockImplementation(() => ({
      doc: (id: string) => ({
        get: id ? creatorDocGet : mockGet,
        update: mockDocUpdate,
        set: vi.fn(),
      }),
      where: mockWhere,
      limit: mockLimit,
      get: mockGet,
      add: mockAdd,
      findNearest: mockFindNearest,
    }));

    // findNearest returns KNN results (is_published needed for post-filter)
    const knnDocs = [
      {
        id: 'abc123', // same as source — should be filtered out
        exists: true,
        data: () => ({ name: 'Source', slug: 'source', _distance: 0, is_published: true, embedding: [0.1] }),
      },
      {
        id: 'sim1',
        exists: true,
        data: () => ({ name: 'Similar One', slug: 'sim-one', _distance: 0.15, is_published: true, embedding: [0.2], categories: ['scholar'] }),
      },
      {
        id: 'sim2',
        exists: true,
        data: () => ({ name: 'Similar Two', slug: 'sim-two', _distance: 0.25, is_published: true, embedding: [0.3], categories: ['educator'] }),
      },
    ];
    mockGet.mockResolvedValueOnce({ docs: knnDocs });

    const res = await app.request('/search/similar?creatorId=abc123');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.fallback).toBe(false);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].id).toBe('sim1');
    expect(body.results[0].similarity).toBeCloseTo(0.85, 2);
    expect(body.results[0].name).toBe('Similar One');
    expect(body.results[0].categories).toEqual(['scholar']);
    expect(body.results[0].embedding).toBeUndefined();
    expect(body.results[0]._distance).toBeUndefined();
    expect(body.results[1].id).toBe('sim2');
    expect(mockFindNearest).toHaveBeenCalled();
  });

  it('falls back to category matching when no embedding', async () => {
    const creatorDocGet = vi.fn().mockResolvedValue({
      exists: true,
      data: () => ({
        name: 'No Embed',
        categories: ['scholar'],
        is_published: true,
        // No embedding field
      }),
    });

    mockCollection.mockImplementation(() => ({
      doc: () => ({ get: creatorDocGet, update: vi.fn(), set: vi.fn() }),
      where: mockWhere,
      limit: mockLimit,
      get: mockGet,
      add: mockAdd,
    }));

    const catDocs = [
      makeCreatorDoc('cat1'),
      makeCreatorDoc('cat2'),
    ];
    mockGet.mockResolvedValueOnce({ docs: catDocs });

    const res = await app.request('/search/similar?creatorId=abc123');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.fallback).toBe(true);
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(mockFindNearest).not.toHaveBeenCalled();
  });

  it('returns 400 without creatorId', async () => {
    const res = await app.request('/search/similar');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /search — Hybrid search
// ---------------------------------------------------------------------------

describe('POST /search', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-establish mock chain after clearAllMocks (previous test groups
    // may have overridden mockCollection with different shapes).
    mockWhere.mockReturnValue(mockQueryChain);
    mockLimit.mockReturnValue({ get: mockGet });
    mockSelect.mockReturnValue({ get: mockGet, limit: mockLimit });
    mockOrderBy.mockReturnValue(mockQueryChain);
    mockStartAt.mockReturnValue(mockQueryChain);
    mockEndAt.mockReturnValue(mockQueryChain);
    mockStartAfter.mockReturnValue(mockQueryChain);
    mockFindNearest.mockReturnValue({ get: mockGet });
    mockDoc.mockReturnValue({ get: mockGet, update: mockUpdate, set: vi.fn() });

    mockCollection.mockImplementation(() => ({
      where: mockWhere,
      limit: mockLimit,
      select: mockSelect,
      doc: mockDoc,
      get: mockGet,
      add: mockAdd,
      orderBy: mockOrderBy,
      findNearest: mockFindNearest,
    }));
  });

  it('performs keyword-only search', async () => {
    mockKeywordSearchCached.mockResolvedValueOnce([
      { id: 'k1', score: 0.9, creator: { id: 'k1', name: 'Islamic Scholar', slug: 'islamic-scholar', categories: ['scholar'], topics: ['islam'] } },
    ]);

    const res = await app.request('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'islamic', mode: 'keyword', limit: 10 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe('k1');
    expect(body.results[0].combinedScore).toBe(0.9);
    expect(body.meta.mode).toBe('keyword');
    expect(mockEmbedQuery).not.toHaveBeenCalled();
    expect(mockKeywordSearchCached).toHaveBeenCalled();
  });

  it('performs semantic-only search using findNearest', async () => {
    mockEmbedQuery.mockResolvedValueOnce([0.5, 0.6, 0.7]);

    const knnDocs = [
      {
        id: 's1',
        exists: true,
        data: () => ({
          name: 'Semantic Match',
          slug: 'semantic-match',
          _distance: 0.2,
          embedding: [0.1, 0.2],
          is_published: true,
        }),
      },
    ];
    mockGet.mockResolvedValueOnce({ docs: knnDocs });

    const res = await app.request('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'islamic history', mode: 'semantic', limit: 10 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe('s1');
    expect(body.results[0].semanticScore).toBeCloseTo(0.8, 2);
    expect(body.results[0].creator.embedding).toBeUndefined();
    expect(body.meta.mode).toBe('semantic');
    expect(mockEmbedQuery).toHaveBeenCalledWith('islamic history');
    expect(mockFindNearest).toHaveBeenCalled();
  });

  it('performs hybrid search merging semantic + keyword', async () => {
    // Semantic results
    mockEmbedQuery.mockResolvedValueOnce([0.5, 0.6, 0.7]);
    const knnDocs = [
      {
        id: 'h1',
        exists: true,
        data: () => ({
          name: 'Both Match',
          slug: 'both',
          _distance: 0.1,
          embedding: [0.1],
          is_published: true,
        }),
      },
      {
        id: 'h2',
        exists: true,
        data: () => ({
          name: 'Semantic Only',
          slug: 'sem-only',
          _distance: 0.3,
          embedding: [0.2],
          is_published: true,
        }),
      },
    ];
    mockGet.mockResolvedValueOnce({ docs: knnDocs }); // findNearest result

    mockKeywordSearchCached.mockResolvedValueOnce([
      { id: 'h1', score: 0.8, creator: { id: 'h1', name: 'Both Match', slug: 'both', categories: ['scholar'], topics: [] } },
      { id: 'h3', score: 0.6, creator: { id: 'h3', name: 'Keyword Only', slug: 'kw-only', categories: ['scholar'], topics: [] } },
    ]);

    const res = await app.request('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'scholar',
        mode: 'hybrid',
        limit: 10,
        semanticWeight: 0.7,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // h1 should be first (appears in both semantic and keyword)
    expect(body.results[0].id).toBe('h1');
    expect(body.results[0].semanticScore).toBeGreaterThan(0);
    expect(body.results[0].keywordScore).toBeGreaterThan(0);
    // h2 and h3 should also be present
    const ids = body.results.map((r: { id: string }) => r.id);
    expect(ids).toContain('h2');
    expect(ids).toContain('h3');
  });

  it('falls back to keyword-only when semantic fails in hybrid mode', async () => {
    mockEmbedQuery.mockRejectedValueOnce(new Error('Voyage API down'));

    mockKeywordSearchCached.mockResolvedValueOnce([
      { id: 'f1', score: 0.7, creator: { id: 'f1', name: 'Fallback', slug: 'fallback', categories: [], topics: [] } },
    ]);

    const res = await app.request('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'fallback test', mode: 'hybrid', limit: 5 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].id).toBe('f1');
  });

  it('rejects query shorter than 2 characters', async () => {
    const res = await app.request('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'a' }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Public writes
// ---------------------------------------------------------------------------

describe('POST /waitlist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds email to waitlist', async () => {
    const waitlistGet = vi.fn().mockResolvedValue({ empty: true });
    const waitlistAdd = vi.fn().mockResolvedValue({ id: 'wl-1' });

    mockCollection.mockImplementation(() => ({
      where: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnValue({ get: waitlistGet }),
        get: waitlistGet,
      }),
      doc: mockDoc,
      limit: mockLimit,
      get: waitlistGet,
      add: waitlistAdd,
    }));

    const res = await app.request('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 200 for duplicate email', async () => {
    const waitlistGet = vi.fn().mockResolvedValue({ empty: false });

    mockCollection.mockImplementation(() => ({
      where: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnValue({ get: waitlistGet }),
        get: waitlistGet,
      }),
      doc: mockDoc,
      limit: mockLimit,
      get: waitlistGet,
      add: mockAdd,
    }));

    const res = await app.request('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'existing@example.com' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('Already on waitlist');
  });
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

describe('Not Found', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await app.request('/nonexistent-path');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Not found');
  });
});
