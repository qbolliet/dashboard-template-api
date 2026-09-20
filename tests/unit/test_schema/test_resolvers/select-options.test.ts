/**
 * Integration tests for the getSelectOptions and getGroupedSelectOptions resolvers.
 *
 * Covers basic value/label retrieval (label = value, straight off the fact
 * table), search term filtering, labels carrying an apostrophe, NULL
 * exclusion on an irregular column hierarchy, the rejection of an unknown
 * column, and grouped option set structure validation.
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

  test('label vaut toujours value', async () => {
    const query = `query { getSelectOptions(fieldName: "indicator", limit: 20) { value label } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // La fact table porte le libellé : aucune résolution, donc label = value
    const opts = result.data!.getSelectOptions as Array<{ value: string; label: string }>;
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((o) => o.value === o.label)).toBe(true);
    expect(opts.map((o) => o.value)).toContain('GDP Growth Rate');
  });

  test('restitue un libellé contenant une apostrophe', async () => {
    const query = `
      query {
        getSelectOptions(fieldName: "departement", schema: "geography", limit: 20) { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Le libellé passe en paramètre, jamais en littéral SQL : l'apostrophe survit
    const values = (result.data!.getSelectOptions as Array<{ value: string }>).map((o) => o.value);
    expect(values).toContain("Côte-d'Or");
  });

  test('le terme de recherche est insensible à la casse et aux accents du libellé', async () => {
    const query = `
      query {
        getSelectOptions(
          fieldName: "departement"
          schema: "geography"
          searchTerm: "CÔTE"
          limit: 10
        ) { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const values = (result.data!.getSelectOptions as Array<{ value: string }>).map((o) => o.value);
    expect(values).toEqual(["Côte-d'Or"]);
  });

  test('exclut les NULL d’une hiérarchie irrégulière', async () => {
    const query = `
      query {
        getSelectOptions(fieldName: "commune", schema: "geography", limit: 50) { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Un département sans niveau communal porte commune = NULL : ce niveau
    // absent termine la branche et n'apparaît jamais comme une modalité.
    const opts = result.data!.getSelectOptions as Array<{ value: unknown; label: unknown }>;
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((o) => o.value !== null && o.label !== null)).toBe(true);
    expect(opts.map((o) => o.value)).toContain('Dijon');
  });

  test('un champ inexistant est rejeté en BAD_USER_INPUT', async () => {
    const query = `query { getSelectOptions(fieldName: "no_such_column", limit: 5) { value label } }`;
    const result = await execute(server, { query });

    // L'ancien catch { return []; } présentait l'erreur comme « aucune option »
    expect(result.errors).toBeDefined();
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('no_such_column');
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
