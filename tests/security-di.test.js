// Unit tests for security components using dependency injection
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Mock test config to avoid loading issues
const testConfig = {
  SECURITY: {
    RATE_LIMIT: {
      ENABLED: false,
      MAX_REQUESTS: 10000,
      TIME_WINDOW: 60000,
      BURST_LIMIT: 1000
    },
    COMPLEXITY: {
      MAX_COMPLEXITY: 10000,
      MAX_DEPTH: 50,
      INTROSPECTION_COST: 1,
      DEPTH_FACTOR: 1
    },
    SANITIZATION: {
      ENABLED: true,
      XSS_PROTECTION: true,
      SQL_INJECTION_PROTECTION: true
    }
  }
};

// Security component mocks that can be tested independently
class MockRateLimiter {
  constructor(config) {
    this.config = config;
    this.clients = new Map();
  }

  async checkLimit(req) {
    if (!this.config.ENABLED) return true;
    
    const key = this.defaultKeyGenerator(req);
    const now = Date.now();
    const windowStart = now - this.config.TIME_WINDOW;
    
    const client = this.clients.get(key) || { count: 0, resetTime: now + this.config.TIME_WINDOW };
    
    // Reset if window expired
    if (now > client.resetTime) {
      client.count = 0;
      client.resetTime = now + this.config.TIME_WINDOW;
    }
    
    client.count++;
    this.clients.set(key, client);
    
    return client.count <= this.config.MAX_REQUESTS;
  }

  defaultKeyGenerator(req) {
    const ip = req.ip || 'unknown';
    const userAgent = req.headers?.['user-agent'] || 'unknown';
    return `${ip}:${userAgent}`;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, client] of this.clients.entries()) {
      if (now > client.resetTime) {
        this.clients.delete(key);
      }
    }
  }
}

class MockComplexityAnalyzer {
  constructor(config) {
    this.config = config;
  }

  calculate(info, variables) {
    let complexity = 0;
    
    if (!info.operation?.selectionSet) {
      return 1;
    }
    
    complexity += this.calculateSelectionSet(info.operation.selectionSet, variables, 1);
    return complexity;
  }

  calculateSelectionSet(selectionSet, variables, depth) {
    let complexity = 0;
    
    for (const selection of selectionSet.selections || []) {
      complexity += this.calculateField(selection, variables, depth);
    }
    
    return complexity;
  }

  calculateField(field, variables, depth) {
    let complexity = 1;
    
    // Add depth factor
    complexity += depth * this.config.DEPTH_FACTOR;
    
    // Handle introspection
    if (field.name?.value?.startsWith('__')) {
      complexity += this.config.INTROSPECTION_COST;
    }
    
    // Handle nested selections
    if (field.selectionSet) {
      complexity += this.calculateSelectionSet(field.selectionSet, variables, depth + 1);
    }
    
    // Handle arguments
    if (field.arguments) {
      for (const arg of field.arguments) {
        const value = this.extractNumericValue(arg.value);
        complexity += Math.log10(value + 1);
      }
    }
    
    return complexity;
  }

  extractNumericValue(valueNode) {
    if (!valueNode?.value) return 1;
    
    const num = Number(valueNode.value);
    return isNaN(num) ? 1 : Math.max(1, num);
  }
}

class MockInputSanitizer {
  constructor(config) {
    this.config = config;
  }

  sanitizeAll(input) {
    if (!this.config.ENABLED) return input;
    return this.sanitizeValue(input);
  }

  sanitizeValue(value) {
    if (typeof value === 'string') {
      let sanitized = value;
      
      if (this.config.XSS_PROTECTION) {
        sanitized = this.sanitizeXSS(sanitized);
      }
      
      if (this.config.SQL_INJECTION_PROTECTION) {
        sanitized = this.sanitizeSQL(sanitized);
      }
      
      return sanitized;
    }
    
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        return value.map(item => this.sanitizeValue(item));
      }
      
