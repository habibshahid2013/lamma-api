import type { Context, Next } from 'hono';
import { Ratelimit } from '@upstash/ratelimit';
import { redis } from '../lib/redis.js';
import type { AppEnv } from '../types/env.js';

/**
 * Rate limiting middleware using Upstash sliding window.
 *
 * Skips rate limiting when Redis is not configured (dev mode).
 * Uses client IP as the identifier for public routes,
 * userId for authenticated routes.
 */

const publicLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, '60 s'),
      prefix: 'rl:public',
    })
  : null;

const searchLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(30, '60 s'),
      prefix: 'rl:search',
    })
  : null;

function getClientIp(c: Context<AppEnv>): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  );
}

export async function rateLimitPublic(c: Context<AppEnv>, next: Next) {
  if (!publicLimiter) return next();

  const identifier = getClientIp(c);
  const { success } = await publicLimiter.limit(identifier);
  if (!success) {
    return c.json({ error: 'Rate limit exceeded' }, 429);
  }
  await next();
}

export async function rateLimitSearch(c: Context<AppEnv>, next: Next) {
  if (!searchLimiter) return next();

  const identifier = c.get('userId') || getClientIp(c);
  const { success } = await searchLimiter.limit(identifier);
  if (!success) {
    return c.json({ error: 'Search rate limit exceeded' }, 429);
  }
  await next();
}
