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
 *
 * structuredFilters on both queries: AND / OR filters on another column (the
 * OR root is parenthesized, so it never reopens the NULL rows), combination
 * with searchTerm / limit / maxDepth / labelField, a pruned tree, the node
 * bound counted after the filter, invalid filters (BAD_USER_INPUT before any
 * read), and an absent or null filter leaving the SQL and the loader key as
 * they were.
 */

import { jest } from '@jest/globals';
import { ApolloServer } from '@apollo/server';
import { config } from '../../../../src/utils/config-loader.js';
import { redis } from '../../../../src/cache/index.js';
import { cacheInvalidationManager } from '../../../../src/cache/cache-invalidation.js';
import { SelectOptionsLoader } from '../../../../src/loaders/select-options.js';
import { ensureSetup, getServer, execute } from './helpers.js';
import type { DuckDBConnection } from '../../../../src/loaders/base-loader.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo réutilisé par tous les tests du fichier
let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
  await clearSelectOptionsCache();
}, 60000);

/**
 * Empties the Redis entries of the select options (`select-options:*`, trees
 * included).
 *
 * The cache key hashes the request, not the SQL built from it: an entry
 * written by a previous run would answer without reaching the loader, hiding
 * a change of the generated SQL. Delegates to `cacheInvalidationManager.scanKeys`,
 * which accounts for the client's `keyPrefix`. With Redis down the loader runs
 * on every call, so the tests hold as well.
 */
// Vidage du cache des options de sélection
async function clearSelectOptionsCache(): Promise<void> {
  try {
    const keys = await cacheInvalidationManager.scanKeys('select-options:*');
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // Redis indisponible : le loader s'exécute à chaque appel
  }
}

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

// ─── Tests du filtre structuredFilters ───────────────────────────────────────

/**
 * Builds one child of a filter group.
 *
 * @param variable - Filtered column.
 * @param operation - FilterOperation enum value.
 * @param value - Operand, omitted for IS_TRUE and the like.
 * @param connector - Connector binding it to the previous child.
 * @returns The GraphQL literal of the child.
 */
// Enfant d'un groupe de filtres, écrit en littéral GraphQL
const crit = (
  variable: string,
  operation: string,
  value?: string,
  connector?: 'AND' | 'OR',
): string => {
  const operand = value === undefined ? '' : `, value: ${JSON.stringify(value)}`;
  const link = connector ? `connector: ${connector}, ` : '';
  return `{ ${link}criterion: { variable: "${variable}", operation: ${operation}${operand} } }`;
};

// Argument structuredFilters dont la racine est un groupe de ces enfants
const filterOf = (...children: string[]): string =>
  `structuredFilters: { children: [${children.join(', ')}] }`;

/**
 * Runs getSelectOptions on the geography schema and returns the values.
 *
 * @param args - Extra GraphQL arguments, already formatted.
 * @returns The option values, in the order of the API.
 */
// Valeurs de getSelectOptions sur le schéma geography
const optionValues = async (args: string): Promise<string[]> => {
  const result = await execute(server, {
    query: `query { getSelectOptions(${args}, schema: "geography") { value } }`,
  });
  expect(result.errors).toBeUndefined();
  return (result.data!.getSelectOptions as Array<{ value: string }>).map((o) => o.value);
};

/** Connexion factice : enregistre le SQL et ses paramètres, répond `declared` puis `rows`. */
const recordingConnection = (rows: unknown[] = []) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const connection = {
    all: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      // Première requête : contrôle de déclaration dans metadata
      return calls.length === 1 ? [{ name: 'country' }] : rows;
    },
  } as unknown as DuckDBConnection;
  return { connection, calls };
};

