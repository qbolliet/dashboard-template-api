// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types communs ────────────────────────────────────────────

/**
 * GraphQL type definitions shared across multiple resolvers.
 *
 * Declares reusable enums (SortOrder, Aggregation), composite types
 * (AggregatedFact, SelectOption), the filter tree inputs (FilterNode,
 * FilterCriterion with FilterConnector / FilterOperation) and SortInput
 * consumed by fact, dimension, and catalog queries.
 */
const commonTypeDefs: DocumentNode = gql`
  enum SortOrder {
    ASC
    DESC
  }

  enum Aggregation {
    SUM
    AVG
    MAX
    MIN
    COUNT
    MEDIAN
    MODE
  }

  type AggregatedFact {
    key: String!
    aggregatedValue: Float!
    count: Int!
    keyLabel: String
  }

  "Logical connector between a filter node and the PREVIOUS node of the same group"
  enum FilterConnector {
    AND
    OR
  }

  "Filter operation. The allowed set depends on the column's SQL type family, read server-side from metadata.sql_type: numeric (EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN IS_NULL IS_NOT_NULL), date (EQ NEQ BEFORE AFTER BETWEEN IS_NULL IS_NOT_NULL), text (EQ NEQ CONTAINS STARTS IN NOT_IN IS_NULL IS_NOT_NULL), boolean (EQ NEQ IS_NULL IS_NOT_NULL)"
  enum FilterOperation {
    "Equality / inequality (all families)"
    EQ
    NEQ
    "Numeric comparisons"
    GT
    GTE
    LT
    LTE
    "Range, bounds included (numeric, date) — value {min, max}"
    BETWEEN
    NOT_BETWEEN
    "Membership — value is a non-empty array"
    IN
    NOT_IN
    "Date comparisons (strict, then inclusive)"
    BEFORE
    AFTER
    ON_OR_BEFORE
    ON_OR_AFTER
    "Text matching (LIKE); wildcards % and _ in the value are escaped"
    CONTAINS
    NOT_CONTAINS
    STARTS
    NOT_STARTS
    ENDS
    NOT_ENDS
    "Case-insensitive text matching (ILIKE); IEQ is case-insensitive equality"
    IEQ
    ICONTAINS
    ISTARTS
    IENDS
    "Regular expression (DuckDB regexp_matches, RE2 syntax; no backreferences or lookaround)"
    MATCHES
    "Value-less operations"
    IS_NULL
    IS_NOT_NULL
    "Boolean shortcuts; the IS_NOT_* forms also match NULL"
    IS_TRUE
    IS_FALSE
    IS_NOT_TRUE
    IS_NOT_FALSE
  }

  "A single filter criterion on one column"
  input FilterCriterion {
    "Column name (must exist in the metadata table)"
    variable: String!
    "Operation to apply, compatible with the column's SQL type family"
    operation: FilterOperation!
    "Scalar (string, number, boolean) for comparisons; non-empty array for IN/NOT_IN; {min, max} for BETWEEN; omitted for IS_NULL/IS_NOT_NULL. Dates in ISO 8601; integers beyond 2^53 as strings."
    value: JSON
  }

  "Node of a filter tree. Exactly one of criterion (leaf) or children (group) must be set; groups must not be empty. The root node must be a group."
  input FilterNode {
    "Connector with the previous node of the parent group (ignored for the first node, defaults to AND)"
    connector: FilterConnector
    "Negates this node: NOT on the leaf predicate, or on the whole group"
    negate: Boolean = false
    "Leaf criterion (mutually exclusive with children)"
    criterion: FilterCriterion
    "Child nodes of a group (mutually exclusive with criterion; sub-groups are parenthesized)"
    children: [FilterNode!]
  }

  input SortInput {
    field: String!
    order: SortOrder = ASC
  }

  type SelectOption {
    value: String!
    label: String!
  }
`;

export { commonTypeDefs };
