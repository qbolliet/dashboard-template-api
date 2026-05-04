/**
 * Integration tests for the getDatabases, getDatabaseSchema, and getSharedDimensions resolvers.
 *
 * Covers catalog listing, schema field metadata, dimension name filtering,
 * and error handling for invalid database identifiers.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo réutilisé par tous les tests du fichier
let server: ApolloServer;

beforeAll(async () => {
    await ensureSetup();
    server = await getServer();
}, 60000);

// ─── Tests getDatabases ───────────────────────────────────────────────────────

describe('getDatabases', () => {
    test('returns at least one database entry', async () => {
        const query = `
      query {
        getDatabases {
          id
          dimensionNames
          fields { name label is_categorical sql_type }
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        const databases = result.data!.getDatabases as unknown[];
        expect(Array.isArray(databases)).toBe(true);
        expect(databases.length).toBeGreaterThan(0);
    });

    test('each entry has id, dimensionNames, and fields arrays', async () => {
        const query = `query { getDatabases { id dimensionNames fields { name is_categorical } } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de la structure de chaque entrée de catalogue
        const databases = result.data!.getDatabases as Array<{
            id: string;
            dimensionNames: string[];
            fields: unknown[];
        }>;
        for (const db of databases) {
            expect(typeof db.id).toBe('string');
            expect(db.id.length).toBeGreaterThan(0);
            expect(Array.isArray(db.dimensionNames)).toBe(true);
            expect(Array.isArray(db.fields)).toBe(true);
        }
    });

    test('dimensionNames is a subset of categorical fields', async () => {
        const query = `query { getDatabases { id dimensionNames fields { name is_categorical } } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification que les dimensions sont bien des champs catégoriels
        const databases = result.data!.getDatabases as Array<{
            id: string;
            dimensionNames: string[];
            fields: Array<{ name: string; is_categorical: boolean }>;
        }>;
        const dbWithData = databases.find(db => db.fields.length > 0);
        if (dbWithData) {
            const categoricalNames = dbWithData.fields
                .filter(f => f.is_categorical)
                .map(f => f.name);
            for (const dim of dbWithData.dimensionNames) {
                expect(categoricalNames).toContain(dim);
            }
        }
    });

    test('lite version — id and dimensionNames only', async () => {
        const query = `query { getDatabases { id dimensionNames } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(Array.isArray(result.data!.getDatabases)).toBe(true);
    });
});

// ─── Tests getDatabaseSchema ──────────────────────────────────────────────────

describe('getDatabaseSchema', () => {
    test('returns field metadata without a database parameter (uses default)', async () => {
        const query = `
      query {
        getDatabaseSchema {
          name
          label
          python_type
          sql_type
          is_categorical
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        const fields = result.data!.getDatabaseSchema as Array<{
            name: string;
            label: string;
            python_type: string;
            sql_type: string;
            is_categorical: boolean;
        }>;
        expect(Array.isArray(fields)).toBe(true);
        expect(fields.length).toBeGreaterThan(0);
        expect(fields[0]).toHaveProperty('name');
        expect(fields[0]).toHaveProperty('label');
        expect(fields[0]).toHaveProperty('python_type');
        expect(fields[0]).toHaveProperty('sql_type');
        expect(typeof fields[0].is_categorical).toBe('boolean');
    });

    test('same result with and without explicit empty database param', async () => {
        const noParam = `query { getDatabaseSchema { name is_categorical } }`;
        const withEmpty = `query { getDatabaseSchema(database: "") { name is_categorical } }`;

        const r1 = await execute(server, { query: noParam });
        const r2 = await execute(server, { query: withEmpty });

        expect(r1.errors).toBeUndefined();
        expect(r2.errors).toBeUndefined();

        // Vérification de l'équivalence des résultats avec et sans paramètre de base de données
        const names1 = (r1.data!.getDatabaseSchema as Array<{ name: string }>).map(f => f.name).sort();
        const names2 = (r2.data!.getDatabaseSchema as Array<{ name: string }>).map(f => f.name).sort();
        expect(names2).toEqual(names1);
    });

    test('schema contains the known test fields (country, indicator, value)', async () => {
        const query = `query { getDatabaseSchema { name is_categorical } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Présence obligatoire des champs de référence du jeu de données de test
        const names = (result.data!.getDatabaseSchema as Array<{ name: string }>).map(f => f.name);
        expect(names).toContain('country');
        expect(names).toContain('indicator');
        expect(names).toContain('value');
    });

    test('rejects an invalid database name', async () => {
        const query = `query { getDatabaseSchema(database: "nonexistent_xyz") { name } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeDefined();
    });

    test('multiple schemas in a single query', async () => {
        const query = `
      query {
        schema1: getDatabaseSchema { name is_categorical }
        schema2: getDatabaseSchema(database: "") { name is_categorical }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(Array.isArray(result.data!.schema1)).toBe(true);
        expect(Array.isArray(result.data!.schema2)).toBe(true);
    });
});

// ─── Tests getSharedDimensions ────────────────────────────────────────────────

describe('getSharedDimensions', () => {
    test('returns the dimensions of a single database', async () => {
        const dbQuery = `query { getDatabases { id dimensionNames } }`;
        const dbResult = await execute(server, { query: dbQuery });
        const databases = dbResult.data!.getDatabases as Array<{ id: string; dimensionNames: string[] }>;
        const defaultDb = databases[0];

        if (!defaultDb) return;

        const query = `query { getSharedDimensions(databases: ["${defaultDb.id}"]) }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification que les dimensions partagées sont bien un sous-ensemble de la base
        const shared = result.data!.getSharedDimensions as string[];
        expect(Array.isArray(shared)).toBe(true);
        expect(shared.length).toBeGreaterThan(0);
        for (const dim of shared) {
            expect(defaultDb.dimensionNames).toContain(dim);
        }
    });

    test('returns common dimensions across two same databases (deduplication)', async () => {
        const dbQuery = `query { getDatabases { id } }`;
        const dbResult = await execute(server, { query: dbQuery });
        const firstId = (dbResult.data!.getDatabases as Array<{ id: string }>)[0]?.id;
        if (!firstId) return;

        const query = `query { getSharedDimensions(databases: ["${firstId}", "${firstId}"]) }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(Array.isArray(result.data!.getSharedDimensions)).toBe(true);
    });

    test('rejects an empty databases list', async () => {
        const query = `query { getSharedDimensions(databases: []) }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeDefined();
    });

    test('rejects an unknown database name', async () => {
        const query = `query { getSharedDimensions(databases: ["nonexistent_db"]) }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeDefined();
    });
});
