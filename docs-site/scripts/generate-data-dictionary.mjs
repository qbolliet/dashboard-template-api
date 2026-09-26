/**
 * Generates the data dictionary of the "API & Data" documentation site.
 *
 * Queries a running API (getCatalogs, getDatasetInfo, getCatalogSchema) and writes one
 * markdown page per (catalog, schema) into docs-site/api/data-dictionary/, plus an index:
 *
 *   - title, description, source, last update and sort columns (cluster_by) of the
 *     result set (DatasetInfo);
 *   - the columns as a table grouped by `family`, each label column (`labelFor`) placed
 *     right under its code;
 *   - the column hierarchies rebuilt from `parentName` (region → departement → commune).
 *
 * The API is read from the API_URL environment variable (default
 * http://localhost:4000/graphql). The build never fails because of it: when the API is
 * unreachable, a warning is logged and the pages of the previous run are kept. The
 * output directory is only replaced once the new pages are complete (rendered aside in a
 * temporary directory), so an interrupted run never leaves a half-written dictionary.
 *
 * Usage:
 *   API_URL=http://localhost:4000/graphql node docs-site/scripts/generate-data-dictionary.mjs [--out <dir>]
 *   npm run docs:dictionary        (API already running)
 *   npm run docs:dictionary:test   (starts the API on the test catalogs)
 */

import { cp, mkdir, rename, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

/** Default output directory, owned by this script (git-ignored). */
export const DEFAULT_OUT_DIR = join(here, '..', 'api', 'data-dictionary');

/** Default GraphQL endpoint of a local API. */
export const DEFAULT_API_URL = 'http://localhost:4000/graphql';

/** Timeout of one GraphQL request. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Heading of the columns that have no family. */
const OTHER_FAMILY = 'Other';

const CATALOGS_QUERY = /* GraphQL */ `
  query DictionaryCatalogs {
    getCatalogs {
      id
      defaultSchema
      schemas {
        name
      }
    }
  }
`;

const SCHEMA_QUERY = /* GraphQL */ `
  query DictionarySchema($catalog: String!, $schema: String!) {
    getDatasetInfo(catalog: $catalog, schema: $schema) {
      label
      description
      source
      updatedAt
      schemaVersion
      clusterBy
    }
    getCatalogSchema(catalog: $catalog, schema: $schema) {
      name
      label
      sqlType
      isCategorical
      isPrimaryKey
      parentName
      labelFor
      labelFields
      unit
      displayFormat
      family
      description
      defaultAggregation
    }
  }
`;

// ─── Accès à l'API ────────────────────────────────────────────────────────────

/**
 * Runs one GraphQL operation.
 *
 * @param apiUrl - GraphQL endpoint.
 * @param query - Operation document.
 * @param variables - Operation variables.
 * @returns The `data` of the response.
 * @throws {Error} On a network failure, a non-2xx status or GraphQL errors.
 */
export async function graphqlRequest(apiUrl, query, variables = {}) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (body?.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join('; '));
  }
  if (!response.ok || !body?.data) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return body.data;
}

// ─── Rendu markdown ───────────────────────────────────────────────────────────

/**
 * Makes a text safe inside a markdown table cell.
 *
 * @param value - Cell text, possibly null.
 * @returns The text on one line, `|` and `<` escaped; an empty string for null.
 */
export function escapeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/</g, '&lt;')
    .trim();
}

/**
 * Formats a value as inline code, empty when absent.
 *
 * @param value - Text to quote.
 * @returns The value between backticks, or an empty string.
 */
function code(value) {
  return value === null || value === undefined || value === '' ? '' : `\`${String(value).replace(/`/g, "'")}\``;
}

/**
 * Orders the columns of one schema for display: label columns come right after the
 * code they label, in the order of the API, and are attached to the family of that code.
 *
 * @param fields - Metadata of the columns, as returned by getCatalogSchema.
 * @returns Groups `{ family, columns }` — families sorted alphabetically, the columns
 *   without a family last under "Other"; each column carries its `isLabel` flag.
 */
