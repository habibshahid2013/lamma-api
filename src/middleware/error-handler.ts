import type { Context } from 'hono';

/**
 * Global error handler for Hono app.
 */
export function onError(err: Error, c: Context) {
  console.error(`[lamma-api] ${c.req.method} ${c.req.path}:`, err);

  const status = 'status' in err && typeof err.status === 'number' ? err.status : 500;

  return c.json(
    {
      error: status >= 500 ? 'Internal server error' : err.message,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    },
    status as 500,
  );
}
