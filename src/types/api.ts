/**
 * Central API response types.
 *
 * These types describe the shape of JSON responses returned by the API.
 * The lamma-app client (lib/api-clients/central-api.ts) has corresponding
 * interfaces that must stay in sync with these definitions.
 *
 * Creator data is returned as Firestore documents with the `embedding`
 * field stripped. The full Creator type lives in lamma-app at
 * lib/types/creator.ts — this file only defines the API envelope types.
 */

// ---------------------------------------------------------------------------
// Creator responses
// ---------------------------------------------------------------------------

export interface CreatorsListResponse {
  creators: Record<string, unknown>[];
  total: number;
  nextCursor: string | null;
}

export interface CreatorResponse {
  creator: Record<string, unknown>;
}

export interface CreatorsByIdsResponse {
  creators: Record<string, unknown>[];
  total: number;
}

export interface CreatorCountsResponse {
  counts: Record<string, number>;
}

export interface SlugsResponse {
  slugs: string[];
  total: number;
}

export interface SearchByNameResult {
  id: string;
  name: string;
  slug: string;
  avatar: string;
  categories: string[];
  location: string;
}

export interface SearchByNameResponse {
  results: SearchByNameResult[];
  total: number;
}

// ---------------------------------------------------------------------------
// Search responses
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: string;
  name: unknown;
  slug: unknown;
  semanticScore: number;
  keywordScore: number;
  combinedScore: number;
  creator?: Record<string, unknown>;
}

export interface SearchResponse {
  results: SearchResult[];
  meta: {
    query: string;
    mode: string;
    resultCount: number;
    timestamp: string;
  };
}

export interface SimilarResult {
  id: string;
  name: string;
  slug: string;
  similarity: number;
  distance?: number;
  [key: string]: unknown;
}

export interface SimilarResponse {
  results: SimilarResult[];
  fallback: boolean;
  precomputed?: boolean;
}

// ---------------------------------------------------------------------------
// User responses
// ---------------------------------------------------------------------------

export interface ApiUserData {
  userId: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  role: 'user' | 'creator' | 'admin';
  creatorProfileId: string | null;
  subscription: {
    plan: 'free' | 'premium';
    status: string;
  };
  following: string[];
  followingCount: number;
  saved: string[];
  preferences?: {
    languages?: string[];
    regions?: string[];
    topics?: string[];
    theme?: 'light' | 'dark' | 'system';
  };
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UserResponse {
  user: ApiUserData;
  created?: boolean;
}

// ---------------------------------------------------------------------------
// Public write responses
// ---------------------------------------------------------------------------

export interface WaitlistResponse {
  success: boolean;
  message: string;
}

export interface ClaimRequestResponse {
  success: boolean;
  message: string;
}
