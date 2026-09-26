/**
 * Tests for the data dictionary generator of the documentation site
 * (docs-site/scripts/generate-data-dictionary.mjs).
 *
 * Covers the pure rendering functions (family grouping, label columns under their
 * code, hierarchies rebuilt from parentName, cell escaping) and the generation against
 * a fake GraphQL server: pages written, invalid schema skipped, and previous pages kept
 * when the API is unreachable.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — module JavaScript sans déclaration de types
import * as dictionary from '../../../docs-site/scripts/generate-data-dictionary.mjs';

const { buildHierarchies, escapeCell, generateDataDictionary, groupByFamily, renderSchemaPage } =
  dictionary;

// ─── Données de test ──────────────────────────────────────────────────────────

interface FieldFixture {
  name: string;
  label: string;
  sqlType: string;
  isCategorical: boolean;
  isPrimaryKey: boolean;
  parentName: string | null;
  labelFor: string | null;
  labelFields: string[];
  unit: string | null;
  displayFormat: string | null;
  family: string | null;
  description: string | null;
  defaultAggregation: string | null;
}

/** Builds a column with neutral defaults. */
function field(name: string, overrides: Partial<FieldFixture> = {}): FieldFixture {
  return {
    name,
    label: name,
    sqlType: 'VARCHAR',
    isCategorical: false,
    isPrimaryKey: false,
    parentName: null,
    labelFor: null,
    labelFields: [],
    unit: null,
    displayFormat: null,
    family: null,
    description: null,
    defaultAggregation: null,
    ...overrides,
  };
}

const TRADE_FIELDS: FieldFixture[] = [
  field('value', { sqlType: 'DOUBLE', family: 'Commerce', unit: '€', defaultAggregation: 'SUM' }),
  field('nc6', {
    family: 'Nomenclature',
    isCategorical: true,
    isPrimaryKey: true,
    labelFields: ['nc6_libelle'],
  }),
  field('nc6_libelle', { family: 'Nomenclature', labelFor: 'nc6' }),
  field('nc8', {
    family: 'Nomenclature',
    isCategorical: true,
    isPrimaryKey: true,
    parentName: 'nc6',
    labelFields: ['nc8_libelle_en', 'nc8_libelle_fr'],
    description: 'Code | with a pipe\nand <tag>',
  }),
  field('nc8_libelle_en', { family: 'Other family', labelFor: 'nc8' }),
  field('nc8_libelle_fr', { labelFor: 'nc8' }),
  field('note'),
];

const GEO_FIELDS: FieldFixture[] = [
  field('region', { isPrimaryKey: true, isCategorical: true }),
  field('departement', { isPrimaryKey: true, isCategorical: true, parentName: 'region' }),
  field('commune', { isPrimaryKey: true, isCategorical: true, parentName: 'departement' }),
  field('epci', { parentName: 'departement' }),
];

const INFO = {
  label: 'Trade by product',
  description: 'Trade flows',
  source: 'model-x',
  updatedAt: '2026-09-01T04:45:00Z',
  schemaVersion: 1,
  clusterBy: ['nc6', 'nc8'],
};

// ─── Fonctions pures ──────────────────────────────────────────────────────────

describe('escapeCell', () => {
  /** Table cells stay on one line and cannot break the table or inject HTML. */
  test('escapes pipes and angle brackets, flattens line breaks', () => {
    expect(escapeCell('a | b\nc <d>')).toBe('a \\| b c &lt;d>');
    expect(escapeCell(null)).toBe('');
  });
});

describe('groupByFamily', () => {
  const groups = groupByFamily(TRADE_FIELDS) as {
    family: string;
    columns: { name: string; isLabel: boolean }[];
  }[];

  /** Families sorted alphabetically, columns without a family last under "Other". */
  test('sorts families, "Other" last', () => {
    expect(groups.map((group) => group.family)).toEqual(['Commerce', 'Nomenclature', 'Other']);
  });

  /** Each label column follows its code, in the family of that code. */
  test('places label columns right after their code, whatever their own family', () => {
    const nomenclature = groups.find((group) => group.family === 'Nomenclature');
    expect(nomenclature?.columns.map((column) => column.name)).toEqual([
      'nc6',
      'nc6_libelle',
      'nc8',
      'nc8_libelle_en',
      'nc8_libelle_fr',
    ]);
    expect(nomenclature?.columns.filter((column) => column.isLabel)).toHaveLength(3);
    expect(groups.find((group) => group.family === 'Other')?.columns.map((c) => c.name)).toEqual([
      'note',
    ]);
  });

  /** A label column whose code is absent is kept as an ordinary column. */
  test('keeps orphan label columns', () => {
    const orphan = groupByFamily([field('x_libelle', { labelFor: 'x', family: 'F' })]);
    expect(orphan[0].columns.map((column: { name: string }) => column.name)).toEqual(['x_libelle']);
  });
});

