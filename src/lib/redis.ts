import { Redis } from '@upstash/redis';

/**
 * Upstash Redis singleton.
 * Returns null when credentials are not configured.
 */
function createRedisClient(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export const redis = createRedisClient();
