// Importation des modules
import { GraphQLError } from 'graphql';
import { BaseQueryLoader } from './base-loader.js';
import { config } from '../utils/config-loader.js';
import { validateIdentifier } from '../utils/utils.js';
import {
  METADATA_SELECT,
  indexMetadataByName,
  resolveLabelField,
  toFieldMetadata,
  withLabelFields,
} from '../utils/metadata-mapping.js';
import type { DuckDBConnection } from './base-loader.js';

// ─── Interfaces des options de sélection ─────────────────────────────────────

/** Parameters for a select options query. */
interface SelectOptionsParams {
  fieldName: string;
  limit: number;
  searchTerm?: string | null;
  /**
   * Effective label column of fieldName, already resolved by resolveLabelField;
   * null renders `label = value`. Part of the key, hence of the cache key.
   */
  labelField?: string | null;
}

/** Select option with value and label. */
interface SelectOption {
  value: string;
  label: string;
}

/** Parameters for a select options tree query. */
interface SelectOptionsTreeParams {
  /** Deepest level displayed (the leaves of the tree). */
  fieldName: string;
  /** Levels kept going up from fieldName; null keeps the whole chain. */
  maxDepth: number | null;
  /** Case-insensitive filter on the fieldName level. */
  searchTerm: string | null;
  /** Hard bound on the node count; part of the key so a cached tree never bypasses it. */
  maxNodes: number;
}

/** One level of a tree chain: the code column and its effective label column. */
interface ChainLevel {
  column: string;
  /** Label column read with the code; null renders `label = value`. */
  labelColumn: string | null;
}

/** Node of a select options tree; `children` is absent on leaves. */
interface SelectOptionNode {
  value: string;
  label: string;
  children?: SelectOptionNode[];
}

/** Internal build node — children keyed by value, in insertion order. */
interface BuildNode {
  value: string;
  label: string;
  children: Map<string, BuildNode>;
}

// Borne par défaut du nombre de nœuds d'un arbre (SELECT_OPTIONS.TREE_MAX_NODES)
const DEFAULT_TREE_MAX_NODES = 5000;

// ─── Fonction utilitaire ─────────────────────────────────────────────────────

/**
 * Escapes the LIKE wildcards of a user-provided search term.
 *
 * The term is passed as a bound parameter, so this only neutralizes `%`, `_`
 * and the escape character itself, which would otherwise widen the match.
 *
 * @param term - Raw search term.
 * @returns Term safe to wrap in `%…%` for a LIKE … ESCAPE '\' predicate.
 */
