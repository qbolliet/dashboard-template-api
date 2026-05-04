/**
 * Integration tests for the getSelectOptions and getGroupedSelectOptions resolvers.
 *
 * Covers basic value/label retrieval, search term filtering,
 * and grouped option set structure validation.
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

// ─── Tests getSelectOptions ───────────────────────────────────────────────────

describe('getSelectOptions', () => {
    test('returns value/label pairs', async () => {
        const query = `query { getSelectOptions(fieldName: "country", limit: 10) { value label } }`;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de la structure et de la limite des options retournées
        const opts = result.data!.getSelectOptions as Array<{ value: unknown; label: unknown }>;
        expect(Array.isArray(opts)).toBe(true);
        expect(opts.length).toBeLessThanOrEqual(10);
        expect(opts[0]).toHaveProperty('value');
        expect(opts[0]).toHaveProperty('label');
    });

    test('filters options with a search term', async () => {
        const query = `
      query {
        getSelectOptions(fieldName: "country", searchTerm: "Fra", limit: 5) { value label }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification que le terme de recherche est bien présent dans les labels retournés
        const opts = result.data!.getSelectOptions as Array<{ label: string }>;
        if (opts.length > 0) {
            expect(opts[0].label.toLowerCase()).toContain('fra');
        }
    });
});

// ─── Tests getGroupedSelectOptions ───────────────────────────────────────────

describe('getGroupedSelectOptions', () => {
    test('returns group and options arrays', async () => {
        const query = `
      query {
        getGroupedSelectOptions(groupField: "country", optionsField: "indicator", limit: 20) {
          group { value label }
          options { value label }
        }
      }
    `;
        const result = await execute(server, { query });

        expect(result.errors).toBeUndefined();

        // Vérification de la présence des champs group et options dans la réponse groupée
        const r = result.data!.getGroupedSelectOptions as {
            group: unknown;
            options: unknown[];
        };
        expect(r.group).toBeDefined();
        expect(r.options).toBeDefined();
        expect(Array.isArray(r.options)).toBe(true);
    });
});
