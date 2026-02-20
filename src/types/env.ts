/**
 * Hono environment bindings.
 *
 * Defines context variables set by middleware (auth, rate-limit, etc.)
 * so that `c.get('userId')` is type-safe across all routes.
 */
export type AppEnv = {
  Variables: {
    userId: string;
    userEmail: string;
    isAdmin: boolean;
  };
};
