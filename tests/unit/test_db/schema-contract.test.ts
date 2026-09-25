/**
 * Contract tests for the test DuckLake catalogs.
 *
 * Locks the test fixtures onto the database specification
 * (../dashboard-template-database/specification-bdd.md §2): every schema holds
 * EXACTLY the three tables fact_table, metadata and dataset_metadata — no dim_*
 * table — `metadata` carries the twelve specified columns with their nullability,
 * `dataset_metadata` carries the six specified columns on a single row, and the
 * declared metadata rows agree with the real fact_table columns.
 *
 * These tests fail as soon as tests/setup/setup-test-data.ts drifts away from
 * the real database format — that is their whole purpose.
 */

import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Contrat attendu ──────────────────────────────────────────────────────────

/** Schémas de test, par catalogue. */
const TEST_SCHEMAS: Array<[catalog: string, catalogFile: string, schemas: string[]]> = [
  ['default', 'test-default.ducklake', ['main', 'predictions', 'geography', 'trade']],
  ['macroeconomics', 'test-macroeconomics.ducklake', ['main', 'trade']],
  ['public_finance', 'test-public-finance.ducklake', ['main']],
];

// Fixtures VOLONTAIREMENT non conformes : elles alimentent le test de la garde
// de version et sont donc exclues des assertions de conformité ci-dessous. Leur
// conformité attendue — celle d'un catalogue que l'API doit refuser — est
// vérifiée par le describe « fixtures de la garde de version » en fin de fichier.
const NONCONFORMANT: Array<[catalog: string, schema: string]> = [
  ['default', 'unsupported_version'],
  ['default', 'missing_dataset_metadata'],
];

// Les trois tables d'un schéma — et rien d'autre (spec §2)
const EXPECTED_TABLES = ['dataset_metadata', 'fact_table', 'metadata'];

// Colonnes de `metadata` : [nom, type SQL, nullable] (spec §2.2)
const METADATA_CONTRACT: Array<[string, string, boolean]> = [
  ['name', 'VARCHAR', false],
  ['label', 'VARCHAR', false],
  ['sql_type', 'VARCHAR', false],
  ['is_primary_key', 'BOOLEAN', false],
  ['is_categorical', 'BOOLEAN', false],
  ['parent_name', 'VARCHAR', true],
  ['label_for', 'VARCHAR', true],
  ['unit', 'VARCHAR', true],
  ['display_format', 'VARCHAR', true],
  ['family', 'VARCHAR', true],
  ['description', 'VARCHAR', true],
  ['default_aggregation', 'VARCHAR', true],
];

// Colonnes de `dataset_metadata` : [nom, type SQL] (spec §2.3)
const DATASET_METADATA_CONTRACT: Array<[string, string]> = [
  ['label', 'VARCHAR'],
  ['description', 'VARCHAR'],
  ['source', 'VARCHAR'],
  ['updated_at', 'TIMESTAMP'],
  ['schema_version', 'INTEGER'],
  ['cluster_by', 'VARCHAR'],
];

// Agrégations admises par la spec §2.2
const ALLOWED_AGGREGATIONS = ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'MEDIAN', 'MODE'];

// ─── Interfaces ───────────────────────────────────────────────────────────────

/** Description d'une colonne telle que la renvoie duckdb_columns(). */
interface ColumnInfo {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
}

/** Ligne de la table metadata d'un schéma de test. */
interface MetadataRow {
  name: string;
  sql_type: string;
  is_primary_key: boolean;
  is_categorical: boolean;
  parent_name: string | null;
  label_for: string | null;
  default_aggregation: string | null;
}

// ─── Ouverture des catalogues de test ─────────────────────────────────────────

let instance: Awaited<ReturnType<typeof DuckDBInstance.create>>;
let connection: Awaited<ReturnType<typeof instance.connect>>;

// Inventaire des tables et colonnes, indexé par "catalogue.schéma"
const tablesBySchema = new Map<string, string[]>();
const columnsBySchema = new Map<string, ColumnInfo[]>();
const metadataBySchema = new Map<string, MetadataRow[]>();
const datasetRowsBySchema = new Map<string, Record<string, unknown>[]>();

