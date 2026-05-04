/**
 * Integration tests for the getMetaData resolver.
 *
 * Covers field metadata retrieval for categorical and numeric fields,
 * the is_primary_key flag, null return for unknown fields, multi-field
 * queries, and DataLoader cache performance.
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

// ─── Tests getMetaData ────────────────────────────────────────────────────────

describe('getMetaData', () => {
    test('returns metadata for a categorical field', async () => {
        const query = `query { getMetaData(name: "country") { name label python_type sql_type is_categorical } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de la cohérence des métadonnées pour un champ catégoriel
        const meta = result.data!.getMetaData as {
            name: string;
            is_categorical: boolean;
            label: unknown;
            python_type: unknown;
            sql_type: unknown;
        };
        expect(meta.name).toBe('country');
        expect(meta.is_categorical).toBe(true);
        expect(meta.label).toBeDefined();
        expect(meta.python_type).toBeDefined();
        expect(meta.sql_type).toBeDefined();
    });

    test('returns metadata for a numeric field', async () => {
        const query = `query { getMetaData(name: "value") { name label python_type sql_type is_categorical } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        const meta = result.data!.getMetaData as { name: string; is_categorical: boolean };
        expect(meta.name).toBe('value');
        expect(meta.is_categorical).toBe(false);
    });

    test('returns is_primary_key field', async () => {
        const query = `query { getMetaData(name: "country") { name is_categorical is_primary_key } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification du typage booléen et de la valeur de clé primaire pour "country"
        const meta = result.data!.getMetaData as { is_primary_key: boolean };
        expect(meta).toBeDefined();
        expect(typeof meta.is_primary_key).toBe('boolean');
        expect(meta.is_primary_key).toBe(true);
    });

    test('returns null for a non-existent field', async () => {
        const query = `query { getMetaData(name: "field_that_does_not_exist") { name label } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(result.data!.getMetaData).toBeNull();
    });

    test('handles multiple fields in a single query', async () => {
        const query = `
      query {
        indicator: getMetaData(name: "indicator") { name label is_categorical }
        value: getMetaData(name: "value") { name label is_categorical }
        date: getMetaData(name: "date") { name sql_type is_categorical }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de la correspondance nom/alias pour chaque champ
        expect((result.data!.indicator as { name: string }).name).toBe('indicator');
        expect((result.data!.value as { name: string }).name).toBe('value');
        expect((result.data!.date as { name: string }).name).toBe('date');
    });

    test('caches repeated queries (second call significantly faster)', async () => {
        const query = `query { getMetaData(name: "country") { name label is_categorical } }`;

        // Première exécution — peut être lente (cache froid)
        const t1 = performance.now();
        await execute(server, { query });
        const d1 = performance.now() - t1;

        // Deuxième exécution — doit bénéficier du cache DataLoader
        const t2 = performance.now();
        await execute(server, { query });
        const d2 = performance.now() - t2;

        // Tolérance de 50ms pour le deuxième appel, indépendamment de d1
        expect(d2).toBeLessThan(Math.max(d1 * 0.8, 50));
    });
});
