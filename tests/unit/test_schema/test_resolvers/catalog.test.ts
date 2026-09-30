/**
 * Integration tests for the getCatalogs, getCatalogSchema, getFields,
 * and getSharedFields resolvers.
 *
 * Covers catalog listing (id + defaultSchema + schemas), schema field
 * metadata, SelectOption filtering, the field intersection across
 * (catalog, schema) targets, and error handling for invalid identifiers.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';

// ─── Ordre attendu des colonnes ───────────────────────────────────────────────

// Ordre des colonnes de fact_table (tests/setup/setup-test-data.ts)
const MAIN_COLUMN_ORDER = [
  'country',
  'indicator',
  'kind',
  'model',
  'training',
  'date',
  'horizon',
  'value',
  'lower_bound',
  'upper_bound',
  'headcount',
  'sample_size',
  'is_provisional',
  'ingested_at',
  'notes',
  'quality_score',
];
const GEOGRAPHY_COLUMN_ORDER = [
  'region',
  'departement',
  'commune',
  'date',
  'population',
  'area_km2',
  'budget',
  'density',
  'is_urban',
];

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo réutilisé par tous les tests du fichier
let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

// ─── Tests getCatalogs ────────────────────────────────────────────────────────

describe('getCatalogs', () => {
  test('returns at least one catalog entry', async () => {
    const query = `
      query {
        getCatalogs {
          id
          defaultSchema
          schemas { name }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const catalogs = result.data!.getCatalogs as unknown[];
    expect(Array.isArray(catalogs)).toBe(true);
    expect(catalogs.length).toBeGreaterThan(0);
  });

  test('each entry has id, defaultSchema, and schemas array of {name}', async () => {
    const query = `query { getCatalogs { id defaultSchema schemas { name } } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de la structure de chaque entrée de catalogue
    const catalogs = result.data!.getCatalogs as Array<{
      id: string;
      defaultSchema: string;
      schemas: Array<{ name: string }>;
    }>;
    for (const cat of catalogs) {
      expect(typeof cat.id).toBe('string');
      expect(cat.id.length).toBeGreaterThan(0);
      expect(typeof cat.defaultSchema).toBe('string');
      expect(cat.defaultSchema.length).toBeGreaterThan(0);
      expect(Array.isArray(cat.schemas)).toBe(true);
      expect(cat.schemas.length).toBeGreaterThan(0);
      for (const s of cat.schemas) {
        expect(typeof s.name).toBe('string');
        expect(s.name.length).toBeGreaterThan(0);
      }
    }
  });

  test('defaultSchema belongs to schemas', async () => {
    const query = `query { getCatalogs { id defaultSchema schemas { name } } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Le schéma par défaut doit appartenir à la liste des schémas du catalogue
    const catalogs = result.data!.getCatalogs as Array<{
      id: string;
      defaultSchema: string;
      schemas: Array<{ name: string }>;
    }>;
    for (const cat of catalogs) {
      const names = cat.schemas.map((s) => s.name);
      expect(names).toContain(cat.defaultSchema);
    }
  });

  // ── Cascade lazy : fields n'est chargé que s'il est demandé ──
  test('cascade — fields load when requested', async () => {
    // Cascade limitée à un catalogue entièrement conforme : `fields` est
    // non-nullable, donc un schéma refusé par la garde de version propagerait
    // son erreur jusqu'à la racine (cf. le test de garde ci-dessous).
    const query = `
      query {
        getCatalogSchema(catalog: "macroeconomics", schema: "main") {
          name
          isCategorical
          isPrimaryKey
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    const fields = result.data!.getCatalogSchema as Array<{
      name: string;
      isCategorical: boolean;
      isPrimaryKey: boolean;
    }>;

    // Le schéma déclare ses colonnes, dont au moins une clé primaire
    // (cohérence loader / scoping de schéma correct).
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.some((f) => f.isPrimaryKey)).toBe(true);
  });

  // ── Découverte : aucune liste SCHEMAS n'est configurée dans les tests ──
  test('sans liste SCHEMAS, liste les schémas conformes découverts, « main » d’abord', async () => {
    const result = await execute(server, {
      query: 'query { getCatalogs { id defaultSchema schemas { name } } }',
    });

    expect(result.errors).toBeUndefined();
    const catalogs = result.data!.getCatalogs as Array<{
      id: string;
      defaultSchema: string;
      schemas: Array<{ name: string }>;
    }>;
    const namesOf = (id: string): string[] | undefined =>
      catalogs.find((cat) => cat.id === id)?.schemas.map((s) => s.name);

    // main d'abord (c'est le défaut), puis l'ordre alphabétique
    expect(namesOf('default')).toEqual([
      'main',
      'emploi',
      'geography',
      'no_primary_key',
      'predictions',
      'trade',
    ]);
    expect(namesOf('macroeconomics')).toEqual(['main', 'trade']);
    expect(namesOf('public_finance')).toEqual(['main']);
    expect(catalogs.map((cat) => cat.defaultSchema)).toEqual(['main', 'main', 'main']);
  });

  test('n’expose pas les schémas refusés par la garde de version', async () => {
    const result = await execute(server, {
      query: 'query { getCatalogs { id schemas { name } } }',
    });

    const names = (result.data!.getCatalogs as Array<{ schemas: Array<{ name: string }> }>).flatMap(
      (cat) => cat.schemas.map((s) => s.name),
    );
    expect(names).not.toContain('unsupported_version');
    expect(names).not.toContain('missing_dataset_metadata');
  });

  test('un schéma exclu de la liste reste refusé par la garde, pas « inconnu »', async () => {
    // Il est découvert (donc adressable) mais non servi : l'erreur dit pourquoi
    for (const schema of ['unsupported_version', 'missing_dataset_metadata']) {
      const result = await execute(server, {
        query: `query { getCatalogSchema(schema: "${schema}") { name } }`,
      });
      expect(result.errors).toBeDefined();
      expect(result.errors![0].extensions?.code).toBe('SCHEMA_VERSION_UNSUPPORTED');
    }
  });

  // ── La cascade traverse chaque schéma listé ──
  test('cascade — fields se résout pour chaque schéma listé, sans erreur', async () => {
    const result = await execute(server, {
      query: 'query { getCatalogs { id schemas { name fields { name } } } }',
    });

    // Les fixtures non conformes ne sont pas listées : plus rien à refuser, et
    // la cascade complète (fields non-nullable) aboutit
    expect(result.errors).toBeUndefined();
    const catalogs = result.data!.getCatalogs as Array<{
      schemas: Array<{ name: string; fields: Array<{ name: string }> }>;
    }>;
    for (const cat of catalogs) {
      for (const schema of cat.schemas) {
        expect(schema.fields.length).toBeGreaterThan(0);
      }
    }
  });

  test('cascade — schemas { name } stays lightweight (no fields requested)', async () => {
    // Asking only for names must not load any schema. Acts as a smoke check
    // that the resolver is genuinely lazy.
    const query = `query { getCatalogs { id schemas { name } } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const catalogs = result.data!.getCatalogs as Array<{
      id: string;
      schemas: Array<{ name: string }>;
    }>;
    for (const cat of catalogs) {
      for (const s of cat.schemas) {
        expect(s).not.toHaveProperty('fields');
      }
    }
  });
});

// ─── Tests getCatalogSchema ───────────────────────────────────────────────────

describe('getCatalogSchema', () => {
  // ── Ordre des colonnes : celui de fact_table, non celui de la table metadata ──
  test.each<[string, string[]]>([
    ['main', MAIN_COLUMN_ORDER],
    ['geography', GEOGRAPHY_COLUMN_ORDER],
    // La base écrit metadata par ordre alphabétique : amount, label, observed_on…
    ['no_primary_key', ['label', 'observed_on', 'amount', 'slot', 'quantity']],
  ])('%s: les champs suivent l’ordre des colonnes de fact_table', async (schema, expected) => {
    const result = await execute(server, {
      query: `query { getCatalogSchema(schema: "${schema}") { name } }`,
    });

    expect(result.errors).toBeUndefined();
    const names = (result.data!.getCatalogSchema as Array<{ name: string }>).map((f) => f.name);
    expect(names).toEqual(expected);
  });

  test('getFields et Catalog.schemas.fields suivent le même ordre', async () => {
    const [fields, cascade] = await Promise.all([
      execute(server, {
        query: 'query { getFields(schema: "no_primary_key") { value } }',
      }),
      execute(server, {
        query: 'query { getCatalogs { id schemas { name fields { name } } } }',
      }),
    ]);

    expect(fields.errors).toBeUndefined();
    const expected = ['label', 'observed_on', 'amount', 'slot', 'quantity'];
    expect((fields.data!.getFields as Array<{ value: string }>).map((f) => f.value)).toEqual(
      expected,
    );
    const catalogs = cascade.data!.getCatalogs as Array<{
      id: string;
      schemas: Array<{ name: string; fields: Array<{ name: string }> }>;
    }>;
    const nokey = catalogs
      .find((cat) => cat.id === 'default')!
      .schemas.find((s) => s.name === 'no_primary_key')!;
    expect(nokey.fields.map((f) => f.name)).toEqual(expected);
  });

  test('returns field metadata without a catalog parameter (uses default)', async () => {
    const query = `
      query {
        getCatalogSchema {
          name
          label
          sqlType
          isCategorical
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const fields = result.data!.getCatalogSchema as Array<{
      name: string;
      label: string;
      sqlType: string;
      isCategorical: boolean;
    }>;
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields[0]).toHaveProperty('name');
    expect(fields[0]).toHaveProperty('label');
    expect(fields[0]).toHaveProperty('sqlType');
    expect(typeof fields[0].isCategorical).toBe('boolean');
  });

  test('same result with and without explicit empty catalog param', async () => {
    const noParam = `query { getCatalogSchema { name isCategorical } }`;
    const withEmpty = `query { getCatalogSchema(catalog: "") { name isCategorical } }`;

    const r1 = await execute(server, { query: noParam });
    const r2 = await execute(server, { query: withEmpty });

    expect(r1.errors).toBeUndefined();
    expect(r2.errors).toBeUndefined();

    // Vérification de l'équivalence des résultats avec et sans paramètre catalog
    const names1 = (r1.data!.getCatalogSchema as Array<{ name: string }>).map((f) => f.name).sort();
    const names2 = (r2.data!.getCatalogSchema as Array<{ name: string }>).map((f) => f.name).sort();
    expect(names2).toEqual(names1);
  });

  test('schema contains the known test fields (country, indicator, value)', async () => {
    const query = `query { getCatalogSchema { name isCategorical } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Présence obligatoire des champs de référence du jeu de données de test
    const names = (result.data!.getCatalogSchema as Array<{ name: string }>).map((f) => f.name);
    expect(names).toContain('country');
    expect(names).toContain('indicator');
    expect(names).toContain('value');
  });

  test('rejects an invalid catalog name', async () => {
    const query = `query { getCatalogSchema(catalog: "nonexistent_xyz") { name } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });

  test('rejects an unknown schema not in the catalog allow-list', async () => {
    // 'totally_unknown_schema' n'est ni dans la config ni dans la découverte
    // — l'allow-list (isValidSchema) doit rejeter, pas une simple validation regex.
    const query = `query { getCatalogSchema(catalog: "default", schema: "totally_unknown_schema") { name } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toMatch(/Schema "totally_unknown_schema" is not available/);
  });

  test('multiple catalogs in a single query', async () => {
    const query = `
      query {
        schema1: getCatalogSchema { name isCategorical }
        schema2: getCatalogSchema(catalog: "") { name isCategorical }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data!.schema1)).toBe(true);
    expect(Array.isArray(result.data!.schema2)).toBe(true);
  });
});

// ─── Tests getFields ──────────────────────────────────────────────────────────

describe('getFields', () => {
  // Helper local : récupère les noms des champs catégoriels du catalogue par défaut
  // depuis getCatalogSchema, le champ dimensionNames ayant été retiré.
  async function defaultCategoricalNames(): Promise<string[]> {
    const query = `query { getCatalogSchema { name isCategorical } }`;
    const result = await execute(server, { query });
    if (result.errors) return [];
    const fields = result.data!.getCatalogSchema as Array<{
      name: string;
      isCategorical: boolean;
    }>;
    return fields.filter((f) => f.isCategorical).map((f) => f.name);
  }

  test('returns all fields as {value, label} pairs by default', async () => {
    const query = `query { getFields { value label } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification de la structure {value, label} renvoyée pour chaque champ
    const fields = result.data!.getFields as Array<{ value: unknown; label: unknown }>;
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) {
      expect(typeof f.value).toBe('string');
      expect(typeof f.label).toBe('string');
      expect((f.value as string).length).toBeGreaterThan(0);
      expect((f.label as string).length).toBeGreaterThan(0);
    }
  });

  test('value corresponds to the field name (known test fields present)', async () => {
    const query = `query { getFields { value } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Présence obligatoire des champs de référence du jeu de données de test
    const values = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    expect(values).toContain('country');
    expect(values).toContain('indicator');
    expect(values).toContain('value');
  });

  test('isCategorical: true returns only fields marked categorical in the default schema', async () => {
    const categorical = await defaultCategoricalNames();

    const query = `query { getFields(isCategorical: true) { value } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Tous les champs catégoriels doivent figurer parmi les champs du catalogue
    const values = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(categorical).toContain(v);
    }
  });

  test('isCategorical: false returns only fields NOT marked categorical', async () => {
    const categorical = await defaultCategoricalNames();

    const query = `query { getFields(isCategorical: false) { value } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Aucun champ continu ne doit être annoncé comme catégoriel
    const values = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    for (const v of values) {
      expect(categorical).not.toContain(v);
    }
  });

  test('sqlType filter only returns fields with the matching sqlType', async () => {
    // Récupération préalable d'un type SQL présent dans le catalogue
    const schemaQuery = `query { getCatalogSchema { name sqlType } }`;
    const schemaResult = await execute(server, { query: schemaQuery });
    const schema = schemaResult.data!.getCatalogSchema as Array<{
      name: string;
      sqlType: string | null;
    }>;
    const sampleType = schema.find((f) => f.sqlType)?.sqlType;
    if (!sampleType) return;

    const query = `query { getFields(sqlType: "${sampleType}") { value } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification que tous les champs retournés correspondent bien au type filtré
    const values = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    const expected = schema
      .filter((f) => (f.sqlType ?? '').toLowerCase() === sampleType.toLowerCase())
      .map((f) => f.name);
    expect(values.sort()).toEqual(expected.sort());
  });

  test('namePattern matches substrings case-insensitively', async () => {
    const query = `query { getFields(namePattern: "COUN") { value } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Toutes les valeurs retournées doivent contenir la sous-chaîne, sans tenir compte de la casse
    const values = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v.toLowerCase()).toContain('coun');
    }
  });

  test('combines multiple filters with AND semantics', async () => {
    const query = `
      query {
        getFields(isCategorical: true, namePattern: "country") { value }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Intersection: catégoriel ET nom contenant "country"
    const values = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    for (const v of values) {
      expect(v.toLowerCase()).toContain('country');
    }
  });

  test('unknown sqlType yields an empty array without error', async () => {
    const query = `query { getFields(sqlType: "TYPE_QUI_N_EXISTE_PAS") { value } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getFields).toEqual([]);
  });

  test('rejects an invalid catalog name', async () => {
    const query = `query { getFields(catalog: "nonexistent_xyz") { value } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });

  test('supports multiple aliases in a single query (disjoint results)', async () => {
    const query = `
      query {
        categorical: getFields(isCategorical: true) { value }
        continuous: getFields(isCategorical: false) { value }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Les deux ensembles doivent être disjoints (aucun champ partagé)
    const cat = (result.data!.categorical as Array<{ value: string }>).map((f) => f.value);
    const cont = (result.data!.continuous as Array<{ value: string }>).map((f) => f.value);
    for (const v of cat) {
      expect(cont).not.toContain(v);
    }
  });
});

// ─── Tests getSharedFields ────────────────────────────────────────────────────

describe('getSharedFields', () => {
  /**
   * Lists the categorical column names of a (catalog, schema) pair.
   *
   * @param catalog - Catalog alias.
   * @param schema - Schema name, or null for the catalog default.
   * @returns Names of the columns flagged categorical.
   */
  // Colonnes catégorielles d'une cible, lues via getCatalogSchema
  async function categoricalNames(
    catalog: string,
    schema: string | null = null,
  ): Promise<string[]> {
    const schemaArg = schema ? `, schema: "${schema}"` : '';
    const query = `query { getCatalogSchema(catalog: "${catalog}"${schemaArg}) { name isCategorical } }`;
    const result = await execute(server, { query });
    if (result.errors) return [];
    const fields = result.data!.getCatalogSchema as Array<{
      name: string;
      isCategorical: boolean;
    }>;
    return fields.filter((f) => f.isCategorical).map((f) => f.name);
  }

  /**
   * Runs getSharedFields over the given targets.
   *
   * @param targets - GraphQL literal of the targets argument.
   * @returns The resolver result and its errors.
   */
  // Exécution de getSharedFields sur une liste de cibles
  async function sharedFields(targets: string) {
    return execute(server, { query: `query { getSharedFields(targets: ${targets}) }` });
  }

  test('une cible unique rend ses colonnes catégorielles', async () => {
    const expected = await categoricalNames('default');

    const result = await sharedFields('[{ catalog: "default" }]');

    expect(result.errors).toBeUndefined();
    const shared = result.data!.getSharedFields as string[];
    expect(shared.length).toBeGreaterThan(0);
    // Seules les colonnes catégorielles sont retournées (comportement documenté
    // dans le SDL) : date et horizon, clés non catégorielles, sont exclues.
    expect([...shared].sort()).toEqual([...expected].sort());
    expect(shared).not.toContain('date');
    expect(shared).not.toContain('value');
  });

  test('deux catalogues au même format partagent toutes leurs catégorielles', async () => {
    const expected = await categoricalNames('default');

    const result = await sharedFields('[{ catalog: "default" }, { catalog: "macroeconomics" }]');

    expect(result.errors).toBeUndefined();
    const shared = result.data!.getSharedFields as string[];
    expect([...shared].sort()).toEqual([...expected].sort());
  });

  test('deux schémas de formats différents n’ont aucune colonne commune', async () => {
    // main porte country/indicator/…, geography porte region/departement/commune
    const result = await sharedFields(
      '[{ catalog: "default", schema: "main" }, { catalog: "default", schema: "geography" }]',
    );

    expect(result.errors).toBeUndefined();
    expect(result.data!.getSharedFields).toEqual([]);
  });

  test('la cible répétée est idempotente', async () => {
    const once = await sharedFields('[{ catalog: "default" }]');
    const twice = await sharedFields('[{ catalog: "default" }, { catalog: "default" }]');

    expect(twice.errors).toBeUndefined();
    expect(twice.data!.getSharedFields).toEqual(once.data!.getSharedFields);
  });

  test('rejects an empty targets list', async () => {
    const result = await sharedFields('[]');

    expect(result.errors).toBeDefined();
  });

  test('rejects an unknown catalog name', async () => {
    const result = await sharedFields('[{ catalog: "nonexistent_db" }]');

    expect(result.errors).toBeDefined();
  });

  test('rejects an unknown schema in a target', async () => {
    const result = await sharedFields('[{ catalog: "default", schema: "totally_unknown_schema" }]');

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toMatch(/Schema "totally_unknown_schema" is not available/);
  });
});
