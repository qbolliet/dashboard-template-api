// Importation des types GraphQL nécessaires à l'analyse AST
import { valueFromASTUntyped } from 'graphql';
import type {
  FieldNode,
  FragmentDefinitionNode,
  GraphQLSchema,
  InlineFragmentNode,
  OperationDefinitionNode,
  ArgumentNode,
  SelectionSetNode,
  ValueNode,
  IntValueNode,
  FloatValueNode,
} from 'graphql';
import { createContextLogger } from '../utils/logger.js';
import { config } from '../utils/config-loader.js';
import type { ContextLogger } from '../utils/logger.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Normalized internal configuration for the complexity analyzer. */
interface ComplexityAnalyzerConfig {
  maxAllowed: number;
  maxRootFields: number;
  scalarCost: number;
  objectCost: number;
  depthFactor: number;
  introspectionCost: number;
  rowCost: number;
  statsCostPerColumn: number;
  defaultRootFieldScore: number;
  rootFieldScores: Record<string, number>;
}

/** Union of AST node types accepted by the recursive complexity analyzer. */
type ComplexityNode = FieldNode | InlineFragmentNode | FragmentDefinitionNode;

/**
 * Source of the number of columns of a schema, used to price `Metadata.stats`
 * (one SQL query per column).
 */
interface ColumnCounter {
  /**
   * Number of columns of a (catalog, schema) target, as given by the GraphQL
   * arguments (absent values resolve to the defaults).
   */
  columnsOf(catalog: unknown, schema: unknown): Promise<number>;
  /** Number of columns of every schema of every catalog. */
  allColumns(): Promise<number>;
}

/** Optional inputs refining the score of an operation. */
interface ScoringOptions {
  /** Executable schema: supplies the default `limit` of an omitted argument. */
  schema?: GraphQLSchema;
  /** Column counts; without it, every Metadata list counts as one column. */
  columns?: ColumnCounter;
}

/**
 * Metadata list reached by following `path` (field names, aliases ignored)
 * below the current node; `count` gives its number of columns.
 */
interface ColumnList {
  path: readonly string[];
  count: () => Promise<number>;
}

/** Per-operation state shared by the recursive walk. */
interface Walk {
  fragments: Record<string, FragmentDefinitionNode>;
  variables: Record<string, unknown>;
}

// ─── Constantes ──────────────────────────────────────────────────────────────

// Champs d'introspection facturés INTROSPECTION_COST ; __typename est gratuit
// (ajouté par Apollo Client et urql à chaque sélection)
const INTROSPECTION_FIELDS = new Set(['__schema', '__type']);

// Compteur par défaut : chaque liste de Metadata compte pour une colonne
const SINGLE_COLUMN: ColumnCounter = {
  columnsOf: async () => 1,
  allColumns: async () => 1,
};

// ─── Classe d'analyse de complexité ─────────────────────────────────────────

/**
 * Analyzes the complexity of GraphQL queries.
 *
 * Every root field pays its configured score (ROOT_FIELD_SCORES, a non-zero
 * default otherwise), the rows requested through `limit`, its filters and
 * sorts; nested objects pay OBJECT_COST times DEPTH_FACTOR^depth, and
 * `Metadata.stats` pays per column of the list it belongs to. The scale is
 * documented in docs-site/toolbox/docs/architecture/security.md.
 */
class QueryComplexityAnalyzer {
  private config: ComplexityAnalyzerConfig;
  private logger: ContextLogger;

