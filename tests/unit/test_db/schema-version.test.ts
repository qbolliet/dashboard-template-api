/**
 * Tests for the schema version guard (src/db/schema-version.ts).
 *
 * The database declares its format through `dataset_metadata.schema_version`
 * (specification-bdd.md §2.3). A schema announcing an unsupported version, or
 * missing the `dataset_metadata` table entirely (a catalog written in the
 * legacy format), must be refused — there is no compatibility path.
 *
 * The two non-conformant fixtures live in the `default` test catalog and are
 * built by tests/setup/setup-test-data.ts:
 *   - `unsupported_version`        → schema_version = 99
 *   - `missing_dataset_metadata`   → no dataset_metadata table at all
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from '../test_schema/test_resolvers/helpers.js';
import { getSchemaVersionStatus, getSupportedVersions } from '../../../src/db/schema-version.js';

let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

// ─── Verdicts enregistrés à l'attach ──────────────────────────────────────────

describe('sondage des versions à l’attach', () => {
  test('la configuration supporte la version 1 par défaut', () => {
    expect(getSupportedVersions()).toEqual([1]);
  });

  test('un schéma conforme est marqué supporté avec sa version', () => {
    const status = getSchemaVersionStatus('default', 'main');
    expect(status).toBeDefined();
    expect(status!.supported).toBe(true);
    expect(status!.version).toBe(1);
  });

  test('un schéma en version hors liste est marqué non supporté', () => {
    const status = getSchemaVersionStatus('default', 'unsupported_version');
    expect(status!.supported).toBe(false);
    expect(status!.version).toBe(99);
  });

  test('un schéma sans dataset_metadata est marqué non supporté, sans version', () => {
    const status = getSchemaVersionStatus('default', 'missing_dataset_metadata');
    expect(status!.supported).toBe(false);
    expect(status!.version).toBeNull();
  });
});

// ─── Refus des requêtes ───────────────────────────────────────────────────────

describe('SCHEMA_VERSION_UNSUPPORTED', () => {
  /**
   * Runs a query against a schema and returns its first error.
   *
   * @param schema - Schema of the default catalog to target.
   * @param query - GraphQL query string, parameterized by $schema.
   * @returns The first GraphQL error, if any.
   */
  // Exécution d'une requête sur un schéma donné, erreur remontée telle quelle
  const errorFor = async (
    schema: string,
    query: string,
  ): Promise<{ message: string; extensions?: Record<string, unknown> } | undefined> => {
    const result = await execute(server, { query, variables: { schema } });
    return result.errors?.[0];
  };

  const FACTS = 'query ($schema: String) { getFactTable(schema: $schema, limit: 1) { total } }';
  const SCHEMA = 'query ($schema: String) { getCatalogSchema(schema: $schema) { name } }';
  const INFO = 'query ($schema: String) { getDatasetInfo(schema: $schema) { schemaVersion } }';

  test.each([
    ['unsupported_version', FACTS],
    ['unsupported_version', SCHEMA],
    ['unsupported_version', INFO],
    ['missing_dataset_metadata', FACTS],
    ['missing_dataset_metadata', SCHEMA],
    ['missing_dataset_metadata', INFO],
  ])('%s est refusé (%#)', async (schema, query) => {
    const error = await errorFor(schema, query);
    expect(error).toBeDefined();
    expect(error!.extensions?.code).toBe('SCHEMA_VERSION_UNSUPPORTED');
  });

  test('le message nomme le catalogue, le schéma et la version trouvée', async () => {
    const error = await errorFor('unsupported_version', FACTS);
    expect(error!.message).toContain('default');
    expect(error!.message).toContain('unsupported_version');
    expect(error!.message).toContain('99');
  });

  test('le message signale l’absence de dataset_metadata', async () => {
    const error = await errorFor('missing_dataset_metadata', FACTS);
    expect(error!.message).toContain('missing_dataset_metadata');
    expect(error!.message).toContain('dataset_metadata');
  });

  test('un schéma conforme n’est pas affecté', async () => {
    const result = await execute(server, {
      query: 'query { getFactTable(schema: "main", limit: 1) { total } }',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data!.getFactTable).toBeDefined();
  });

  test('une comparaison cross-schéma vers un schéma non conforme est refusée', async () => {
    const result = await execute(server, {
      query: `query {
        compareFacts(
          catalogA: "default"
          catalogB: "default"
          schemaA: "main"
          schemaB: "unsupported_version"
          joinFields: ["country"]
          limit: 5
        ) { total }
      }`,
    });
    expect(result.errors?.[0].extensions?.code).toBe('SCHEMA_VERSION_UNSUPPORTED');
  });
});
