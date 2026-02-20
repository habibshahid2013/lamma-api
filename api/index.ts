/**
 * Vercel serverless entry point.
 *
 * Vercel expects a default export from `api/index.ts` when using
 * the Hono adapter. All routes are handled by the Hono app instance.
 */
import { handle } from 'hono/vercel';
import app from '../src/app.js';

export default handle(app);