describe('buildHierarchies', () => {
  /** A code chain, label columns excluded. */
  test('rebuilds nc6 → nc8', () => {
    expect(buildHierarchies(TRADE_FIELDS)).toEqual([['nc6', 'nc8']]);
  });

  /** A parent with two children gives one chain per branch. */
  test('rebuilds region → departement → commune with branches', () => {
    expect(buildHierarchies(GEO_FIELDS)).toEqual([
      ['region', 'departement', 'commune'],
      ['region', 'departement', 'epci'],
    ]);
  });

  /** No hierarchy, and a cycle does not loop. */
  test('handles flat columns and cycles', () => {
    expect(buildHierarchies([field('a'), field('b')])).toEqual([]);
    expect(() =>
      buildHierarchies([field('a', { parentName: 'b' }), field('b', { parentName: 'a' })]),
    ).not.toThrow();
  });
});

describe('renderSchemaPage', () => {
  const page: string = renderSchemaPage({
    catalog: 'default',
    schema: 'trade',
    info: INFO,
    fields: TRADE_FIELDS,
  });

  /** Dataset information and sort columns are at the top. */
  test('describes the result set', () => {
    expect(page).toContain('title: "Trade by product"');
    expect(page).toContain('Trade flows');
    expect(page).toContain('| Source | model-x |');
    expect(page).toContain('| Last update | 2026-09-01T04:45:00Z |');
    expect(page).toContain('| Sort columns (`cluster_by`, default page order) | `nc6`, `nc8` |');
  });

  /** Hierarchies, families and label columns. */
  test('lists hierarchies and groups columns by family', () => {
    expect(page).toContain('- `nc6` → `nc8`');
    expect(page.indexOf('### Commerce')).toBeLessThan(page.indexOf('### Nomenclature'));
    expect(page).toContain('| ↳ `nc8_libelle_fr` |');
    expect(page.indexOf('| `nc8` |')).toBeLessThan(page.indexOf('| ↳ `nc8_libelle_en` |'));
  });

  /** A description cannot break its table row. */
  test('escapes descriptions', () => {
    expect(page).toContain('Code \\| with a pipe and &lt;tag>');
  });

  /** Same input, same bytes: no generation timestamp. */
  test('is deterministic', () => {
    expect(
      renderSchemaPage({ catalog: 'default', schema: 'trade', info: INFO, fields: TRADE_FIELDS }),
    ).toBe(page);
  });
});

// ─── Génération contre une API simulée ───────────────────────────────────────

describe('generateDataDictionary', () => {
  let server: Server;
  let apiUrl: string;
  let outDir: string;
  const logs: { info: string[]; warn: string[] } = { info: [], warn: [] };
  const log = {
    info: (message: string): number => logs.info.push(message),
    warn: (message: string): number => logs.warn.push(message),
  };

  beforeAll(async () => {
    // API simulée : deux schémas, dont un invalide
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const { query, variables } = JSON.parse(body) as {
          query: string;
          variables: { schema?: string };
        };
        response.setHeader('content-type', 'application/json');
        if (query.includes('getCatalogs')) {
          response.end(
            JSON.stringify({
              data: {
                getCatalogs: [
                  {
                    id: 'default',
                    defaultSchema: 'trade',
                    schemas: [{ name: 'trade' }, { name: 'broken' }],
                  },
                ],
              },
            }),
          );
        } else if (variables.schema === 'broken') {
          response.end(
            JSON.stringify({
              errors: [{ message: 'schema version 99 is not supported' }],
              data: null,
            }),
          );
        } else {
          response.end(
            JSON.stringify({ data: { getDatasetInfo: INFO, getCatalogSchema: TRADE_FIELDS } }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    outDir = join(mkdtempSync(join(tmpdir(), 'dictionary-')), 'data-dictionary');
    logs.info.length = 0;
    logs.warn.length = 0;
  });

  afterEach(() => {
    rmSync(join(outDir, '..'), { recursive: true, force: true });
  });

  /** One page per valid schema plus the index; the invalid schema is skipped with a warning. */
  test('writes the pages and skips an invalid schema', async () => {
    const result = await generateDataDictionary({ apiUrl, outDir, log });

    expect(result.status).toBe('written');
    expect(result.pages).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(existsSync(join(outDir, 'default', 'trade.md'))).toBe(true);
    expect(existsSync(join(outDir, 'default', 'broken.md'))).toBe(false);
    expect(readFileSync(join(outDir, 'index.md'), 'utf8')).toContain('[trade](./default/trade.md)');
    expect(logs.warn.join('\n')).toContain('default.broken skipped');
    // Le rendu temporaire ne subsiste pas
    expect(existsSync(`${outDir}.tmp`)).toBe(false);
  });

  /** The previous pages are neither removed nor rewritten when the API cannot be reached. */
  test('keeps the previous pages when the API is unreachable', async () => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'index.md'), 'previous', 'utf8');

    const result = await generateDataDictionary({
      apiUrl: 'http://127.0.0.1:9/graphql',
      outDir,
      log,
    });

    expect(result.status).toBe('unreachable');
    expect(readFileSync(join(outDir, 'index.md'), 'utf8')).toBe('previous');
    expect(logs.warn.join('\n')).toContain('keeping the previous pages');
  });
});
