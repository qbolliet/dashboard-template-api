// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition des types pour les options de sélection ──────────────────────

/**
 * GraphQL type definitions for select option queries.
 *
 * Declares the two query entry points: getSelectOptions (flat list of one
 * column, with search and limit) and getSelectOptionsTree (nested tree of a
 * column hierarchy declared through metadata.parent_name).
 */
const selectTypeDefs: DocumentNode = gql`
  extend type Query {
    getSelectOptions(
      fieldName: String!
      limit: Int = 50
      searchTerm: String = ""
      catalog: String
      schema: String
    ): [SelectOption!]!

    """
    Nested option tree of a column hierarchy, \`fieldName\` being the deepest
    level displayed. The chain of columns is walked up from \`fieldName\`
    through \`Metadata.parentName\`; the tree is read with a single
    \`SELECT DISTINCT\` over that chain.

    Shape: \`[{ value, label, children? }]\` — \`label\` always equals \`value\`,
    \`children\` is absent on leaves. A NULL level ends its branch: the parent
    becomes a leaf, no empty node is ever produced. A column without
    \`parentName\` yields a one-level tree (a list of leaves).

    Example on the chain \`region → departement → commune\`:
    \`getSelectOptionsTree(fieldName: "commune", maxDepth: 2)\` returns
    \`[{ value: "Côte-d'Or", label: "Côte-d'Or", children: [{ value: "Beaune",
    label: "Beaune" }, …] }, …]\` — departements holding their own communes,
    i.e. the group-options format of a select menu. Without \`maxDepth\` the
    regions are the roots and the tree has three levels.

    Trees larger than the configured node bound (API.SELECT_OPTIONS.TREE_MAX_NODES)
    are rejected with BAD_USER_INPUT, never truncated: narrow them with
    \`searchTerm\` or \`maxDepth\`, or use \`getSelectOptions\` on the leaf level.
    """
    getSelectOptionsTree(
      "Deepest level displayed (the leaves of the tree)."
      fieldName: String!
      "Number of levels kept going up from fieldName (>= 1). Defaults to the whole chain."
      maxDepth: Int
      "Case-insensitive filter on the fieldName level; ancestors of matching leaves are kept, other branches pruned."
      searchTerm: String
      catalog: String
      schema: String
    ): JSON!
  }
`;

export { selectTypeDefs };
