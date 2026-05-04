/**
 * Dependency Injection Container for test isolation and testability.
 *
 * Provides a lightweight DI container backed by an EventEmitter, supporting
 * singleton services, factory-based instantiation, and mock injection for tests.
 */

// Conteneur d'injection de dépendances — amélioration de la testabilité des modules.
import { EventEmitter } from 'events';

// ─── Interfaces et types ───────────────────────────────────────────────────────

/** Signature d'une factory de service — reçoit ses dépendances résolues en arguments. */
type ServiceFactory<T = unknown> = (...deps: unknown[]) => T;

/** Configuration interne d'une factory enregistrée dans le conteneur. */
interface FactoryConfig<T = unknown> {
  factory: ServiceFactory<T>;
  singleton: boolean;
  dependencies: string[];
}

/** Options d'enregistrement d'un service. */
interface RegisterOptions {
  singleton?: boolean;
  dependencies?: string[];
}

/** Statistiques agrégées renvoyées par getStatistics (usage futur). */
interface ContainerStatistics {
  serviceCount: number;
  factoryCount: number;
  singletonCount: number;
}

// ─── Classe principale ─────────────────────────────────────────────────────────

/**
 * Lightweight Dependency Injection Container extending EventEmitter.
 *
 * Supports three registration modes: direct instance, factory with optional
 * singleton lifecycle, and mock injection for test overrides.
 *
 * Example:
 *   const container = new DIContainer();
 *   container.register('db', (config) => new Database(config), { singleton: true });
 *   const db = container.get('db');
 */
class DIContainer extends EventEmitter {
  /** Instances directes enregistrées via instance() ou mock(). */
  private services: Map<string, unknown>;
  /** Configurations de factories enregistrées via register(). */
  private factories: Map<string, FactoryConfig>;
  /** Cache des instances singleton créées par les factories. */
  private singletons: Map<string, unknown>;

  constructor() {
    super();
    // Initialisation des registres internes
    this.services = new Map();
    this.factories = new Map();
    this.singletons = new Map();
  }

  /**
   * Register a service factory with optional singleton lifecycle.
   *
   * Args:
   *     name: Unique service identifier.
   *     factory: Function that creates the service instance.
   *     options: Registration options (singleton, dependencies).
   *
   * Returns:
   *     This container instance for method chaining.
   */
  register<T = unknown>(
    name: string,
    factory: ServiceFactory<T>,
    options: RegisterOptions = {}
  ): this {
    const { singleton = false, dependencies = [] } = options;

    // Enregistrement de la configuration de la factory
    this.factories.set(name, { factory, singleton, dependencies });
    this.emit('registered', name);
    return this;
  }

  /**
   * Register a singleton service factory (shorthand for register with singleton: true).
   *
   * Args:
   *     name: Unique service identifier.
   *     factory: Function that creates the service instance.
   *     dependencies: List of dependency names to resolve before calling factory.
   *
   * Returns:
   *     This container instance for method chaining.
   */
  singleton<T = unknown>(
    name: string,
    factory: ServiceFactory<T>,
    dependencies: string[] = []
  ): this {
    // Délégation à register avec le mode singleton activé
    return this.register(name, factory, { singleton: true, dependencies });
  }

  /**
   * Register a pre-built service instance directly.
   *
   * Args:
   *     name: Unique service identifier.
   *     instance: The service instance to store.
   *
   * Returns:
   *     This container instance for method chaining.
   */
  instance<T = unknown>(name: string, instance: T): this {
    // Enregistrement direct de l'instance sans factory
    this.services.set(name, instance);
    this.emit('registered', name);
    return this;
  }

  /**
   * Retrieve a registered service by name, creating it if needed.
   *
   * Resolution order: direct instance → existing singleton → factory instantiation.
   *
   * Args:
   *     name: Service identifier to resolve.
   *
   * Returns:
   *     The resolved service instance.
   *
   * Raises:
   *     Error: When the service name is not registered in the container.
   */
  get<T = unknown>(name: string): T {
    // Retour de l'instance directe si disponible
    if (this.services.has(name)) {
      return this.services.get(name) as T;
    }

    // Retour du singleton déjà créé si disponible
    if (this.singletons.has(name)) {
      return this.singletons.get(name) as T;
    }

    // Création depuis la factory enregistrée
    const serviceConfig = this.factories.get(name);
    if (!serviceConfig) {
      throw new Error(`Service '${name}' not found in DI container`);
    }

    const { factory, singleton, dependencies } = serviceConfig;

    // Résolution récursive des dépendances
    const resolvedDependencies = dependencies.map((dep) => this.get(dep));

    // Instanciation via la factory
    const instance = factory(...resolvedDependencies) as T;

    // Mise en cache du singleton pour les appels suivants
    if (singleton) {
      this.singletons.set(name, instance);
    }

    this.emit('created', name, instance);
    return instance;
  }

  /**
   * Check whether a service name is registered in the container.
   *
   * Args:
   *     name: Service identifier to check.
   *
   * Returns:
   *     True if the service exists in any registry.
   */
  has(name: string): boolean {
    return (
      this.services.has(name) ||
      this.factories.has(name) ||
      this.singletons.has(name)
    );
  }

  /**
   * Clear all registries (instances, factories, singletons).
   *
   * Returns:
   *     This container instance for method chaining.
   */
  clear(): this {
    // Vidage complet des trois registres
    this.services.clear();
    this.factories.clear();
    this.singletons.clear();
    this.emit('cleared');
    return this;
  }

  /**
   * Clear only the singleton cache, preserving factories and direct instances.
   *
   * Useful for test isolation between test cases without full container reset.
   *
   * Returns:
   *     This container instance for method chaining.
   */
  clearSingletons(): this {
    // Invalidation du cache singleton uniquement — isolation entre tests
    this.singletons.clear();
    this.emit('singletons-cleared');
    return this;
  }

  /**
   * Override a service with a mock instance for testing purposes.
   *
   * Args:
   *     name: Service identifier to override.
   *     mockInstance: Mock instance to substitute.
   *
   * Returns:
   *     This container instance for method chaining.
   */
  mock<T = unknown>(name: string, mockInstance: T): this {
    // Substitution par un mock pour les tests
    this.services.set(name, mockInstance);
    this.emit('mocked', name);
    return this;
  }

  /**
   * Remove a mock override and restore factory-based resolution.
   *
   * Args:
   *     name: Service identifier to unmock.
   *
   * Returns:
   *     This container instance for method chaining.
   */
  unmock(name: string): this {
    // Suppression du mock — retour à la résolution par factory
    if (this.services.has(name)) {
      this.services.delete(name);
      this.emit('unmocked', name);
    }
    return this;
  }

  /**
   * Return all registered service names across all registries.
   *
   * Returns:
   *     Deduplicated array of service names.
   */
  getServiceNames(): string[] {
    // Union des noms enregistrés dans les trois registres
    const names = new Set<string>();
    this.services.forEach((_, name) => names.add(name));
    this.factories.forEach((_, name) => names.add(name));
    this.singletons.forEach((_, name) => names.add(name));
    return Array.from(names);
  }
}

// ─── Instance et exports ───────────────────────────────────────────────────────

// Conteneur global partagé entre les modules
const container = new DIContainer();

/**
 * Create an isolated DI container for a single test.
 *
 * Returns:
 *     A fresh DIContainer instance with no registered services.
 */
export const createTestContainer = (): DIContainer => new DIContainer();

export { DIContainer, container };
export default container;
