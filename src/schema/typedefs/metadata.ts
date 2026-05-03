// Importation des modules
import { gql } from 'graphql-tag';
import type { DocumentNode } from 'graphql';

// ─── Définition du type des méta-données ─────────────────────────────────────

/**
 * GraphQL type definitions for field metadata queries.
 *
 * Declares the Metadata type, which describes a single catalog field
 * (name, label, Python/SQL types, categorical and primary-key flags),
 * and the getMetaData query entry point.
 */
const metadataTypeDefs: DocumentNode = gql`
  type Metadata {
    name: String
    label: String
    python_type: String
    sql_type: String
    is_categorical: Boolean
    is_primary_key: Boolean
  }

  extend type Query {
    getMetaData(name: String!, database: String): Metadata
  }
`;

export { metadataTypeDefs };