  /**
   * Initializes the analyzer with values from the YAML complexity config.
   *
   * @param complexityConfig - Raw complexity section from SECURITY.COMPLEXITY.
   */
  constructor(complexityConfig: Partial<Record<string, unknown>> = {}) {
    // Fusion des options avec les valeurs par défaut
    this.config = {
      maxAllowed: (complexityConfig['MAX_ALLOWED'] as number) ?? 200,
      maxRootFields: (complexityConfig['MAX_ROOT_FIELDS'] as number) ?? 20,
      scalarCost: (complexityConfig['SCALAR_COST'] as number) ?? 0,
      objectCost: (complexityConfig['OBJECT_COST'] as number) ?? 1,
      depthFactor: (complexityConfig['DEPTH_FACTOR'] as number) ?? 1.5,
      introspectionCost: (complexityConfig['INTROSPECTION_COST'] as number) ?? 1000,
      rowCost: (complexityConfig['ROW_COST'] as number) ?? 0.1,
      statsCostPerColumn: (complexityConfig['STATS_COST_PER_COLUMN'] as number) ?? 5,
      defaultRootFieldScore: (complexityConfig['DEFAULT_ROOT_FIELD_SCORE'] as number) ?? 5,
      rootFieldScores: (complexityConfig['ROOT_FIELD_SCORES'] as Record<string, number>) ?? {},
    };
    // Initialisation du logger contextuel
    this.logger = createContextLogger({ component: 'security', module: 'complexity' });
  }

  /**
   * Calculates the complexity score of a whole GraphQL operation.
   *
   * Every root field of the operation (fragments at the root included) is
   * scored and the scores are summed, so that a document requesting several
   * expensive queries pays for all of them.
   *
   * @param operation - Operation definition resolved by Apollo before execution.
   * @param fragments - Named fragment definitions declared in the document.
   * @param variables - Resolved variable values for the operation.
   * @param options - Executable schema and column counter, both optional.
   * @returns Cumulative complexity score for the operation.
   */
  async calculateForOperation(
    operation: OperationDefinitionNode,
    fragments: Record<string, FragmentDefinitionNode> = {},
    variables: Record<string, unknown> = {},
    options: ScoringOptions = {},
  ): Promise<number> {
    // Valeurs effectives des variables : fournies, sinon défaut de la définition
    const walk: Walk = { fragments, variables: this.withDefaultValues(operation, variables) };
    const columns = options.columns ?? SINGLE_COLUMN;

    // Score cumulé des champs racine
    let complexity = 0;
    for (const field of this.collectRootFields(operation.selectionSet, fragments)) {
      complexity += await this.calculateFieldComplexity(
        field,
        walk,
        0,
        this.columnListOf(field, walk, columns),
        this.defaultLimitOf(field, options.schema),
      );
    }

    // Journalisation du score calculé
    this.logger.operation('Query complexity calculated', {
      operationName: operation.name?.value ?? 'anonymous',
      complexity,
      maxAllowed: this.config.maxAllowed,
    });

    return complexity;
  }

  /**
   * Counts the root fields of an operation, aliases included.
   *
   * Meta fields (`__typename`, introspection) are not counted: they read no
   * data. Fragments at the root are expanded.
   *
   * @param operation - Operation definition to inspect.
   * @param fragments - Named fragment definitions declared in the document.
   * @returns Number of data root fields.
   */
  countRootFields(
    operation: OperationDefinitionNode,
    fragments: Record<string, FragmentDefinitionNode> = {},
  ): number {
    return this.collectRootFields(operation.selectionSet, fragments).filter(
      (field) => !field.name.value.startsWith('__'),
    ).length;
  }

  /**
   * Returns the configured complexity ceiling.
   *
   * @returns Maximum complexity score allowed for a single operation.
   */
  get maxAllowed(): number {
    return this.config.maxAllowed;
  }

  /**
   * Returns the configured ceiling on root fields.
   *
   * @returns Maximum number of root fields allowed for a single operation.
   */
  get maxRootFields(): number {
    return this.config.maxRootFields;
  }

