// Importation des modules
import { gql } from 'apollo-server';

// Définition du type des méta-données
const metadataTypeDefs = gql`
  type Metadata {
    name: String
    label: String
    python_type: String
    sql_type: String
    is_categorical: Boolean
  }

  extend type Query {
    getMetaData(name: String!, database: String): Metadata
  }
`;

export { metadataTypeDefs };