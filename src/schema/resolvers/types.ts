// ─── Types partagés du module resolvers ──────────────────────────────────────

import type { LoadersCollection } from '../../loaders/index.js';

// ─── Contexte GraphQL ─────────────────────────────────────────────────────────

/** Apollo Server context injected into every resolver. */
export interface GraphQLContext {
  loaders: LoadersCollection;
  getLoadersForDatabase: (database?: string | null) => LoadersCollection | null;
}
