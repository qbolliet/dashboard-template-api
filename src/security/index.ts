// Ré-exportation centralisée de tous les modules du dossier security
import { SecurityManager, initializeSecurityManager } from './manager.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryComplexityAnalyzer } from './complexity-analyzer.js';
import { createRateLimitMiddleware } from './rate-limit-middleware.js';
import { createDepthLimitRule } from './depth-limit.js';
import { requireAdminKey } from './admin-auth.js';
import { parseTrustedProxies, configuredTrustProxy } from './trusted-proxies.js';
import { parseCorsOrigins, createCorsMiddleware } from './cors.js';

export {
  parseTrustedProxies,
  configuredTrustProxy,
  parseCorsOrigins,
  createCorsMiddleware,
  SecurityManager,
  initializeSecurityManager,
  RateLimiter,
  QueryComplexityAnalyzer,
  createRateLimitMiddleware,
  createDepthLimitRule,
  requireAdminKey,
};