// Échappement des jokers LIKE d'un terme de recherche
function escapeLikeWildcards(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Erreur de dépassement de la borne du nombre de nœuds
/**
 * Builds the error raised when a tree exceeds its node bound.
 *
 * @param fieldName - Leaf column of the requested tree.
 * @param maxNodes - Configured bound.
 * @returns BAD_USER_INPUT error pointing to searchTerm and maxDepth.
 */
function treeTooLargeError(fieldName: string, maxNodes: number): GraphQLError {
  return new GraphQLError(
    `Select options tree for '${fieldName}' exceeds ${maxNodes} nodes. ` +
      'Narrow it with searchTerm or reduce maxDepth.',
    { extensions: { code: 'BAD_USER_INPUT' } },
  );
}

// Conversion d'un nœud de construction en nœud rendu
/**
 * Converts a build node into its rendered form, recursively.
 *
 * @param node - Build node to convert.
 * @returns Rendered node, without `children` on a leaf.
 */
function toOptionNode(node: BuildNode): SelectOptionNode {
  const rendered: SelectOptionNode = { value: node.value, label: node.label };
  if (node.children.size > 0) {
    rendered.children = [...node.children.values()].map(toOptionNode);
  }
  return rendered;
}

// Construction de l'arbre à partir des lignes du SELECT DISTINCT
/**
 * Builds a nested option tree from the distinct rows of a column chain.
 *
 * Rows must come ordered by the chain columns: siblings keep that order.
 * A branch stops at its first NULL level (specification-bdd.md §2.5), so an
 * irregular branch ends on a shallower leaf and no empty node is produced.
 * A level with a label column reads its label from the `_label_<i>` alias of
 * the row, falling back to the code when the label is NULL.
 *
 * @param rows - Distinct rows of the chain columns, ordered.
 * @param chain - Levels, from the root level to the leaf level.
 * @param maxNodes - Hard bound on the total number of nodes.
 * @param fieldName - Leaf column, quoted in the overflow error.
 * @returns The forest of root nodes.
 * @throws {GraphQLError} BAD_USER_INPUT when the tree exceeds maxNodes.
 */
function buildOptionTree(
  rows: Record<string, unknown>[],
  chain: ChainLevel[],
  maxNodes: number,
  fieldName: string,
): SelectOptionNode[] {
  // Initialisation des racines et du comptage des noeuds
  const roots = new Map<string, BuildNode>();
  let nodeCount = 0;

  // Parcours des lignes
  for (const row of rows) {
    let siblings = roots;
    // Parcours des branches
    for (const [index, { column, labelColumn }] of chain.entries()) {
      const raw = row[column];
      // Premier niveau NULL : fin de la branche
      if (raw === null || raw === undefined) break;

      const value = String(raw);
      let node = siblings.get(value);
      if (!node) {
        nodeCount += 1;
        if (nodeCount > maxNodes) throw treeTooLargeError(fieldName, maxNodes);
        // Libellé du niveau, repli sur le code quand il est NULL
        const rawLabel = labelColumn ? row[`_label_${index}`] : null;
        const label = rawLabel === null || rawLabel === undefined ? value : String(rawLabel);
        node = { value, label, children: new Map() };
        siblings.set(value, node);
      }
      siblings = node.children;
    }
  }

  return [...roots.values()].map(toOptionNode);
}

// Classe de chargement des options de sélection
/**
 * Loader for select option queries (dropdown values).
 *
 * The fact table stores labels directly (no dim_* table exists): a DISTINCT
 * scan of the column, with `label = value` — except for a code column with a
 * label column (specification-bdd.md §2.6), read from the same fact table
 * row: `value` = code, `label` = label.
 */
class SelectOptionsLoader extends BaseQueryLoader {
  // Initialisation avec la configuration spécifique aux options de sélection
  /**
   * Creates a SelectOptionsLoader bound to a specific database.
   *
   * @param catalogId - Catalog alias to query; null uses the default catalog.
   * @param schema - DuckLake schema within the catalog; null uses the catalog default.
   * @param cacheVariant - Result shape sharing the prefix (e.g. 'tree'); null for flat lists.
   */
  constructor(
    catalogId: string | null = null,
    schema: string | null = null,
    cacheVariant: string | null = null,
  ) {
    super({
      batchSize: config.API.LOADERS.BATCH_SIZE,
      cachePrefix: 'select-options',
      cache: true,
      // Durée de mise en cache plus longue car les options changent peu
      cacheTimeout: config.API.LOADERS.SELECT_OPTIONS_CACHE_TIMEOUT,
      catalogId,
      schema,
      cacheVariant,
    });
  }

  // Méthode de chargement des valeurs distinctes d'une colonne
  /**
   * Loads the distinct values of a fact table column as select options.
   *
   * NULL values are excluded — they carry no modality and terminate a branch
   * of a column hierarchy. The search term is bound as a parameter and its
   * LIKE wildcards are escaped.
   *
   * With a label column, the code and its label are read by the same
   * `SELECT DISTINCT`: the functional dependency code → label guaranteed by
   * the writer makes `DISTINCT (code, label)` equal to `DISTINCT code`. The
   * code is cast to VARCHAR, the search matches the code or the label, and a
   * NULL label falls back to the code (`SelectOption.label` is non-null).
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Object with fieldName, limit, optional searchTerm and the
   *   effective labelField.
   * @returns Array of SelectOption; `label = value` without a label column.
   * @throws {GraphQLError} BAD_USER_INPUT when the column does not exist in the
   *   schema's metadata table.
   */
  async loadSelectOptions(
    connection: DuckDBConnection,
    { fieldName, limit, searchTerm, labelField = null }: SelectOptionsParams,
  ): Promise<SelectOption[]> {
    validateIdentifier(fieldName, 'fieldName');
    if (labelField) validateIdentifier(labelField, 'labelField');

    // La colonne doit être déclarée dans metadata : contrôle explicite pour
    // renvoyer une erreur utilisable plutôt que de laisser fuiter DuckDB.
    const declared = await connection.all(
      `SELECT name FROM ${this.qualifyTable('metadata')} WHERE name = ?`,
      [fieldName],
    );
    if (declared.length === 0) {
      throw new GraphQLError(`Unknown field '${fieldName}'`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    if (labelField) {
      return this.loadLabelledSelectOptions(connection, fieldName, labelField, limit, searchTerm);
    }

    // Construction de la requête : valeurs distinctes, NULL exclus, triées
    let query =
      `SELECT DISTINCT ${fieldName} AS value FROM ${this.qualifyTable('fact_table')} ` +
      `WHERE ${fieldName} IS NOT NULL`;
    const params: unknown[] = [];

    // Recherche insensible à la casse, jokers du terme neutralisés
    if (searchTerm) {
      query += ` AND LOWER(CAST(${fieldName} AS VARCHAR)) LIKE ? ESCAPE '\\'`;
      params.push(`%${escapeLikeWildcards(searchTerm.toLowerCase())}%`);
    }

    query += ` ORDER BY ${fieldName} LIMIT ?`;
    params.push(limit);

    const results = await connection.all(query, params);

    // Colonne sans libellés : la fact table porte le libellé, label = value (spec bdd §2.4)
    return results.map((row) => ({
      value: String(row.value),
      label: String(row.value),
    }));
  }

  // Méthode de chargement des couples (code, libellé) d'une colonne de code
  /**
   * Loads the distinct (code, label) pairs of a code column.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param fieldName - Code column, already validated.
   * @param labelField - Effective label column, already validated.
   * @param limit - Maximum number of options.
   * @param searchTerm - Case-insensitive filter on the code or the label.
   * @returns Options ordered by code as VARCHAR, `label` falling back to the code.
   */
  private async loadLabelledSelectOptions(
    connection: DuckDBConnection,
    fieldName: string,
    labelField: string,
    limit: number,
    searchTerm?: string | null,
  ): Promise<SelectOption[]> {
    // Couple (code, libellé) lu dans la même ligne de la fact table
    let query =
      `SELECT DISTINCT CAST(${fieldName} AS VARCHAR) AS value, ${labelField} AS label ` +
      `FROM ${this.qualifyTable('fact_table')} WHERE ${fieldName} IS NOT NULL`;
    const params: unknown[] = [];

    // Recherche dans le code ou le libellé, même échappement des jokers
    if (searchTerm) {
      const pattern = `%${escapeLikeWildcards(searchTerm.toLowerCase())}%`;
      query +=
        ` AND (LOWER(CAST(${fieldName} AS VARCHAR)) LIKE ? ESCAPE '\\'` +
        ` OR LOWER(${labelField}) LIKE ? ESCAPE '\\')`;
      params.push(pattern, pattern);
    }

    query += ' ORDER BY value LIMIT ?';
    params.push(limit);

    const results = await connection.all(query, params);

    // Code sans libellé : label = value, SelectOption.label étant non nullable
    return results.map((row) => ({
      value: String(row.value),
      label: row.label === null || row.label === undefined ? String(row.value) : String(row.label),
    }));
  }

  // Méthode de résolution de la chaîne de colonnes d'une hiérarchie
  /**
   * Resolves the column chain ending at fieldName by walking `parentName` up.
   *
   * The writer guarantees a forest ; the walk still
   * stops on a column already visited or on an undeclared parent, so that a
   * corrupted metadata table can never make it loop. Each level carries its
   * effective label column, picked by the default rule of resolveLabelField
   * from the same metadata read (no per-level argument).
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param fieldName - Deepest level of the chain.
   * @param maxDepth - Number of levels kept going up; null keeps them all.
   * @returns Levels from the root down to fieldName, with their label columns.
   * @throws {GraphQLError} BAD_USER_INPUT when fieldName is not declared.
   */
  async resolveColumnChain(
    connection: DuckDBConnection,
    fieldName: string,
    maxDepth: number | null,
  ): Promise<ChainLevel[]> {
    // Lecture de metadata par le point de mapping unique du contrat
    const rows = await connection.all(
      `SELECT ${METADATA_SELECT} FROM ${this.qualifyTable('metadata')}`,
    );
    const metadataByName = indexMetadataByName(withLabelFields(rows.map(toFieldMetadata)));
    const parentOf = new Map(
      [...metadataByName.values()].map((field) => [field.name, field.parentName]),
    );

    if (!parentOf.has(fieldName)) {
      throw new GraphQLError(`Unknown field '${fieldName}'`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // Remontée depuis la feuille, garde-fou anti-cycle compris
    const chain = [fieldName];
    let parent = parentOf.get(fieldName) ?? null;
    while (parent && (maxDepth === null || chain.length < maxDepth)) {
      if (chain.includes(parent) || !parentOf.has(parent)) break;
      chain.push(parent);
      parent = parentOf.get(parent) ?? null;
    }

    // Validation de chaque identifiant avant interpolation, libellé par défaut du niveau
    return chain.reverse().map((column) => {
      const labelColumn = resolveLabelField(column, metadataByName);
      return {
        column: validateIdentifier(column, 'parentName'),
        labelColumn: labelColumn ? validateIdentifier(labelColumn, 'labelField') : null,
      };
    });
  }

  // Méthode de chargement de l'arbre des options d'une hiérarchie de colonnes
  /**
   * Loads the option tree of a column hierarchy, fieldName being the leaves.
   *
   * One distinct query over the chain columns, then the tree is built in
   * memory. NULL root values are excluded and a NULL level ends its branch.
   * Each level with a label column adds that column to the same DISTINCT —
   * the functional dependency code → label keeps one row per code path, so
   * a node is still one code. With a searchTerm, only rows whose leaf code or
   * leaf label matches are read, so only the branches leading to a retained
   * leaf survive. The query is capped at
   * maxNodes + 1 rows: each distinct row ends on a distinct node, so reaching
   * the cap already proves the tree too large.
   *
   * @param connection - Active DuckDB connection from the pool.
   * @param params - Object with fieldName, maxDepth, searchTerm and maxNodes.
   * @returns Forest of `{ value, label, children? }` nodes.
   * @throws {GraphQLError} BAD_USER_INPUT when maxDepth < 1, fieldName is
   *   unknown, or the tree exceeds maxNodes.
   */
  async loadSelectOptionsTree(
    connection: DuckDBConnection,
    { fieldName, maxDepth, searchTerm, maxNodes }: SelectOptionsTreeParams,
  ): Promise<SelectOptionNode[]> {
    validateIdentifier(fieldName, 'fieldName');
    if (maxDepth !== null && maxDepth < 1) {
      throw new GraphQLError('maxDepth must be greater than or equal to 1', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    const chain = await this.resolveColumnChain(connection, fieldName, maxDepth);
    const codes = chain.map(({ column }) => column).join(', ');
    // Chaque niveau apporte son code et, s'il en a une, sa colonne de libellés
    const projection = chain
      .flatMap(({ column, labelColumn }, index) =>
        labelColumn ? [column, `${labelColumn} AS _label_${index}`] : [column],
      )
      .join(', ');
    const leafLabel = chain[chain.length - 1].labelColumn;

    // Construction de la requête : racine non NULL, feuille éventuellement filtrée
    let query =
      `SELECT DISTINCT ${projection} FROM ${this.qualifyTable('fact_table')} ` +
      `WHERE ${chain[0].column} IS NOT NULL`;
    const params: unknown[] = [];

    // Recherche sur le code de la feuille, ou sur son libellé quand il existe
    if (searchTerm) {
      const pattern = `%${escapeLikeWildcards(searchTerm.toLowerCase())}%`;
      if (leafLabel) {
        query +=
          ` AND (LOWER(CAST(${fieldName} AS VARCHAR)) LIKE ? ESCAPE '\\'` +
          ` OR LOWER(${leafLabel}) LIKE ? ESCAPE '\\')`;
        params.push(pattern, pattern);
      } else {
        query += ` AND LOWER(CAST(${fieldName} AS VARCHAR)) LIKE ? ESCAPE '\\'`;
        params.push(pattern);
      }
    }

    // Plafond maxNodes + 1 : une ligne distincte = un nœud terminal distinct
    query += ` ORDER BY ${codes} LIMIT ?`;
    params.push(maxNodes + 1);

    const rows = await connection.all(query, params);
    if (rows.length > maxNodes) throw treeTooLargeError(fieldName, maxNodes);

    return buildOptionTree(rows, chain, maxNodes, fieldName);
  }
}

// Fonction de création d'un loader pour les options de sélection
/**
 * Creates a DataLoader for select option queries.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by SelectOptionsParams, returning SelectOption arrays.
 */
const createSelectOptionsLoader = (
  catalogId: string | null = null,
  schema: string | null = null,
) => {
  const loader = new SelectOptionsLoader(catalogId, schema);
  return loader.createLoader<SelectOptionsParams, SelectOption[]>((connection, params) =>
    loader.loadSelectOptions(connection, params),
  );
};

// Fonction de création d'un loader pour les arbres d'options de sélection
/**
 * Creates a DataLoader for select option trees of column hierarchies.
 *
 * Shares the `select-options` cache prefix (so the existing invalidation
 * patterns cover it) under a dedicated `tree` variant.
 *
 * @param catalogId - Catalog alias to query; null uses the default catalog.
 * @param schema - DuckLake schema within the catalog; null uses the catalog default.
 * @returns DataLoader keyed by SelectOptionsTreeParams, returning option forests.
 */
const createSelectOptionsTreeLoader = (
  catalogId: string | null = null,
  schema: string | null = null,
) => {
  const loader = new SelectOptionsLoader(catalogId, schema, 'tree');
  return loader.createLoader<SelectOptionsTreeParams, SelectOptionNode[]>((connection, params) =>
    loader.loadSelectOptionsTree(connection, params),
  );
};

export {
  createSelectOptionsLoader,
  createSelectOptionsTreeLoader,
  SelectOptionsLoader,
  DEFAULT_TREE_MAX_NODES,
};
export type {
  SelectOptionsParams,
  SelectOption,
  SelectOptionsTreeParams,
  SelectOptionNode,
  ChainLevel,
};
