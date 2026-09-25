/**
 * Integration tests for codes and labels (metadata.label_for, revue §5.8).
 *
 * Runs against the `trade` schema of the test catalogs: the code hierarchy
 * nc6 → nc8 (VARCHAR codes with leading zeros), the label columns nc6_libelle,
 * nc8_libelle_en and nc8_libelle_fr, the INTEGER code partner_code with its
 * label partner_libelle, one nc8 code without label (NULL on all its rows) and
 * labels carrying an apostrophe. macroeconomics.trade shares three nc8 codes,
 * one of which is labelled only there.
 *
 * Covers Metadata.labelFor / labelFields, getFields(includeLabelFields),
 * getSharedFields, getSelectOptions(labelField), getSelectOptionsTree, the
 * keyLabel of aggregated and compared facts, and a text filter on a label
 * column.
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

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Option de menu renvoyée par getSelectOptions. */
interface Option {
  value: string;
  label: string;
}

/** Nœud d'arbre renvoyé par getSelectOptionsTree. */
interface TreeNode {
  value: string;
  label: string;
  children?: TreeNode[];
}

/** Ligne de comparaison renvoyée par compareFacts / compareAggregatedFacts. */
interface Compared {
  key: string;
  keyLabel: string | null;
}

// ─── Données attendues du schéma trade ────────────────────────────────────────

// Libellés de la fixture (tests/setup/setup-test-data.ts)
const NC6_CHEVAUX = 'Chevaux, autres que reproducteurs de race pure';
const NC6_BOVINS = "Viandes désossées de l'espèce bovine, fraîches ou réfrigérées";

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/**
 * Runs getSelectOptions on the trade schema.
 *
 * @param args - Extra GraphQL arguments, already formatted.
 * @returns Options, or the errors of the response.
 */
// Exécution de getSelectOptions sur le schéma trade
async function selectOptions(args: string): Promise<{
  options: Option[];
  errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }>;
}> {
  const result = await execute(server, {
    query: `query { getSelectOptions(${args}, schema: "trade", limit: 50) { value label } }`,
  });
  return {
    options: (result.data?.getSelectOptions as Option[] | undefined) ?? [],
    errors: result.errors,
  };
}

/**
 * Runs getSelectOptionsTree on the trade schema.
 *
 * @param args - Extra GraphQL arguments, already formatted.
 * @returns The option forest.
 */
// Exécution de getSelectOptionsTree sur le schéma trade
async function tree(args: string): Promise<TreeNode[]> {
  const result = await execute(server, {
    query: `query { getSelectOptionsTree(${args}, schema: "trade") }`,
  });
  expect(result.errors).toBeUndefined();
  return result.data!.getSelectOptionsTree as TreeNode[];
}

// ─── Métadonnées ──────────────────────────────────────────────────────────────

