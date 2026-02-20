/**
 * Vercel serverless entry point.
 *
 * Uses hono/vercel handle() to bridge Vercel's Edge/Node runtime
 * with Hono's fetch-based request handling.
 */
import { handle } from '@hono/node-server/vercel';
import app from '../src/app.js';

export default handle(app);
