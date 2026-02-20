/**
 * Vercel serverless entry point.
 *
 * Uses @hono/node-server/vercel to bridge Vercel's Node.js runtime
 * with Hono's fetch-based request handling.  The node-server adapter
 * converts IncomingMessage → Web API Request which Hono expects.
 */
import { handle } from '@hono/node-server/vercel';
import app from '../src/app.js';

export default handle(app);
