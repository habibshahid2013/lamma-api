/**
 * Entry point for the Central API.
 *
 * Vercel: `export default app` (handled by hono adapter)
 * Cloud Run: `serve({ fetch: app.fetch, port })`
 *
 * This file auto-detects the environment.
 */
import app from './app.js';

const isVercel = !!process.env.VERCEL;

if (!isVercel) {
  // Local dev or Cloud Run
  const { serve } = await import('@hono/node-server');
  const port = parseInt(process.env.PORT ?? '8080', 10);
  serve({ fetch: app.fetch, port });
  console.log(`[lamma-api] Listening on http://localhost:${port}`);
}

// Vercel serverless
export default app;
