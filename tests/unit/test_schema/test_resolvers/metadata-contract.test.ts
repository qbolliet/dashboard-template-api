/**
 * Integration tests for the metadata contract exposed to the interface.
 *
 * Covers the three surfaces introduced with the camelCase Metadata type: the
 * eleven columns of specification-bdd.md §2.2 rendered by getCatalogSchema,
 * the `family` filter of getFields, and the DatasetInfo of §2.3 reachable both
 * as the lazy `info` field of CatalogSchemaInfo and as the getDatasetInfo query.
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

// Les onze colonnes du contrat, telles que le SDL les nomme
const ALL_FIELDS = `
  name
  label
  sqlType
  isCategorical
  isPrimaryKey
  parentName
  unit
  displayFormat
  family
  description
  defaultAggregation
`;

// ─── Contrat Metadata complet ─────────────────────────────────────────────────

describe('contrat Metadata', () => {
  test('getCatalogSchema rend les onze colonnes en camelCase', async () => {
    const result = await execute(server, {
      query: `query { getCatalogSchema(schema: "main") { ${ALL_FIELDS} } }`,
    });

    expect(result.errors).toBeUndefined();
    const fields = result.data!.getCatalogSchema as Record<string, unknown>[];
    const value = fields.find((f) => f.name === 'value')!;

    expect(value).toEqual({
      name: 'value',
      label: 'Measurement Value',
      sqlType: 'DOUBLE',
      isCategorical: false,
      isPrimaryKey: false,
      parentName: null,
      unit: '€',
      displayFormat: ',.2f',
      family: 'Économie',
      description: "Valeur mesurée de l'indicateur",
      defaultAggregation: 'SUM',
    });
  });

  test('les champs d’UI non renseignés remontent à null', async () => {
    const result = await execute(server, {
      query: `query { getCatalogSchema(schema: "main") { ${ALL_FIELDS} } }`,
    });

    const fields = result.data!.getCatalogSchema as Record<string, unknown>[];
    // is_provisional ne déclare ni unité, ni format, ni agrégation par défaut
    const provisional = fields.find((f) => f.name === 'is_provisional')!;

    expect(provisional.unit).toBeNull();
    expect(provisional.displayFormat).toBeNull();
    expect(provisional.defaultAggregation).toBeNull();
    expect(provisional.parentName).toBeNull();
    expect(provisional.description).toBeNull();
    // Les colonnes NOT NULL restent renseignées
    expect(provisional.label).toBe('Provisional');
    expect(provisional.sqlType).toBe('BOOLEAN');
  });

  test('parentName porte la chaîne hiérarchique du schéma geography', async () => {
    const result = await execute(server, {
      query: 'query { getCatalogSchema(schema: "geography") { name parentName } }',
    });

    const fields = result.data!.getCatalogSchema as Record<string, unknown>[];
    const byName = new Map(fields.map((f) => [f.name, f.parentName]));

    expect(byName.get('region')).toBeNull();
    expect(byName.get('departement')).toBe('region');
    expect(byName.get('commune')).toBe('departement');
  });

  test('defaultAggregation est rendu comme valeur de l’enum Aggregation', async () => {
    const result = await execute(server, {
      query: 'query { getCatalogSchema(schema: "main") { name defaultAggregation } }',
    });

    const fields = result.data!.getCatalogSchema as Record<string, unknown>[];
    const declared = fields.map((f) => f.defaultAggregation).filter((a): a is string => a !== null);

    expect(declared.length).toBeGreaterThan(0);
    for (const aggregation of declared) {
      expect(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'MEDIAN', 'MODE']).toContain(aggregation);
    }
  });

  test('getMetaData rend le même contrat pour une colonne isolée', async () => {
    const result = await execute(server, {
      query: `query { getMetaData(name: "quality_score", schema: "main") { ${ALL_FIELDS} } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data!.getMetaData).toEqual({
      name: 'quality_score',
      label: 'Quality Score',
      sqlType: 'DOUBLE',
      isCategorical: false,
      isPrimaryKey: false,
      parentName: null,
      unit: null,
      displayFormat: '.0%',
      family: 'Qualité',
      description: 'Indice de confiance — NULL sur une partie des lignes',
      defaultAggregation: 'AVG',
    });
  });
});

// ─── Filtre getFields(family) ─────────────────────────────────────────────────

describe('getFields(family)', () => {
  /**
   * Runs getFields with the given inline arguments.
   *
   * @param args - Inline GraphQL argument list.
   * @returns The returned select options.
   */
  // Exécution de getFields avec une liste d'arguments littérale
  const fieldsWith = async (args: string): Promise<{ value: string; label: string }[]> => {
    const result = await execute(server, {
      query: `query { getFields(${args}) { value label } }`,
    });
    expect(result.errors).toBeUndefined();
    return result.data!.getFields as { value: string; label: string }[];
  };

  test('filtre par famille thématique, en égalité stricte', async () => {
    const options = await fieldsWith('schema: "main", family: "Temps"');

    expect(options.map((o) => o.value).sort()).toEqual(['date', 'horizon']);
  });

  test('une famille inconnue rend une liste vide', async () => {
    expect(await fieldsWith('schema: "main", family: "Inexistante"')).toEqual([]);
  });

  test('la comparaison est sensible à la casse', async () => {
    expect(await fieldsWith('schema: "main", family: "temps"')).toEqual([]);
  });

  test('se combine en ET avec les autres filtres', async () => {
    const options = await fieldsWith(
      'schema: "main", family: "Temps", isPrimaryKey: true, sqlType: "DATE"',
    );

    expect(options.map((o) => o.value)).toEqual(['date']);
  });

  test('sans le filtre, les colonnes des autres familles sont présentes', async () => {
    const all = await fieldsWith('schema: "main"');
    const timeOnly = await fieldsWith('schema: "main", family: "Temps"');

    expect(all.length).toBeGreaterThan(timeOnly.length);
  });
});

