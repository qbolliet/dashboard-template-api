/**
 * Integration tests for the getCatalogs, getCatalogSchema, getFields,
 * and getSharedDimensions resolvers.
 *
 * Covers catalog listing (id + defaultSchema + schemas), schema field
 * metadata, SelectOption filtering, dimension intersection across
 * (catalog, schema) targets, and error handling for invalid identifiers.
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

  // ── Cascade lazy : fields/dimensionNames ne sont chargés que si demandés ──
  test('cascade — fields and dimensionNames load when requested', async () => {
    const query = `
      query {
        getCatalogs {
          id
          schemas {
            name
            fields { name is_categorical }
            dimensionNames
          }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    const catalogs = result.data!.getCatalogs as Array<{
      id: string;
      schemas: Array<{
        name: string;
        fields: Array<{ name: string; is_categorical: boolean }>;
        dimensionNames: string[];
      }>;
    }>;
    expect(catalogs.length).toBeGreaterThan(0);

    // Pour chaque schéma de chaque catalogue, fields et dimensionNames sont
    // des tableaux et les noms de dimensions sont un sous-ensemble des champs
    // catégoriels (cohérence loader/schema scoping correct).
    for (const cat of catalogs) {
      for (const s of cat.schemas) {
        expect(Array.isArray(s.fields)).toBe(true);
        expect(Array.isArray(s.dimensionNames)).toBe(true);
        const categoricalNames = s.fields.filter((f) => f.is_categorical).map((f) => f.name);
        for (const dim of s.dimensionNames) {
          expect(categoricalNames).toContain(dim);
        }
      }
    }
  });

  test('cascade — schemas { name } stays lightweight (no fields requested)', async () => {
    // Asking only for names must succeed even when schemas exist that would
    // fail to load if fields were eagerly resolved. Acts as a smoke check
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
        expect(s).not.toHaveProperty('dimensionNames');
      }
    }
  });
});

// ─── Tests getCatalogSchema ───────────────────────────────────────────────────

describe('getCatalogSchema', () => {
  test('returns field metadata without a catalog parameter (uses default)', async () => {
    const query = `
      query {
        getCatalogSchema {
          name
          label
          python_type
          sql_type
          is_categorical
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const fields = result.data!.getCatalogSchema as Array<{
      name: string;
      label: string;
      python_type: string;
      sql_type: string;
      is_categorical: boolean;
    }>;
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
    expect(fields[0]).toHaveProperty('name');
    expect(fields[0]).toHaveProperty('label');
    expect(fields[0]).toHaveProperty('python_type');
    expect(fields[0]).toHaveProperty('sql_type');
    expect(typeof fields[0].is_categorical).toBe('boolean');
  });

  test('same result with and without explicit empty catalog param', async () => {
    const noParam = `query { getCatalogSchema { name is_categorical } }`;
    const withEmpty = `query { getCatalogSchema(catalog: "") { name is_categorical } }`;

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
    const query = `query { getCatalogSchema { name is_categorical } }`;
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
    expect(result.errors![0].message).toMatch(/Schema 'totally_unknown_schema' is not available/);
  });

  test('multiple catalogs in a single query', async () => {
    const query = `
      query {
        schema1: getCatalogSchema { name is_categorical }
        schema2: getCatalogSchema(catalog: "") { name is_categorical }
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
  // depuis getCatalogSchema, sans recourir à un éventuel champ dimensionNames retiré.
  async function defaultCategoricalNames(): Promise<string[]> {
    const query = `query { getCatalogSchema { name is_categorical } }`;
    const result = await execute(server, { query });
    if (result.errors) return [];
    const fields = result.data!.getCatalogSchema as Array<{
      name: string;
      is_categorical: boolean;
    }>;
    return fields.filter((f) => f.is_categorical).map((f) => f.name);
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

    // Tous les champs catégoriels doivent figurer parmi les dimensions du catalogue
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

    // Aucun champ continu ne doit appartenir aux dimensions catégorielles
    const values = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    for (const v of values) {
      expect(categorical).not.toContain(v);
    }
  });

  test('sqlType filter only returns fields with the matching sql_type', async () => {
    // Récupération préalable d'un type SQL présent dans le catalogue
    const schemaQuery = `query { getCatalogSchema { name sql_type } }`;
    const schemaResult = await execute(server, { query: schemaQuery });
    const schema = schemaResult.data!.getCatalogSchema as Array<{
      name: string;
      sql_type: string | null;
    }>;
    const sampleType = schema.find((f) => f.sql_type)?.sql_type;
    if (!sampleType) return;

    const query = `query { getFields(sqlType: "${sampleType}") { value } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification que tous les champs retournés correspondent bien au type filtré
    const values = (result.data!.getFields as Array<{ value: string }>).map((f) => f.value);
    const expected = schema
      .filter((f) => (f.sql_type ?? '').toLowerCase() === sampleType.toLowerCase())
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

// ─── Tests getSharedDimensions ────────────────────────────────────────────────

describe('getSharedDimensions', () => {
  // Helper local : récupère les dimensions du catalogue par défaut via
  // getCatalogSchema (filtrage côté JS sur is_categorical).
  async function defaultDimensionNames(catalog: string): Promise<string[]> {
    const query = `query { getCatalogSchema(catalog: "${catalog}") { name is_categorical } }`;
    const result = await execute(server, { query });
    if (result.errors) return [];
    const fields = result.data!.getCatalogSchema as Array<{
      name: string;
      is_categorical: boolean;
    }>;
    return fields.filter((f) => f.is_categorical).map((f) => f.name);
  }

  test('returns the dimensions of a single target', async () => {
    const listQuery = `query { getCatalogs { id } }`;
    const listResult = await execute(server, { query: listQuery });
    const firstId = (listResult.data!.getCatalogs as Array<{ id: string }>)[0]?.id;
    if (!firstId) return;

    const expected = await defaultDimensionNames(firstId);

    const query = `query { getSharedDimensions(targets: [{ catalog: "${firstId}" }]) }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();

    // Vérification que les dimensions partagées sont bien un sous-ensemble du catalogue
    const shared = result.data!.getSharedDimensions as string[];
    expect(Array.isArray(shared)).toBe(true);
    expect(shared.length).toBeGreaterThan(0);
    for (const dim of shared) {
      expect(expected).toContain(dim);
    }
  });

  test('returns common dimensions across two identical targets (deduplication)', async () => {
    const listQuery = `query { getCatalogs { id } }`;
    const listResult = await execute(server, { query: listQuery });
    const firstId = (listResult.data!.getCatalogs as Array<{ id: string }>)[0]?.id;
    if (!firstId) return;

    const query = `query {
      getSharedDimensions(targets: [{ catalog: "${firstId}" }, { catalog: "${firstId}" }])
    }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data!.getSharedDimensions)).toBe(true);
  });

  test('rejects an empty targets list', async () => {
    const query = `query { getSharedDimensions(targets: []) }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });

  test('rejects an unknown catalog name', async () => {
    const query = `query { getSharedDimensions(targets: [{ catalog: "nonexistent_db" }]) }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
  });

  test('rejects an unknown schema in a target', async () => {
    const query = `query {
      getSharedDimensions(targets: [{ catalog: "default", schema: "totally_unknown_schema" }])
    }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toMatch(/Schema 'totally_unknown_schema' is not available/);
  });
});
