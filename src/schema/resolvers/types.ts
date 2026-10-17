// ─── Types partagés du module resolvers ──────────────────────────────────────

import type { LoadersCollection } from '../../loaders/index.js';

// ─── Contexte GraphQL ─────────────────────────────────────────────────────────

/** Apollo Server context injected into every resolver. */
export interface GraphQLContext {
  loaders: LoadersCollection;
  /**
   * Returns loaders bound to the given catalog/schema (GraphQL arguments
   * only — see `contextScope` in ./scope.ts), or null to reuse `loaders`.
   */
  getLoadersForCatalog: (
    catalog?: string | null,
    schema?: string | null,
  ) => LoadersCollection | null;
}
