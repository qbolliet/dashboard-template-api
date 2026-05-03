// Importation des modules
import { gql } from 'graphql-tag';

const selectTypeDefs = gql`
  extend type Query {
    getSelectOptions(
      fieldName: String!
      limit: Int = 50
      searchTerm: String = ""
      database: String
    ): [SelectOption!]!
    
    getGroupedSelectOptions(
      groupField: String!
      optionsField: String!
      limit: Int = 50
      database: String
    ): GroupedSelectOptions!
  }

  type GroupedSelectOptions {
    group: [SelectOption!]!
    options: [SelectOption!]!
  }
`;

export { selectTypeDefs };