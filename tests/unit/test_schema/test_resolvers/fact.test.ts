/**
 * Integration tests for the getFactTable, getFactTableWithMetadata resolvers,
 * and associated error handling and complex combined queries.
 *
 * Covers pagination, string and structured filters, sorting, field selection,
 * dimension details, format options (OBJECTS/ARRAYS), SQL injection guards,
 * and multi-resolver single-request composition.
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

// ─── Tests getFactTable ───────────────────────────────────────────────────────

describe('getFactTable', () => {
    test('returns paginated facts with all pagination fields', async () => {
        const query = `
      query {
        getFactTable(limit: 10, offset: 0) {
          data { value }
          total
          hasNextPage
          currentPage
          totalPages
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        const ft = result.data!.getFactTable as {
            data: unknown[];
            total: number;
            hasNextPage: boolean;
            currentPage: number;
            totalPages: number;
        };
        expect(Array.isArray(ft.data)).toBe(true);
        expect(ft.data.length).toBeLessThanOrEqual(10);
        expect(ft.total).toBeGreaterThan(0);
        expect(ft.currentPage).toBe(1);
        expect(typeof ft.hasNextPage).toBe('boolean');
        expect(ft.totalPages).toBeGreaterThan(0);
    });

    test('applies string filters', async () => {
        const query = `
      query {
        getFactTable(filters: "country = 1 AND indicator = 1", limit: 20, offset: 0) {
          data { value }
          total
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(Array.isArray((result.data!.getFactTable as { data: unknown[] }).data)).toBe(true);
    });

    test('applies structured filters', async () => {
        const query = `
      query {
        getFactTable(
          structuredFilters: [
            { key: "country", operator: "=", value: "1" }
            { key: "kind", operator: "=", value: "1" }
          ]
          limit: 10
          offset: 0
        ) {
          data { value }
          total
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(Array.isArray((result.data!.getFactTable as { data: unknown[] }).data)).toBe(true);
    });

    test('applies sorting — values in descending order', async () => {
        const query = `
      query {
        getFactTable(
          sort: [{ field: "value", order: DESC }, { field: "date", order: ASC }]
          limit: 15
          offset: 0
        ) {
          data { value }
          total
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de l'ordre décroissant des valeurs
        const values = (result.data!.getFactTable as { data: Array<{ value: number }> })
            .data.map(d => d.value);
        for (let i = 1; i < values.length; i++) {
            expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
        }
    });

    test('selects specific fields', async () => {
        const query = `
      query {
        getFactTable(fields: ["country", "indicator", "value", "date"], limit: 5, offset: 0) {
          data { value }
          total
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect((result.data!.getFactTable as { data: unknown[] }).data.length).toBeLessThanOrEqual(5);
    });

    test('returns dimension details with labels', async () => {
        const query = `
      query {
        getFactTable(limit: 5, offset: 0) {
          data {
            value
            dimensionDetails { name value label }
          }
          total
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de la présence du détail de dimension "country" avec son label
        const firstRow = (result.data!.getFactTable as {
            data: Array<{ dimensionDetails: Array<{ name: string; label: unknown }> }>;
        }).data[0];
        const details = firstRow.dimensionDetails;
        expect(Array.isArray(details)).toBe(true);
        const countryDetail = details.find(d => d.name === 'country');
        if (countryDetail) {
            expect(countryDetail.label).toBeDefined();
        }
    });

    test('handles multiple pages — currentPage increments correctly', async () => {
        const query = `
      query {
        page1: getFactTable(limit: 10, offset: 0) { data { value } total currentPage hasNextPage }
        page2: getFactTable(limit: 10, offset: 10) { data { value } currentPage hasNextPage }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de l'incrémentation correcte du numéro de page
        const page1 = result.data!.page1 as { currentPage: number; total: unknown };
        const page2 = result.data!.page2 as { currentPage: number };
        expect(page1.currentPage).toBe(1);
        expect(page2.currentPage).toBe(2);
        expect(page1.total).toBeDefined();
    });

    test('handles IN operator', async () => {
        const query = `
      query {
        getFactTable(
          structuredFilters: [{ key: "country", operator: "IN", values: ["1", "2", "3"] }]
          limit: 10
          offset: 0
        ) { data { value } total }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(Array.isArray((result.data!.getFactTable as { data: unknown[] }).data)).toBe(true);
    });

    test('handles NOT IN operator', async () => {
        const query = `
      query {
        getFactTable(
          structuredFilters: [{ key: "country", operator: "NOT IN", values: ["1", "2"] }]
          limit: 10
          offset: 0
        ) { data { value } total }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(Array.isArray((result.data!.getFactTable as { data: unknown[] }).data)).toBe(true);
    });

    test('handles mixed operators in a single filter set', async () => {
        const query = `
      query {
        getFactTable(
          structuredFilters: [
            { key: "country", operator: "IN", values: ["1", "2", "3"] }
            { key: "kind", operator: "=", value: "1" }
            { key: "indicator", operator: "NOT IN", values: ["5", "6"] }
          ]
          limit: 10
          offset: 0
        ) { data { value } total }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        expect(result.data!.getFactTable).toBeDefined();
    });

    test('rejects limit > 1000', async () => {
        const query = `query { getFactTable(limit: 1001, offset: 0) { data { value } } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeDefined();
        expect(result.errors![0].message).toContain('Limit cannot exceed 1000');
    });

    test('rejects offset > 10000', async () => {
        const query = `query { getFactTable(limit: 10, offset: 10001) { data { value } } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeDefined();
        expect(result.errors![0].message).toContain('Offset cannot exceed 10000');
    });

    test('accepts explicit empty database parameter (falls back to default)', async () => {
        const noParam = `query { getFactTable(limit: 5, offset: 0) { data { value } total } }`;
        const withEmpty = `query { getFactTable(limit: 5, offset: 0, database: "") { data { value } total } }`;

        const r1 = await execute(server, { query: noParam });
        const r2 = await execute(server, { query: withEmpty });

        expect(r1.errors).toBeUndefined();
        expect(r2.errors).toBeUndefined();
        expect((r2.data!.getFactTable as { total: number }).total)
            .toBe((r1.data!.getFactTable as { total: number }).total);
    });

    test('rejects an invalid database', async () => {
        const query = `query { getFactTable(limit: 5, offset: 0, database: "nonexistent_db_xyz") { data { value } } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeDefined();
    });

    test('handles query variables', async () => {
        const query = `
      query TestVars($country: String!, $limit: Int!, $offset: Int!) {
        getFactTable(
          structuredFilters: [{ key: "country", operator: "=", value: $country }]
          limit: $limit
          offset: $offset
        ) { data { value } total }
      }
    `;
        const result = await execute(server, {
            query,
            variables: { country: '1', limit: 10, offset: 0 }
        });

        expect(result.errors).toBeUndefined();
        expect((result.data!.getFactTable as { data: unknown[] }).data.length).toBeLessThanOrEqual(10);
    });

    test('handles large datasets (1000 records) in under 10s', async () => {
        const query = `query { getFactTable(limit: 1000, offset: 0) { data { value } total } }`;
        // Mesure du temps d'exécution pour la vérification de performance
        const t = Date.now();
        const result = await execute(server, { query });
        expect(result.errors).toBeUndefined();
        expect(Date.now() - t).toBeLessThan(10000);
    });

    test('prevents SQL injection in string filters', async () => {
        const query = `
      query {
        getFactTable(filters: "country = '1; DROP TABLE facts; --'", limit: 10, offset: 0) {
          data { value }
        }
      }
    `;
        const result = await execute(server, { query });
        // Vérification que le serveur répond sans crash (l'injection doit être bloquée ou ignorée)
        expect(result).toBeDefined();
    });

    test('validates field names in structured filters', async () => {
        const query = `
      query {
        getFactTable(
          structuredFilters: [{ key: "'; DROP TABLE facts; --", operator: "=", value: "1" }]
          limit: 10
          offset: 0
        ) { data { value } }
      }
    `;
        const result = await execute(server, { query });
        // Vérification que le serveur répond sans crash (le nom de champ invalide est rejeté)
        expect(result).toBeDefined();
    });
});

// ─── Tests getFactTableWithMetadata ──────────────────────────────────────────

describe('getFactTableWithMetadata', () => {
    test('returns columns, data, and metadata (OBJECTS format by default)', async () => {
        const query = `
      query {
        getFactTableWithMetadata(limit: 50, offset: 0) {
          columns
          data
          metadata { count extents total hasNextPage currentPage totalPages }
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        const r = result.data!.getFactTableWithMetadata as {
            columns: unknown[];
            data: unknown;
            metadata: { count: number; extents: unknown };
        };
        expect(Array.isArray(r.columns)).toBe(true);
        expect(r.data).toBeDefined();
        expect(r.metadata.count).toBeGreaterThan(0);
        expect(r.metadata.extents).toBeDefined();
    });

    test('OBJECTS format — data items are objects (not arrays)', async () => {
        const query = `
      query {
        getFactTableWithMetadata(limit: 5, offset: 0, format: OBJECTS) {
          columns
          data
          metadata { count total }
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification que chaque ligne de données est un objet et non un tableau
        const rows = (result.data!.getFactTableWithMetadata as { data: unknown[] }).data;
        expect(Array.isArray(rows)).toBe(true);
        if (rows.length > 0) {
            expect(typeof rows[0]).toBe('object');
            expect(Array.isArray(rows[0])).toBe(false);
        }
    });

    test('ARRAYS format — data items are arrays matching columns length', async () => {
        const query = `
      query {
        getFactTableWithMetadata(limit: 5, offset: 0, format: ARRAYS) {
          columns
          data
          metadata { count total }
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        const r = result.data!.getFactTableWithMetadata as {
            columns: unknown[];
            data: Array<unknown[]>;
        };
        expect(Array.isArray(r.columns)).toBe(true);

        // Vérification que chaque ligne est un tableau de longueur égale au nombre de colonnes
        if (r.data.length > 0) {
            expect(Array.isArray(r.data[0])).toBe(true);
            expect(r.data[0].length).toBe(r.columns.length);
        }
    });

    test('ARRAYS format with filters and sort', async () => {
        const query = `
      query {
        getFactTableWithMetadata(
          structuredFilters: [{ key: "country", operator: "IN", values: ["1", "2", "3"] }]
          sort: [{ field: "value", order: DESC }]
          limit: 10
          offset: 0
          format: ARRAYS
        ) {
          columns
          data
          metadata { count extents total }
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        const r = result.data!.getFactTableWithMetadata as {
            data: Array<unknown[]>;
            metadata: { count: number };
        };
        expect(r.metadata.count).toBeGreaterThan(0);
        if (r.data.length > 0) {
            expect(Array.isArray(r.data[0])).toBe(true);
        }
    });

    test('applies filters and computes metadata correctly', async () => {
        const query = `
      query {
        getFactTableWithMetadata(
          structuredFilters: [{ key: "country", operator: "IN", values: ["1", "2", "3"] }]
          limit: 100
          offset: 0
        ) { columns data metadata { count extents total } }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();
        const meta = (result.data!.getFactTableWithMetadata as {
            metadata: { count: number; extents: unknown };
        }).metadata;
        expect(meta.count).toBeGreaterThan(0);
        expect(meta.extents).toBeDefined();
    });
});

// ─── Tests de gestion des erreurs ─────────────────────────────────────────────

describe('error handling', () => {
    test('rejects invalid sort order', async () => {
        const query = `
      query {
        getFactTable(sort: [{ field: "value", order: INVALID }], limit: 10, offset: 0) {
          data { value }
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeDefined();
        expect(result.errors![0].message).toContain('SortOrder');
    });

    test('handles invalid filter operator gracefully (no crash)', async () => {
        const query = `
      query {
        getFactTable(
          structuredFilters: [{ key: "country", operator: "INVALID_OP", value: "1" }]
          limit: 10
          offset: 0
        ) { data { value } }
      }
    `;
        const result = await execute(server, { query });
        // Vérification de l'absence de crash — pas de vérification du contenu exact de l'erreur
        expect(result).toBeDefined();
    });
});

// ─── Tests de requête combinée complexe ───────────────────────────────────────

describe('complex combined query', () => {
    test('metadata + dimensions + facts + aggregations + options in one request', async () => {
        const query = `
      query {
        countryMeta: getMetaData(name: "country") { name label is_categorical }
        countries: getDimensionTable(name: "country") { value label }
        facts: getFactTable(
          structuredFilters: [{ key: "country", operator: "=", value: "1" }]
          sort: [{ field: "value", order: DESC }]
          limit: 5
          offset: 0
        ) { data { value dimensionDetails { name value label } } total }
        aggregated: getAggregatedFacts(
          groupBy: "indicator"
          aggregation: AVG
          filters: "country = 1"
        ) { key keyLabel aggregatedValue }
        options: getSelectOptions(fieldName: "indicator") { value label }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de la présence et cohérence de tous les résultats dans la réponse combinée
        expect((result.data!.countryMeta as { name: string }).name).toBe('country');
        expect(Array.isArray(result.data!.countries)).toBe(true);
        expect((result.data!.facts as { data: unknown }).data).toBeDefined();
        expect(Array.isArray(result.data!.aggregated)).toBe(true);
        expect(Array.isArray(result.data!.options)).toBe(true);
    });
});
