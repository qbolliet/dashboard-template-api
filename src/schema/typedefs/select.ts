// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types pour les options de sélection ──────────────────────

/**
 * GraphQL type definitions for select option queries.
 *
 * Declares the two query entry points: getSelectOptions (flat list of one
 * column, with search and limit) and getSelectOptionsTree (nested tree of a
 * column hierarchy declared through metadata.parent_name). Both render a code
 * column with its label column (metadata.label_for) when it has one, and both
 * accept the optional `structuredFilters` FilterNode of getFieldStats to make
 * the options depend on the other filters of a dashboard.
 */
const selectTypeDefs: DocumentNode = gql`
  extend type Query {
    """
    Distinct values of one column, with search and limit. \`label = value\`,
    except for a code column with label columns (\`Metadata.labelFields\`):
    \`value\` is the code (cast to text), \`label\` its label — the code itself
    when the label is NULL. \`searchTerm\` then matches the code or the label.

    \`structuredFilters\` makes the menu depend on the other filters of the
    dashboard: the same \`FilterNode\` as \`getFieldStats\`, compiled into a
    parameterized WHERE clause. It restricts the rows read *before* the
    \`SELECT DISTINCT\`, so only the values held by at least one row satisfying
    the filter are returned; \`searchTerm\` and \`limit\` then apply to those
    values, unchanged. Absent or null: every row is read, exactly as without
    the argument. An invalid tree (unknown variable, operation not allowed on
    the column type, bound exceeded) is rejected with BAD_USER_INPUT, as on
    every query taking a \`FilterNode\`.

    Example: the communes of the region \`Île-de-France\` —
    \`getSelectOptions(fieldName: "commune", schema: "geography",
    structuredFilters: { children: [{ criterion: { variable: "region",
    operation: EQ, value: "Île-de-France" } }] })\` returns
    \`[{ value: "Meaux", label: "Meaux" }, { value: "Melun", label: "Melun" },
    { value: "Paris", label: "Paris" }]\`.
    """
    getSelectOptions(
      fieldName: String!
      limit: Int = 50
      searchTerm: String = ""
      "Label column of fieldName to render (one of its labelFields). Defaults to the only one, or the first by alphabetical order; rejected with BAD_USER_INPUT when it is not a label column of fieldName."
      labelField: String
      catalog: String
      schema: String
      "Filter tree (root = group), compiled server-side into a parameterized WHERE clause that restricts the rows before the DISTINCT: only the values of rows satisfying it are returned. Absent or null: no restriction."
      structuredFilters: FilterNode
    ): [SelectOption!]!

    """
    Nested option tree of a column hierarchy, \`fieldName\` being the deepest
    level displayed. The chain of columns is walked up from \`fieldName\`
    through \`Metadata.parentName\`; the tree is read with a single
    \`SELECT DISTINCT\` over that chain.

    Shape: \`[{ value, label, children? }]\` — \`children\` is absent on leaves.
    \`label\` equals \`value\` unless the level is a code column with label
    columns (\`Metadata.labelFields\`): each level then reads its label from its
    own label column, chosen by the default rule of \`getSelectOptions\` (the
    only one, or the first by alphabetical order; no per-level argument), and
    falls back to the code when the label is NULL. A node is still one code.
    A NULL level ends its branch: the parent becomes a leaf, no empty node is
    ever produced. A column without \`parentName\` yields a one-level tree (a
    list of leaves).

    Example on the chain \`region → departement → commune\`:
    \`getSelectOptionsTree(fieldName: "commune", maxDepth: 2)\` returns
    \`[{ value: "Côte-d'Or", label: "Côte-d'Or", children: [{ value: "Beaune",
    label: "Beaune" }, …] }, …]\` — departements holding their own communes,
    i.e. the group-options format of a select menu. Without \`maxDepth\` the
    regions are the roots and the tree has three levels.

    Example on the code chain \`nc6 → nc8\` (labels \`nc6_libelle\`,
    \`nc8_libelle_en\`, \`nc8_libelle_fr\`):
    \`getSelectOptionsTree(fieldName: "nc8")\` returns \`[{ value: "010121",
    label: "Chevaux reproducteurs de race pure", children: [{ value: "01012100",
    label: "Pure-bred breeding horses" }] }, …]\` — \`nc8\` takes \`nc8_libelle_en\`,
    first by alphabetical order; use \`getSelectOptions(labelField: …)\` on the
    leaf level for another label column.

    \`structuredFilters\` (the \`FilterNode\` of \`getFieldStats\`, compiled into a
    parameterized WHERE clause) restricts the rows *before* the chain is walked
    up: only the branches holding at least one row that satisfies the filter
    are returned, the others are pruned. \`searchTerm\`, \`maxDepth\` and
    \`labelField\` rules apply to those rows, unchanged, and the node bound
    counts what is left after the filter. Absent or null: every row is read,
    exactly as without the argument. An invalid tree (unknown variable,
    operation not allowed on the column type…) is rejected with BAD_USER_INPUT.

    Example on the chain \`region → departement → commune\`:
    \`getSelectOptionsTree(fieldName: "commune", structuredFilters: { children:
    [{ criterion: { variable: "is_urban", operation: IS_TRUE } }] })\` keeps
    the urban rows only and returns \`[{ value: "Bourgogne-Franche-Comté",
    label: "Bourgogne-Franche-Comté", children: [{ value: "Côte-d'Or",
    label: "Côte-d'Or", children: [{ value: "Dijon", label: "Dijon" }] }] },
    …]\` — the other communes, and the departements left without any, are
    pruned.

    Trees larger than the configured node bound (API.SELECT_OPTIONS.TREE_MAX_NODES)
    are rejected with BAD_USER_INPUT, never truncated: narrow them with
    \`searchTerm\`, \`maxDepth\` or \`structuredFilters\`, or use \`getSelectOptions\`
    on the leaf level.
    """
    getSelectOptionsTree(
      "Deepest level displayed (the leaves of the tree)."
      fieldName: String!
      "Number of levels kept going up from fieldName (>= 1). Defaults to the whole chain."
      maxDepth: Int
      "Case-insensitive filter on the fieldName level (its code, or its label when it has a label column); ancestors of matching leaves are kept, other branches pruned."
      searchTerm: String
      catalog: String
      schema: String
      "Filter tree (root = group), compiled server-side into a parameterized WHERE clause that restricts the rows before the chain is walked up: only the branches holding a satisfying row are returned. Absent or null: no restriction."
      structuredFilters: FilterNode
    ): JSON!
  }
`;

export { selectTypeDefs };
