// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types pour les données de faits ──────────────────────────

/**
 * GraphQL type definitions for fact table queries.
 *
 * Declares all types used by fact queries: Fact, FieldValue,
 * pagination wrappers (PaginatedFacts), the D3-optimized dataset type
 * (DatasetWithMetadata), the JSON scalar, the DataFormat enum, and two
 * Query entry points.
 */
const factTypeDefs: DocumentNode = gql`
  "A single named column value of a fact row. The value preserves its original type (Float, Int, String, Boolean…) via the JSON scalar."
  type FieldValue {
    "Name of the column (e.g. country, date, value, lower_bound)"
    name: String!
    "Raw column value, original type preserved. NULL is returned as null."
    value: JSON
  }

  "A single fact record from the fact table, split into its coordinates and its measures"
  type Fact {
    "Coordinates of the row — every column with isPrimaryKey = true, NULL levels of a column hierarchy included"
    keys: [FieldValue!]!
    "Measures of the row — every column with isPrimaryKey = false"
    measures: [FieldValue!]!
  }

  "Paginated response for fact queries"
  type PaginatedFacts {
    "Array of fact records"
    data: [Fact]
    "Total number of records matching the query"
    total: Float
    "Whether there are more pages available"
    hasNextPage: Boolean
    "Current page number (1-indexed)"
    currentPage: Int
    "Total number of pages"
    totalPages: Float
  }

  "Metadata about a dataset, useful for visualization"
  type DatasetMetadata {
    "Number of records in current page"
    count: Int!
    "Bounds of the columns of this page (not of the whole dataset), keyed by column name: [min, max] as numbers for numeric columns (integers beyond 2^53, serialized as strings, are compared as numbers, so their bound is approximate), [min, max] as ISO 8601 strings for date and timestamp columns (chronological comparison). NULLs are ignored; a column with no value has no entry. Global bounds of a column: Metadata.stats"
    extents: JSON
    "Total number of records matching the query"
    total: Float
    "Whether there are more pages available"
    hasNextPage: Boolean
    "Current page number (1-indexed)"
    currentPage: Int
    "Total number of pages"
    totalPages: Float
    "ISO 8601 timestamp of when this query was executed"
    generatedAt: String!
  }

  "D3-optimized data format with metadata"
  type DatasetWithMetadata {
    "Column names in the dataset"
    columns: [String!]!
    "Metadata of the returned columns — same names, same order as columns (axis type, header label, unit, display format…). Fails explicitly when a column has no row in the metadata table"
    fields: [Metadata!]!
    "Rows, as JSON objects (OBJECTS) or arrays ordered as columns (ARRAYS). Value types are guaranteed, see the JSON scalar"
    data: [JSON!]!
    "Metadata about the dataset"
    metadata: DatasetMetadata!
  }

  """
  Custom scalar type for JSON values. Value types coming from the fact table are
  serialized the same way on every path (rows as objects or arrays, aggregates, comparisons):
  integers (TINYINT to UBIGINT, HUGEINT) are JSON numbers when Number.isSafeInteger holds and
  their exact decimal string beyond (|value| > 2^53 - 1); DECIMAL, FLOAT and DOUBLE are JSON
  numbers (NaN and ±Infinity become null); DATE is "YYYY-MM-DD"; TIMESTAMP is ISO 8601 with a
  T separator, "YYYY-MM-DDTHH:mm:ss[.sss]", with a Z suffix (UTC) only for the types carrying a
  time zone; BOOLEAN is a boolean; NULL is null.
  """
  scalar JSON

  "Format de sérialisation des données pour getFactTableWithMetadata"
  enum DataFormat {
    "Tableau d'objets [{col: val, ...}] — format par défaut, compatible D3 et DataTable"
    OBJECTS
    "Tableau de tableaux [[val1, val2, ...]] — plus compact, optimisé pour AG Grid / TanStack"
    ARRAYS
  }

  extend type Query {
    "Get fact table data with pagination and filtering"
    getFactTable(
      fields: [String!]
      "Filter tree (root = group), compiled server-side into a parameterized WHERE clause"
      structuredFilters: FilterNode
      limit: Int! = 100
      offset: Int! = 0
      sort: [SortInput!]
      catalog: String
      schema: String
    ): PaginatedFacts

    "Get fact data optimized for D3 visualization"
    getFactTableWithMetadata(
      fields: [String!]
      "Filter tree (root = group), compiled server-side into a parameterized WHERE clause"
      structuredFilters: FilterNode
      limit: Int! = 100
      offset: Int! = 0
      sort: [SortInput!]
      catalog: String
      schema: String
      "Format de sérialisation des données : OBJECTS (défaut) ou ARRAYS (tableau de tableaux)"
      format: DataFormat = OBJECTS
    ): DatasetWithMetadata
  }
`;

export { factTypeDefs };
