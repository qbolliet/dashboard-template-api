// Importation des modules
import { gql } from 'apollo-server';


// Définition des types associés aux requêtes des dimensions
const dimensionTypeDefs = gql`
    type Dimension {
        value: String
        label: String
    }

    type Query {
        getDimensionTable(name: String!): [Dimension]
    }
`;

export { dimensionTypeDefs };