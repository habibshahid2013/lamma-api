import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { onError } from './middleware/error-handler.js';
import { creatorsRouter } from './routes/creators.js';
import { searchRouter } from './routes/search.js';
import { usersRouter } from './routes/users.js';
import { healthRouter } from './routes/health.js';
import { publicRouter } from './routes/public.js';
import type { AppEnv } from './types/env.js';

const VERCEL_ORIGIN_RE = /^https:\/\/.*\.vercel\.app$/;

/**
 * Lamma+ Central API
 *
 * Single REST surface for all non-SSR/SSG traffic.
 * All Firestore access is server-side via Admin SDK.
 */
const app = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------
app.use('*', logger());
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = [
        'https://lammaplus.app',
        'https://www.lammaplus.app',
        'https://admin.lamma.app',
        'https://community.lamma.app',
        'http://localhost:3000',
      ];
      if (allowed.includes(origin)) return origin;
      if (VERCEL_ORIGIN_RE.test(origin)) return origin;
      return '';
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

// ---------------------------------------------------------------------------
// Route modules
// ---------------------------------------------------------------------------
app.route('/health', healthRouter);
app.route('/creators', creatorsRouter);
app.route('/search', searchRouter);
app.route('/users', usersRouter);
app.route('/', publicRouter);

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.onError(onError);

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
