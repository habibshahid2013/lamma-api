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

const mockQueryChain = {
  where: mockWhere,
  limit: mockLimit,
  get: mockGet,
  count: mockCount,
  orderBy: mockOrderBy,
  startAt: mockStartAt,
  endAt: mockEndAt,
  startAfter: mockStartAfter,
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
mockSelect.mockReturnValue({ get: mockGet });
mockOrderBy.mockReturnValue(mockQueryChain);
mockStartAt.mockReturnValue(mockQueryChain);
mockEndAt.mockReturnValue(mockQueryChain);
mockStartAfter.mockReturnValue(mockQueryChain);
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
  beforeEach(() => vi.clearAllMocks());

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

  it('returns 400 without creatorId', async () => {
    const res = await app.request('/search/similar');
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
