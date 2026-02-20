# Lamma+ Central API (`lamma-api`)

Central REST API for the Lamma+ platform. Provides a single server-side surface between consumer applications and Firebase Firestore, replacing direct client SDK calls with authenticated, rate-limited, cached endpoints.

**Production URL:** `https://lamma-api-ten.vercel.app`

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | [Hono](https://hono.dev/) v4 (14KB, portable) |
| Runtime | Node.js on Vercel Serverless Functions |
| Database | Firebase Admin SDK (`preferRest: true` for reduced cold starts) |
| Auth | Firebase Auth token verification (Bearer tokens) |
| Rate Limiting | Upstash Redis sliding window |
| Validation | Zod schemas on all inputs |
| Tests | Vitest (19 integration tests) |

---

## API Endpoints

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | Public | Liveness + Firestore connectivity check |

### Creators

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/creators` | Public | List creators with optional filters |
| GET | `/creators/by-slug/:slug` | Public | Single creator by slug |
| POST | `/creators/by-ids` | Public | Batch fetch by IDs (max 50) |
| GET | `/creators/counts` | Public | Creator counts per category |

**Query parameters for `GET /creators`:**

| Param | Type | Description |
|-------|------|-------------|
| `category` | string | Filter by category (array-contains) |
| `region` | string | Filter by region |
| `language` | string | Filter by language (array-contains) |
| `gender` | string | Filter by gender |
| `featured` | boolean | Featured creators only |
| `trending` | boolean | Trending creators only |
| `isHistorical` | boolean | Historical figures only |
| `showDrafts` | boolean | Include unpublished creators |
| `limit` | number | Max results (default 50) |

### Search

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/search` | Public | Keyword/hybrid search with filters |
| GET | `/search/similar` | Public | Precomputed similar creators by ID |

### Users (Authenticated)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/users/me` | Bearer | Read user profile |
| PUT | `/users/me` | Bearer | Create user profile (signup) |
| PATCH | `/users/me` | Bearer | Update user profile |
| POST | `/users/me/following` | Bearer | Follow/unfollow a creator |
| POST | `/users/me/saved` | Bearer | Save/unsave a creator |

### Public

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/waitlist` | Public | Premium waitlist signup |
| POST | `/claim-requests` | Bearer | Submit profile claim request |

---

## Middleware

- **CORS** — Allows `lammaplus.app`, `admin.lamma.app`, `community.lamma.app`, `localhost:3000`, and `*.vercel.app`
- **Rate Limiting** — Upstash Redis sliding window: 60 req/min (public), 30 req/min (search). Skipped when Redis is not configured (dev mode)
- **Secure Headers** — Hono secure-headers middleware
- **Auth** — Firebase Admin `verifyIdToken` on protected routes. Sets `userId` and `isAdmin` on Hono context
- **Logger** — Request/response logging

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Yes | Service account email |
| `FIREBASE_PRIVATE_KEY` | Yes | Service account private key (with `\n` escapes) |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis URL (rate limiting disabled without it) |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis token |
| `PORT` | No | Local dev port (default 8080) |
| `API_VERSION` | No | Version string for health endpoint |

---

## Local Development

```bash
# Install dependencies
npm install

# Start dev server (auto-reload via tsx)
npm run dev
# → http://localhost:8080

# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

Create a `.env` file with at minimum the Firebase credentials:

```env
FIREBASE_PROJECT_ID="your-project-id"
FIREBASE_CLIENT_EMAIL="your-service-account@appspot.gserviceaccount.com"
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

---

## Deployment

### Vercel (Production)

The API deploys as a single Vercel Serverless Function via `api/index.ts`, which uses the `@hono/node-server/vercel` adapter to bridge Node.js runtime with Hono's fetch-based handling.

```bash
vercel --prod
```

**Important:** The Node.js adapter (`@hono/node-server/vercel`) is required — not `hono/vercel` — because Firebase Admin SDK needs Node.js APIs that are unavailable in Edge Runtime.

All traffic is rewritten to `/api` via `vercel.json`:

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }],
  "functions": { "api/index.ts": { "maxDuration": 30 } }
}
```

### Local / Cloud Run

The entry point (`src/index.ts`) auto-detects the environment:
- **Vercel:** Exports the Hono app (handled by the adapter in `api/index.ts`)
- **Local/Cloud Run:** Starts an HTTP server on `PORT` (default 8080)

---

## How lamma-app Consumes This API

The Next.js consumer app (`lamma-app`) calls the Central API through a typed client at `lib/api-clients/central-api.ts`. The base URL is set via the `LAMMA_CENTRAL_API_URL` environment variable (server-side only).

**Data flow:**

```
Browser → Next.js API Route → Central API → Firestore
                 ↓
         Redis cache layer
                 ↓
         Static fallback (if API unreachable)
```

**Routes wired to Central API:**
- `GET /api/data/creators` → `listCreators()`
- `GET /api/data/creators/by-slug/[slug]` → `getCreatorBySlug()`
- `POST /api/data/creators/by-ids` → `getCreatorsByIds()`
- `GET /api/data/creators/counts` → `getCreatorCounts()`
- SSR fetchers in `lib/server/creators.ts`

**Routes still on direct Firestore (features not yet in Central API):**
- Cursor-based pagination (`/api/creators`)
- Semantic search (`/api/search/semantic`)
- Similar search (`/api/search/similar`)
- Name prefix search (`/api/data/creators/search-by-name`)
- `getTopCreatorSlugs` (queries `slugs` collection)

---

## Project Structure

```
lamma-api/
├── api/
│   └── index.ts              # Vercel serverless entry point
├── src/
│   ├── app.ts                # Hono app (routes, middleware, CORS)
│   ├── index.ts              # Dual entry (Vercel export + local server)
│   ├── types/
│   │   └── env.ts            # Typed Hono context (AppEnv)
│   ├── lib/
│   │   ├── firebase.ts       # Firebase Admin SDK singleton
│   │   └── redis.ts          # Upstash Redis client
│   ├── middleware/
│   │   ├── auth.ts           # Firebase Auth verification
│   │   ├── rate-limit.ts     # Upstash sliding window
│   │   └── error-handler.ts  # Global error handler
│   ├── routes/
│   │   ├── health.ts         # GET /health
│   │   ├── creators.ts       # Creator CRUD endpoints
│   │   ├── search.ts         # Search + similar
│   │   ├── users.ts          # User profile + follow/save
│   │   └── public.ts         # Waitlist + claim requests
│   └── schemas/
│       ├── creator.ts        # Zod: list query, slug param, by-ids body
│       ├── search.ts         # Zod: semantic search body, similar query
│       ├── user.ts           # Zod: user create/patch, follow, saved
│       └── public.ts         # Zod: waitlist, claim request
├── tests/
│   └── routes.test.ts        # 19 integration tests
├── vercel.json               # Deployment config
├── tsconfig.json
├── package.json
└── vitest.config.ts
```
