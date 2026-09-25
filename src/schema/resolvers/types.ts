// ─── Types partagés du module resolvers ──────────────────────────────────────

import type { LoadersCollection } from '../../loaders/index.js';

// ─── Contexte GraphQL ─────────────────────────────────────────────────────────

/** Apollo Server context injected into every resolver. */
export interface GraphQLContext {
  loaders: LoadersCollection;
  /** Catalog and schema pinned by the HTTP headers, null when absent. */
  requestCatalog?: string | null;
  requestSchema?: string | null;
  getLoadersForCatalog: (
    catalog?: string | null,
    schema?: string | null,
  ) => LoadersCollection | null;
}