  /**
   * Flattens the root selection set into its fields.
   *
   * Inline fragments and fragment spreads at the root carry root fields: they
   * are expanded recursively (an unknown fragment is ignored).
   *
   * @param selectionSet - Root selection set of the operation (or of a fragment).
   * @param fragments - Named fragment definitions available in the document.
   * @param visited - Fragment names already expanded (guards against cycles).
   * @returns Root field nodes, in document order.
   */
  private collectRootFields(
    selectionSet: SelectionSetNode | undefined,
    fragments: Record<string, FragmentDefinitionNode>,
    visited: Set<string> = new Set(),
  ): FieldNode[] {
    const fields: FieldNode[] = [];
    for (const selection of selectionSet?.selections ?? []) {
      if (selection.kind === 'Field') {
        fields.push(selection);
      } else if (selection.kind === 'InlineFragment') {
        fields.push(...this.collectRootFields(selection.selectionSet, fragments, visited));
      } else {
        const name = selection.name.value;
        const fragment = fragments[name];
        if (fragment && !visited.has(name)) {
          visited.add(name);
          fields.push(...this.collectRootFields(fragment.selectionSet, fragments, visited));
        }
      }
    }
    return fields;
  }

  /**
   * Locates the Metadata list of a root field, whose `stats` is priced per column.
   *
   * The only lists of Metadata of the API: the columns of a schema
   * (`getCatalogSchema`), the columns of a page (`getFactTableWithMetadata {
   * fields }`, the `fields` argument when given) and every column of every
   * schema (`getCatalogs { schemas { fields } }`). Any other Metadata is a
   * single column.
   *
   * @param root - Root field node.
   * @param walk - Variables of the operation.
   * @param columns - Column counter of the request.
   * @returns The list below the root field, or null.
   */
  private columnListOf(root: FieldNode, walk: Walk, columns: ColumnCounter): ColumnList | null {
    const catalog = this.argumentValue(root, 'catalog', walk.variables);
    const schema = this.argumentValue(root, 'schema', walk.variables);

    switch (root.name.value) {
      case 'getCatalogSchema':
        return { path: [], count: () => columns.columnsOf(catalog, schema) };
      case 'getFactTableWithMetadata': {
        // Colonnes projetées : l'argument `fields`, sinon toutes celles du schéma
        const fields = this.argumentValue(root, 'fields', walk.variables);
        const count =
          Array.isArray(fields) && fields.length > 0
            ? async (): Promise<number> => fields.length
            : (): Promise<number> => columns.columnsOf(catalog, schema);
        return { path: ['fields'], count };
      }
      case 'getCatalogs':
        return { path: ['schemas', 'fields'], count: () => columns.allColumns() };
      default:
        return null;
    }
  }

  /**
   * Reads the SDL default of the `limit` argument of a root field.
   *
   * @param root - Root field node.
   * @param schema - Executable schema, when available.
   * @returns The default limit, or undefined when the field has no `limit`
   *   argument or the schema is unknown.
   */
  private defaultLimitOf(root: FieldNode, schema: GraphQLSchema | undefined): number | undefined {
    const definition = schema?.getQueryType()?.getFields()[root.name.value];
    const limitArg = definition?.args.find((arg) => arg.name === 'limit');
    if (!limitArg) {
      return undefined;
    }
    // Argument sans défaut SDL : taille de page par défaut de l'API
    return typeof limitArg.defaultValue === 'number'
      ? limitArg.defaultValue
      : (config.API?.PAGINATION?.DEFAULT_LIMIT ?? 100);
  }

  /**
   * Reads the value of an argument of a field (literal or variable).
   *
   * @param field - Field node carrying the argument.
   * @param name - Argument name.
   * @param variables - Effective variable values of the operation.
   * @returns The argument value, or undefined when absent or unreadable.
   */
  private argumentValue(
    field: FieldNode,
    name: string,
    variables: Record<string, unknown>,
  ): unknown {
    const argument = field.arguments?.find((arg) => arg.name.value === name);
    if (!argument) {
      return undefined;
    }
    try {
      return valueFromASTUntyped(argument.value, variables);
    } catch {
      return undefined;
    }
  }