/**
 * Runs a query against the attached test catalogs.
 *
 * @param sql - Query to execute.
 * @returns Result rows as plain objects.
 */
// Exécution d'une requête de lecture sur les catalogues attachés
const query = async (sql: string): Promise<Record<string, unknown>[]> => {
  const result = await connection.runAndReadAll(sql);
  return result.getRowObjectsJson() as unknown as Record<string, unknown>[];
};

beforeAll(async () => {
  const dataDir = path.resolve(__dirname, '../../../data');
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
  await connection.run('LOAD ducklake;');

  // Attachement en lecture seule : plusieurs contextes Jest partagent les fichiers
  for (const [catalog, file] of TEST_SCHEMAS) {
    await connection.run(
      `ATTACH 'ducklake:${path.resolve(dataDir, file).replace(/\\/g, '/')}' AS "${catalog}" (READ_ONLY)`,
    );
  }

  // Inventaire complet, chargé une fois pour toutes les assertions
  for (const [catalog, , schemas] of TEST_SCHEMAS) {
    const tables = await query(
      `SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = '${catalog}'`,
    );
    const columns = await query(
      `SELECT schema_name, table_name, column_name, data_type, is_nullable
       FROM duckdb_columns() WHERE database_name = '${catalog}'`,
    );

    for (const schema of schemas) {
      const key = `${catalog}.${schema}`;
      tablesBySchema.set(
        key,
        tables
          .filter((row) => row.schema_name === schema)
          .map((row) => String(row.table_name))
          .sort(),
      );
      columnsBySchema.set(
        key,
        columns.filter((row) => row.schema_name === schema) as unknown as ColumnInfo[],
      );
      metadataBySchema.set(
        key,
        (await query(
          `SELECT name, sql_type, is_primary_key, is_categorical, parent_name, label_for, default_aggregation
           FROM "${catalog}".${schema}.metadata`,
        )) as unknown as MetadataRow[],
      );
      datasetRowsBySchema.set(
        key,
        await query(`SELECT * FROM "${catalog}".${schema}.dataset_metadata`),
      );
    }
  }
}, 60000);

afterAll(() => {
  instance?.closeSync();
});

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/** Every (catalog, schema) pair under contract, as test.each tuples. */
const ALL_SCHEMAS: Array<[string, string]> = TEST_SCHEMAS.flatMap(([catalog, , schemas]) =>
  schemas.map((schema): [string, string] => [catalog, schema]),
);

/**
 * Returns the columns of one table of a schema, in declaration order.
 *
 * @param key - "catalog.schema" key.
 * @param table - Table name.
 * @returns Column descriptors of that table.
 */
// Colonnes d'une table donnée, dans l'ordre de déclaration
const columnsOf = (key: string, table: string): ColumnInfo[] =>
  (columnsBySchema.get(key) ?? []).filter((column) => column.table_name === table);

// ─── Trois tables, et rien d'autre ────────────────────────────────────────────

describe('structure des schémas de test', () => {
  test.each(ALL_SCHEMAS)('%s.%s contient exactement les trois tables', (catalog, schema) => {
    expect(tablesBySchema.get(`${catalog}.${schema}`)).toEqual(EXPECTED_TABLES);
  });

  test.each(ALL_SCHEMAS)('%s.%s ne contient aucune table dim_*', (catalog, schema) => {
    const tables = tablesBySchema.get(`${catalog}.${schema}`) ?? [];
    expect(tables.filter((table) => table.startsWith('dim_'))).toEqual([]);
  });
});

// ─── Table metadata ───────────────────────────────────────────────────────────

