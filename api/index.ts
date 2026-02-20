/**
 * Vercel serverless entry point.
 *
 * Uses @hono/node-server/vercel with a rawBody shim.  Vercel pre-parses
 * request bodies and exposes rawBody as a *string*, but the Hono adapter
 * expects rawBody to be a Buffer.  Without this shim, POST requests with
 * Content-Type headers hang because the adapter tries to read from an
 * already-consumed IncomingMessage stream.
 */
import { handle } from '@hono/node-server/vercel';
import type { IncomingMessage, ServerResponse } from 'node:http';
import app from '../src/app.js';

const honoHandler = handle(app);

export default function handler(
  req: IncomingMessage & { rawBody?: string | Buffer; body?: unknown },
  res: ServerResponse,
) {
  // Convert Vercel's string rawBody → Buffer so the adapter recognises it.
  if (typeof req.rawBody === 'string') {
    (req as any).rawBody = Buffer.from(req.rawBody);
  } else if (req.body !== undefined && req.body !== null && !req.rawBody) {
    // Fallback: re-serialise the parsed body as a Buffer
    (req as any).rawBody = Buffer.from(
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    );
  }
  return honoHandler(req, res);
}
