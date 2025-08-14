// Unit tests for security framework components
import { jest } from '@jest/globals';
import { 
  SecurityManager, 
  RateLimiter, 
  QueryComplexityAnalyzer, 
  InputSanitizer, 
  PatternValidator 
} from '../src/security/index.js';
import { GraphQLError } from 'graphql';

// Mock dependencies
jest.mock('../src/utils/config-loader.js', () => ({
  config: {
    SECURITY: {
      RATE_LIMIT: {
        ENABLED: true,
        MAX_REQUESTS: 100,
        TIME_WINDOW: 60000,
        BURST_LIMIT: 20,
        SKIP_PATTERNS: ['__schema', '__type']
      },
      COMPLEXITY: {
        MAX_COMPLEXITY: 1000,
        MAX_DEPTH: 15,
        INTROSPECTION_COST: 1000,
        DEPTH_FACTOR: 2
      },
      SANITIZATION: {
        ENABLED: true,
        XSS_PROTECTION: true,
        SQL_INJECTION_PROTECTION: true,
        MAX_STRING_LENGTH: 10000
      }
    }
  }
}));

jest.mock('../src/utils/logger.js', () => ({
  createContextLogger: () => ({
    security: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn()
  })
}));

describe('SecurityManager', () => {
  let securityManager;
  let mockContext;
  let mockInfo;

  beforeEach(() => {
    jest.clearAllMocks();
    securityManager = new SecurityManager();
    
    mockContext = {
      requestId: 'test-request-id',
      req: {
        ip: '127.0.0.1',
        headers: { 'user-agent': 'test-agent' }
      }
    };

    mockInfo = {
      fieldName: 'testField',
      operation: {
        selectionSet: {
          selections: [
            { name: { value: 'testField' } }
          ]
        }
      }
    };
  });

  describe('Constructor', () => {
    test('should initialize with default configuration', () => {
      expect(securityManager.config).toBeDefined();
      expect(securityManager.rateLimiter).toBeInstanceOf(RateLimiter);
      expect(securityManager.complexityAnalyzer).toBeInstanceOf(QueryComplexityAnalyzer);
      expect(securityManager.inputSanitizer).toBeInstanceOf(InputSanitizer);
      expect(securityManager.patternValidator).toBeInstanceOf(PatternValidator);
    });

    test('should initialize with custom configuration', () => {
      const customConfig = {
        RATE_LIMIT: { ENABLED: false },
        COMPLEXITY: { MAX_COMPLEXITY: 500 },
        SANITIZATION: { ENABLED: false }
      };

      const customManager = new SecurityManager(customConfig);
      expect(customManager.config).toEqual(customConfig);
    });
  });

  describe('createSecurityMiddleware', () => {
    test('should create middleware function', () => {
      const middleware = securityManager.createSecurityMiddleware();
      expect(typeof middleware).toBe('function');
    });

    test('should execute security checks in correct order', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      const mockResolve = jest.fn().mockResolvedValue('test-result');

      // Mock security components
      securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue(true);
      securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(100);
      securityManager.inputSanitizer.sanitizeAll = jest.fn().mockReturnValue({});
      securityManager.patternValidator.validateQuery = jest.fn().mockReturnValue(true);

      const result = await middleware(mockResolve, null, {}, mockContext, mockInfo);

      expect(securityManager.rateLimiter.checkLimit).toHaveBeenCalled();
      expect(securityManager.complexityAnalyzer.calculate).toHaveBeenCalled();
      expect(securityManager.inputSanitizer.sanitizeAll).toHaveBeenCalled();
      expect(securityManager.patternValidator.validateQuery).toHaveBeenCalled();
      expect(mockResolve).toHaveBeenCalled();
      expect(result).toBe('test-result');
    });

    test('should handle rate limit exceeded', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      const mockResolve = jest.fn();

      securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue(false);

      await expect(
        middleware(mockResolve, null, {}, mockContext, mockInfo)
      ).rejects.toThrow(GraphQLError);
    });

    test('should handle complexity limit exceeded', async () => {
      const middleware = securityManager.createSecurityMiddleware();
      const mockResolve = jest.fn();

      securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue(true);
      securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(2000);

      await expect(
        middleware(mockResolve, null, {}, mockContext, mockInfo)
      ).rejects.toThrow(GraphQLError);
    });
  });
});