describe('table metadata', () => {
  test.each(ALL_SCHEMAS)('%s.%s a les colonnes de la spec §2.2', (catalog, schema) => {
    const columns = columnsOf(`${catalog}.${schema}`, 'metadata');
    expect(columns.map((column) => column.column_name)).toEqual(
      METADATA_CONTRACT.map(([name]) => name),
    );
    expect(columns.map((column) => column.data_type)).toEqual(
      METADATA_CONTRACT.map(([, type]) => type),
    );
    expect(columns.map((column) => column.is_nullable)).toEqual(
      METADATA_CONTRACT.map(([, , nullable]) => nullable),
    );
  });

  test.each(ALL_SCHEMAS)('%s.%s ne déclare pas de python_type', (catalog, schema) => {
    const names = columnsOf(`${catalog}.${schema}`, 'metadata').map((c) => c.column_name);
    expect(names).not.toContain('python_type');
  });

  test.each(ALL_SCHEMAS)(
    '%s.%s décrit exactement les colonnes de fact_table',
    (catalog, schema) => {
      const key = `${catalog}.${schema}`;
      const factColumns = columnsOf(key, 'fact_table').map((column) => column.column_name);
      const declared = (metadataBySchema.get(key) ?? []).map((row) => row.name);
      expect([...declared].sort()).toEqual([...factColumns].sort());
    },
  );

  test.each(ALL_SCHEMAS)('%s.%s annonce le type SQL réel de chaque colonne', (catalog, schema) => {
    const key = `${catalog}.${schema}`;
    const actualTypes = new Map(
      columnsOf(key, 'fact_table').map((column) => [column.column_name, column.data_type]),
    );
    for (const row of metadataBySchema.get(key) ?? []) {
      expect(row.sql_type).toBe(actualTypes.get(row.name));
    }
  });

  test.each(ALL_SCHEMAS)('%s.%s n’utilise que des agrégations admises', (catalog, schema) => {
    for (const row of metadataBySchema.get(`${catalog}.${schema}`) ?? []) {
      if (row.default_aggregation !== null) {
        expect(ALLOWED_AGGREGATIONS).toContain(row.default_aggregation);
      }
    }
  });

  test.each(ALL_SCHEMAS)(
    '%s.%s déclare une forêt de parent_name, catégorielle de bout en bout',
    (catalog, schema) => {
      const rows = metadataBySchema.get(`${catalog}.${schema}`) ?? [];
      const byName = new Map(rows.map((row) => [row.name, row]));

      for (const row of rows) {
        if (row.parent_name === null) continue;

        // La colonne parente existe et appartient à la hiérarchie
        const parent = byName.get(row.parent_name);
        expect(parent).toBeDefined();
        // Une colonne d'une hiérarchie est toujours catégorielle (spec §2.5)
        expect(row.is_categorical).toBe(true);
        expect(parent!.is_categorical).toBe(true);

        // Absence de cycle : la remontée termine sur une racine
        const seen = new Set<string>([row.name]);
        let current = parent!;
        while (current.parent_name !== null) {
          expect(seen.has(current.name)).toBe(false);
          seen.add(current.name);
          current = byName.get(current.parent_name)!;
          expect(current).toBeDefined();
        }
      }
    },
  );
});

// ─── Colonnes de libellés (spec §2.6) ─────────────────────────────────────────

