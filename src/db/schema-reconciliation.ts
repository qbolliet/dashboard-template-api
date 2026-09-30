// Réconciliation découverte ↔ configuration des schémas d'un catalogue (fonction pure)

/**
 * Schema list policy of one catalog, fixed at start-up from the configuration.
 */
interface SchemaPolicy {
  /** Schemas listed in the configuration (`['main']` when none). */
  configured: string[];
  /** Whether `SCHEMAS` was given explicitly (strict allow-list). */
  explicit: boolean;
}

/** Outcome of a reconciliation, with what the caller may want to warn about. */
interface SchemaReconciliation {
  /** Schemas to serve, the first one being the default. Never empty. */
  schemas: string[];
  /** Configured schemas absent from the discovery (explicit list only). */
  missing: string[];
  /** True when no configured schema was discovered and the configuration is kept as is. */
  keptConfigured: boolean;
}

/**
 * Orders discovered schemas: `main` first, the others alphabetically.
 *
 * `information_schema.schemata` gives no ordering guarantee, and the first
 * schema of the list is the default one.
 *
 * @param discovered - Schema names as reported by the engine.
 * @returns A new, deterministically ordered list.
 */
// Ordre stable des schémas découverts : « main » puis alphabétique
function orderDiscovered(discovered: string[]): string[] {
  return [...discovered].sort((a, b) => {
    if (a === b) return 0;
    if (a === 'main') return -1;
    if (b === 'main') return 1;
    return a < b ? -1 : 1;
  });
}

/**
 * Reconciles the schemas discovered in a catalog with its configured policy.
 *
 *  - Explicit `SCHEMAS`: intersection (config ∩ discovery), in config order —
 *    the config is an allow-list, never widened. When the intersection is
 *    empty, the configuration is kept as is so existing queries do not break.
 *  - No `SCHEMAS` (the default): the discovered list, `main` first then
 *    alphabetical; `['main']` when the discovery is empty, so a catalog never
 *    has an empty schema list.
 *
 * Pure: the same inputs always give the same list. The start-up/reload path
 * (`DatabaseManager.initSchemas`) and the freshness probe both use it, so the
 * probe compares like with like and a fallback never looks like a change.
 *
 * @param discovered - Schemas reported by `information_schema.schemata` for the catalog.
 * @param policy - Configured list and whether it is an explicit allow-list.
 * @returns The schemas to serve, and the configured schemas that are missing.
 */
function reconcileSchemaList(discovered: string[], policy: SchemaPolicy): SchemaReconciliation {
  if (policy.explicit) {
    // Allow-list stricte : intersection (config ∩ découverte), ordre de la config
    const intersection = policy.configured.filter((s) => discovered.includes(s));
    const missing = policy.configured.filter((s) => !discovered.includes(s));
    if (intersection.length === 0) {
      return { schemas: [...policy.configured], missing, keptConfigured: true };
    }
    return { schemas: intersection, missing, keptConfigured: false };
  }

  // Liste découverte ordonnée ; repli sur « main » si le catalogue est vide
  return {
    schemas: discovered.length > 0 ? orderDiscovered(discovered) : ['main'],
    missing: [],
    keptConfigured: false,
  };
}

export { orderDiscovered, reconcileSchemaList };
export type { SchemaPolicy, SchemaReconciliation };