describe('RateLimiter', () => {
  let rateLimiter;
  let mockReq;

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimiter = new RateLimiter({
      ENABLED: true,
      MAX_REQUESTS: 10,
      TIME_WINDOW: 60000,
      BURST_LIMIT: 5
    });

    mockReq = {
      ip: '192.168.1.1',
      headers: { 'user-agent': 'test-browser' }
    };
  });

  describe('checkLimit', () => {
    test('should allow requests within limit', async () => {
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result).toBe(true);
    });

    test('should generate consistent keys for same client', () => {
      const key1 = rateLimiter.defaultKeyGenerator(mockReq);
      const key2 = rateLimiter.defaultKeyGenerator(mockReq);
      expect(key1).toBe(key2);
    });

    test('should generate different keys for different IPs', () => {
      const req1 = { ip: '192.168.1.1', headers: { 'user-agent': 'browser' } };
      const req2 = { ip: '192.168.1.2', headers: { 'user-agent': 'browser' } };
      
      const key1 = rateLimiter.defaultKeyGenerator(req1);
      const key2 = rateLimiter.defaultKeyGenerator(req2);
      expect(key1).not.toBe(key2);
    });

    test('should handle missing IP gracefully', () => {
      const reqWithoutIP = { headers: { 'user-agent': 'test-browser' } };
      const key = rateLimiter.defaultKeyGenerator(reqWithoutIP);
      expect(key).toContain('unknown');
    });

    test('should track request count correctly', async () => {
      // Make multiple requests
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit(mockReq);
      }

      // Check that requests are being tracked
      const key = rateLimiter.defaultKeyGenerator(mockReq);
      expect(rateLimiter.clients.has(key)).toBe(true);
    });
  });

  describe('cleanup', () => {
    test('should remove expired entries', () => {
      const key = 'test-key';
      rateLimiter.clients.set(key, {
        count: 1,
        resetTime: Date.now() - 1000 // Expired
      });

      rateLimiter.cleanup();
      expect(rateLimiter.clients.has(key)).toBe(false);
    });

    test('should keep valid entries', () => {
      const key = 'test-key';
      rateLimiter.clients.set(key, {
        count: 1,
        resetTime: Date.now() + 60000 // Valid
      });

      rateLimiter.cleanup();
      expect(rateLimiter.clients.has(key)).toBe(true);
    });
  });
});