describe('colonnes de libellés (label_for)', () => {
  test.each(ALL_SCHEMAS)('%s.%s respecte les invariants de label_for', (catalog, schema) => {
    const rows = metadataBySchema.get(`${catalog}.${schema}`) ?? [];
    const byName = new Map(rows.map((row) => [row.name, row]));
    const parents = new Set(rows.map((row) => row.parent_name).filter((name) => name !== null));

    for (const row of rows) {
      if (row.label_for === null) continue;

      // 1. La cible existe et diffère de la colonne de libellés
      const target = byName.get(row.label_for);
      expect(target).toBeDefined();
      expect(row.label_for).not.toBe(row.name);
      // 2. Pas de chaîne : la cible n'est pas elle-même une colonne de libellés
      expect(target!.label_for).toBeNull();
      // 3. VARCHAR, hors clé primaire, hors hiérarchie
      expect(row.sql_type).toBe('VARCHAR');
      expect(row.is_primary_key).toBe(false);
      expect(row.parent_name).toBeNull();
      expect(parents.has(row.name)).toBe(false);
    }
  });

  test.each(ALL_SCHEMAS)(
    '%s.%s respecte la dépendance fonctionnelle code → libellé',
    async (catalog, schema) => {
      const rows = metadataBySchema.get(`${catalog}.${schema}`) ?? [];
      const table = `"${catalog}".${schema}.fact_table`;

      for (const { name: label, label_for: code } of rows) {
        if (code === null) continue;

        // Contrôle de la spec §2.6, mot pour mot
        const conflicting = await query(
          `SELECT ${code} FROM ${table} WHERE ${code} IS NOT NULL GROUP BY ${code}
           HAVING COUNT(DISTINCT ${label}) > 1
               OR (COUNT(${label}) > 0 AND COUNT(${label}) < COUNT(*))`,
        );
        expect(conflicting).toEqual([]);
        const orphans = await query(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${code} IS NULL AND ${label} IS NOT NULL`,
        );
        expect(Number(orphans[0].n)).toBe(0);
      }
    },
  );

  test('default.trade déclare les colonnes de libellés de nc6, nc8 et partner_code', () => {
    const rows = metadataBySchema.get('default.trade') ?? [];
    const labelFor = Object.fromEntries(rows.map((row) => [row.name, row.label_for]));

    expect(labelFor).toMatchObject({
      nc6_libelle: 'nc6',
      nc8_libelle_en: 'nc8',
      nc8_libelle_fr: 'nc8',
      partner_libelle: 'partner_code',
      nc8: null,
    });
  });
});

// ─── Table dataset_metadata ───────────────────────────────────────────────────

describe('table dataset_metadata', () => {
  test.each(ALL_SCHEMAS)('%s.%s a les colonnes de la spec §2.3', (catalog, schema) => {
    const columns = columnsOf(`${catalog}.${schema}`, 'dataset_metadata');
    expect(columns.map((column) => column.column_name)).toEqual(
      DATASET_METADATA_CONTRACT.map(([name]) => name),
    );
    expect(columns.map((column) => column.data_type)).toEqual(
      DATASET_METADATA_CONTRACT.map(([, type]) => type),
    );
  });

  test.each(ALL_SCHEMAS)('%s.%s porte une seule ligne en version 1', (catalog, schema) => {
    const rows = datasetRowsBySchema.get(`${catalog}.${schema}`) ?? [];
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].schema_version)).toBe(1);
    expect(rows[0].updated_at).toBeTruthy();
  });

  test.each(ALL_SCHEMAS)('%s.%s a un cluster_by JSON de colonnes existantes', (catalog, schema) => {
    const key = `${catalog}.${schema}`;
    const rows = datasetRowsBySchema.get(key) ?? [];
    const clusterBy = JSON.parse(String(rows[0].cluster_by)) as string[];

    expect(Array.isArray(clusterBy)).toBe(true);
    expect(clusterBy.length).toBeGreaterThan(0);

    const factColumns = columnsOf(key, 'fact_table').map((column) => column.column_name);
    for (const column of clusterBy) {
      expect(factColumns).toContain(column);
    }
  });
});

// ─── Fixtures non conformes de la garde de version ────────────────────────────

describe('fixtures de la garde de version', () => {
  test.each(NONCONFORMANT)('%s.%s existe', async (catalog, schema) => {
    const rows = await query(
      `SELECT table_name FROM duckdb_tables() WHERE database_name = '${catalog}' AND schema_name = '${schema}'`,
    );
    // Sans ces fixtures, les tests de la garde passeraient à vide
    expect(rows.length).toBeGreaterThan(0);
  });

  test('default.unsupported_version annonce une version hors liste', async () => {
    const rows = await query(
      'SELECT schema_version FROM "default".unsupported_version.dataset_metadata',
    );
    expect(Number(rows[0].schema_version)).toBe(99);
  });

  test('default.missing_dataset_metadata n’a pas de table dataset_metadata', async () => {
    const rows = await query(
      `SELECT table_name FROM duckdb_tables() WHERE database_name = 'default' AND schema_name = 'missing_dataset_metadata'`,
    );
    const tables = rows.map((row) => String(row.table_name));
    expect(tables).not.toContain('dataset_metadata');
    expect(tables).toContain('fact_table');
  });
});
