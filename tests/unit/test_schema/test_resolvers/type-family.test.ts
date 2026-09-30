/**
 * Integration tests for Metadata.typeFamily and Metadata.filterOperations.
 *
 * Both fields are derived from sqlType by the server's own filtering rule, on
 * every path that produces a Metadata: getCatalogSchema, CatalogSchemaInfo.fields,
 * DatasetWithMetadata.fields, getMetaData and the field infos of an aggregation.
 * Checks the families of the test schemas (DOUBLE → NUMBER, UBIGINT → INTEGER,
 * TIMESTAMP → TIMESTAMP, BOOLEAN → BOOLEAN, TIME → OTHER…) and that the exposed
 * operations are those of the mapping module.
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';
import { filterOperationsOf, typeFamilyOf } from '../../../../src/utils/metadata-mapping.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

// ─── Interfaces et fonctions utilitaires ──────────────────────────────────────

/** Champs de type d'une colonne, tels que demandés par les requêtes de ce fichier. */
interface TypedField {
  name: string;
  sqlType: string;
  isCategorical: boolean;
  typeFamily: string;
  filterOperations: string[];
}

/** Sélection GraphQL commune à toutes les requêtes de ce fichier. */
const TYPED_FIELD = 'name sqlType isCategorical typeFamily filterOperations';

/**
 * Runs a query and returns its data, failing on any GraphQL error.
 *
 * @param query - GraphQL query text.
 * @returns The `data` of the response.
 */
// Exécution d'une requête, échec sur toute erreur GraphQL
async function run(query: string): Promise<Record<string, unknown>> {
  const result = await execute(server, { query });
  expect(result.errors).toBeUndefined();
  return result.data!;
}

/**
 * Reads the typed fields of one schema through getCatalogSchema.
 *
 * @param schema - Schema of the default catalog.
 * @returns The fields keyed by column name.
 */
// Colonnes d'un schéma indexées par nom
async function catalogSchema(schema: string): Promise<Record<string, TypedField>> {
  const data = await run(`query { getCatalogSchema(schema: "${schema}") { ${TYPED_FIELD} } }`);
  const fields = data.getCatalogSchema as TypedField[];
  return Object.fromEntries(fields.map((field) => [field.name, field]));
}

/**
 * Asserts that every field carries the family and operations of its SQL type.
 *
 * @param fields - Fields returned by the API.
 */
// Cohérence de chaque colonne avec la règle du module de correspondance
function expectConsistent(fields: TypedField[]): void {
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    expect({ name: field.name, typeFamily: field.typeFamily }).toEqual({
      name: field.name,
      typeFamily: typeFamilyOf(field.sqlType),
    });
    expect({ name: field.name, filterOperations: field.filterOperations }).toEqual({
      name: field.name,
      filterOperations: filterOperationsOf(field.sqlType),
    });
  }
}

// ─── getCatalogSchema ─────────────────────────────────────────────────────────