  /**
   * Recursively computes the complexity contribution of an AST node.
   *
   * @param node - AST node to analyze (field, inline fragment, or named fragment).
   * @param walk - Fragments and variables of the operation.
   * @param depth - Current recursion depth (0 for a root field).
   * @param columnList - Metadata list at or below this node, if any.
   * @param defaultLimit - SDL default of an omitted `limit` (root fields only).
   * @returns Cumulative complexity score for this node and all its descendants.
   */
  private async calculateFieldComplexity(
    node: ComplexityNode,
    walk: Walk,
    depth: number,
    columnList: ColumnList | null,
    defaultLimit?: number,
  ): Promise<number> {
    // Coût propre du nœud — un fragment (nommé ou en ligne) est un conteneur et
    // non un champ : il ne coûte rien par lui-même, seulement par ses sélections.
    let complexity = 0;
    if (node.kind === 'Field') {
      complexity = await this.fieldCost(node, depth, columnList);

      // Complexité additionnelle des arguments du champ
      complexity += this.calculateArgumentsComplexity(
        node.arguments ?? [],
        walk.variables,
        defaultLimit,
      );
    }

    // Récursion sur les sélections enfants
    for (const selection of node.selectionSet?.selections ?? []) {
      if (selection.kind === 'Field') {
        complexity += await this.calculateFieldComplexity(
          selection,
          walk,
          depth + 1,
          this.childColumnList(columnList, selection),
        );
      } else if (selection.kind === 'InlineFragment') {
        complexity += await this.calculateFieldComplexity(selection, walk, depth, columnList);
      } else {
        const fragment = walk.fragments[selection.name.value];
        if (fragment) {
          complexity += await this.calculateFieldComplexity(fragment, walk, depth, columnList);
        }
      }
    }

    return complexity;
  }

  /**
   * Computes the own cost of a field, before arguments and children.
   *
   * @param field - Field node.
   * @param depth - Depth of the field (0 for a root field).
   * @param columnList - Metadata list at or below this field, if any.
   * @returns The cost of the field itself.
   */
  private async fieldCost(
    field: FieldNode,
    depth: number,
    columnList: ColumnList | null,
  ): Promise<number> {
    const name = field.name.value;

    // __typename : aucune donnée lue
    if (name === '__typename') {
      return 0;
    }
    // Champ d'introspection — coût intentionnellement élevé
    if (INTROSPECTION_FIELDS.has(name)) {
      return this.config.introspectionCost * Math.pow(this.config.depthFactor, depth);
    }
    // Champ racine : score de la table, jamais nul pour un champ absent
    if (depth === 0) {
      return this.config.rootFieldScores[name] ?? this.config.defaultRootFieldScore;
    }
    // Metadata.stats : une requête SQL par colonne de la liste englobante
    if (name === 'stats' && field.selectionSet) {
      const columns = columnList && columnList.path.length === 0 ? await columnList.count() : 1;
      return this.config.statsCostPerColumn * columns;
    }
    // Coût d'objet (sous-sélection) ou de feuille, pondéré par la profondeur
    const base = field.selectionSet ? this.config.objectCost : this.config.scalarCost;
    return base * Math.pow(this.config.depthFactor, depth);
  }

  /**
   * Follows the path to a Metadata list one level down.
   *
   * @param columnList - List at or below the parent field, if any.
   * @param child - Child field node.
   * @returns The list at or below the child, or null when the child leaves the path.
   */
  private childColumnList(columnList: ColumnList | null, child: FieldNode): ColumnList | null {
    if (!columnList) {
      return null;
    }
    // Parent = la liste elle-même : ses enfants (dont `stats`) la voient
    if (columnList.path.length === 0) {
      return columnList;
    }
    // Descente le long du chemin, les alias étant ignorés
    return columnList.path[0] === child.name.value
      ? { path: columnList.path.slice(1), count: columnList.count }
      : null;
  }