describe('Metadata.labelFor / labelFields', () => {
  test('une colonne de code liste ses colonnes de libellés, triées par nom', async () => {
    const result = await execute(server, {
      query: `query { getMetaData(name: "nc8", schema: "trade") { name labelFor labelFields } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getMetaData).toEqual({
      name: 'nc8',
      labelFor: null,
      labelFields: ['nc8_libelle_en', 'nc8_libelle_fr'],
    });
  });

  test('une colonne de libellés porte labelFor et aucun labelFields', async () => {
    const result = await execute(server, {
      query: `query { getMetaData(name: "nc8_libelle_fr", schema: "trade") { labelFor labelFields } }`,
    });

    expect(result.data!.getMetaData).toEqual({ labelFor: 'nc8', labelFields: [] });
  });

  test('labelFields est vide sur une colonne sans libellés', async () => {
    const result = await execute(server, {
      query: `query { getMetaData(name: "year", schema: "trade") { labelFor labelFields } }`,
    });

    expect(result.data!.getMetaData).toEqual({ labelFor: null, labelFields: [] });
  });

  test('getCatalogSchema rend toutes les colonnes, libellés compris, avec labelFields', async () => {
    const result = await execute(server, {
      query: `query { getCatalogSchema(schema: "trade") { name labelFor labelFields } }`,
    });

    expect(result.errors).toBeUndefined();
    const byName = new Map(
      (
        result.data!.getCatalogSchema as Array<{
          name: string;
          labelFor: string | null;
          labelFields: string[];
        }>
      ).map((row) => [row.name, row]),
    );
    expect(byName.get('nc6')!.labelFields).toEqual(['nc6_libelle']);
    expect(byName.get('partner_code')!.labelFields).toEqual(['partner_libelle']);
    expect(byName.get('nc8_libelle_en')!.labelFor).toBe('nc8');
    expect(byName.get('value')!.labelFields).toEqual([]);
  });

  test('un schéma sans colonne de libellés rend labelFor null partout', async () => {
    const result = await execute(server, {
      query: `query { getCatalogSchema { labelFor labelFields } }`,
    });

    const rows = result.data!.getCatalogSchema as Array<{
      labelFor: string | null;
      labelFields: string[];
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.labelFor === null && row.labelFields.length === 0)).toBe(true);
  });
});

// ─── getFields / getSharedFields ──────────────────────────────────────────────

describe('getFields(includeLabelFields)', () => {
  const LABEL_COLUMNS = ['nc6_libelle', 'nc8_libelle_en', 'nc8_libelle_fr', 'partner_libelle'];

  test('exclut les colonnes de libellés par défaut', async () => {
    const result = await execute(server, {
      query: `query { getFields(schema: "trade") { value } }`,
    });

    expect(result.errors).toBeUndefined();
    const names = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    expect(names).toEqual(
      expect.arrayContaining(['nc6', 'nc8', 'partner_code', 'year', 'value', 'weight_kg']),
    );
    LABEL_COLUMNS.forEach((column) => expect(names).not.toContain(column));
  });

  test('les inclut avec includeLabelFields: true', async () => {
    const result = await execute(server, {
      query: `query { getFields(schema: "trade", includeLabelFields: true) { value } }`,
    });

    const names = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    expect(names).toEqual(expect.arrayContaining(LABEL_COLUMNS));
    expect(names).toHaveLength(10);
  });

  test('se combine avec les autres filtres', async () => {
    const result = await execute(server, {
      query: `query { getFields(schema: "trade", isCategorical: true, includeLabelFields: true) { value } }`,
    });

    const names = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    expect(names).toContain('nc8_libelle_fr');
    expect(names).not.toContain('year');
  });
});

describe('getSharedFields', () => {
  test('exclut les colonnes de libellés : la jointure porte sur le code', async () => {
    const result = await execute(server, {
      query: `query {
        getSharedFields(targets: [
          { catalog: "default", schema: "trade" },
          { catalog: "macroeconomics", schema: "trade" }
        ])
      }`,
    });

    expect(result.errors).toBeUndefined();
    const shared = result.data!.getSharedFields as string[];
    expect(shared).toEqual(expect.arrayContaining(['nc6', 'nc8', 'partner_code']));
    ['nc6_libelle', 'nc8_libelle_en', 'nc8_libelle_fr', 'partner_libelle'].forEach((column) =>
      expect(shared).not.toContain(column),
    );
  });
});

// ─── getSelectOptions ─────────────────────────────────────────────────────────

describe('getSelectOptions sur une colonne de code', () => {
  test('libellé par défaut : le premier par ordre alphabétique (nc8_libelle_en)', async () => {
    const { options, errors } = await selectOptions('fieldName: "nc8"');

    expect(errors).toBeUndefined();
    expect(options).toEqual([
      { value: '01012100', label: 'Pure-bred breeding horses' },
      { value: '01012910', label: 'Horses for slaughter' },
      { value: '01012990', label: 'Horses other than for slaughter' },
      { value: '02013000', label: 'Boneless bovine meat, fresh or chilled' },
      // Code sans libellé : label = value
      { value: '02013090', label: '02013090' },
    ]);
  });

  test('labelField choisit une autre colonne de libellés', async () => {
    const { options } = await selectOptions('fieldName: "nc8", labelField: "nc8_libelle_fr"');

    expect(options.find((o) => o.value === '01012910')!.label).toBe('Chevaux de boucherie');
    expect(options.find((o) => o.value === '02013090')!.label).toBe('02013090');
  });

  test('labelField explicite égal au défaut donne le même résultat', async () => {
    const byDefault = await selectOptions('fieldName: "nc8"');
    const explicit = await selectOptions('fieldName: "nc8", labelField: "nc8_libelle_en"');

    expect(explicit.options).toEqual(byDefault.options);
  });

  test('searchTerm cherche dans le code (zéros de tête conservés)', async () => {
    const { options } = await selectOptions('fieldName: "nc8", searchTerm: "0101"');

    expect(options.map((o) => o.value)).toEqual(['01012100', '01012910', '01012990']);
  });

  test('searchTerm cherche dans un mot du libellé effectif, sans casse', async () => {
    const english = await selectOptions('fieldName: "nc8", searchTerm: "SLAUGHTER"');
    expect(english.options.map((o) => o.value)).toEqual(['01012910', '01012990']);

    const french = await selectOptions(
      'fieldName: "nc8", labelField: "nc8_libelle_fr", searchTerm: "boucherie"',
    );
    expect(french.options.map((o) => o.value)).toEqual(['01012910', '01012990']);

    // Le libellé non retenu n'est pas cherché
    const other = await selectOptions('fieldName: "nc8", searchTerm: "boucherie"');
    expect(other.options).toEqual([]);
  });

  test('restitue et cherche un libellé contenant une apostrophe', async () => {
    const { options, errors } = await selectOptions(
      `fieldName: "nc8", labelField: "nc8_libelle_fr", searchTerm: "l'espèce"`,
    );

    expect(errors).toBeUndefined();
    expect(options).toEqual([
      { value: '02013000', label: "Viandes désossées de l'espèce bovine, fraîches ou réfrigérées" },
    ]);
  });

  test('code INTEGER : value est le code converti en texte', async () => {
    const { options } = await selectOptions('fieldName: "partner_code"');

    expect(options).toEqual([
      { value: '250', label: 'France' },
      { value: '276', label: 'Allemagne' },
      { value: '384', label: "Côte d'Ivoire" },
    ]);

    const byCode = await selectOptions('fieldName: "partner_code", searchTerm: "27"');
    expect(byCode.options).toEqual([{ value: '276', label: 'Allemagne' }]);
    const byLabel = await selectOptions('fieldName: "partner_code", searchTerm: "ivoire"');
    expect(byLabel.options).toEqual([{ value: '384', label: "Côte d'Ivoire" }]);
  });

  test('labelField qui n’est pas un libellé de la colonne → BAD_USER_INPUT', async () => {
    const { errors } = await selectOptions('fieldName: "nc8", labelField: "nc6_libelle"');

    expect(errors).toBeDefined();
    expect(errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(errors![0].message).toContain('nc8_libelle_en, nc8_libelle_fr');
  });
});

describe('getSelectOptions sur une colonne sans libellés', () => {
  test('comportement inchangé : label = value', async () => {
    const { options } = await selectOptions('fieldName: "year"');

    expect(options).toEqual([
      { value: '2023', label: '2023' },
      { value: '2024', label: '2024' },
    ]);
  });

  test('un labelField y est refusé', async () => {
    const { errors } = await selectOptions('fieldName: "year", labelField: "nc8_libelle_fr"');

    expect(errors![0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(errors![0].message).toMatch(/Available: none/);
  });
});

// ─── getSelectOptionsTree ─────────────────────────────────────────────────────

describe('getSelectOptionsTree sur la chaîne de codes nc6 → nc8', () => {
  test('chaque niveau prend le libellé de sa colonne de libellés', async () => {
    expect(await tree('fieldName: "nc8"')).toEqual([
      {
        value: '010121',
        label: 'Chevaux reproducteurs de race pure',
        children: [{ value: '01012100', label: 'Pure-bred breeding horses' }],
      },
      {
        value: '010129',
        label: NC6_CHEVAUX,
        children: [
          { value: '01012910', label: 'Horses for slaughter' },
          { value: '01012990', label: 'Horses other than for slaughter' },
        ],
      },
      {
        value: '020130',
        label: NC6_BOVINS,
        children: [
          { value: '02013000', label: 'Boneless bovine meat, fresh or chilled' },
          { value: '02013090', label: '02013090' },
        ],
      },
    ]);
  });

  test('searchTerm sur le libellé de la feuille garde ses ancêtres', async () => {
    expect(await tree('fieldName: "nc8", searchTerm: "slaughter"')).toEqual([
      {
        value: '010129',
        label: NC6_CHEVAUX,
        children: [
          { value: '01012910', label: 'Horses for slaughter' },
          { value: '01012990', label: 'Horses other than for slaughter' },
        ],
      },
    ]);
  });

  test('searchTerm sur le code de la feuille', async () => {
    const forest = await tree('fieldName: "nc8", searchTerm: "02013"');

    expect(forest.map((n) => n.value)).toEqual(['020130']);
    expect(forest[0].children!.map((n) => n.value)).toEqual(['02013000', '02013090']);
  });

  test('un niveau seul rend ses codes libellés', async () => {
    expect(await tree('fieldName: "nc6"')).toEqual([
      { value: '010121', label: 'Chevaux reproducteurs de race pure' },
      { value: '010129', label: NC6_CHEVAUX },
      { value: '020130', label: NC6_BOVINS },
    ]);
  });
});

// ─── keyLabel des agrégats ────────────────────────────────────────────────────

describe('AggregatedFact.keyLabel', () => {
  test('groupé par nc8 : libellé par défaut lu par ANY_VALUE, null pour un code sans libellé', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "trade", groupBy: "nc8", measure: "value") {
          key keyLabel aggregatedValue count
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getAggregatedFacts).toEqual([
      { key: '01012100', keyLabel: 'Pure-bred breeding horses', aggregatedValue: 6630, count: 6 },
      { key: '01012910', keyLabel: 'Horses for slaughter', aggregatedValue: 12630, count: 6 },
      {
        key: '01012990',
        keyLabel: 'Horses other than for slaughter',
        aggregatedValue: 18630,
        count: 6,
      },
      {
        key: '02013000',
        keyLabel: 'Boneless bovine meat, fresh or chilled',
        aggregatedValue: 24630,
        count: 6,
      },
      { key: '02013090', keyLabel: null, aggregatedValue: 30630, count: 6 },
    ]);
  });

  test('groupé par un code INTEGER', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "trade", groupBy: "partner_code", measure: "value") { key keyLabel }
      }`,
    });

    expect(result.data!.getAggregatedFacts).toEqual([
      { key: '250', keyLabel: 'France' },
      { key: '276', keyLabel: 'Allemagne' },
      { key: '384', keyLabel: "Côte d'Ivoire" },
    ]);
  });

  test('groupé par une colonne sans libellés : keyLabel null', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFacts(schema: "trade", groupBy: "year", measure: "value") { key keyLabel }
      }`,
    });

    expect(result.data!.getAggregatedFacts).toEqual([
      { key: '2023', keyLabel: null },
      { key: '2024', keyLabel: null },
    ]);
  });

  test('getAggregatedFactsWithMetadata suit le même chemin', async () => {
    const result = await execute(server, {
      query: `query {
        getAggregatedFactsWithMetadata(schema: "trade", groupBy: "nc8", measure: "value", limit: 2) {
          data { key keyLabel }
          metadata { groupByFieldInfo { name labelFields } }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const payload = result.data!.getAggregatedFactsWithMetadata as {
      data: Array<{ key: string; keyLabel: string | null }>;
      metadata: { groupByFieldInfo: { name: string; labelFields: string[] } };
    };
    expect(payload.data).toEqual([
      { key: '01012100', keyLabel: 'Pure-bred breeding horses' },
      { key: '01012910', keyLabel: 'Horses for slaughter' },
    ]);
    expect(payload.metadata.groupByFieldInfo).toEqual({
      name: 'nc8',
      labelFields: ['nc8_libelle_en', 'nc8_libelle_fr'],
    });
  });
});

