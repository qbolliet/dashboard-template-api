// Importation des modules
import { gql } from 'apollo-server';

const selectTypeDefs = gql`
  extend type Query {
    getSelectOptions(
      fieldName: String!
      limit: Int = 50
      searchTerm: String = ""
    ): [SelectOption!]!
    
    getGroupedSelectOptions(
      groupField: String!
      optionsField: String!
      limit: Int = 50
    ): GroupedSelectOptions!
  }

  type GroupedSelectOptions {
    group: [SelectOption!]!
    options: [SelectOption!]!
  }
`;

export { selectTypeDefs };