import type { Context, Next } from 'hono';
import { getAdminAuth } from '../lib/firebase.js';
import type { AppEnv } from '../types/env.js';

/**
 * Firebase Auth middleware.
 *
 * Verifies the Bearer token from the Authorization header.
 * Sets `c.set('userId', uid)` and `c.set('isAdmin', boolean)` on success.
 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    c.set('userId', decoded.uid);
    c.set('userEmail', decoded.email ?? '');
    c.set('isAdmin', decoded.admin === true);
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
}

/**
 * Admin-only middleware. Must come after requireAuth.
 */
export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Admin access required' }, 403);
  }
  await next();
}