// ─── keyLabel des comparaisons ────────────────────────────────────────────────

describe('ComparedFact.keyLabel', () => {
  // Codes partagés par default.trade et macroeconomics.trade ; 02013090 n'est
  // libellé que dans macroeconomics : le COALESCE des deux côtés le récupère.
  const EXPECTED_LABELS: Record<string, string> = {
    '01012100': 'Pure-bred breeding horses',
    '02013000': 'Boneless bovine meat, fresh or chilled',
    '02013090': 'Other boneless bovine meat',
  };

  test('compareFacts sur un seul champ de jointure doté de libellés', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(
          catalogA: "default", schemaA: "trade",
          catalogB: "macroeconomics", schemaB: "trade",
          joinFields: ["nc8"], limit: 500
        ) { total data { key keyLabel } }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const { total, data } = result.data!.compareFacts as { total: number; data: Compared[] };
    // 6 lignes côté default × 2 côté macroeconomics, pour 3 codes communs
    expect(total).toBe(36);
    expect([...new Set(data.map((row) => row.key))]).toEqual(Object.keys(EXPECTED_LABELS));
    data.forEach((row) => expect(row.keyLabel).toBe(EXPECTED_LABELS[row.key]));
  });

  test('compareFacts sur plusieurs champs de jointure : keyLabel null', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(
          catalogA: "default", schemaA: "trade",
          catalogB: "macroeconomics", schemaB: "trade",
          joinFields: ["nc8", "partner_code"], limit: 5
        ) { data { key keyLabel } }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const { data } = result.data!.compareFacts as { data: Compared[] };
    expect(data.length).toBeGreaterThan(0);
    data.forEach((row) => expect(row.keyLabel).toBeNull());
  });

  test('compareFacts sur une colonne sans libellés : keyLabel null', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(catalogA: "default", catalogB: "macroeconomics", joinFields: ["country"], limit: 3) {
          data { keyLabel }
        }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const { data } = result.data!.compareFacts as { data: Compared[] };
    data.forEach((row) => expect(row.keyLabel).toBeNull());
  });

  test('compareAggregatedFacts suit le chemin de getAggregatedFacts (ANY_VALUE)', async () => {
    const result = await execute(server, {
      query: `query {
        compareAggregatedFacts(
          catalogA: "default", schemaA: "trade",
          catalogB: "macroeconomics", schemaB: "trade",
          groupBy: "nc8"
        ) { total data { key keyLabel } }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const { total, data } = result.data!.compareAggregatedFacts as {
      total: number;
      data: Compared[];
    };
    expect(total).toBe(3);
    expect(data).toEqual(
      Object.entries(EXPECTED_LABELS).map(([key, keyLabel]) => ({ key, keyLabel })),
    );
  });

  test('un schéma invalide est refusé avant toute lecture de métadonnées', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(
          catalogA: "default", schemaA: "nope",
          catalogB: "macroeconomics", schemaB: "trade",
          joinFields: ["nc8"]
        ) { total }
      }`,
    });

    expect(result.errors![0].message).toMatch(/Schema 'nope' is not available/);
  });
});

// ─── Filtres sur une colonne de libellés ──────────────────────────────────────

describe('filtre sur une colonne de libellés', () => {
  test('CONTAINS passe : une colonne de libellés est de la famille texte', async () => {
    const result = await execute(server, {
      query: `query {
        getFactTable(
          schema: "trade",
          fields: ["nc8", "nc8_libelle_fr"],
          structuredFilters: {
            children: [{ criterion: { variable: "nc8_libelle_fr", operation: CONTAINS, value: "bovine" } }]
          }
        ) { total }
      }`,
    });

    expect(result.errors).toBeUndefined();
    // 02013000 seul : 3 partenaires × 2 années
    expect((result.data!.getFactTable as { total: number }).total).toBe(6);
  });
});
