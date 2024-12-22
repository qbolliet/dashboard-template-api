// Importation des modules
const { gql } = require('apollo-server');


// Définition des types associés aux requêtes des dimensions
const dimensionTypeDefs = gql`
    type Dimension {
        value: Int
        label: String
    }

    type Query {
        getDimensionTable(name: String!): [Dimension]
    }
`;

exports.dimensionTypeDefs = dimensionTypeDefs