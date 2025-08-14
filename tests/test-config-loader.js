// Test-specific configuration loader that loads test configs instead of production
import fs from 'fs';
import yaml from 'yaml';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration loader class
class TestConfigLoader {
  constructor() {
    this.testConfigDir = path.resolve(__dirname, '../config/test');
    this.prodConfigDir = path.resolve(__dirname, '../config');
    this.config = null;
  }

  loadConfig() {
    if (this.config) return this.config;
    
    // List of configuration files to load
    const configFiles = [
      'main.yaml',
      'database.yaml',
      'security.yaml'
    ];

    this.config = {};

    // Load test-specific configs first, then fall back to production configs
    configFiles.forEach(file => {
      const testFilePath = path.join(this.testConfigDir, file);
      const prodFilePath = path.join(this.prodConfigDir, file);
      
      let filePath = null;
      if (fs.existsSync(testFilePath)) {
        filePath = testFilePath;
      } else if (fs.existsSync(prodFilePath)) {
        filePath = prodFilePath;
      }
      
      if (filePath) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const parsed = yaml.parse(content);
          this.config = this.mergeDeep(this.config, parsed);
        } catch (error) {
          console.warn(`Warning: Could not load config file ${file}:`, error.message);
        }
      }
    });

    // Resolve environment variables
    this.config = this.resolveEnvVariables(this.config);

    // Apply test environment overrides
    this.config = this.applyEnvironmentSpecific(this.config);

    // Convert numeric values
    this.config = this.convertNumericValues(this.config);

    return this.config;
  }

  mergeDeep(target, source) {
    if (typeof target !== 'object' || typeof source !== 'object') {
      return source;
    }

    const result = { ...target };

    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.mergeDeep(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }

    return result;
  }

  resolveEnvVariables(obj) {
    if (typeof obj === 'string') {
      return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        const [name, defaultValue] = varName.split(':-');
        return process.env[name] || defaultValue || match;
      });
    }

    if (typeof obj === 'object' && obj !== null) {
      const result = Array.isArray(obj) ? [] : {};
      for (const key in obj) {
        result[key] = this.resolveEnvVariables(obj[key]);
      }
      return result;
    }

    return obj;
  }

  applyEnvironmentSpecific(config) {
    const nodeEnv = process.env.NODE_ENV || 'test';
    const envKey = `${nodeEnv}_overrides`;
    
    if (config[envKey]) {
      config = this.mergeDeep(config, config[envKey]);
      delete config[envKey];
    }

    return config;
  }

  convertNumericValues(obj) {
    if (typeof obj === 'string') {
      const num = Number(obj);
      if (!isNaN(num) && obj.toString() === num.toString()) {
        return num;
      }
      return obj;
    }

    if (typeof obj === 'object' && obj !== null) {
      const result = Array.isArray(obj) ? [] : {};
      for (const key in obj) {
        result[key] = this.convertNumericValues(obj[key]);
      }
      return result;
    }

    return obj;
  }

  get(path, defaultValue = null) {
    const keys = path.split('.');
    let current = this.config;
    
    for (const key of keys) {
      if (current === null || current === undefined || !(key in current)) {
        return defaultValue;
      }
      current = current[key];
    }
    
    return current;
  }

  has(path) {
    return this.get(path, Symbol('not-found')) !== Symbol('not-found');
  }

  reload() {
    this.config = null;
    return this.loadConfig();
  }
}

// Create and export test configuration
const testConfigLoader = new TestConfigLoader();
const testConfig = testConfigLoader.loadConfig();

export { TestConfigLoader, testConfig };
export default testConfig;