describe('getCatalogSchema', () => {
  test('main: numeric, date, timestamp, text and boolean columns get their family', async () => {
    const byName = await catalogSchema('main');

    expect(byName.value).toMatchObject({ sqlType: 'DOUBLE', typeFamily: 'NUMBER' });
    expect(byName.lower_bound).toMatchObject({ sqlType: 'FLOAT', typeFamily: 'NUMBER' });
    expect(byName.horizon).toMatchObject({ sqlType: 'INTEGER', typeFamily: 'INTEGER' });
    expect(byName.headcount).toMatchObject({ sqlType: 'BIGINT', typeFamily: 'INTEGER' });
    expect(byName.sample_size).toMatchObject({ sqlType: 'UINTEGER', typeFamily: 'INTEGER' });
    expect(byName.date).toMatchObject({ sqlType: 'DATE', typeFamily: 'DATE' });
    expect(byName.ingested_at).toMatchObject({ sqlType: 'TIMESTAMP', typeFamily: 'TIMESTAMP' });
    expect(byName.notes).toMatchObject({ sqlType: 'VARCHAR', typeFamily: 'TEXT' });
    expect(byName.is_provisional).toMatchObject({ sqlType: 'BOOLEAN', typeFamily: 'BOOLEAN' });
    expectConsistent(Object.values(byName));
  });

  test('a DOUBLE measure is offered numeric operations, never text ones', async () => {
    const { value } = await catalogSchema('main');

    expect(value.filterOperations).toEqual(expect.arrayContaining(['GT', 'LTE', 'BETWEEN']));
    expect(value.filterOperations).not.toContain('CONTAINS');
    expect(value.filterOperations).not.toContain('MATCHES');
  });

  test('geography: UBIGINT is INTEGER, DOUBLE is NUMBER, BOOLEAN is BOOLEAN', async () => {
    const byName = await catalogSchema('geography');

    expect(byName.population).toMatchObject({ sqlType: 'UBIGINT', typeFamily: 'INTEGER' });
    expect(byName.density).toMatchObject({ sqlType: 'DOUBLE', typeFamily: 'NUMBER' });
    expect(byName.is_urban).toMatchObject({
      sqlType: 'BOOLEAN',
      typeFamily: 'BOOLEAN',
      filterOperations: [
        'EQ',
        'NEQ',
        'IS_TRUE',
        'IS_FALSE',
        'IS_NOT_TRUE',
        'IS_NOT_FALSE',
        'IS_NULL',
        'IS_NOT_NULL',
      ],
    });
    expectConsistent(Object.values(byName));
  });

  test('a categorical column keeps the operations of its type', async () => {
    const { region } = await catalogSchema('geography');

    expect(region).toMatchObject({ isCategorical: true, typeFamily: 'TEXT' });
    expect(region.filterOperations).toEqual(filterOperationsOf('VARCHAR'));
  });

  test('no_primary_key: a bare DECIMAL is NUMBER, a TIME is OTHER with IS_NULL only', async () => {
    const byName = await catalogSchema('no_primary_key');

    expect(byName.amount).toMatchObject({ sqlType: 'DECIMAL', typeFamily: 'NUMBER' });
    expect(byName.slot).toMatchObject({
      sqlType: 'TIME',
      typeFamily: 'OTHER',
      filterOperations: ['IS_NULL', 'IS_NOT_NULL'],
    });
    expectConsistent(Object.values(byName));
  });
});

// ─── Autres chemins produisant un Metadata ───────────────────────────────────

describe('every path producing a Metadata', () => {
  test('DatasetWithMetadata.fields', async () => {
    const data = await run(`query {
      getFactTableWithMetadata(
        fields: ["value", "sample_size", "date", "ingested_at", "is_provisional", "country"],
        limit: 1
      ) { fields { ${TYPED_FIELD} } }
    }`);
    const { fields } = data.getFactTableWithMetadata as { fields: TypedField[] };

    expect(fields.map((field) => [field.name, field.typeFamily])).toEqual([
      ['value', 'NUMBER'],
      ['sample_size', 'INTEGER'],
      ['date', 'DATE'],
      ['ingested_at', 'TIMESTAMP'],
      ['is_provisional', 'BOOLEAN'],
      ['country', 'TEXT'],
    ]);
    expectConsistent(fields);
  });

  test('CatalogSchemaInfo.fields', async () => {
    const data = await run(`query { getCatalogs { schemas { name fields { ${TYPED_FIELD} } } } }`);
    const catalogs = data.getCatalogs as Array<{
      schemas: Array<{ name: string; fields: TypedField[] }>;
    }>;
    const fields = catalogs.flatMap((catalog) =>
      catalog.schemas.flatMap((schema) => schema.fields),
    );

    expectConsistent(fields);
  });

  test('getMetaData', async () => {
    const data = await run(`query { getMetaData(name: "ingested_at") { ${TYPED_FIELD} } }`);

    expect(data.getMetaData).toMatchObject({
      typeFamily: 'TIMESTAMP',
      filterOperations: filterOperationsOf('TIMESTAMP'),
    });
  });

  test('groupByFieldInfo and measureFieldInfo', async () => {
    const data = await run(`query {
      getAggregatedFactsWithMetadata(groupBy: "country", measure: "value", limit: 1) {
        metadata {
          groupByFieldInfo { ${TYPED_FIELD} }
          measureFieldInfo { ${TYPED_FIELD} }
        }
      }
    }`);
    const { metadata } = data.getAggregatedFactsWithMetadata as {
      metadata: { groupByFieldInfo: TypedField; measureFieldInfo: TypedField };
    };

    expect(metadata.groupByFieldInfo.typeFamily).toBe('TEXT');
    expect(metadata.measureFieldInfo.typeFamily).toBe('NUMBER');
    expectConsistent([metadata.groupByFieldInfo, metadata.measureFieldInfo]);
  });
});