export function groupByFamily(fields) {
  const names = new Set(fields.map((field) => field.name));
  const labelsByCode = new Map();
  for (const field of fields) {
    if (field.labelFor && names.has(field.labelFor)) {
      if (!labelsByCode.has(field.labelFor)) labelsByCode.set(field.labelFor, []);
      labelsByCode.get(field.labelFor).push(field);
    }
  }

  const groups = new Map();
  for (const field of fields) {
    // Une colonne de libellés suit son code, dans la famille de celui-ci
    if (field.labelFor && names.has(field.labelFor)) continue;
    const family = field.family || OTHER_FAMILY;
    if (!groups.has(family)) groups.set(family, []);
    const columns = groups.get(family);
    columns.push({ ...field, isLabel: false });
    for (const label of labelsByCode.get(field.name) ?? []) {
      columns.push({ ...label, isLabel: true });
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === OTHER_FAMILY) return 1;
      if (b === OTHER_FAMILY) return -1;
      return a.localeCompare(b, 'en');
    })
    .map(([family, columns]) => ({ family, columns }));
}

/**
 * Rebuilds the column hierarchies from `parentName`.
 *
 * A hierarchy is a chain of columns, each one pointing at its parent
 * (region → departement → commune). A parent with several children yields one chain per
 * branch. Label columns are not part of a hierarchy, and a column alone is not one.
 *
 * @param fields - Metadata of the columns, as returned by getCatalogSchema.
 * @returns Chains of column names, from the top level to the deepest one.
 */
export function buildHierarchies(fields) {
  const names = new Set(fields.filter((field) => !field.labelFor).map((field) => field.name));
  const children = new Map();
  for (const field of fields) {
    if (field.labelFor || !field.parentName || !names.has(field.parentName)) continue;
    if (!children.has(field.parentName)) children.set(field.parentName, []);
    children.get(field.parentName).push(field.name);
  }

  const isRoot = (field) =>
    !field.labelFor && children.has(field.name) && (!field.parentName || !names.has(field.parentName));

  const chains = [];
  const walk = (name, path, seen) => {
    const next = children.get(name);
    // Un cycle dans parentName ne doit pas boucler
    if (!next || seen.has(name)) {
      chains.push(path);
      return;
    }
    for (const child of next) walk(child, [...path, child], new Set([...seen, name]));
  };
  for (const field of fields) {
    if (isRoot(field)) walk(field.name, [field.name], new Set());
  }
  return chains;
}

/**
 * Renders the page of one (catalog, schema).
 *
 * @param page - `{ catalog, schema, info, fields }`: DatasetInfo and column metadata.
 * @returns The markdown of the page, with its frontmatter.
 */