describe('getSelectOptions — structuredFilters', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('un filtre ET sur une autre colonne restreint les modalités', async () => {
    // is_urban et la région : Dijon, Meaux et Montpellier sont urbains, seul Meaux est francilien
    expect(
      await optionValues(
        `fieldName: "commune", ${filterOf(crit('is_urban', 'IS_TRUE'), crit('region', 'EQ', 'Île-de-France'))}`,
      ),
    ).toEqual(['Meaux']);
    // Un enfant seul : le connecteur par défaut ne joue pas
    expect(
      await optionValues(
        `fieldName: "commune", ${filterOf(crit('region', 'EQ', 'Île-de-France'))}`,
      ),
    ).toEqual(['Meaux', 'Melun', 'Paris']);
  });

  test('un filtre OU relie ses enfants', async () => {
    expect(
      await optionValues(
        `fieldName: "commune", ${filterOf(
          crit('region', 'EQ', 'Occitanie'),
          crit('departement', 'EQ', 'Paris', 'OR'),
        )}`,
      ),
    ).toEqual(['Montpellier', 'Paris']);
  });

  test('un filtre OU est parenthésé : il ne rouvre pas les lignes à commune NULL', async () => {
    // Saône-et-Loire a commune = NULL : sans parenthèses, « commune IS NOT NULL AND a OR b »
    // laisserait passer sa ligne par le second opérande, et la modalité NULL deviendrait « null »
    const values = await optionValues(
      `fieldName: "commune", ${filterOf(
        crit('region', 'EQ', 'Occitanie'),
        crit('departement', 'EQ', 'Saône-et-Loire', 'OR'),
      )}`,
    );

    expect(values).toEqual(['Montpellier']);
  });

  test('searchTerm s’applique aux lignes filtrées, y compris derrière un OU', async () => {
    // Sans parenthèses, Montpellier (région Occitanie) échapperait à la recherche « paris »
    expect(
      await optionValues(
        `fieldName: "commune", searchTerm: "paris", ${filterOf(
          crit('region', 'EQ', 'Occitanie'),
          crit('departement', 'EQ', 'Paris', 'OR'),
        )}`,
      ),
    ).toEqual(['Paris']);
    // La recherche seule, dans une région : Paris est hors du terme « me »
    expect(
      await optionValues(
        `fieldName: "commune", searchTerm: "me", ${filterOf(crit('region', 'EQ', 'Île-de-France'))}`,
      ),
    ).toEqual(['Meaux', 'Melun']);
  });

  test('limit s’applique après le filtre', async () => {
    expect(
      await optionValues(
        `fieldName: "commune", limit: 2, ${filterOf(crit('region', 'EQ', 'Île-de-France'))}`,
      ),
    ).toEqual(['Meaux', 'Melun']);
  });

  test('un filtre sans ligne rend une liste vide', async () => {
    expect(
      await optionValues(`fieldName: "commune", ${filterOf(crit('region', 'EQ', 'Atlantis'))}`),
    ).toEqual([]);
  });

  test('deux filtres de même forme mais d’opérandes différents ne partagent pas de résultat', async () => {
    const first = await optionValues(
      `fieldName: "commune", ${filterOf(crit('region', 'EQ', 'Occitanie'))}`,
    );
    const second = await optionValues(
      `fieldName: "commune", ${filterOf(crit('region', 'EQ', 'Île-de-France'))}`,
    );

    expect(first).toEqual(['Montpellier']);
    expect(second).toEqual(['Meaux', 'Melun', 'Paris']);
  });

  test('le filtre passe aussi par une variable GraphQL', async () => {
    const result = await execute(server, {
      query: `query Q($f: FilterNode) {
        getSelectOptions(fieldName: "commune", schema: "geography", structuredFilters: $f) { value }
      }`,
      variables: {
        f: {
          children: [{ criterion: { variable: 'region', operation: 'EQ', value: 'Occitanie' } }],
        },
      },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getSelectOptions).toEqual([{ value: 'Montpellier' }]);
  });

  test('avec une colonne de libellés, le filtre restreint les couples (code, libellé)', async () => {
    const run = (args: string) =>
      execute(server, {
        query: `query { getSelectOptions(fieldName: "nc8", schema: "trade", ${args}) { value label } }`,
      });

    const filtered = await run(filterOf(crit('nc6', 'EQ', '010129')));
    expect(filtered.errors).toBeUndefined();
    expect(filtered.data!.getSelectOptions).toEqual([
      { value: '01012910', label: 'Horses for slaughter' },
      { value: '01012990', label: 'Horses other than for slaughter' },
    ]);

    // La recherche porte sur le code ou le libellé des seules lignes filtrées
    const searched = await run(`searchTerm: "other", ${filterOf(crit('nc6', 'EQ', '010129'))}`);
    expect(searched.data!.getSelectOptions).toEqual([
      { value: '01012990', label: 'Horses other than for slaughter' },
    ]);
  });

  describe('filtre invalide', () => {
    test.each([
      ['une variable inconnue', crit('no_such_column', 'EQ', 'x'), /no_such_column/],
      ['une opération non admise sur le type', crit('region', 'IS_TRUE'), /IS_TRUE/],
    ])('%s → BAD_USER_INPUT, sans SQL de lecture', async (_case, child, message) => {
      const spy = jest.spyOn(SelectOptionsLoader.prototype, 'loadSelectOptions');
      const result = await execute(server, {
        query: `query { getSelectOptions(fieldName: "commune", schema: "geography", ${filterOf(child)}) { value } }`,
      });

      expect(result.data).toBeNull();
      expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(result.errors![0].message).toMatch(message);
      expect(spy).not.toHaveBeenCalled();
    });

    test('un groupe racine vide → BAD_USER_INPUT', async () => {
      const result = await execute(server, {
        query: `query { getSelectOptions(fieldName: "commune", schema: "geography", structuredFilters: { children: [] }) { value } }`,
      });

      expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    });
  });

  describe('sans filtre : strictement le comportement d’avant', () => {
    const ALL_COMMUNES = ['Beaune', 'Dijon', 'Meaux', 'Melun', 'Montpellier', 'Paris'];

    test('absent ou null rend les mêmes modalités', async () => {
      expect(await optionValues('fieldName: "commune"')).toEqual(ALL_COMMUNES);
      expect(await optionValues('fieldName: "commune", structuredFilters: null')).toEqual(
        ALL_COMMUNES,
      );
    });

    test('la clé du loader, donc du cache, ne porte aucun champ where', async () => {
      const spy = jest.spyOn(SelectOptionsLoader.prototype, 'loadWithCache');

      await optionValues('fieldName: "commune"');
      await optionValues('fieldName: "commune", structuredFilters: null');
      await runTree('fieldName: "commune"');
      await runTree('fieldName: "commune", structuredFilters: null');
      const unfiltered = spy.mock.calls.map(([key]) => key);

      // Quatre clés, aucune ne mentionne where (null ≠ absent dans le hachage de la clé)
      expect(unfiltered).toHaveLength(4);
      for (const key of unfiltered) expect(key).not.toHaveProperty('where');

      spy.mockClear();
      await optionValues(`fieldName: "commune", ${filterOf(crit('region', 'EQ', 'Occitanie'))}`);
      expect(spy.mock.calls[0][0]).toHaveProperty('where.sql');
    });

    test('le SQL des trois chemins de lecture est celui d’avant', async () => {
      const loader = new SelectOptionsLoader();
      jest.spyOn(loader, 'resolveColumnChain').mockResolvedValue([
        { column: 'region', labelColumn: null },
        { column: 'commune', labelColumn: null },
      ]);

      const flat = recordingConnection();
      await loader.loadSelectOptions(flat.connection, { fieldName: 'country', limit: 50 });
      expect(flat.calls[1].sql).toMatch(
        /^SELECT DISTINCT "country" AS value FROM .+ WHERE "country" IS NOT NULL ORDER BY "country" LIMIT \?$/,
      );
      expect(flat.calls[1].params).toEqual([50]);

      const labelled = recordingConnection();
      await loader.loadSelectOptions(labelled.connection, {
        fieldName: 'country',
        limit: 50,
        labelField: 'country_label',
        where: null,
      });
      expect(labelled.calls[1].sql).toMatch(
        /^SELECT DISTINCT CAST\("country" AS VARCHAR\) AS value, "country_label" AS label FROM .+ WHERE "country" IS NOT NULL ORDER BY value LIMIT \?$/,
      );
      expect(labelled.calls[1].params).toEqual([50]);

      const tree = recordingConnection();
      await loader.loadSelectOptionsTree(tree.connection, {
        fieldName: 'commune',
        maxDepth: null,
        searchTerm: null,
        maxNodes: 5000,
      });
      expect(tree.calls[0].sql).toMatch(
        /^SELECT DISTINCT "region", "commune" FROM .+ WHERE "region" IS NOT NULL ORDER BY "region", "commune" LIMIT \?$/,
      );
      expect(tree.calls[0].params).toEqual([5001]);
    });
  });

  test('le filtre est parenthésé et ses paramètres précèdent ceux de la recherche', async () => {
    const loader = new SelectOptionsLoader();
    const where = { sql: '"a" = ? OR "b" = ?', params: ['x', 'y'] };

    const flat = recordingConnection();
    await loader.loadSelectOptions(flat.connection, {
      fieldName: 'country',
      limit: 7,
      searchTerm: 'Fr',
      where,
    });
    expect(flat.calls[1].sql).toContain(
      'WHERE "country" IS NOT NULL AND ("a" = ? OR "b" = ?) AND LOWER(CAST("country" AS VARCHAR)) LIKE ?',
    );
    expect(flat.calls[1].params).toEqual(['x', 'y', '%fr%', 7]);

    const labelled = recordingConnection();
    await loader.loadSelectOptions(labelled.connection, {
      fieldName: 'country',
      limit: 7,
      searchTerm: 'Fr',
      labelField: 'country_label',
      where,
    });
    expect(labelled.calls[1].sql).toContain('IS NOT NULL AND ("a" = ? OR "b" = ?) AND (LOWER(');
    expect(labelled.calls[1].params).toEqual(['x', 'y', '%fr%', '%fr%', 7]);
  });

  test('un résultat filtré a le TTL court des variantes filtrées, comme getFieldStats', () => {
    const loader = new SelectOptionsLoader();
    const filtered = { fieldName: 'country', limit: 5, where: { sql: '"a" = ?', params: ['x'] } };

    expect(loader.cacheTimeoutFor(filtered)).toBe(config.API.LOADERS.FACT_CACHE_TIMEOUT);
    expect(loader.cacheTimeoutFor({ fieldName: 'country', limit: 5 })).toBe(
      config.API.LOADERS.SELECT_OPTIONS_CACHE_TIMEOUT,
    );
    expect(loader.cacheTimeoutFor({ ...filtered, where: null })).toBe(
      config.API.LOADERS.SELECT_OPTIONS_CACHE_TIMEOUT,
    );
  });
});