// ─── DatasetInfo ──────────────────────────────────────────────────────────────

describe('DatasetInfo', () => {
  const INFO_FIELDS = 'label description source updatedAt schemaVersion clusterBy';

  test('getDatasetInfo rend les méta-données du jeu de résultats', async () => {
    const result = await execute(server, {
      query: `query { getDatasetInfo(schema: "main") { ${INFO_FIELDS} } }`,
    });

    expect(result.errors).toBeUndefined();
    const info = result.data!.getDatasetInfo as Record<string, unknown>;

    expect(info.label).toBe('Indicateurs — default');
    expect(info.source).toBe('test-fixture:default');
    expect(info.schemaVersion).toBe(1);
  });

  test('clusterBy est décodé en liste de colonnes existantes', async () => {
    const result = await execute(server, {
      query: `query {
        getDatasetInfo(schema: "main") { clusterBy }
        getCatalogSchema(schema: "main") { name isPrimaryKey }
      }`,
    });

    const { clusterBy } = result.data!.getDatasetInfo as { clusterBy: string[] };
    const fields = result.data!.getCatalogSchema as { name: string; isPrimaryKey: boolean }[];
    const primaryKeys = fields.filter((f) => f.isPrimaryKey).map((f) => f.name);

    expect(Array.isArray(clusterBy)).toBe(true);
    // Défaut de la spec §5.3 : les clés primaires dans l'ordre de déclaration
    expect(clusterBy).toEqual(primaryKeys);
  });

  test('updatedAt est une chaîne ISO 8601 parsable', async () => {
    const result = await execute(server, {
      query: 'query { getDatasetInfo(schema: "main") { updatedAt } }',
    });

    const { updatedAt } = result.data!.getDatasetInfo as { updatedAt: string };

    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
  });

  test('le champ lazy info est bien résolu, et gardé, pour chaque schéma', async () => {
    // `info` est non-nullable : dans un catalogue hébergeant un schéma non
    // conforme, demander info sur TOUS les schémas propage l'erreur jusqu'à la
    // racine. C'est la conséquence assumée de « aucun chemin de compatibilité »
    // — et cela prouve que le resolver lazy s'exécute bien par schéma.
    const result = await execute(server, {
      query: `query { getCatalogs { id schemas { name info { ${INFO_FIELDS} } } } }`,
    });

    expect(result.errors).toBeDefined();
    for (const error of result.errors!) {
      expect(error.extensions?.code).toBe('SCHEMA_VERSION_UNSUPPORTED');
      // Seules les fixtures non conformes échouent
      expect(String(error.message)).toMatch(/unsupported_version|missing_dataset_metadata/);
    }
  });

  test('le champ info n’est pas chargé quand il n’est pas demandé', async () => {
    // Le catalogue `default` héberge deux schémas non conformes : les lister
    // sans demander `info` ne doit déclencher aucune lecture, donc aucune erreur
    const result = await execute(server, {
      query: 'query { getCatalogs { id schemas { name } } }',
    });

    expect(result.errors).toBeUndefined();
  });

  test('chaque schéma porte ses propres méta-données', async () => {
    const result = await execute(server, {
      query: `query {
        main: getDatasetInfo(schema: "main") { label }
        geography: getDatasetInfo(schema: "geography") { label }
      }`,
    });

    expect((result.data!.main as { label: string }).label).toBe('Indicateurs — default');
    expect((result.data!.geography as { label: string }).label).toBe('Territoires');
  });

  test('un schéma inconnu est rejeté', async () => {
    const result = await execute(server, {
      query: 'query { getDatasetInfo(schema: "totally_unknown_schema") { label } }',
    });

    expect(result.errors).toBeDefined();
  });
});