  /**
   * Calculates additional complexity from field arguments.
   *
   * Rows requested through `limit` (bounded by API.PAGINATION.MAX_LIMIT, above
   * which the resolver rejects the query before any SQL), filters and sorts
   * each carry a cost reflecting their execution overhead.
   *
   * @param args - Argument AST nodes for the current field.
   * @param variables - Resolved variable values for the operation.
   * @param defaultLimit - Limit charged when the field omits `limit`.
   * @returns Complexity contribution from the given arguments.
   */
  private calculateArgumentsComplexity(
    args: readonly ArgumentNode[],
    variables: Record<string, unknown>,
    defaultLimit?: number,
  ): number {
    // Initialisation du score d'arguments
    let complexity = 0;
    let limitCharged = false;

    for (const arg of args) {
      const argName = arg.name.value;

      if (argName === 'limit' || argName === 'first') {
        // Coût proportionnel au nombre de lignes demandées
        complexity += this.rowsCost(this.resolveLimit(arg.value, variables));
        limitCharged = true;
      } else if (argName === 'structuredFilters' || argName === 'where') {
        // Coût fixe pour les prédicats de filtre
        complexity += 2;
      } else if (argName === 'orderBy' || argName === 'sort') {
        // Coût pour les directives de tri
        complexity += 1;
      }
    }

    // `limit` omis : la valeur par défaut du SDL s'applique, elle est facturée
    if (!limitCharged && defaultLimit !== undefined) {
      complexity += this.rowsCost(defaultLimit);
    }

    return complexity;
  }

  /**
   * Prices a number of requested rows.
   *
   * @param limit - Requested rows.
   * @returns ROW_COST per row, rows bounded by API.PAGINATION.MAX_LIMIT.
   */
  private rowsCost(limit: number): number {
    const maxLimit = config.API?.PAGINATION?.MAX_LIMIT ?? 1000;
    return Math.min(limit, maxLimit) * this.config.rowCost;
  }

  /**
   * Completes the provided variables with the defaults of the operation.
   *
   * A variable that is omitted, or explicitly undefined, takes the default
   * declared in its definition (`$limit: Int = 50`). A variable set to null
   * is kept as is: it is a value, resolved by {@link resolveLimit}.
   *
   * @param operation - Operation whose variable definitions carry the defaults.
   * @param variables - Variable values provided with the request.
   * @returns Variable values with the defaults applied.
   */
  private withDefaultValues(
    operation: OperationDefinitionNode,
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const effective: Record<string, unknown> = { ...variables };

    for (const definition of operation.variableDefinitions ?? []) {
      const name = definition.variable.name.value;
      if (effective[name] === undefined && definition.defaultValue) {
        effective[name] = valueFromASTUntyped(definition.defaultValue);
      }
    }
    return effective;
  }

  /**
   * Resolves the value of a pagination argument (`limit`, `first`).
   *
   * The argument is a literal or a variable reference. An absent or null
   * variable means the field default applies: the API default page size
   * (API.PAGINATION.DEFAULT_LIMIT) is charged, never zero, so that omitting
   * the limit cannot make a query cheaper than its real cost. Never throws.
   *
   * @param node - Value node of the argument.
   * @param variables - Effective variable values of the operation.
   * @returns A non-negative numeric limit.
   */
  private resolveLimit(node: ValueNode, variables: Record<string, unknown>): number {
    let value: ValueNode | unknown = node;

    // Résolution des références de variables GraphQL
    if (node.kind === 'Variable') {
      value = variables[node.name.value];
    }

    // Variable absente ou nulle, ou littéral null : limite par défaut du champ
    if (value === undefined || value === null || (value as ValueNode).kind === 'NullValue') {
      return config.API?.PAGINATION?.DEFAULT_LIMIT ?? 100;
    }

    const limit = this.extractNumericValue(value as ValueNode | number);
    return Number.isFinite(limit) ? Math.max(limit, 0) : 0;
  }

  /**
   * Extracts a numeric value from an AST value node or a plain number.
   *
   * @param node - An AST IntValue, FloatValue node, or a plain JavaScript number.
   * @returns The numeric value, or 0 when the type is unrecognized.
   */
  private extractNumericValue(node: ValueNode | number): number {
    if (typeof node === 'number') {
      return node;
    }
    if (node?.kind === 'IntValue') {
      return parseInt((node as IntValueNode).value, 10);
    }
    if (node?.kind === 'FloatValue') {
      return parseFloat((node as FloatValueNode).value);
    }
    return 0;
  }
}

export { QueryComplexityAnalyzer };
export type { ComplexityAnalyzerConfig, ComplexityNode, ColumnCounter, ScoringOptions };