describe('getSelectOptionsTree — structuredFilters', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('élague les branches sans ligne satisfaisant le filtre', async () => {
    const result = await runTree(`fieldName: "commune", ${filterOf(crit('is_urban', 'IS_TRUE'))}`);

    expect(result.errors).toBeUndefined();
    // Beaune, Paris, Melun et Saône-et-Loire (commune NULL) ne sont pas urbains :
    // leurs branches disparaissent, ainsi que les départements qu'elles vidaient
    expect(result.data!.getSelectOptionsTree).toEqual([
      node('Bourgogne-Franche-Comté', node("Côte-d'Or", node('Dijon'))),
      node('Occitanie', node('Hérault', node('Montpellier'))),
      node('Île-de-France', node('Seine-et-Marne', node('Meaux'))),
    ]);
  });

  test('une branche irrégulière reste, feuille comprise, si sa ligne satisfait le filtre', async () => {
    const result = await runTree(
      `fieldName: "commune", ${filterOf(crit('departement', 'EQ', 'Saône-et-Loire'))}`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data!.getSelectOptionsTree).toEqual([
      node('Bourgogne-Franche-Comté', node('Saône-et-Loire')),
    ]);
  });

  test('un filtre OU, avec searchTerm, ne laisse passer que les feuilles recherchées', async () => {
    const result = await runTree(
      `fieldName: "commune", searchTerm: "paris", ${filterOf(
        crit('region', 'EQ', 'Occitanie'),
        crit('departement', 'EQ', 'Paris', 'OR'),
      )}`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data!.getSelectOptionsTree).toEqual([
      node('Île-de-France', node('Paris', node('Paris'))),
    ]);
  });

  test('searchTerm élague l’arbre déjà filtré', async () => {
    const result = await runTree(
      `fieldName: "commune", searchTerm: "me", ${filterOf(crit('is_urban', 'IS_TRUE'))}`,
    );

    // « me » retient Meaux et Melun ; seul Meaux est urbain
    expect(result.data!.getSelectOptionsTree).toEqual([
      node('Île-de-France', node('Seine-et-Marne', node('Meaux'))),
    ]);
  });

  test('maxDepth remonte la chaîne à partir des lignes filtrées', async () => {
    const result = await runTree(
      `fieldName: "commune", maxDepth: 2, ${filterOf(crit('is_urban', 'IS_TRUE'))}`,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data!.getSelectOptionsTree).toEqual([
      node("Côte-d'Or", node('Dijon')),
      node('Hérault', node('Montpellier')),
      node('Seine-et-Marne', node('Meaux')),
    ]);
  });

  describe('borne TREE_MAX_NODES comptée après le filtre', () => {
    const original = config.API.SELECT_OPTIONS;
    afterEach(() => {
      config.API.SELECT_OPTIONS = original;
    });

    const ileDeFrance = filterOf(crit('region', 'EQ', 'Île-de-France'));

    test('un arbre filtré sous la borne passe alors que l’arbre complet la dépasse', async () => {
      // Île-de-France : 6 nœuds ; l'arbre complet en compte 14
      config.API.SELECT_OPTIONS = { TREE_MAX_NODES: 6 };

      const filtered = await runTree(`fieldName: "commune", ${ileDeFrance}`);
      expect(filtered.errors).toBeUndefined();

      const whole = await runTree('fieldName: "commune"');
      expect(whole.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    });

    test('un arbre filtré au-dessus de la borne est rejeté, sans troncature', async () => {
      config.API.SELECT_OPTIONS = { TREE_MAX_NODES: 5 };

      const result = await runTree(`fieldName: "commune", ${ileDeFrance}`);

      expect(result.data).toBeNull();
      expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(result.errors![0].message).toContain('exceeds 5 nodes');
    });
  });

  test.each([
    ['une variable inconnue', crit('no_such_column', 'EQ', 'x'), /no_such_column/],
    ['une opération non admise sur le type', crit('region', 'IS_TRUE'), /IS_TRUE/],
  ])(
    'filtre invalide (%s) → BAD_USER_INPUT, sans SQL de lecture',
    async (_case, child, message) => {
      const spy = jest.spyOn(SelectOptionsLoader.prototype, 'loadSelectOptionsTree');
      const result = await runTree(`fieldName: "commune", ${filterOf(child)}`);

      expect(result.data).toBeNull();
      expect(result.errors![0].extensions?.code).toBe('BAD_USER_INPUT');
      expect(result.errors![0].message).toMatch(message);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  test('le filtre est parenthésé et ses paramètres précèdent ceux de la recherche', async () => {
    const loader = new SelectOptionsLoader();
    jest.spyOn(loader, 'resolveColumnChain').mockResolvedValue([
      { column: 'region', labelColumn: null },
      { column: 'commune', labelColumn: null },
    ]);
    const { connection, calls } = recordingConnection();

    await loader.loadSelectOptionsTree(connection, {
      fieldName: 'commune',
      maxDepth: null,
      searchTerm: 'Me',
      maxNodes: 10,
      where: { sql: '"a" = ? OR "b" = ?', params: ['x', 'y'] },
    });

    expect(calls[0].sql).toContain(
      'WHERE "region" IS NOT NULL AND ("a" = ? OR "b" = ?) AND LOWER(CAST("commune" AS VARCHAR)) LIKE ?',
    );
    expect(calls[0].params).toEqual(['x', 'y', '%me%', 11]);
  });

  test('absent ou null rend l’arbre complet d’avant', async () => {
    const whole = await runTree('fieldName: "commune"');
    const withNull = await runTree('fieldName: "commune", structuredFilters: null');

    expect(withNull.errors).toBeUndefined();
    expect(withNull.data).toEqual(whole.data);
    expect((whole.data!.getSelectOptionsTree as TreeNode[]).length).toBe(3);
  });
});
