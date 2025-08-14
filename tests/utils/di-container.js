// Dependency Injection Container for better testability
import { EventEmitter } from 'events';

class DIContainer extends EventEmitter {
  constructor() {
    super();
    this.services = new Map();
    this.factories = new Map();
    this.singletons = new Map();
  }

  // Register a service factory
  register(name, factory, options = {}) {
    const { singleton = false, dependencies = [] } = options;
    
    this.factories.set(name, {
      factory,
      singleton,
      dependencies
    });

    this.emit('registered', name);
    return this;
  }

  // Register a singleton service
  singleton(name, factory, dependencies = []) {
    return this.register(name, factory, { singleton: true, dependencies });
  }

  // Register an instance directly
  instance(name, instance) {
    this.services.set(name, instance);
    this.emit('registered', name);
    return this;
  }

  // Get a service
  get(name) {
    // Return direct instance if available
    if (this.services.has(name)) {
      return this.services.get(name);
    }

    // Check if singleton already created
    if (this.singletons.has(name)) {
      return this.singletons.get(name);
    }

    // Create from factory
    const serviceConfig = this.factories.get(name);
    if (!serviceConfig) {
      throw new Error(`Service '${name}' not found in DI container`);
    }

    const { factory, singleton, dependencies } = serviceConfig;
    
    // Resolve dependencies
    const resolvedDependencies = dependencies.map(dep => this.get(dep));
    
    // Create instance
    const instance = factory(...resolvedDependencies);

    // Store singleton for reuse
    if (singleton) {
      this.singletons.set(name, instance);
    }

    this.emit('created', name, instance);
    return instance;
  }

  // Check if service is registered
  has(name) {
    return this.services.has(name) || this.factories.has(name) || this.singletons.has(name);
  }

  // Clear all services (useful for tests)
  clear() {
    this.services.clear();
    this.factories.clear();
    this.singletons.clear();
    this.emit('cleared');
    return this;
  }

  // Clear only singletons (useful for test isolation)
  clearSingletons() {
    this.singletons.clear();
    this.emit('singletons-cleared');
    return this;
  }

  // Override a service for testing
  mock(name, mockInstance) {
    this.services.set(name, mockInstance);
    this.emit('mocked', name);
    return this;
  }

  // Remove mock and restore original
  unmock(name) {
    if (this.services.has(name)) {
      this.services.delete(name);
      this.emit('unmocked', name);
    }
    return this;
  }

  // Get all registered service names
  getServiceNames() {
    const names = new Set();
    this.services.forEach((_, name) => names.add(name));
    this.factories.forEach((_, name) => names.add(name));
    this.singletons.forEach((_, name) => names.add(name));
    return Array.from(names);
  }
}

// Create global container
const container = new DIContainer();

// Helper function to create a test container
export const createTestContainer = () => new DIContainer();

export { DIContainer, container };
export default container;