describe('QueryComplexityAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new QueryComplexityAnalyzer({
      MAX_COMPLEXITY: 1000,
      MAX_DEPTH: 10,
      INTROSPECTION_COST: 100,
      DEPTH_FACTOR: 2
    });
  });

  describe('calculate', () => {
    test('should calculate complexity for simple query', () => {
      const mockInfo = {
        operation: {
          selectionSet: {
            selections: [
              {
                name: { value: 'simpleField' },
                selectionSet: null
              }
            ]
          }
        }
      };

      const complexity = analyzer.calculate(mockInfo, {});
      expect(complexity).toBeGreaterThan(0);
      expect(complexity).toBeLessThan(100);
    });

    test('should handle introspection queries', () => {
      const mockInfo = {
        operation: {
          selectionSet: {
            selections: [
              {
                name: { value: '__schema' },
                selectionSet: {
                  selections: [
                    { name: { value: 'types' } }
                  ]
                }
              }
            ]
          }
        }
      };

      const complexity = analyzer.calculate(mockInfo, {});
      expect(complexity).toBeGreaterThanOrEqual(100); // Should include introspection cost
    });

    test('should handle nested selections', () => {
      const mockInfo = {
        operation: {
          selectionSet: {
            selections: [
              {
                name: { value: 'parentField' },
                selectionSet: {
                  selections: [
                    {
                      name: { value: 'childField' },
                      selectionSet: {
                        selections: [
                          { name: { value: 'grandchildField' } }
                        ]
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      };

      const complexity = analyzer.calculate(mockInfo, {});
      expect(complexity).toBeGreaterThan(10); // Should account for nesting
    });

    test('should handle queries with arguments', () => {
      const mockInfo = {
        operation: {
          selectionSet: {
            selections: [
              {
                name: { value: 'fieldWithArgs' },
                arguments: [
                  {
                    name: { value: 'limit' },
                    value: { value: 1000 }
                  }
                ]
              }
            ]
          }
        }
      };

      const complexity = analyzer.calculate(mockInfo, {});
      expect(complexity).toBeGreaterThan(0);
    });
  });

  describe('extractNumericValue', () => {
    test('should extract number from value', () => {
      const value = analyzer.extractNumericValue({ value: 42 });
      expect(value).toBe(42);
    });

    test('should extract number from string', () => {
      const value = analyzer.extractNumericValue({ value: '100' });
      expect(value).toBe(100);
    });

    test('should return 1 for non-numeric values', () => {
      const value = analyzer.extractNumericValue({ value: 'invalid' });
      expect(value).toBe(1);
    });

    test('should handle missing value', () => {
      const value = analyzer.extractNumericValue({});
      expect(value).toBe(1);
    });
  });
});

describe('InputSanitizer', () => {
  let sanitizer;

  beforeEach(() => {
    sanitizer = new InputSanitizer({
      ENABLED: true,
      XSS_PROTECTION: true,
      SQL_INJECTION_PROTECTION: true,
      MAX_STRING_LENGTH: 100
    });
  });

  describe('sanitizeAll', () => {
    test('should sanitize object recursively', () => {
      const input = {
        field1: '<script>alert("xss")</script>',
        field2: 'SELECT * FROM users',
        nested: {
          field3: '<?php echo "test"; ?>',
          field4: 'normal text'
        }
      };

      const result = sanitizer.sanitizeAll(input);
      expect(result.field1).not.toContain('<script>');
      expect(result.field2).toBeDefined();
      expect(result.nested.field3).not.toContain('<?php');
      expect(result.nested.field4).toBe('normal text');
    });

    test('should handle arrays', () => {
      const input = {
        items: ['<script>test</script>', 'normal', 'DROP TABLE users']
      };

      const result = sanitizer.sanitizeAll(input);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items[0]).not.toContain('<script>');
      expect(result.items[1]).toBe('normal');
    });

    test('should handle primitive values', () => {
      const result1 = sanitizer.sanitizeAll('test string');
      const result2 = sanitizer.sanitizeAll(123);
      const result3 = sanitizer.sanitizeAll(true);

      expect(result1).toBe('test string');
      expect(result2).toBe(123);
      expect(result3).toBe(true);
    });
  });

  describe('sanitizeXSS', () => {
    test('should remove script tags', () => {
      const input = '<script>alert("xss")</script>Hello';
      const result = sanitizer.sanitizeXSS(input);
      expect(result).not.toContain('<script>');
      expect(result).toContain('Hello');
    });

    test('should remove javascript: URLs', () => {
      const input = 'javascript:alert("xss")';
      const result = sanitizer.sanitizeXSS(input);
      expect(result).not.toContain('javascript:');
    });

    test('should handle on* event handlers', () => {
      const input = '<img src="x" onerror="alert(1)">';
      const result = sanitizer.sanitizeXSS(input);
      expect(result).not.toContain('onerror');
    });
  });

  describe('sanitizeSQL', () => {
    test('should handle SQL injection patterns', () => {
      const input = "'; DROP TABLE users; --";
      const result = sanitizer.sanitizeSQL(input);
      expect(result).toBeDefined();
      // Should either escape or remove dangerous patterns
    });

    test('should handle UNION attacks', () => {
      const input = "1' UNION SELECT password FROM users";
      const result = sanitizer.sanitizeSQL(input);
      expect(result).toBeDefined();
    });
  });

  describe('sanitizeNumber', () => {
    test('should handle valid numbers', () => {
      expect(sanitizer.sanitizeNumber(42)).toBe(42);
      expect(sanitizer.sanitizeNumber('42')).toBe(42);
      expect(sanitizer.sanitizeNumber(3.14)).toBe(3.14);
    });

    test('should handle invalid numbers', () => {
      expect(sanitizer.sanitizeNumber('invalid')).toBe(0);
      expect(sanitizer.sanitizeNumber(null)).toBe(0);
      expect(sanitizer.sanitizeNumber(undefined)).toBe(0);
    });

    test('should handle edge cases', () => {
      expect(sanitizer.sanitizeNumber(Infinity)).toBe(0);
      expect(sanitizer.sanitizeNumber(-Infinity)).toBe(0);
      expect(sanitizer.sanitizeNumber(NaN)).toBe(0);
    });
  });
});

describe('PatternValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new PatternValidator();
  });

  describe('validateQuery', () => {
    test('should validate simple queries', () => {
      const query = 'query { user { name } }';
      const result = validator.validateQuery(query);
      expect(typeof result).toBe('boolean');
    });

    test('should handle complex queries', () => {
      const query = `
        query GetUserData($id: ID!) {
          user(id: $id) {
            name
            posts {
              title
              comments {
                text
                author { name }
              }
            }
          }
        }
      `;
      const result = validator.validateQuery(query);
      expect(typeof result).toBe('boolean');
    });

    test('should handle malformed queries gracefully', () => {
      const query = 'invalid query syntax {{{';
      const result = validator.validateQuery(query);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('pattern compilation', () => {
    test('should handle pattern loading errors gracefully', () => {
      expect(() => {
        validator.compilePatterns(['[invalid-regex']);
      }).not.toThrow();
    });

    test('should reload patterns', () => {
      expect(() => {
        validator.reload();
      }).not.toThrow();
    });
  });
});

describe('Security Integration Tests', () => {
  test('should work together in realistic scenarios', async () => {
    const securityManager = new SecurityManager();
    const middleware = securityManager.createSecurityMiddleware();

    const mockResolve = jest.fn().mockResolvedValue('result');
    const mockContext = {
      requestId: 'integration-test',
      req: { ip: '127.0.0.1', headers: { 'user-agent': 'test' } }
    };
    const mockInfo = {
      fieldName: 'testQuery',
      operation: {
        selectionSet: {
          selections: [{ name: { value: 'simpleField' } }]
        }
      }
    };
    const mockArgs = { input: 'clean input' };

    // Mock all security checks to pass
    securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue(true);
    securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(50);
    securityManager.inputSanitizer.sanitizeAll = jest.fn().mockReturnValue(mockArgs);
    securityManager.patternValidator.validateQuery = jest.fn().mockReturnValue(true);

    const result = await middleware(mockResolve, null, mockArgs, mockContext, mockInfo);
    expect(result).toBe('result');
  });

  test('should handle multiple security violations', async () => {
    const securityManager = new SecurityManager();
    const middleware = securityManager.createSecurityMiddleware();

    const mockResolve = jest.fn();
    const mockContext = {
      requestId: 'violation-test',
      req: { ip: '127.0.0.1', headers: { 'user-agent': 'test' } }
    };
    const mockInfo = {
      fieldName: 'testQuery',
      operation: {
        selectionSet: {
          selections: [{ name: { value: 'simpleField' } }]
        }
      }
    };

    // Rate limit violation should be checked first
    securityManager.rateLimiter.checkLimit = jest.fn().mockResolvedValue(false);
    securityManager.complexityAnalyzer.calculate = jest.fn().mockReturnValue(2000); // Also exceeds limit

    await expect(
      middleware(mockResolve, null, {}, mockContext, mockInfo)
    ).rejects.toThrow('Rate limit exceeded');
  });
});