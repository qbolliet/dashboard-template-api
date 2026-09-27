// Ré-exportation centralisée de tous les modules du dossier security
import { SecurityManager, initializeSecurityManager, getSecurityManager } from './manager.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryComplexityAnalyzer } from './complexity-analyzer.js';
import { PatternValidator } from './pattern-validator.js';
import { createRateLimitMiddleware } from './rate-limit-middleware.js';
import { createDepthLimitRule, createSimpleDepthLimitRule } from './depth-limit.js';
import { requireAdminKey } from './admin-auth.js';
import { parseTrustedProxies, configuredTrustProxy } from './trusted-proxies.js';

export {
  parseTrustedProxies,
  configuredTrustProxy,
  SecurityManager,
  initializeSecurityManager,
  getSecurityManager,
  RateLimiter,
  QueryComplexityAnalyzer,
  PatternValidator,
  createRateLimitMiddleware,
  createDepthLimitRule,
  createSimpleDepthLimitRule,
  requireAdminKey,
};
