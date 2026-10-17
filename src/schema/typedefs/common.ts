// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types communs ────────────────────────────────────────────

/**
 * GraphQL type definitions shared across multiple resolvers.
 *
 * Declares reusable enums (SortOrder, Aggregation), the SelectOption
 * type, the filter tree inputs (FilterNode,
 * FilterCriterion with FilterConnector / FilterOperation) and SortInput
 * consumed by fact, select, and catalog queries.
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

  "Logical connector between a filter node and the PREVIOUS node of the same group. AND, OR, AND_NOT and OR_NOT follow SQL precedence (NOT, then AND, then OR); XOR, XNOR, NAND and NOR take everything on their left as a single operand. A NULL operand yields NULL (row not selected), except NOR which is true only when both sides are false."
  enum FilterConnector {
    "a AND b"
    AND
    "a OR b"
    OR
    "a AND NOT b"
    AND_NOT
    "a OR NOT b"
    OR_NOT
    "Exclusive or: exactly one of the two holds"
    XOR
    "Equivalence: both hold, or neither does"
    XNOR
    "Not both: NOT (a AND b)"
    NAND
    "Neither: NOT (a OR b)"
    NOR
  }

  "Filter operation. The allowed set depends on the column's SQL type, read server-side from metadata.sqlType, and is exposed per column as Metadata.filterOperations (route on Metadata.typeFamily, offer Metadata.filterOperations — never copy the table client-side). Numeric: comparisons, BETWEEN, IN, IS_NULL; DATE/TIMESTAMP: EQ, NEQ, BEFORE/AFTER family, BETWEEN, IN, IS_NULL; VARCHAR: EQ, NEQ, LIKE and ILIKE families, MATCHES, IN, IS_NULL; BOOLEAN: EQ, NEQ, IS_TRUE family, IS_NULL; any other type (TIME, INTERVAL, BLOB, nested types…): IS_NULL and IS_NOT_NULL only"
  enum FilterOperation {
    "Equality / inequality (numeric, date, text and boolean columns)"
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
    "Value-less operations, allowed on every column whatever its type"
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
