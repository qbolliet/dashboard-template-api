// Importation des modules
import { gql } from 'graphql-tag';

// Définition du type des méta-données
const metadataTypeDefs = gql`
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