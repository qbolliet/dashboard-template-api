// Ré-exportation centralisée de tous les modules du dossier security
import { SecurityManager, initializeSecurityManager, getSecurityManager } from './manager.js';
import { RateLimiter } from './rate-limiter.js';
import { QueryComplexityAnalyzer } from './complexity-analyzer.js';
import { InputSanitizer } from './input-sanitizer.js';
import { PatternValidator } from './pattern-validator.js';
import { createDepthLimitRule, createSimpleDepthLimitRule } from './depth-limit.js';
import { requireAdminKey } from './admin-auth.js';

export {
  SecurityManager,
  initializeSecurityManager,
  getSecurityManager,
  RateLimiter,
  QueryComplexityAnalyzer,
  InputSanitizer,
  PatternValidator,
  createDepthLimitRule,
  createSimpleDepthLimitRule,
  requireAdminKey,
};
