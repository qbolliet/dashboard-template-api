/**
 * Shared test helpers for GraphQL resolver integration tests.
 *
 * Provides server initialization, catalog setup verification, and a
 * thin wrapper around Apollo Server's executeOperation to normalize
 * the response into the familiar { data, errors } shape.
 */

import { ApolloServer } from '@apollo/server';
import { schema } from '../../../../src/schema/index.js';
import { createLoaders } from '../../../../src/loaders/index.js';
import { databaseManager } from '../../../../src/db/index.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─── Résolution du répertoire courant ─────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Résultat d'une opération GraphQL normalisé. */
export interface GraphQLResult {
    data: Record<string, unknown> | null;
    errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }>;
}

/** Paramètre d'opération transmis à executeOperation d'Apollo Server. */
export interface GraphQLOperation {
    query: string;
    variables?: Record<string, unknown>;
}

// ─── État du serveur partagé ──────────────────────────────────────────────────

// Instance unique du serveur Apollo — réutilisée entre tous les tests
let _server: ApolloServer | null = null;

/**
 * Ensures the test catalog has been initialized by npm run test:setup.
 *
 * Tests run in READ_ONLY mode to allow multiple Jest VM contexts to open
 * the same DuckLake file simultaneously; the catalog must pre-exist.
 *
 * Raises:
 *     Error: If the test catalog file is not found at the expected path.
 */
export const ensureSetup = async (): Promise<void> => {
    // Vérification de l'existence du catalogue de test
    const catalogPath = path.resolve(__dirname, '../../../../data/test-default.ducklake');
    if (!fs.existsSync(catalogPath)) {
        throw new Error(
            `Test catalog not found: ${catalogPath}\n` +
            `Run "npm run test:setup" before running the resolver tests.`
        );
    }
};

/**
 * Returns the shared Apollo Server instance, creating it on first call.
 *
 * Singleton pattern — a single server is started once per test suite to
 * avoid repeated startup overhead across test files.
 *
 * Returns:
 *     Started ApolloServer instance.
 */
export const getServer = async (): Promise<ApolloServer> => {
    // Initialisation du serveur au premier appel
    if (!_server) {
        _server = new ApolloServer({ schema });
        await _server.start();
    }
    return _server;
};

/**
 * Executes a GraphQL operation and normalizes the Apollo Server v5 response.
 *
 * Mirrors the contextValue built in src/server.ts: injects a fresh set of
 * DataLoaders, the databaseManager, and the cross-database routing helper.
 *
 * Args:
 *     server: Running ApolloServer instance.
 *     operation: GraphQL query string and optional variables.
 *
 * Returns:
 *     Normalized { data, errors } result object.
 */
export const execute = async (
    server: ApolloServer,
    operation: GraphQLOperation
): Promise<GraphQLResult> => {
    // Construction du contexte de requête — identique à src/server.ts
    const defaultDb = databaseManager.getDefaultDatabase();
    const { body } = await server.executeOperation(operation, {
        contextValue: {
            requestId: uuidv4(),
            loaders: createLoaders(defaultDb),
            databaseManager,
            requestDatabase: defaultDb,
            // Résolution des loaders pour une base de données cible
            getLoadersForDatabase: (databaseId: string) => {
                const targetDb = databaseManager.validateDatabaseRouting(databaseId, defaultDb);
                return targetDb === defaultDb ? null : createLoaders(targetDb);
            }
        }
    });

    // Normalisation du format de réponse Apollo Server v5
    if (body.kind === 'single') return body.singleResult as GraphQLResult;
    return { data: null, errors: [{ message: 'Unexpected incremental response' }] };
};
