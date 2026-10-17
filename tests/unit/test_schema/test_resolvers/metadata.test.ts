/**
 * Integration tests for the getMetaData resolver.
 *
 * Covers field metadata retrieval for categorical and numeric fields,
 * the isPrimaryKey flag, null return for unknown fields, multi-field
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
    const query = `query { getMetaData(name: "country") { name label sqlType isCategorical } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de la cohérence des métadonnées pour un champ catégoriel
    const meta = result.data!.getMetaData as {
      name: string;
      isCategorical: boolean;
      label: unknown;
      sqlType: unknown;
    };
    expect(meta.name).toBe('country');
    expect(meta.isCategorical).toBe(true);
    expect(meta.label).toBeDefined();
    // La fact table porte le libellé : la colonne est un VARCHAR
    expect(meta.sqlType).toBe('VARCHAR');
  });

  test('returns metadata for a numeric field', async () => {
    const query = `query { getMetaData(name: "value") { name label sqlType isCategorical } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const meta = result.data!.getMetaData as { name: string; isCategorical: boolean };
    expect(meta.name).toBe('value');
    expect(meta.isCategorical).toBe(false);
  });

  test('returns isPrimaryKey field', async () => {
    const query = `query { getMetaData(name: "country") { name isCategorical isPrimaryKey } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification du typage booléen et de la valeur de clé primaire pour "country"
    const meta = result.data!.getMetaData as { isPrimaryKey: boolean };
    expect(meta).toBeDefined();
    expect(typeof meta.isPrimaryKey).toBe('boolean');
    expect(meta.isPrimaryKey).toBe(true);
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
        indicator: getMetaData(name: "indicator") { name label isCategorical }
        value: getMetaData(name: "value") { name label isCategorical }
        date: getMetaData(name: "date") { name sqlType isCategorical }
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
    const query = `query { getMetaData(name: "country") { name label isCategorical } }`;

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
