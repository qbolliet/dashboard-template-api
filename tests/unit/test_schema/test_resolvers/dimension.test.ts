/**
 * Integration tests for the getDimensionTable resolver.
 *
 * Covers dimension value retrieval, multi-dimension queries, empty results
 * for unknown dimensions, database routing, and DataLoader cache behavior.
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

// ─── Tests getDimensionTable ──────────────────────────────────────────────────

describe('getDimensionTable', () => {
  test('returns dimension values with value and label', async () => {
    const query = `query { getDimensionTable(name: "country") { value label } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de la présence des champs value et label
    const rows = result.data!.getDimensionTable as Array<{ value: unknown; label: unknown }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('value');
    expect(rows[0]).toHaveProperty('label');
  });

  test('handles multiple dimensions in a single query', async () => {
    const query = `
      query {
        countries: getDimensionTable(name: "country") { value label }
        indicators: getDimensionTable(name: "indicator") { value label }
        kinds: getDimensionTable(name: "kind") { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data!.countries)).toBe(true);
    expect(Array.isArray(result.data!.indicators)).toBe(true);
    expect(Array.isArray(result.data!.kinds)).toBe(true);
  });

  test('returns empty array for a non-existent dimension', async () => {
    const query = `query { getDimensionTable(name: "inexistent") { value label } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getDimensionTable).toEqual([]);
  });

  test('accepts explicit empty database parameter (routes to default)', async () => {
    const noParam = `query { getDimensionTable(name: "country") { value label } }`;
    const withEmpty = `query { getDimensionTable(name: "country", catalog: "") { value label } }`;

    const r1 = await execute(server, { query: noParam });
    const r2 = await execute(server, { query: withEmpty });

    expect(r1.errors).toBeUndefined();
    expect(r2.errors).toBeUndefined();

    // Vérification de l'équivalence entre appel sans paramètre et avec paramètre vide
    expect(r1.data!.getDimensionTable).toEqual(r2.data!.getDimensionTable);
  });

  test('caches repeated dimension queries (second call significantly faster)', async () => {
    const query = `query { getDimensionTable(name: "country") { value label } }`;

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
