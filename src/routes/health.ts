import { Hono } from 'hono';
import { getDb } from '../lib/firebase.js';
import type { AppEnv } from '../types/env.js';

export const healthRouter = new Hono<AppEnv>();

/**
 * GET /health
 *
 * Liveness + readiness check. Verifies Firestore connectivity.
 */
healthRouter.get('/', async (c) => {
  const checks: Record<string, string> = {};

  // Firestore connectivity
  try {
    const db = getDb();
    await db.collection('_health').doc('ping').get();
    checks.firestore = 'ok';
  } catch {
    checks.firestore = 'error';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');

  return c.json(
    {
      status: allOk ? 'ok' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
      version: process.env.API_VERSION || '0.1.0',
    },
    allOk ? 200 : 503,
  );
});
