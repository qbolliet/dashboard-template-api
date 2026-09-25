/**
 * Integration tests for the getSelectOptions and getSelectOptionsTree resolvers.
 *
 * getSelectOptions: value/label retrieval (label = value, straight off the
 * fact table), search term filtering, labels carrying an apostrophe, NULL
 * exclusion on an irregular column hierarchy, rejection of an unknown column.
 *
 * getSelectOptionsTree, on the region → departement → commune chain of the
 * geography schema: full tree, maxDepth (group-options format, each commune
 * under its own departement), irregular branch, searchTerm pruning, column
 * without parent, invalid maxDepth, unknown field and TREE_MAX_NODES overflow.
 */

import { ApolloServer } from '@apollo/server';
import { config } from '../../../../src/utils/config-loader.js';
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

// ─── Tests getSelectOptionsTree ──────────────────────────────────────────────

/** Nœud d'arbre d'options tel que le rend le scalaire JSON. */
interface TreeNode {
  value: string;
  label: string;
  children?: TreeNode[];
}

/**
 * Builds the expected node, `label = value`, children omitted on a leaf.
 *
 * @param value - Node value (and label).
 * @param children - Child nodes; none for a leaf.
 * @returns The node as the API renders it.
 */
// Nœud attendu : label = value, children absent sur une feuille
const node = (value: string, ...children: TreeNode[]): TreeNode =>
  children.length > 0 ? { value, label: value, children } : { value, label: value };

/**
 * Runs getSelectOptionsTree on the geography schema.
 *
 * @param args - Extra GraphQL arguments, already formatted.
 * @returns Normalised GraphQL result.
 */
// Exécution de la query sur le schéma geography
const runTree = (args: string) =>
  execute(server, {
    query: `query { getSelectOptionsTree(${args}, schema: "geography") }`,
  });

describe('getSelectOptionsTree', () => {
  test('rend l’arbre complet de la chaîne region → departement → commune', async () => {
    const result = await runTree('fieldName: "commune"');

    expect(result.errors).toBeUndefined();
    // Tri déterministe (ORDER BY de la chaîne, collation binaire : « Î » après « O »)
    expect(result.data!.getSelectOptionsTree).toEqual([
      node(
        'Bourgogne-Franche-Comté',
        node("Côte-d'Or", node('Beaune'), node('Dijon')),
        node('Saône-et-Loire'),
      ),
      node('Occitanie', node('Hérault', node('Montpellier'))),
      node(
        'Île-de-France',
        node('Paris', node('Paris')),
        node('Seine-et-Marne', node('Meaux'), node('Melun')),
      ),
    ]);
  });

  test('maxDepth: 2 rend le group-options, chaque commune sous SON département', async () => {
    const result = await runTree('fieldName: "commune", maxDepth: 2');

    expect(result.errors).toBeUndefined();
    const tree = result.data!.getSelectOptionsTree as TreeNode[];
    expect(tree).toEqual([
      node("Côte-d'Or", node('Beaune'), node('Dijon')),
      node('Hérault', node('Montpellier')),
      node('Paris', node('Paris')),
      node('Saône-et-Loire'),
      node('Seine-et-Marne', node('Meaux'), node('Melun')),
    ]);

    // Bug de l'ancienne getGroupedSelectOptions : deux listes non corrélées.
    // Ici une commune n'apparaît qu'une fois, sous son seul département.
    const communes = tree.flatMap((d) => (d.children ?? []).map((c) => c.value));
    expect(new Set(communes).size).toBe(communes.length);
  });

  test('une branche irrégulière s’arrête au département, sans nœud vide', async () => {
    const result = await runTree('fieldName: "commune"');

    const tree = result.data!.getSelectOptionsTree as TreeNode[];
    const bourgogne = tree.find((r) => r.value === 'Bourgogne-Franche-Comté')!;
    const saone = bourgogne.children!.find((d) => d.value === 'Saône-et-Loire')!;

    // Commune NULL : le département est une feuille (spec bdd §2.5)
    expect(saone).toEqual({ value: 'Saône-et-Loire', label: 'Saône-et-Loire' });
    expect(saone).not.toHaveProperty('children');
    // Aucun libellé vide ni nul fabriqué nulle part dans l'arbre
    const all = (nodes: TreeNode[]): TreeNode[] =>
      nodes.flatMap((n) => [n, ...all(n.children ?? [])]);
    expect(all(tree).every((n) => typeof n.value === 'string' && n.value !== '')).toBe(true);
  });

  test('searchTerm garde les ancêtres des feuilles retenues et élague le reste', async () => {
    const result = await runTree('fieldName: "commune", searchTerm: "ME"');

    expect(result.errors).toBeUndefined();
    // « me » ne retient que Meaux et Melun : une seule région, un seul département
    expect(result.data!.getSelectOptionsTree).toEqual([
      node('Île-de-France', node('Seine-et-Marne', node('Meaux'), node('Melun'))),
    ]);
  });

  test('une colonne sans parentName rend un arbre à un niveau', async () => {
    const result = await runTree('fieldName: "region"');

    expect(result.errors).toBeUndefined();
    expect(result.data!.getSelectOptionsTree).toEqual([
      node('Bourgogne-Franche-Comté'),
      node('Occitanie'),
      node('Île-de-France'),
    ]);
  });

  test('maxDepth < 1 est rejeté en BAD_USER_INPUT', async () => {
    const result = await runTree('fieldName: "commune", maxDepth: 0');

    expect(result.errors).toBeDefined();
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('maxDepth');
  });

  test('un champ inexistant est rejeté en BAD_USER_INPUT', async () => {
    const result = await runTree('fieldName: "no_such_column"');

    expect(result.errors).toBeDefined();
    expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(result.errors![0].message).toContain('no_such_column');
  });

  describe('borne TREE_MAX_NODES', () => {
    // Configuration réduite le temps du test, restaurée ensuite
    const original = config.API.SELECT_OPTIONS;
    afterEach(() => {
      config.API.SELECT_OPTIONS = original;
    });

    test.each([
      // 7 lignes distinctes > 3 : rejet dès la lecture (plafond LIMIT)
      ['par le plafond de lignes', 3],
      // 7 lignes ≤ 10 mais 14 nœuds > 10 : rejet à la construction
      ['à la construction de l’arbre', 10],
    ])('dépassement détecté %s → BAD_USER_INPUT, sans troncature', async (_case, maxNodes) => {
      config.API.SELECT_OPTIONS = { TREE_MAX_NODES: maxNodes };

      const result = await runTree('fieldName: "commune"');

      expect(result.data).toBeNull();
      expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(result.errors![0].message).toContain(`exceeds ${maxNodes} nodes`);
      expect(result.errors![0].message).toContain('searchTerm');
      expect(result.errors![0].message).toContain('maxDepth');
    });

    test('un arbre sous la borne passe', async () => {
      config.API.SELECT_OPTIONS = { TREE_MAX_NODES: 14 };

      const result = await runTree('fieldName: "commune"');

      expect(result.errors).toBeUndefined();
    });
  });
});