export function renderSchemaPage({ catalog, schema, info, fields }) {
  const title = info.label || `${catalog}.${schema}`;
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `sidebar_label: ${JSON.stringify(schema)}`,
    `description: ${JSON.stringify(`Columns, labels and hierarchies of ${catalog}.${schema}`)}`,
    '---',
    '',
    `# ${title}`,
    '',
    ':::note',
    'Generated from the running API. Do not edit this page: run `npm run docs:dictionary`.',
    ':::',
    '',
  ];
  if (info.description) lines.push(info.description, '');

  lines.push(
    '| | |',
    '| --- | --- |',
    `| Catalog | ${code(catalog)} |`,
    `| Schema | ${code(schema)} |`,
    `| Source | ${escapeCell(info.source) || '—'} |`,
    `| Last update | ${escapeCell(info.updatedAt)} |`,
    `| Schema version | ${info.schemaVersion} |`,
    `| Sort columns (\`cluster_by\`, default page order) | ${info.clusterBy.map(code).join(', ') || '—'} |`,
    `| Columns | ${fields.length} |`,
    '',
  );

  const hierarchies = buildHierarchies(fields);
  if (hierarchies.length > 0) {
    lines.push('## Hierarchies', '');
    lines.push(
      'A hierarchy is a chain of columns declared through `parentName`; a missing level is `NULL`.',
      '',
    );
    for (const chain of hierarchies) {
      lines.push(`- ${chain.map(code).join(' → ')}`);
    }
    lines.push('');
  }

  lines.push('## Columns', '');
  lines.push('Label columns (`labelFor`) are listed under the code they label, prefixed with ↳.', '');
  for (const { family, columns } of groupByFamily(fields)) {
    lines.push(
      `### ${family}`,
      '',
      '| Name | Label | SQL type | Unit | Display format | Default aggregation | Categorical | Primary key | Description |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const column of columns) {
      const name = column.isLabel ? `↳ ${code(column.name)}` : code(column.name);
      lines.push(
        `| ${[
          name,
          escapeCell(column.label),
          code(column.sqlType),
          escapeCell(column.unit),
          code(column.displayFormat),
          code(column.defaultAggregation),
          column.isCategorical ? '✓' : '',
          column.isPrimaryKey ? '✓' : '',
          escapeCell(column.description),
        ].join(' | ')} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Renders the index page listing every generated schema.
 *
 * @param entries - `{ catalog, schema, title }` of each generated page.
 * @returns The markdown of the index, with its frontmatter.
 */
export function renderIndexPage(entries) {
  const lines = [
    '---',
    'id: data-dictionary-index',
    'title: Data Dictionary',
    'sidebar_label: Overview',
    'slug: /',
    '---',
    '',
    '# Data Dictionary',
    '',
    'One page per catalog and schema, generated from the API (`getCatalogs`, `getDatasetInfo`,',
    '`getCatalogSchema`): result-set description, columns grouped by family, label columns next',
    'to their code and column hierarchies.',
    '',
    '| Catalog | Schema | Title |',
    '| --- | --- | --- |',
  ];
  for (const { catalog, schema, title } of entries) {
    lines.push(`| ${code(catalog)} | [${escapeCell(schema)}](./${catalog}/${schema}.md) | ${escapeCell(title)} |`);
  }
  return `${lines.join('\n')}\n`;
}

// ─── Génération ───────────────────────────────────────────────────────────────

/**
 * Replaces a directory by another one, falling back to a copy when the rename is
 * refused (a synced or locked folder on Windows).
 *
 * @param source - Freshly rendered directory.
 * @param target - Directory to replace.
 */
async function replaceDirectory(source, target) {
  await rm(target, { recursive: true, force: true });
  try {
    await rename(source, target);
  } catch {
    await cp(source, target, { recursive: true });
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * Generates the whole dictionary.
 *
 * @param options - `apiUrl` (GraphQL endpoint), `outDir` (output directory), `log`
 *   (`{ info, warn }`, defaults to the console).
 * @returns `{ status, pages, skipped }`: status is `written`, `unreachable` (previous
 *   pages kept) or `empty` (the API answered but no schema could be described; previous
 *   pages kept).
 */
export async function generateDataDictionary({
  apiUrl = process.env.API_URL || DEFAULT_API_URL,
  outDir = DEFAULT_OUT_DIR,
  log = { info: console.log, warn: console.warn },
} = {}) {
  let catalogs;
  try {
    ({ getCatalogs: catalogs } = await graphqlRequest(apiUrl, CATALOGS_QUERY));
  } catch (error) {
    log.warn(
      `[data-dictionary] API unreachable at ${apiUrl} (${error.message}): keeping the previous pages.`,
    );
    return { status: 'unreachable', pages: 0, skipped: [] };
  }

  const tmpDir = `${outDir}.tmp`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  const entries = [];
  const skipped = [];
  for (const catalog of catalogs) {
    for (const { name: schema } of catalog.schemas) {
      try {
        const data = await graphqlRequest(apiUrl, SCHEMA_QUERY, { catalog: catalog.id, schema });
        const info = data.getDatasetInfo;
        const markdown = renderSchemaPage({
          catalog: catalog.id,
          schema,
          info,
          fields: data.getCatalogSchema,
        });
        await mkdir(join(tmpDir, catalog.id), { recursive: true });
        await writeFile(join(tmpDir, catalog.id, `${schema}.md`), markdown, 'utf8');
        entries.push({ catalog: catalog.id, schema, title: info.label || '' });
      } catch (error) {
        // Schéma invalide (version non supportée, dataset_metadata absent…) : page ignorée
        skipped.push({ catalog: catalog.id, schema, reason: error.message });
        log.warn(`[data-dictionary] ${catalog.id}.${schema} skipped: ${error.message}`);
      }
    }
  }

  if (entries.length === 0) {
    await rm(tmpDir, { recursive: true, force: true });
    log.warn('[data-dictionary] no schema could be described: keeping the previous pages.');
    return { status: 'empty', pages: 0, skipped };
  }

  await writeFile(join(tmpDir, 'index.md'), renderIndexPage(entries), 'utf8');
  await replaceDirectory(tmpDir, outDir);
  log.info(`[data-dictionary] ${entries.length} page(s) written to ${outDir}`);
  return { status: 'written', pages: entries.length, skipped };
}

// Exécution directe uniquement : le module reste importable par les tests
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex === -1 ? DEFAULT_OUT_DIR : resolve(process.argv[outIndex + 1]);
  generateDataDictionary({ outDir }).catch((error) => {
    // Filet de sécurité : la doc ne doit jamais échouer sur le dictionnaire
    console.warn(`[data-dictionary] unexpected error, previous pages kept: ${error.message}`);
  });
}