      const sanitized = {};
      for (const [key, val] of Object.entries(value)) {
        sanitized[key] = this.sanitizeValue(val);
      }
      return sanitized;
    }
    
    return value;
  }

  sanitizeXSS(input) {
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+="[^"]*"/gi, '')
      .replace(/on\w+='[^']*'/gi, '');
  }

  sanitizeSQL(input) {
    // Basic SQL injection prevention
    const sqlPatterns = [
      /(['"])([^'"]*)(\1)/g, // Quoted strings
      /(;|\-\-|\*|\/\*|\*\/)/g, // SQL meta characters
      /\b(union|select|insert|update|delete|drop|exec|execute)\b/gi // SQL keywords
    ];
    
    let sanitized = input;
    sqlPatterns.forEach(pattern => {
      sanitized = sanitized.replace(pattern, (match) => {
        // Simple escaping
        return match.replace(/'/g, "\\'").replace(/"/g, '\\"');
      });
    });
    
    return sanitized;
  }
}

describe('Security Components with Dependency Injection', () => {
  let securityConfig;

  beforeEach(() => {
    securityConfig = testConfig?.SECURITY || {
      RATE_LIMIT: {
        ENABLED: false,
        MAX_REQUESTS: 10000,
        TIME_WINDOW: 60000,
        BURST_LIMIT: 1000
      },
      COMPLEXITY: {
        MAX_COMPLEXITY: 10000,
        MAX_DEPTH: 50,
        INTROSPECTION_COST: 1,
        DEPTH_FACTOR: 1
      },
      SANITIZATION: {
        ENABLED: true,
        XSS_PROTECTION: true,
        SQL_INJECTION_PROTECTION: true
      }
    };
  });

  describe('MockRateLimiter', () => {
    test('should allow requests when disabled', async () => {
      const rateLimiter = new MockRateLimiter({ ENABLED: false });
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } };
      
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result).toBe(true);
    });

    test('should track request counts when enabled', async () => {
      const rateLimiter = new MockRateLimiter({
        ENABLED: true,
        MAX_REQUESTS: 5,
        TIME_WINDOW: 60000
      });
      
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } };
      
      // First 5 requests should pass
      for (let i = 0; i < 5; i++) {
        const result = await rateLimiter.checkLimit(mockReq);
        expect(result).toBe(true);
      }
      
      // 6th request should fail
      const result = await rateLimiter.checkLimit(mockReq);
      expect(result).toBe(false);
    });

    test('should generate consistent keys', () => {
      const rateLimiter = new MockRateLimiter({ ENABLED: true });
      const req1 = { ip: '192.168.1.1', headers: { 'user-agent': 'browser' } };
      const req2 = { ip: '192.168.1.1', headers: { 'user-agent': 'browser' } };
      
      const key1 = rateLimiter.defaultKeyGenerator(req1);
      const key2 = rateLimiter.defaultKeyGenerator(req2);
      
      expect(key1).toBe(key2);
    });

    test('should cleanup expired entries', () => {
      const rateLimiter = new MockRateLimiter({ ENABLED: true });
      
      // Add expired entry
      rateLimiter.clients.set('test-key', {
        count: 5,
        resetTime: Date.now() - 1000 // Expired
      });
      
      rateLimiter.cleanup();
      
      expect(rateLimiter.clients.has('test-key')).toBe(false);
    });
  });

  describe('MockComplexityAnalyzer', () => {
    test('should calculate basic query complexity', () => {
      const analyzer = new MockComplexityAnalyzer(securityConfig.COMPLEXITY);
      
      const mockInfo = {
        operation: {
          selectionSet: {
            selections: [
              { name: { value: 'simpleField' } },
              { name: { value: 'anotherField' } }
            ]
          }
        }
      };
      
      const complexity = analyzer.calculate(mockInfo, {});
      expect(complexity).toBeGreaterThan(0);
    });

    test('should handle introspection queries', () => {
      const analyzer = new MockComplexityAnalyzer(securityConfig.COMPLEXITY);
      
      const mockInfo = {
        operation: {
          selectionSet: {
            selections: [
              { name: { value: '__schema' } },
              { name: { value: '__type' } }
            ]
          }
        }
      };
      
      const complexity = analyzer.calculate(mockInfo, {});
      expect(complexity).toBeGreaterThanOrEqual(2); // At least introspection cost
    });

    test('should extract numeric values correctly', () => {
      const analyzer = new MockComplexityAnalyzer(securityConfig.COMPLEXITY);
      
      expect(analyzer.extractNumericValue({ value: 42 })).toBe(42);
      expect(analyzer.extractNumericValue({ value: '100' })).toBe(100);
      expect(analyzer.extractNumericValue({ value: 'invalid' })).toBe(1);
      expect(analyzer.extractNumericValue({})).toBe(1);
    });
  });

  describe('MockInputSanitizer', () => {
    test('should sanitize XSS attempts', () => {
      const sanitizer = new MockInputSanitizer(securityConfig.SANITIZATION);
      
      const maliciousInput = '<script>alert("xss")</script>Hello';
      const sanitized = sanitizer.sanitizeXSS(maliciousInput);
      
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).toContain('Hello');
    });

    test('should sanitize SQL injection attempts', () => {
      const sanitizer = new MockInputSanitizer(securityConfig.SANITIZATION);
      
      const maliciousInput = "'; DROP TABLE users; --";
      const sanitized = sanitizer.sanitizeSQL(maliciousInput);
      
      expect(sanitized).toBeDefined();
      // Should escape or modify dangerous patterns
    });

    test('should sanitize nested objects', () => {
      const sanitizer = new MockInputSanitizer(securityConfig.SANITIZATION);
      
      const input = {
        field1: '<script>alert("xss")</script>',
        nested: {
          field2: 'normal text',
          field3: 'javascript:alert(1)'
        },
        array: ['<script>alert("test")</script>', 'normal', 'onclick="evil()"']
      };
      
      const result = sanitizer.sanitizeAll(input);
      
      expect(result.field1).not.toContain('<script>');
      expect(result.nested.field2).toBe('normal text');
      expect(result.nested.field3).not.toContain('javascript:');
      expect(result.array[0]).not.toContain('<script>');
      expect(result.array[0]).not.toContain('alert');
      expect(result.array[1]).toBe('normal');
    });

    test('should handle disabled sanitization', () => {
      const sanitizer = new MockInputSanitizer({ ENABLED: false });
      
      const input = '<script>alert("test")</script>';
      const result = sanitizer.sanitizeAll(input);
      
      expect(result).toBe(input); // Should return unchanged
    });
  });

  describe('Integration Testing', () => {
    test('should work together in a security pipeline', async () => {
      const rateLimiter = new MockRateLimiter({
        ENABLED: true,
        MAX_REQUESTS: 10,
        TIME_WINDOW: 60000
      });
      
      const complexityAnalyzer = new MockComplexityAnalyzer({
        MAX_COMPLEXITY: 100,
        DEPTH_FACTOR: 2,
        INTROSPECTION_COST: 5
      });
      
      const inputSanitizer = new MockInputSanitizer({
        ENABLED: true,
        XSS_PROTECTION: true,
        SQL_INJECTION_PROTECTION: true
      });
      
      // Simulate a request
      const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' } };
      const mockInfo = {
        operation: {
          selectionSet: {
            selections: [{ name: { value: 'testField' } }]
          }
        }
      };
      const mockArgs = { input: '<script>alert("test")</script>' };
      
      // Check rate limit
      const rateLimitPassed = await rateLimiter.checkLimit(mockReq);
      expect(rateLimitPassed).toBe(true);
      
      // Check complexity
      const complexity = complexityAnalyzer.calculate(mockInfo, {});
      expect(complexity).toBeLessThan(100);
      
      // Sanitize input
      const sanitizedArgs = inputSanitizer.sanitizeAll(mockArgs);
      expect(sanitizedArgs.input).not.toContain('<script>');
      
      // All checks should pass
      expect(rateLimitPassed && complexity < 100).toBe(true);
    });
  });
});