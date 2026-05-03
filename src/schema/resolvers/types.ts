// ─── Types partagés du module resolvers ──────────────────────────────────────

import type { LoadersCollection } from '../../loaders/index.js';

// ─── Contexte GraphQL ─────────────────────────────────────────────────────────

/** Contexte Apollo Server injecté dans chaque resolver. */
export interface GraphQLContext {
    loaders: LoadersCollection;
    getLoadersForDatabase: (database?: string | null) => LoadersCollection | null;
}
